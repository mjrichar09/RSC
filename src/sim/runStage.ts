/**
 * Drive a whole stage headlessly with the AI driver.
 *
 * This is the stage validator: if the driver cannot get round, the stage is not
 * shippable. It is also how medal times get calibrated, and in P7 it is what
 * lets generated stages be accepted or rejected without anyone playing them.
 */

import { Race } from '../game/race.js';
import { Driver, type DriverOptions } from './driver.js';
import type { Conditions } from './conditions.js';
import type { VehicleTuning } from '../data/tuning.js';
import { type Ghost, GhostRecorder } from './replay.js';
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
  /** Recorded ghost, when `recordGhost` was requested and the run finished. */
  ghost: Ghost | null;
}

export interface StageRunOptions {
  driver?: DriverOptions;
  /**
   * Tuning overrides, so a handling change can be checked against every stage
   * before it is committed. `npm run stages -- --set=…` was documented as
   * working and was not wired up at all, which made "the AI still gets round"
   * a vacuous check — it was driving the committed tuning every time.
   */
  tuning?: Partial<VehicleTuning>;
  /** Race the stage under these conditions. Defaults to clear daylight. */
  conditions?: Conditions;
  /** Give up after this many simulated seconds. */
  timeout?: number;
  /** Record a ghost of the run. Used for benchmark ghosts and for tests. */
  recordGhost?: boolean;
  /**
   * Run with the damage model on. Off by default so stage validation measures
   * the road rather than the car's condition; on when the question is about
   * wear, heat or brakes.
   */
  damage?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  /** Best time achieved across the attempts, or null if none finished. */
  time: number | null;
  /** Why it was rejected. */
  reason: string | null;
  offRoadFraction: number;
  rescues: number;
}

/**
 * Decide whether a stage is shippable.
 *
 * Driven at several grip budgets, because a stage that only works for one very
 * specific driving style is not a good stage — and because the AI is chaotic
 * near its own limit, so a single run is a coin toss rather than a verdict.
 * A stage has to be completable by a careful driver *and* by a committed one.
 */
export async function validateStage(
  stage: Stage,
  conditions?: Conditions,
  tuning?: Partial<VehicleTuning>,
): Promise<ValidationResult> {
  const budgets = [0.55, 0.75, 0.95];
  let best: number | null = null;
  let offRoad = 1;
  let rescues = 0;
  let finished = 0;

  for (const gripBudget of budgets) {
    const result = await runStage(stage, {
      driver: { gripBudget },
      recordGhost: false,
      ...(conditions ? { conditions } : {}),
      ...(tuning ? { tuning } : {}),
    });
    rescues = Math.max(rescues, result.rescues);
    if (result.finished && result.time !== null) {
      finished++;
      if (best === null || result.time < best) {
        best = result.time;
        // The off-road figure comes from the run that set the best time, not
        // the worst of the three. The question a stage has to answer is "can it
        // be driven cleanly", and taking the *max* while taking the best time
        // asks something else — that even the most over-committed style stays
        // on the road, which is not true of any stage in the game including the
        // ones that pass. It made the verdict a coin toss: a change with no
        // behavioural content at all, reordering two symmetric wheel mounts,
        // flipped Pine Loop's night-rain variant from 24% to 59% by nudging the
        // last bits of a chaotic run.
        offRoad = result.offRoadFraction;
      }
    }
  }
  if (best === null) offRoad = 1;

  // Two of three is the bar: one failure at the ragged end of the range is the
  // AI making a mistake, three is the stage being at fault.
  if (finished < 2) {
    return { ok: false, time: best, reason: 'not reliably completable', offRoadFraction: offRoad, rescues };
  }
  if (offRoad > 0.45) {
    return { ok: false, time: best, reason: 'too much of it is off-road', offRoadFraction: offRoad, rescues };
  }
  if (rescues > 3) {
    return { ok: false, time: best, reason: 'needs too many rescues', offRoadFraction: offRoad, rescues };
  }
  return { ok: true, time: best, reason: null, offRoadFraction: offRoad, rescues };
}

export async function runStage(
  stage: Stage,
  options: StageRunOptions = {},
): Promise<StageRunResult> {
  const timeout = options.timeout ?? 300;
  const world = await createWorld({
    stage,
    ...(options.conditions ? { conditions: options.conditions } : {}),
    ...(options.damage ? { damage: true } : {}),
    ...(options.tuning ? { tuning: options.tuning } : {}),
  });
  // The driver is told what it is driving in: a lap in the wet is planned in
  // the wet, or it brakes for every corner as though the road were dry.
  const driver = new Driver(stage, {
    // The world's *resolved* tuning, not `options.tuning`, which is a partial —
    // a harness running `--set=tireGrip=1.6` has to hand the driver the car it
    // built, or it measures one car through another's idea of grip.
    tuning: world.vehicle.tuning,
    ...options.driver,
    ...(options.conditions ? { conditions: options.conditions } : {}),
  });
  const race = new Race(stage);
  const recorder = new TelemetryRecorder();
  const ghostRecorder = options.recordGhost ? new GhostRecorder() : null;

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
    if (ghostRecorder && race.phase === 'running') {
      ghostRecorder.capture(race.time, race.furthest, world.state());
    }

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
    ghost:
      ghostRecorder && race.finishTime !== null
        ? ghostRecorder.finish(stage.def.id, race.finishTime)
        : null,
  };
}
