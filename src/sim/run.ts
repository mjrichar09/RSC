/**
 * Run a trace against a fresh world and collect telemetry.
 * Shared by the headless tool and the vitest regression suite.
 */

import { type Trace, sampleTrace, traceDuration } from './trace.js';
import { TelemetryRecorder, type TelemetrySummary } from './telemetry.js';
import { type WorldOptions, createWorld } from './world.js';
import { type Quat, rotateInverse } from './math.js';

export interface RunResult {
  trace: Trace;
  summary: TelemetrySummary;
  recorder: TelemetryRecorder;
}

export async function runTrace(trace: Trace, options: WorldOptions = {}): Promise<RunResult> {
  const world = await createWorld(options);
  if (options.damageTo && world.damage) {
    for (const [id, health] of Object.entries(options.damageTo)) {
      world.damage.health.set(id as never, health);
    }
    world.damage.refreshFailures();
  }
  const recorder = new TelemetryRecorder();
  const total = traceDuration(trace);

  // Settle the suspension before the trace starts, so a launch measures the car
  // and not the first tenth of a second of it falling onto its springs.
  for (let i = 0; i < 60; i++) {
    world.step({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
  }
  world.time = 0;
  world.steps = 0;

  while (world.time < total) {
    const state = world.state();
    // Signed drift. `VehicleState.driftAngle` is a magnitude — it comes out of
    // an `acos` — and a driver needs to know which way the car is going, not
    // just how far off it is. Taken from the velocity in the car's own frame,
    // which is exact through the transition where the yaw rate has already
    // reversed and the drift has not.
    const local = rotateInverse(
      world.cars[0]!.vehicle.body.rotation() as Quat,
      state.velocity,
    );
    const drift = Math.atan2(local.x, Math.max(Math.abs(local.z), 0.5)) * (180 / Math.PI);
    world.step(
      sampleTrace(trace, world.time, {
        drift,
        yawRate: state.yawRate * (180 / Math.PI),
        speed: state.speed,
      }),
    );
    recorder.capture(world);
  }

  return { trace, summary: recorder.summarise(world.steps), recorder };
}
