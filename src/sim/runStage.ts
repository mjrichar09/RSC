/**
 * Drive a whole stage headlessly with the AI driver.
 *
 * This is the stage validator: if the driver cannot get round, the stage is not
 * shippable. It is also how medal times get calibrated, and in P7 it is what
 * lets generated stages be accepted or rejected without anyone playing them.
 */

import { Race } from '../game/race.js';
import { Driver, type DriverOptions } from './driver.js';
import type { Stage } from './stage.js';
import { TelemetryRecorder, type TelemetrySummary } from './telemetry.js';
import { createWorld } from './world.js';

export interface StageRunResult {
  stage: Stage;
  finished: boolean;
  /** Seconds, or null if the driver never got round. */
  time: number | null;
  /** How far it got, 0..1. */
  progress: number;
  /** Why it stopped, when it did not finish. */
  failure: 'stuck' | 'timeout' | null;
  splits: number[];
  summary: TelemetrySummary;
  /** Fraction of the run spent with the car off the road surface. */
  offRoadFraction: number;
  /** How many times the car had to be rescued back onto the centreline. */
  rescues: number;
}

export interface StageRunOptions {
  driver?: DriverOptions;
  /** Give up after this many simulated seconds. */
  timeout?: number;
}

export async function runStage(
  stage: Stage,
  options: StageRunOptions = {},
): Promise<StageRunResult> {
  const timeout = options.timeout ?? 300;
  const world = await createWorld({ stage });
  const driver = new Driver(stage, options.driver);
  const race = new Race(stage);
  const recorder = new TelemetryRecorder();

  for (let i = 0; i < 60; i++) world.step({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
  world.time = 0;
  world.steps = 0;

  let offRoadSteps = 0;
  let stuckFor = 0;
  let rescues = 0;
  let failure: StageRunResult['failure'] = null;

  while (world.time < timeout && race.phase !== 'finished') {
    const state = world.state();
    world.step(driver.input(state, world.dt));
    race.update(world.state(), world.dt);
    recorder.capture(world);

    const here = stage.progressAt(world.state().position);
    if (!here.onRoad) offRoadSteps++;

    // Stuck: barely moving, well after the start. The driver gets a few seconds
    // to reverse itself out before the rescue steps in, and only a run that
    // keeps needing rescuing is reported as a failed stage.
    if (race.phase === 'running' && Math.abs(world.state().speed) < 1.0) {
      stuckFor += world.dt;
      if (stuckFor > 5) {
        stuckFor = 0;
        rescues++;
        if (rescues > 8) {
          failure = 'stuck';
          break;
        }
        world.rescue(race.furthest);
      }
    } else {
      stuckFor = 0;
    }
  }

  if (!failure && race.phase !== 'finished') failure = 'timeout';

  return {
    stage,
    finished: race.phase === 'finished',
    time: race.finishTime,
    progress: race.progress,
    failure,
    splits: race.splits.map((s) => s.time),
    summary: recorder.summarise(world.steps),
    offRoadFraction: world.steps > 0 ? offRoadSteps / world.steps : 0,
    rescues,
  };
}
