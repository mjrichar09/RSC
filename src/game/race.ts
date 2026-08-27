/**
 * Race session: timing, checkpoints and medals.
 *
 * Progress is measured as arc length along the stage spline rather than by
 * triggering volumes, which means it survives the car cutting a corner, sliding
 * backwards through a gate, or landing sideways — all of which happen
 * constantly in a rally game and all of which break naive trigger boxes.
 */

import type { MedalTimes, Stage } from '../sim/stage.js';
import type { VehicleState } from '../sim/vehicle.js';

export type Medal = 'author' | 'gold' | 'silver' | 'bronze' | 'finish';
export type RacePhase = 'staging' | 'running' | 'finished' | 'retired';

/** Best medal earned for a time, or 'finish' if it beat none of them. */
export function medalFor(time: number, medals: MedalTimes): Medal {
  if (time <= medals.author) return 'author';
  if (time <= medals.gold) return 'gold';
  if (time <= medals.silver) return 'silver';
  if (time <= medals.bronze) return 'bronze';
  return 'finish';
}

export interface Split {
  index: number;
  distance: number;
  time: number;
}

export class Race {
  readonly stage: Stage;
  /** Medal times in force for this run — a variant's, not always the stage's. */
  readonly medals: MedalTimes;

  phase: RacePhase = 'staging';
  /** Elapsed seconds. Starts when the car first moves. */
  time = 0;
  /** Furthest arc length reached, metres. Never goes backwards. */
  furthest = 0;
  splits: Split[] = [];
  finishTime: number | null = null;
  medal: Medal | null = null;
  /** Why the run ended, when the car failed rather than finished. */
  retirement: string | null = null;

  private nextCheckpoint = 0;
  private hint: number | undefined;

  constructor(stage: Stage, medals?: MedalTimes) {
    this.stage = stage;
    this.medals = medals ?? stage.def.medals;
  }

  /** Fraction of the stage completed, 0..1. */
  get progress(): number {
    return Math.min(this.furthest / this.stage.length, 1);
  }

  /** Checkpoints passed so far. */
  get checkpointsPassed(): number {
    return this.nextCheckpoint;
  }

  /**
   * Finish time this run is currently on for, in seconds.
   *
   * Elapsed time scaled by how much of the stage is left. Crude — it assumes
   * the rest of the stage takes as long per metre as the part already driven —
   * but it is available from the first attempt, which a ghost is not. A player
   * with no time set otherwise races with no reference at all.
   *
   * Null until enough of the stage is behind you for the estimate to mean
   * anything; early on it swings wildly and would read as noise.
   */
  get projectedTime(): number | null {
    if (this.phase !== 'running' || this.progress < 0.06) return null;
    return this.time / this.progress;
  }

  /** The medal this run is currently on for, or null while it is too early. */
  get projectedMedal(): Medal | null {
    const projected = this.projectedTime;
    return projected === null ? null : medalFor(projected, this.medals);
  }

  /** Call once per fixed step, after the sim has advanced. */
  /**
   * End the run without a finish. The clock stops, no medal is awarded, and
   * P5 will still charge for the repairs — which is the whole point of the
   * damage model having consequences.
   */
  retire(reason: string): void {
    if (this.phase === 'finished' || this.phase === 'retired') return;
    this.phase = 'retired';
    this.retirement = reason;
  }

  update(state: VehicleState, dt: number): void {
    if (this.phase === 'finished' || this.phase === 'retired') return;

    const here = this.stage.progressAt(state.position, this.hint);
    this.hint = here.index;

    if (this.phase === 'staging') {
      // The clock starts on the first real movement, so sitting on the line
      // costs nothing and a restart is instant.
      if (Math.abs(state.speed) > 0.6) this.phase = 'running';
      else return;
    }

    this.time += dt;
    if (here.distance > this.furthest) this.furthest = here.distance;

    const checkpoints = this.stage.checkpoints;
    while (
      this.nextCheckpoint < checkpoints.length &&
      this.furthest >= checkpoints[this.nextCheckpoint]!.distance
    ) {
      this.splits.push({
        index: this.nextCheckpoint,
        distance: checkpoints[this.nextCheckpoint]!.distance,
        time: this.time,
      });
      this.nextCheckpoint++;
    }

    // Finishing requires every checkpoint, so the line cannot be reached by
    // cutting across the middle of a loop-shaped stage.
    const atEnd = this.furthest >= this.stage.length - 4;
    if (atEnd && this.nextCheckpoint >= checkpoints.length) {
      this.phase = 'finished';
      this.finishTime = this.time;
      this.medal = medalFor(this.time, this.medals);
    }
  }

  reset(): void {
    this.phase = 'staging';
    this.time = 0;
    this.furthest = 0;
    this.splits = [];
    this.finishTime = null;
    this.medal = null;
    this.retirement = null;
    this.nextCheckpoint = 0;
    this.hint = undefined;
  }
}
