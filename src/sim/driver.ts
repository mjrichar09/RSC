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

export interface DriverOptions {
  /** Lateral acceleration the driver believes it can sustain, in g. */
  gripBudget?: number;
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
      conditions: options.conditions ?? CLEAR_DAY,
      baseLookahead: options.baseLookahead ?? 9,
      lookaheadPerSpeed: options.lookaheadPerSpeed ?? 0.6,
      maxSpeed: options.maxSpeed ?? 45,
    };
  }

  /** Target speed for the tightest corner within the next `scan` metres. */
  private targetSpeed(fromDistance: number, scan: number): number {
    const { gripBudget, maxSpeed } = this.options;
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
    const steer = clamp(bearing * 2.1 + recentre, -1, 1);

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
