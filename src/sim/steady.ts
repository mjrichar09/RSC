/**
 * Steady-state cornering probe.
 *
 * Holds a constant throttle and steering angle until the car settles, then
 * averages the last stretch. This is the standard way to measure a car's
 * balance: compare front and rear slip angles and you know whether it
 * understeers or oversteers, without anyone having to drive it.
 */

import type { VehicleTuning } from '../data/tuning.js';
import type { SurfaceId } from './surfaces.js';
import { TelemetryRecorder } from './telemetry.js';
import { createWorld } from './world.js';

export interface SteadyStateResult {
  steer: number;
  throttle: number;
  surface: SurfaceId;
  speedKph: number;
  /** Metres. 999 means it never turned. */
  radius: number;
  /** Degrees per second. */
  yawRate: number;
  driftDeg: number;
  /** Peak lateral acceleration sustained, in g. The headline grip number. */
  lateralG: number;
  frontSlipDeg: number;
  rearSlipDeg: number;
  /**
   * front − rear slip angle, degrees.
   * Positive = understeer (front gives up first), negative = oversteer.
   */
  balance: number;
  spun: boolean;
}

export interface SteadyStateOptions {
  steer: number;
  throttle?: number;
  surface?: SurfaceId;
  /** Seconds spent building speed in a straight line before turning in. */
  runUp?: number;
  /** Seconds of cornering. The last third is what gets averaged. */
  hold?: number;
  tuning?: Partial<VehicleTuning>;
}

export async function steadyState(options: SteadyStateOptions): Promise<SteadyStateResult> {
  const { steer, throttle = 0.55, surface = 'tarmac', runUp = 3, hold = 9, tuning } = options;

  const world = await createWorld({ baseSurface: surface, tuning });
  const recorder = new TelemetryRecorder();

  for (let i = 0; i < 60; i++) world.step({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
  world.time = 0;
  world.steps = 0;

  while (world.time < runUp) {
    world.step({ throttle: 1, brake: 0, steer: 0, handbrake: 0 });
  }
  const settleAt = runUp + hold * (2 / 3);
  while (world.time < runUp + hold) {
    world.step({ throttle, brake: 0, steer, handbrake: 0 });
    if (world.time >= settleAt) recorder.capture(world);
  }

  const s = recorder.samples;
  const mean = (f: (x: (typeof s)[number]) => number) =>
    s.reduce((acc, x) => acc + f(x), 0) / Math.max(s.length, 1);

  const front = mean((x) => x.frontSlip);
  const rear = mean((x) => x.rearSlip);
  const drift = mean((x) => x.drift);

  return {
    steer,
    throttle,
    surface,
    speedKph: mean((x) => Math.abs(x.speed)) * 3.6,
    radius: mean((x) => x.turnRadius),
    yawRate: mean((x) => x.yawRate),
    driftDeg: drift,
    lateralG: mean((x) => Math.abs(x.speed * (x.yawRate * Math.PI) / 180)) / 9.81,
    frontSlipDeg: front,
    rearSlipDeg: rear,
    balance: front - rear,
    // Past ~60° of drift with the wheel held, the car is no longer cornering,
    // it is spinning.
    spun: drift > 60,
  };
}
