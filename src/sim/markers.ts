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

/**
 * Is this thing inside the car's footprint?
 *
 * Shared by the marker poles and the corner boards, because it is the same
 * question about the same rectangle. Flattened to the ground plane: a post is
 * either in the car's way or it is not, and its height has nothing to do with
 * which.
 */
function insideFootprint(at: Vec3, carPosition: Vec3, carRotation: Quat): Vec3 | null {
  const local = rotateInverse(carRotation, {
    x: at.x - carPosition.x,
    y: 0,
    z: at.z - carPosition.z,
  });
  if (Math.abs(local.x) > HIT_HALF_WIDTH || Math.abs(local.z) > HIT_HALF_LENGTH) return null;
  return local;
}

/** Where on the car a roadside post came down: its side, at bumper height. */
function contactPoint(local: Vec3): Vec3 {
  return v3(Math.sign(local.x) * 0.8, -0.15, Math.max(Math.min(local.z, 1.9), -1.9));
}

/**
 * A corner board that has been driven into.
 *
 * Same treatment as the poles, and for the same reasons — but it arrived here
 * the long way round, so the reasoning is worth keeping.
 *
 * The boards were pure decoration for a long time: a post two metres off the
 * road that the car passed straight through. Giving them a *rigid body* fixed
 * that and introduced something worse — every sign on the stage lying in the
 * verge before the lights went green. A two-metre pole nine centimetres across
 * is only marginally stable on a trimesh even when it is placed perfectly, and
 * it was not being placed perfectly; and once tipped, a cylinder rolls.
 *
 * A rigid body was never the right tool. Forty of them per stage is a physics
 * bill for something that is only ever brushed, and this file already had the
 * answer for exactly that shape of problem. A swept check costs nothing, cannot
 * fall over on its own, and gives the same answer.
 */
export interface FallenSign {
  /** 0 upright, 1 flat. */
  fallen: number;
  /** Direction it was knocked, radians about Y. */
  knockedToward: number;
}

export class Signs {
  readonly all: FallenSign[] = [];
  /** Bumped when one goes over, so the renderer knows to re-pose. */
  version = 0;

  /** Positions come from the stage; only the knocked-over state lives here. */
  constructor(private readonly posts: readonly { position: Vec3; yaw: number }[]) {
    for (const _ of posts) this.all.push({ fallen: 0, knockedToward: 0 });
  }

  /**
   * Knock over any board the car is standing in, and report what it costs.
   *
   * A linear scan. There are a few dozen boards on a stage against eighty
   * poles, and unlike the poles they are not on a fixed spacing, so there is no
   * index to jump to — but the same measurement applies: this is a handful of
   * rejected distance tests per step for an event that happens once or twice a
   * lap.
   */
  strike(
    carPosition: Vec3,
    carVelocity: Vec3,
    carRotation: Quat,
  ): { impulse: number; at: Vec3 } | null {
    const speed = Math.hypot(carVelocity.x, carVelocity.z);
    for (let i = 0; i < this.posts.length; i++) {
      const sign = this.all[i]!;
      if (sign.fallen > 0) continue;
      const local = insideFootprint(this.posts[i]!.position, carPosition, carRotation);
      if (!local) continue;

      sign.fallen = 0.001;
      sign.knockedToward =
        speed > 0.1 ? Math.atan2(carVelocity.x, carVelocity.z) : this.posts[i]!.yaw;
      this.version++;
      return { impulse: BASE_IMPULSE + speed * IMPULSE_PER_MS, at: contactPoint(local) };
    }
    return null;
  }

  /** Lay the knocked ones down over about a third of a second. */
  update(dt: number): void {
    for (const sign of this.all) {
      if (sign.fallen <= 0 || sign.fallen >= 1) continue;
      sign.fallen = Math.min(sign.fallen + dt * 3.2, 1);
      this.version++;
    }
  }

  reset(): void {
    for (const sign of this.all) {
      sign.fallen = 0;
      sign.knockedToward = 0;
    }
    this.version++;
  }

  get flattened(): number {
    return this.all.reduce((n, sign) => n + (sign.fallen > 0 ? 1 : 0), 0);
  }
}

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

    // Straight to the poles either side of the car. They are laid out in pairs
    // at a fixed spacing, so their index falls out of the arithmetic — and a
    // linear scan over eighty of them, four cars, a hundred and twenty times a
    // second, measured at 7 µs a step for an event that happens twice a lap.
    const row = Math.round(nearDistance / SPACING) - 1;
    const from = Math.max((row - 2) * 2, 0);
    const to = Math.min((row + 3) * 2, this.all.length);

    for (let i = from; i < to; i++) {
      const marker = this.all[i]!;
      if (marker.fallen > 0) continue;

      const local = insideFootprint(marker.position, carPosition, carRotation);
      if (!local) continue;

      marker.fallen = 0.001;
      marker.knockedToward = speed > 0.1 ? Math.atan2(carVelocity.x, carVelocity.z) : marker.yaw;
      this.version++;

      return { impulse: BASE_IMPULSE + speed * IMPULSE_PER_MS, at: contactPoint(local) };
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
