/**
 * Race session: timing, checkpoints and medals.
 *
 * Progress is measured as arc length along the stage spline rather than by
 * triggering volumes, which means it survives the car cutting a corner, sliding
 * backwards through a gate, or landing sideways — all of which happen
 * constantly in a rally game and all of which break naive trigger boxes.
 *
 * A gate is the exception, and it has to be. Arc length alone counted a
 * checkpoint the moment the car drew level with it, wherever it was across the
 * road: a car three metres up the embankment on the wrong side of a post
 * collected the split exactly as if it had gone through, which made the gates
 * decoration and made cutting free. So a gate is passed by being *between its
 * posts* when you cross its line, and only then. Everything else — where you
 * are on the stage, the clock, the ghost — is still arc length, so the one
 * place a trigger volume exists is the one place the game means one.
 *
 * That volume is built from the gate's own three vectors and not from the
 * stage's arc length, and the difference is not academic. The spline's lateral
 * offset is measured to the nearest *sample*, and through a tight corner the
 * nearest sample sits across the apex from the car: measured that way the AI's
 * own clean lap of Grand Traverse came out twelve metres off the centreline at
 * a checkpoint it had driven straight through, and every gate on the stage read
 * as missed. A gate is a plane with a width. It is tested as one.
 *
 * ## How wide the gate is
 *
 * As wide as the corridor: the road, its verges and its embankments. Not as
 * wide as the posts, which stand at the road edge, and the difference was
 * measured rather than chosen. Driving every stage and variant with the AI at
 * three levels of commitment (`.tmpcheck` aside, the same three
 * `validateStage` uses), the over-committed run is outside the posts by up to
 * five metres at three of Grand Traverse's six gates — it is on the verge,
 * which is part of the stage and is meant to be driveable at a price. A rule
 * that failed that run would be refereeing a wheel on the grass.
 *
 * What it does stop is the thing that was actually broken: arriving at a gate's
 * arc length from somewhere else entirely. On a stage that loops back within
 * forty metres of itself, the old rule handed you a checkpoint for being level
 * with it on the wrong leg, and handed you the finish for cutting across the
 * middle. Both now require crossing the gate's own plane, inside the corridor,
 * in order.
 */

import type { Checkpoint, MedalTimes, Stage } from '../sim/stage.js';
import type { Vec3 } from '../sim/math.js';
import { CORRIDOR } from '../sim/corridor.js';
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

/**
 * How close to the finish line counts as being on it, metres.
 *
 * The line is the last sample of the centreline and the car is a point on a
 * spline lookup, so an exact equality would be missed at any real speed: at 200
 * km/h a step covers half a metre. Four metres is the same band the finish has
 * always used.
 */
const FINISH_BAND = 4;


/**
 * How near a gate the car has to be for anything about it to mean anything.
 *
 * The plane is infinite; the gate is not, and the difference showed on screen.
 * Measured only along the plane's normal, a car four hundred metres away but
 * momentarily level with a gate's *plane* counted as crossing it — three of the
 * four stages in one screenshot were telling the driver they had missed a
 * checkpoint that was still half a stage ahead of them. So the test is a
 * distance from the gate itself, in the gate's own frame, and thirty metres is
 * generous for something the car passes at under one metre a step.
 */
const GATE_RANGE = 30;

/**
 * How far either side of a gate's posts still counts as through it.
 *
 * The verge and the embankment: the whole width the stage is cut to. See the
 * note at the top of this file for the measurement behind it.
 */
const GATE_SHOULDER = CORRIDOR.vergeWidth + CORRIDOR.bankWidth;

/** Where a point sits relative to a gate: through it, and across it. */
function relativeTo(gate: Checkpoint, point: Vec3): { through: number; across: number } {
  const dx = point.x - gate.position.x;
  const dy = point.y - gate.position.y;
  const dz = point.z - gate.position.z;
  return {
    through: dx * gate.forward.x + dy * gate.forward.y + dz * gate.forward.z,
    across: dx * gate.left.x + dy * gate.left.y + dz * gate.left.z,
  };
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

  /**
   * Gates crossed on the wrong side of a post, in stage order.
   *
   * Kept rather than merely counted so the HUD can name which one — "CP2
   * MISSED" is something a player can act on by turning round, and "checkpoint
   * missed" is something they can only be baffled by.
   */
  missed: number[] = [];

  /** Gates passed properly, which may arrive out of order. */
  private readonly cleared = new Set<number>();

  private nextCheckpoint = 0;
  private hint: number | undefined;
  /**
   * Which side of each gate's plane the car was on last step.
   *
   * Undefined until the first update: the first reading is a position, and it
   * takes two of them to make a crossing.
   */
  private gateSide: (number | undefined)[] = [];

  /** The finish line, as the same kind of gate as every checkpoint. */
  private readonly finish: Checkpoint;

  constructor(stage: Stage, medals?: MedalTimes) {
    this.stage = stage;
    this.medals = medals ?? stage.def.medals;
    const last = stage.spline.samples[stage.spline.samples.length - 1]!;
    this.finish = {
      distance: stage.length,
      position: last.position,
      width: last.width,
      left: last.left,
      forward: last.forward,
    };
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
    // Gates are taken in order, so the only ones in play are the one being
    // waited on and any left behind. A stage that doubles back past a
    // checkpoint already taken does not re-open it.
    for (const i of this.inPlay(checkpoints.length)) {
      const gate = checkpoints[i]!;
      const now = relativeTo(gate, state.position);
      const before = this.gateSide[i];
      this.gateSide[i] = now.through;

      // Through it: the car changed sides of the plane while it was actually at
      // the gate, and inside it. In either direction — a handbrake turn at a
      // checkpoint can cross the same line three times, and any one of those
      // crossings is allowed to be the good one.
      const at = Math.hypot(now.through, now.across) <= GATE_RANGE;
      if (
        before !== undefined &&
        at &&
        before < 0 !== now.through < 0 &&
        Math.abs(now.across) <= gate.width + GATE_SHOULDER
      ) {
        this.pass(i, checkpoints.length);
        continue;
      }

      // Past it and it was never taken. Said this way round rather than as
      // "crossed the plane outside the gate", because a car that went round the
      // outside by fifty metres never crossed anything — and that is exactly
      // the car that most needs telling.
      if (now.through > GATE_RANGE && !this.cleared.has(i) && !this.missed.includes(i)) {
        this.missed.push(i);
      }
    }

    // Finishing requires every checkpoint, so the line cannot be reached by
    // cutting across the middle of a loop-shaped stage — and it requires being
    // between the finish posts, so it cannot be reached over the bank either.
    const line = relativeTo(this.finish, state.position);
    const atEnd =
      line.through >= -FINISH_BAND && Math.hypot(line.through, line.across) <= GATE_RANGE;
    if (
      atEnd &&
      Math.abs(line.across) <= this.finish.width + GATE_SHOULDER &&
      this.nextCheckpoint >= checkpoints.length
    ) {
      this.phase = 'finished';
      this.finishTime = this.time;
      this.medal = medalFor(this.time, this.medals);
    }
  }

  /**
   * Record a gate as passed.
   *
   * Splits are only meaningful in order, so a gate taken out of sequence — the
   * third one collected while the second is still missed — counts as passed and
   * puts no time on the board until the ones behind it are cleared.
   */
  /** The gates still owed: the one being waited on, and any left behind. */
  private inPlay(total: number): number[] {
    const gates = new Set(this.missed);
    if (this.nextCheckpoint < total) gates.add(this.nextCheckpoint);
    return [...gates];
  }

  private pass(index: number, total: number): void {
    const at = this.missed.indexOf(index);
    if (at !== -1) this.missed.splice(at, 1);
    this.cleared.add(index);
    while (this.nextCheckpoint < total && this.cleared.has(this.nextCheckpoint)) {
      this.splits.push({
        index: this.nextCheckpoint,
        distance: this.stage.checkpoints[this.nextCheckpoint]!.distance,
        time: this.time,
      });
      this.nextCheckpoint++;
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
    this.missed = [];
    this.cleared.clear();
    this.gateSide = [];
  }
}
