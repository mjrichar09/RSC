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

/**
 * `struck` is the one that lasts. A hit animal used to become `gone` in the
 * same frame — it simply stopped being drawn, so the thing you just destroyed
 * your car on vanished at the moment of impact and the replay showed a car
 * crumpling for no reason. It is thrown now, and it stays where it lands.
 */
export type AnimalState = 'grazing' | 'alert' | 'bolting' | 'struck' | 'gone';

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
  /** Metres per second, while it is being thrown. */
  velocity: Vec3;
  /**
   * Tumble about its own long axis, radians.
   *
   * A struck deer does not stay upright, and lying it flat is most of what
   * makes the aftermath read as an aftermath. Kept separate from `yaw` so the
   * renderer can turn it and tip it independently.
   */
  roll: number;
  /** Tumble rate while airborne, radians per second. */
  spin: number;
  /** Where the ground is under it, so a thrown one knows when it has landed. */
  groundY: number;
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
 * lands on half a metre of panel.
 *
 * 3.6 for a long time, and it had quietly stopped meaning anything: the comment
 * here claimed a 90 km/h strike wrote off the front end, and measured with
 * `npm run crash -- --deer=90` it left the radiator at 78%, the lights at 32%
 * and a bill of 584 — a scratch. The damage thresholds moved underneath it and
 * this number never followed. At 9.0 the strike does what it was always
 * described as doing:
 *
 *   20 km/h   a cracked lamp                              a fright
 *   40 km/h   lights out, nose dented                     a bill
 *   60 km/h   lights gone, front panel folded             a bad accident
 *   90 km/h   front end gone, radiator holed, ~2600       written off
 *  200 km/h   the glass goes too, ~4700                   see STRIKE_CEILING
 *
 * The ceiling and the knee were both raised when the body started absorbing the
 * first seven thousand newton-seconds of any impact: the deer was landing on a
 * panel that now soaks up a quarter of it, and without that adjustment a strike
 * at open-road speed had quietly become half the accident it was calibrated to
 * be.
 *
 * Re-measure with `npm run crash -- --deer=...` after any change to the damage
 * thresholds, because that is precisely how this drifted the first time.
 */
export const STRIKE_CONCENTRATION = 9.0;

/**
 * The most a deer is allowed to put into the car, newton-seconds.
 *
 * There is a rule here older than this number and it is a fairness one: a deer
 * steps out with very little warning, so a strike may be an expensive disaster
 * and may never be an instant retirement. Without a ceiling it becomes one —
 * past about 34 000 N·s the damage model's structural spreading reaches the
 * engine wherever the hit landed, and at 9.0 that is a deer at 105 km/h ending
 * the run. `tests/wildlife.test.ts` asserts the rule at 200 km/h.
 *
 * A ceiling is also the honest end of the concentration fiction. The factor
 * says a deer loads the front far harder than its momentum suggests, which is
 * true; it cannot be true without limit, because there is only so much a 130 kg
 * animal can put into a structure before it is the animal that gives way.
 *
 * Approached smoothly rather than clamped, so a faster strike is always a worse
 * one — a hard clamp would make 120 km/h and 200 km/h identical, and "it stops
 * getting worse" is its own kind of wrong.
 *
 * Set with margin rather than right up against the engine: the seize point is
 * around 34 000 and this is 27 000, so a damage retune has to move things by a
 * quarter before the fairness rule silently stops holding. `tests/wildlife`
 * asserts that margin directly, so it fails loudly instead.
 */
export const STRIKE_CEILING = 34_000;

/**
 * Below this the strike is simply its raw impulse; above it, it bends.
 *
 * The knee matters as much as the ceiling. Softening the *whole* curve — one
 * exponential from zero — was tried first and it compresses the bottom as hard
 * as the top: a deer at 20 km/h ended up costing what one at 40 should, and the
 * only way to get a written-off front end at 90 was to make a walking-pace
 * bump expensive. Staying linear until the accident is already serious keeps
 * the cheap end cheap and spends the whole soft region where it is needed,
 * which is the last few thousand newton-seconds before the engine.
 */
const STRIKE_KNEE = 27_000;

/**
 * Impulse a strike actually delivers, after the ceiling.
 *
 * Exported because `npm run crash -- --deer=` has to model exactly what the
 * world does; that harness computing the raw product itself is how the
 * calibration and the game drifted apart in the first place.
 */
export function strikeImpulse(speed: number): number {
  const raw = DEER_MASS * Math.abs(speed) * STRIKE_CONCENTRATION;
  if (raw <= STRIKE_KNEE) return raw;
  const room = STRIKE_CEILING - STRIKE_KNEE;
  return STRIKE_KNEE + room * (1 - Math.exp(-(raw - STRIKE_KNEE) / room));
}

/** Upward kick given to a struck animal, m/s: enough to clear the bonnet. */
const LAUNCH_UP = 3.5;
/** Gravity for the throw, m/s². The world's own, since it is the same world. */
const GRAVITY = 9.81;
/** How fast a landed animal slides to a stop, per second. */
const GROUND_DRAG = 3.2;

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
        velocity: v3(0, 0, 0),
        roll: 0,
        spin: 0,
        groundY: sample.position.y,
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

      if (animal.state === 'struck') {
        this.fly(animal, dt);
        continue;
      }

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
      // Already hit, or gone. A struck animal is scenery from that moment: it
      // is thrown down the road ahead of you and may well land on the racing
      // line, and being billed for it a second time on the way past is not a
      // second accident.
      if (animal.state === 'struck' || animal.state === 'gone') continue;
      // The car's actual footprint, not a circle around its centre: a circle
      // wide enough to reach the nose also "hits" a deer standing a metre clear
      // of the door, which is a strike the player can see they avoided.
      const local = rotateInverse(carRotation, {
        x: animal.position.x - carPosition.x,
        y: 0,
        z: animal.position.z - carPosition.z,
      });
      if (Math.abs(local.x) > HIT_HALF_WIDTH || Math.abs(local.z) > HIT_HALF_LENGTH) continue;

      const speed = Math.hypot(carVelocity.x, carVelocity.z);
      animal.state = 'struck';
      // Thrown along the car's own direction and up over the bonnet. A deer
      // weighs a fraction of a car, so it leaves considerably faster than the
      // car arrived — but not so much faster that it disappears before anyone
      // has seen what happened.
      const along = speed > 0.1 ? speed : 4;
      animal.velocity = v3(
        (carVelocity.x / Math.max(speed, 0.001)) * along * 0.75,
        LAUNCH_UP + along * 0.18,
        (carVelocity.z / Math.max(speed, 0.001)) * along * 0.75,
      );
      // Tumbling. Signed off the seed so a replay throws it the same way twice.
      animal.spin = (this.random() - 0.5) * 9;
      animal.groundY = animal.position.y;
      return {
        impulse: strikeImpulse(speed),
        // Pushed along the car's own travel: the deer goes over the bonnet.
        push: speed > 0.1 ? v3(carVelocity.x / speed, 0, carVelocity.z / speed) : v3(0, 0, 1),
      };
    }
    return null;
  }

  /**
   * A struck animal, in the air and then on the ground.
   *
   * Ballistic and then still. Deliberately not a rigid body: it is scenery from
   * the moment it is hit — nothing collides with it again, nothing reads its
   * position, and one more body in the broadphase for something that lands once
   * and lies there would be a physics bill for a visual.
   */
  private fly(animal: Animal, dt: number): void {
    const landed = animal.position.y <= animal.groundY + 0.01 && animal.velocity.y <= 0;
    if (landed) {
      // Down, and settling. It keeps sliding for a moment because it arrived
      // with a great deal of speed, then stops for good.
      animal.position.y = animal.groundY;
      animal.velocity.y = 0;
      const drag = Math.max(1 - GROUND_DRAG * dt, 0);
      animal.velocity.x *= drag;
      animal.velocity.z *= drag;
      animal.spin *= drag;
      // Flat on its side, reached quickly and then held.
      animal.roll += (Math.PI / 2 - animal.roll) * Math.min(6 * dt, 1);
    } else {
      animal.velocity.y -= GRAVITY * dt;
      animal.roll += animal.spin * dt;
    }
    animal.position.x += animal.velocity.x * dt;
    animal.position.y += animal.velocity.y * dt;
    animal.position.z += animal.velocity.z * dt;
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
      animal.velocity = v3(0, 0, 0);
      animal.roll = 0;
      animal.spin = 0;
      animal.groundY = sample.position.y;
      animal.position = add(sample.position, scale(sample.left, offset * animal.side));
      animal.yaw = Math.atan2(sample.left.x * animal.side, sample.left.z * animal.side);
    }
  }
}
