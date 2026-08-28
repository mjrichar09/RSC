/**
 * Marker poles along the road edge.
 *
 * They were painted scenery: an instanced box every eighteen metres that the
 * car drove straight through. On a fixed isometric camera they are what makes
 * the road's width and direction readable, which is a real job — but a thing
 * that stands at the edge of the road and cannot be touched teaches the player
 * that the edge of the road is not there.
 *
 * So they are objects now. Clip one and it goes over, and the car takes a
 * small hit for it: not enough to end a run, more than enough to leave a mark
 * on the bodywork and a sound in your ears. That is the honest price of using
 * the whole road, and it is the difference between a marker and a stake.
 *
 * They are not rigid bodies. Eighty per stage, four cars, and every one of them
 * a collider is a physics bill for something that is only ever hit a glancing
 * blow; a swept check against the car's own footprint costs nothing and gives
 * the same answer.
 */

import type { Spline } from './spline.js';
import { type Quat, type Vec3, rotateInverse, v3 } from './math.js';

export interface Marker {
  /** Distance along the stage, metres. Markers are stored in this order. */
  distance: number;
  /** Which verge: -1 is the driver's right, 1 the left. */
  side: -1 | 1;
  position: Vec3;
  /** Which way it faces when it is still standing. */
  yaw: number;
  /** 0 upright, 1 flat on the ground. */
  fallen: number;
  /** Direction it was knocked, radians about Y. */
  knockedToward: number;
}

/** Metres between poles. Close enough to read the road, far enough to be cheap. */
const SPACING = 18;
/** How far outside the driveable width they stand. */
const OUTSIDE = 0.7;

/**
 * The car's footprint for this check, plus a little.
 *
 * Slightly wider than the car so a pole clipped by a mirror still goes over —
 * being *just* missed by a post you are certain you hit is worse than the
 * reverse.
 */
const HIT_HALF_WIDTH = 1.1;
const HIT_HALF_LENGTH = 2.2;

/**
 * What hitting one costs, in newton-seconds.
 *
 * Calibrated against the damage model's own thresholds: a mirror goes at 1800,
 * a wing starts folding at 3600, and lights and panels want 4200. So a pole
 * clipped at walking pace is a dent and nothing else, one taken at 100 km/h
 * costs a mirror, and one taken flat out starts folding a wing. Nothing here can end a run, and everything
 * here can be seen on the car afterwards.
 */
const BASE_IMPULSE = 900;
const IMPULSE_PER_MS = 70;

export class Markers {
  readonly all: Marker[] = [];
  /** Bumped when one goes over, so the renderer knows to rebuild its instances. */
  version = 0;

  constructor(spline: Spline, length: number) {
    for (let d = SPACING; d < length; d += SPACING) {
      const sample = spline.at(d);
      for (const side of [-1, 1] as const) {
        const off = sample.width + OUTSIDE;
        this.all.push({
          distance: d,
          side,
          position: v3(
            sample.position.x + sample.left.x * off * side,
            sample.position.y,
            sample.position.z + sample.left.z * off * side,
          ),
          yaw: Math.atan2(sample.forward.x, sample.forward.z),
          fallen: 0,
          knockedToward: 0,
        });
      }
    }
  }

  /**
   * Knock over anything the car is standing in, and report what it costs.
   *
   * `nearDistance` is where the car is along the stage; only the handful of
   * poles either side of that are considered, because checking eighty of them
   * against four cars at 120 Hz is ten thousand distance tests a second for an
   * event that happens twice a lap.
   */
  strike(
    nearDistance: number,
    carPosition: Vec3,
    carVelocity: Vec3,
    carRotation: Quat,
  ): { impulse: number; at: Vec3 } | null {
    const speed = Math.hypot(carVelocity.x, carVelocity.z);

    for (const marker of this.all) {
      if (marker.fallen > 0) continue;
      if (Math.abs(marker.distance - nearDistance) > SPACING * 2) continue;

      const local = rotateInverse(carRotation, {
        x: marker.position.x - carPosition.x,
        y: 0,
        z: marker.position.z - carPosition.z,
      });
      if (Math.abs(local.x) > HIT_HALF_WIDTH || Math.abs(local.z) > HIT_HALF_LENGTH) continue;

      marker.fallen = 0.001;
      marker.knockedToward = speed > 0.1 ? Math.atan2(carVelocity.x, carVelocity.z) : marker.yaw;
      this.version++;

      return {
        impulse: BASE_IMPULSE + speed * IMPULSE_PER_MS,
        // Where on the car it landed: the side it came down, at bumper height.
        at: v3(
          Math.sign(local.x) * 0.8,
          -0.15,
          Math.max(Math.min(local.z, 1.9), -1.9),
        ),
      };
    }
    return null;
  }

  /** Lay the knocked ones down over about a third of a second. */
  update(dt: number): void {
    for (const marker of this.all) {
      if (marker.fallen <= 0 || marker.fallen >= 1) continue;
      marker.fallen = Math.min(marker.fallen + dt * 3.2, 1);
      this.version++;
    }
  }

  /** Stand them all back up. A restart is a fresh stage, posts included. */
  reset(): void {
    for (const marker of this.all) {
      marker.fallen = 0;
      marker.knockedToward = 0;
    }
    this.version++;
  }

  /** How many are down. Reported by the harness and worth knowing in a test. */
  get flattened(): number {
    return this.all.reduce((count, marker) => count + (marker.fallen > 0 ? 1 : 0), 0);
  }
}
