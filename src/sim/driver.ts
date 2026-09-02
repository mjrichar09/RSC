/**
 * Scripted AI driver.
 *
 * Pure pursuit: aim at a point down the centreline, and pick a target speed
 * from the curvature ahead. It is not trying to be fast — it is trying to be a
 * consistent, honest driver, because its two jobs are to prove a stage is
 * completable (which is what makes generated stages viable in P7) and to serve
 * as a repeatable benchmark when tuning changes.
 */

import { clamp, cross, dot, rotate, rotateInverse, sub, v3 } from './math.js';
import type { DriverInput } from './input.js';
import type { Stage } from './stage.js';
import type { VehicleState } from './vehicle.js';
import { CLEAR_DAY, type Conditions, gripMultiplier } from './conditions.js';
import { surface } from './surfaces.js';
import { CAR, type VehicleTuning } from '../data/tuning.js';

/**
 * The tyre model every `gripBudget` in this project was calibrated against.
 *
 * The budgets are absolute lateral g — 0.75 means "I will plan for three
 * quarters of a g" — and that was a number with no connection to the car. The
 * driver read the *surface* grip and the weather and nothing at all out of
 * `data/tuning.ts`, so changing the tyres moved what the car could do and left
 * the AI planning at the old speeds. Measured, dropping peak grip from 1.15 g
 * to 1.03 turned a clean 87 s Grand Traverse lap into 111 s with a fifth of it
 * in the scenery, and every stage's medal table is calibrated on that lap.
 *
 * So the budget is scaled by how the current tyres compare to these. Both
 * constants are the values at the time of calibration, which is what makes
 * `gripFactor` exactly 1 there: every budget in the codebase keeps the meaning
 * it was chosen with, and only starts moving when the tyres do.
 */
const REFERENCE_TIRE_GRIP = 1.35;
const REFERENCE_PEAK_SLIP = 0.2;

/**
 * The steering the driver's gains were tuned against.
 *
 * Same problem as the grip, on the other axis, and it bit immediately.
 * `DriverInput.steer` is a *fraction of available lock*, not an angle, so the
 * wheel angle the AI actually gets for a given bearing error depends on three
 * tuning numbers it never read. Widening the speed falloff from 0.3/24 to
 * 0.6/37 more than doubles the lock available at 100 km/h — the same output,
 * 2.3x the angle — and the AI started sawing at every correction. On Vieux
 * Village, which is a narrow street with stone walls down both sides, that put
 * it off the road on every run it had previously driven clean.
 */
const REFERENCE_MAX_STEER = 0.5;
const REFERENCE_STEER_FALLOFF = 0.3;
const REFERENCE_STEER_FALLOFF_AT = 24;

/** Lock actually available at a speed, radians. Mirrors `Vehicle.updateSteering`. */
function lockAt(speed: number, maxSteer: number, falloff: number, falloffAt: number): number {
  return maxSteer * (1 - (1 - falloff) * clamp(speed / falloffAt, 0, 1));
}

/**
 * What to multiply the *recentring* term by so the angle it produces is the one
 * it was tuned for.
 *
 * Only the recentring term, and that split is measured rather than reasoned.
 * The two halves of this controller want opposite things from extra lock:
 *
 * - The **pursuit** term (`bearing * 2.1`) is aiming at a point down the road,
 *   and more authority genuinely lets it make a tighter corner. Compensated, it
 *   costs Grand Traverse — which is mostly hairpins — 13 seconds: 82.6 s to
 *   95.4 s, degrading further the harder the driver commits.
 * - The **recentring** term is a stabiliser, a proportional pull back toward
 *   the centreline that exists because pure pursuit will happily settle into an
 *   offset on the verge. Its gain was chosen against the lock of the day, so
 *   2.3x the angle for the same output is 2.3x the loop gain, and it oscillates.
 *   Uncompensated it cost Vieux Village — a narrow street with stone walls —
 *   12 seconds and put a clean run off the road: 30.5 s to 42.6 s.
 *
 * Compensating exactly one of them is better than compensating both or neither
 * on all three stages that care. Speed-dependent, because the reference falloff
 * was: the old car simply had less lock at speed, and that was quietly doing a
 * lot of the stabilising this now does explicitly.
 */
function steerScale(speed: number, tuning: VehicleTuning): number {
  const now = lockAt(
    speed,
    tuning.maxSteerAngle,
    tuning.steerSpeedFalloff,
    tuning.steerSpeedFalloffAt,
  );
  if (now < 1e-6) return 1;
  const reference = lockAt(
    speed,
    REFERENCE_MAX_STEER,
    REFERENCE_STEER_FALLOFF,
    REFERENCE_STEER_FALLOFF_AT,
  );
  return reference / now;
}

/**
 * How much more (or less) lateral g this car can hold than the reference one.
 *
 * Two terms, and they are not equally solid:
 *
 * - **`tireGrip`** is the peak friction coefficient and scales the friction
 *   circle directly, so this part is exact.
 * - **`peakSlipAngle`** is a curve *shape*, not a height — the peak of the slip
 *   curve is 1.0 whatever it is set to. What a wider peak actually costs is
 *   force at the slip angles below it, which is where a car corners, and that
 *   is not available in closed form. The inverse ratio here is an
 *   approximation, and deliberately a pessimistic one: measured, 0.20 → 0.24
 *   cost about 10% of peak lateral g and this predicts 17%. A driver that
 *   under-estimates its grip is slow; one that over-estimates it is in a ditch,
 *   and only one of those two failures ends a stage validation run.
 *
 * `npm run stages` is what actually confirms this, and it is the check that has
 * to be run after any change to either number.
 */
function gripFactor(tuning: VehicleTuning): number {
  return (
    (tuning.tireGrip / REFERENCE_TIRE_GRIP) * (REFERENCE_PEAK_SLIP / tuning.peakSlipAngle)
  );
}

export interface DriverOptions {
  /**
   * Lateral acceleration the driver believes it can sustain, in g.
   *
   * Read as commitment rather than as an absolute: it is what the driver would
   * plan for in a car with the reference tyres, and it is scaled by
   * `gripFactor` for the car it is actually in. So 0.75 still means what it
   * meant when it was chosen, and a stiffer or softer tyre moves it without
   * anybody having to remember to.
   */
  gripBudget?: number;
  /**
   * The car being driven, so the driver knows what its tyres can do.
   *
   * Defaults to the committed tuning, which is what almost every caller is
   * using anyway — a harness running with `--set` overrides has to pass the
   * world's resolved tuning, or it is measuring one car with another's driver.
   */
  tuning?: VehicleTuning;
  /**
   * Conditions the lap is being driven in, so the driver knows the road is wet.
   * Without it, it plans every corner as though it were dry.
   */
  conditions?: Conditions;
  /** Lookahead distance at rest, metres. */
  baseLookahead?: number;
  /** Extra lookahead per m/s of speed. */
  lookaheadPerSpeed?: number;
  /** Hard ceiling on target speed, m/s. */
  maxSpeed?: number;
}

export class Driver {
  private readonly stage: Stage;
  private readonly options: Required<DriverOptions>;
  private hint: number | undefined;

  /** Arc length reached so far. Used to detect a stalled or stuck run. */
  progress = 0;

  /** Furthest arc length reached, for detecting genuine lack of progress. */
  private best = -Infinity;
  /** Seconds since the car last made forward progress along the stage. */
  private stalled = 0;
  /** Seconds left of a reversing recovery. */
  private reversing = 0;
  private started = false;

  constructor(stage: Stage, options: DriverOptions = {}) {
    this.stage = stage;
    this.options = {
      gripBudget: options.gripBudget ?? 0.6,
      tuning: options.tuning ?? CAR,
      conditions: options.conditions ?? CLEAR_DAY,
      baseLookahead: options.baseLookahead ?? 9,
      lookaheadPerSpeed: options.lookaheadPerSpeed ?? 0.6,
      maxSpeed: options.maxSpeed ?? 45,
    };
  }

  /** Target speed for the tightest corner within the next `scan` metres. */
  private targetSpeed(fromDistance: number, scan: number): number {
    const { maxSpeed } = this.options;
    const gripBudget = this.options.gripBudget * gripFactor(this.options.tuning);
    let limit = maxSpeed;

    for (let d = 0; d < scan; d += 4) {
      const s = this.stage.spline.at(fromDistance + d);
      const curvature = Math.abs(s.curvature);
      if (curvature < 1e-4) continue;

      const radius = 1 / curvature;
      /*
       * Corner speed from the grip that is actually under the car.
       *
       * The budget used to be a flat number: the same target speed for a snow
       * hairpin as for a dry tarmac one. It went unnoticed for as long as the
       * car could not reach those speeds on snow — the gearbox was upshifting
       * on wheelspin and leaving it in the wrong gear — and the moment that was
       * fixed the driver started arriving at winter corners a third too fast
       * and spending half the stage in the scenery.
       */
      const ground = surface(s.surface);
      const grip = ground.grip * gripMultiplier(this.options.conditions, ground);
      const corner = Math.sqrt(gripBudget * grip * 9.81 * radius);
      // Allow a higher speed for a corner that is still far off — there is time
      // to shed speed before reaching it. Kept conservative: arriving too fast
      // on a narrow stage means going over the bank, not just running wide.
      const allowance = corner + d * 0.22;
      limit = Math.min(limit, allowance);
    }
    return clamp(limit, 6, maxSpeed);
  }

  input(state: VehicleState, dt = 1 / 120): DriverInput {
    const loc = this.stage.spline.locate(state.position, this.hint);
    this.hint = loc.index;
    this.progress = loc.distance;

    if (Math.abs(state.speed) > 3) this.started = true;

    // How far the car has to rotate to point back down the stage. Positive
    // means it needs to turn right.
    const nose = rotate(state.rotation, v3(0, 0, 1));
    const misalignment = Math.atan2(
      dot(cross(nose, loc.sample.forward), v3(0, 1, 0)),
      dot(nose, loc.sample.forward),
    );

    // Recovery. Pure pursuit cannot turn a car around — with the aim point
    // behind it the bearing saturates and it just circles — so being stuck or
    // facing the wrong way has to be handled explicitly. Reversing steers the
    // opposite way to forward travel, hence the negated lock.
    if (this.reversing > 0) {
      this.reversing -= dt;
      // Keep backing up while still pointing the wrong way.
      if (this.reversing <= 0 && Math.abs(misalignment) > 1.2) this.reversing = 0.6;
      return {
        throttle: 0,
        brake: 1,
        steer: -clamp(-misalignment * 1.5, -1, 1),
        handbrake: 0,
      };
    }
    if (this.started && Math.abs(misalignment) > 2.0) {
      this.reversing = 1.2;
    }
    // Trigger on lack of *progress*, not on low speed: a tight hairpin is slow
    // but still advancing, and reversing out of one loses the whole corner.
    if (loc.distance > this.best + 0.5) {
      this.best = loc.distance;
      this.stalled = 0;
    } else if (this.started) {
      this.stalled += dt;
      if (this.stalled > 3) {
        this.stalled = 0;
        this.reversing = 1.4;
      }
    }

    const speed = Math.max(state.speed, 0);
    const lookahead = this.options.baseLookahead + speed * this.options.lookaheadPerSpeed;
    const aimAt = this.stage.spline.at(loc.distance + lookahead);

    // Steering: bearing to the aim point, expressed in the car's own frame.
    const toAim = rotateInverse(state.rotation, sub(aimAt.position, state.position));
    const bearing = Math.atan2(toAim.x, Math.max(toAim.z, 0.1));
    // Pull back toward the centreline rather than tracking the aim point alone;
    // pure pursuit will happily settle into a stable offset on the verge.
    const recentre = clamp(loc.lateral * 0.07, -0.45, 0.45);
    // Scaled to the lock this car actually has, so the wheel angle is the one
    // these gains were tuned to produce whatever the steering tuning says.
    const steer = clamp(bearing * 2.1 + recentre * steerScale(speed, this.options.tuning), -1, 1);

    const target = this.targetSpeed(loc.distance, 70);
    const error = target - speed;

    let throttle = 0;
    let brake = 0;
    if (error > 0.5) throttle = clamp(error * 0.35, 0, 1);
    else if (error < -0.8) brake = clamp(-error * 0.3, 0, 1);

    // Ease off the power when already sliding, rather than compounding it.
    const sliding = state.driftAngle > 0.3;
    if (sliding) throttle *= 0.35;

    // The AI works in the car's local frame, where a positive steer goes left;
    // `DriverInput.steer` is the driver's language, where positive is right. So
    // it flips exactly once, here, on the way out.
    return { throttle, brake, steer: -steer, handbrake: 0 };
  }

  /** True when the car is pointing back down the stage — used for stuck detection. */
  static facingBackwards(stage: Stage, state: VehicleState, hint?: number): boolean {
    const loc = stage.spline.locate(state.position, hint);
    const nose = rotate(state.rotation, v3(0, 0, 1));
    return dot(nose, loc.sample.forward) < -0.5;
  }
}
