/**
 * Run a trace against a fresh world and collect telemetry.
 * Shared by the headless tool and the vitest regression suite.
 */

import { type Trace, sampleTrace, traceDuration } from './trace.js';
import { TelemetryRecorder, type TelemetrySummary } from './telemetry.js';
import { type WorldOptions, createWorld } from './world.js';

export interface RunResult {
  trace: Trace;
  summary: TelemetrySummary;
  recorder: TelemetryRecorder;
}

export async function runTrace(trace: Trace, options: WorldOptions = {}): Promise<RunResult> {
  const world = await createWorld(options);
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
    world.step(sampleTrace(trace, world.time));
    recorder.capture(world);
  }

  return { trace, summary: recorder.summarise(world.steps), recorder };
}
