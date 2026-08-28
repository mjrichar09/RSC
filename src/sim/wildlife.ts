/**
 * Animals at the roadside.
 *
 * This is the telegraphed half of the surprise tier. Where a deer stands is
 * fixed by the stage seed, so it is in the same place on every load and in
 * every headless run — you can learn a stage. What it *does* is a seeded roll
 * weighted by how fast you are coming, so the same deer does not always bolt,
 * and it is always visible, and always alert, before it moves.
 *
 * That ordering is the whole design. Being hit by something you could not have
 * seen is what makes people stop playing; being hit by something you saw,
 * misjudged, and drove past too fast is a story.
 */

import type { Spline } from './spline.js';
import { type Quat, type Vec3, add, rotateInverse, scale, v3 } from './math.js';

export type AnimalState = 'grazing' | 'alert' | 'bolting' | 'gone';

export interface Animal {
  /** Distance along the stage where it started, metres. */
  distance: number;
  /** Which verge it grazes on: -1 left, 1 right. */
  side: -1 | 1;
  state: AnimalState;
  /** Current world position. Moves once it bolts. */
  position: Vec3;
  /** Facing, radians about Y. Turns to face the road when alert. */
  yaw: number;
  /** 0..1 across the road, once bolting. */
  crossed: number;
}

export interface WildlifeOptions {
  /** How many animals per kilometre of stage. */
  perKm?: number;
  /** Deterministic stream. Placement and behaviour both draw from it. */
  random?: () => number;
}

/** Mass of an adult deer, kg. Heavy enough that hitting one is an accident. */
export const DEER_MASS = 130;
/**
 * How much harder a strike loads the car's front than its momentum change
 * suggests.
 *
 * The damage model's thresholds are momentum change of the *car*, calibrated
 * against a wall that stops it dead. A deer changes the car's momentum by
 * almost nothing and still destroys the front of it, because all of that load
 * lands on half a metre of panel. Set so that a strike at 90 km/h holes the
 * radiator and takes the lights — a written-off front end, which is what a deer
 * strike at that speed actually is — while 35 km/h is paint and a fright.
 */
export const STRIKE_CONCENTRATION = 3.6;

/** How far ahead a deer notices the car and lifts its head, metres. */
const ALERT_RANGE = 60;
/** Distance at which a bolt would be pointless — it has already been passed. */
const PASSED_BY = 8;
/** How fast it crosses, metres per second. */
const BOLT_SPEED = 7.5;
/**
 * The strike box, in car-local metres: the car's own footprint plus the deer's
 * body. Half the car is 0.85 m wide and 2.0 m long; a deer is about 0.7 m
 * across and 1.4 m long.
 */
const HIT_HALF_WIDTH = 1.5;
const HIT_HALF_LENGTH = 2.7;

/** Grazing offset from the centreline, as a multiple of the road half-width. */
const VERGE_OFFSET = 1.45;

/**
 * Wildlife on one stage.
 *
 * Placement is a pure function of the stream it is given, so a stage seeded the
 * same way always has the same animals in the same places.
 */
export class Wildlife {
  readonly animals: Animal[] = [];
  private readonly random: () => number;
  private readonly spline: Spline;

  constructor(spline: Spline, length: number, options: WildlifeOptions = {}) {
    this.spline = spline;
    this.random = options.random ?? (() => 0.5);
    const perKm = options.perKm ?? 3;
    const count = Math.max(0, Math.round((length / 1000) * perKm));

    for (let i = 0; i < count; i++) {
      // Spread through the stage rather than clustered, then jittered, so they
      // are neither evenly spaced nor bunched at one end.
      const span = length / Math.max(count, 1);
      const distance = span * (i + 0.25 + this.random() * 0.5);
      // Never in the first or last stretch: the line off the start and the run
      // to the finish are where a surprise would feel arbitrary.
      if (distance < 60 || distance > length - 60) continue;

      const side: -1 | 1 = this.random() < 0.5 ? -1 : 1;
      const sample = this.spline.at(distance);
      const offset = sample.width * VERGE_OFFSET + this.random() * 2;
      this.animals.push({
        distance,
        side,
        state: 'grazing',
        position: add(sample.position, scale(sample.left, offset * side)),
        // Grazing animals face away from the road, which is why the head
        // coming up is a tell you can read at a glance.
        yaw: Math.atan2(sample.left.x * side, sample.left.z * side),
        crossed: 0,
      });
    }
  }

  /**
   * Advance every animal.
   *
   * `carDistance` is the car's progress along the stage and `carSpeed` its
   * speed in m/s — a deer is far more likely to panic in front of something
   * arriving fast.
   */
  update(dt: number, carDistance: number, carSpeed: number): void {
    for (const animal of this.animals) {
      if (animal.state === 'gone') continue;

      const ahead = animal.distance - carDistance;
      const sample = this.spline.at(animal.distance);

      if (animal.state === 'bolting') {
        animal.crossed += (BOLT_SPEED * dt) / Math.max(sample.width * 2.6, 1);
        const offset = sample.width * VERGE_OFFSET * (1 - 2 * animal.crossed);
        animal.position = add(sample.position, scale(sample.left, offset * animal.side));
        animal.yaw = Math.atan2(-sample.left.x * animal.side, -sample.left.z * animal.side);
        if (animal.crossed >= 1.25) animal.state = 'gone';
        continue;
      }

      if (ahead < -PASSED_BY || ahead > ALERT_RANGE) continue;

      if (animal.state === 'grazing') {
        // Head up, facing the road. This lasts as long as it takes the car to
        // cover the alert range, which at racing speed is about a second and a
        // half — short, but never zero.
        animal.state = 'alert';
        animal.yaw = Math.atan2(sample.forward.x, sample.forward.z);
        continue;
      }

      // Alert: the roll. Weighted by closing speed, and only while the car is
      // close enough that bolting would put it in the way.
      if (ahead > 0 && ahead < 34) {
        // About a third of deer bolt in front of a car arriving at racing
        // speed, and the ones that do give roughly a second of warning. Higher
        // than that and every animal on the stage becomes a wall; lower and the
        // tell stops meaning anything.
        const panic = Math.min(Math.max(carSpeed - 8, 0) / 28, 1);
        if (this.random() < panic * 0.35 * dt) animal.state = 'bolting';
      }
    }
  }

  /**
   * A strike, if the car is on top of one. Returns the impulse in N·s and the
   * direction the car was pushed, or null.
   *
   * Deliberately a proximity test rather than a rigid body: a deer is not an
   * obstacle you can push around, it is an event that happens to you, and a
   * ragdoll would cost a body and a collider per animal for no gain.
   */
  strike(
    carPosition: Vec3,
    carVelocity: Vec3,
    carRotation: Quat,
  ): { impulse: number; push: Vec3 } | null {
    for (const animal of this.animals) {
      if (animal.state === 'gone') continue;
      // The car's actual footprint, not a circle around its centre: a circle
      // wide enough to reach the nose also "hits" a deer standing a metre clear
      // of the door, which is a strike the player can see they avoided.
      const local = rotateInverse(carRotation, {
        x: animal.position.x - carPosition.x,
        y: 0,
        z: animal.position.z - carPosition.z,
      });
      if (Math.abs(local.x) > HIT_HALF_WIDTH || Math.abs(local.z) > HIT_HALF_LENGTH) continue;

      animal.state = 'gone';
      const speed = Math.hypot(carVelocity.x, carVelocity.z);
      return {
        impulse: DEER_MASS * speed * STRIKE_CONCENTRATION,
        // Pushed along the car's own travel: the deer goes over the bonnet.
        push: speed > 0.1 ? v3(carVelocity.x / speed, 0, carVelocity.z / speed) : v3(0, 0, 1),
      };
    }
    return null;
  }

  /** Animals worth drawing: everything that has not left the scene. */
  visible(): Animal[] {
    return this.animals.filter((a) => a.state !== 'gone');
  }

  reset(): void {
    for (const animal of this.animals) {
      const sample = this.spline.at(animal.distance);
      const offset = sample.width * VERGE_OFFSET;
      animal.state = 'grazing';
      animal.crossed = 0;
      animal.position = add(sample.position, scale(sample.left, offset * animal.side));
      animal.yaw = Math.atan2(sample.left.x * animal.side, sample.left.z * animal.side);
    }
  }
}
