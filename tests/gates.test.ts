/**
 * A gate has to be gone through.
 *
 * Progress on a stage is arc length, and it should be: it survives a car
 * cutting a corner, sliding backwards or landing sideways. But arc length alone
 * made the checkpoints decoration. A car level with a gate collected its split
 * wherever it was — and on a stage that loops back within forty metres of
 * itself, "level with it" can mean standing on a different leg of the road
 * entirely. The finish went the same way: the line could be taken by cutting
 * across the middle of the loop rather than driving round it.
 *
 * So a gate is a plane with a width now, and it is crossed or it is not. The
 * width is the corridor rather than the posts — see `race.ts` for the
 * measurement behind that — so running wide onto the verge still counts, and
 * being somewhere else entirely does not.
 *
 * These tests drive the rules with positions rather than through the physics:
 * what is being checked is the rule, and a full sim run would only make it
 * slower to find out the rule was wrong.
 */

import { describe, expect, it } from 'vitest';
import { Race } from '../src/game/race.js';
import { Stage } from '../src/sim/stage.js';
import { stageById } from '../src/data/stages/index.js';
import { CORRIDOR } from '../src/sim/corridor.js';
import type { VehicleState } from '../src/sim/vehicle.js';

const stage = new Stage(stageById('pine-loop'));
/** Far enough across to be off the stage altogether, not merely off the road. */
const OUTSIDE = CORRIDOR.vergeWidth + CORRIDOR.bankWidth + 3;

/**
 * A car at `distance` along the stage, `lateral` metres to its left.
 *
 * Only the fields `Race.update` reads are filled in; the rest of a
 * `VehicleState` is irrelevant to timing and checkpoints.
 */
function at(distance: number, lateral: number): VehicleState {
  const s = stage.spline.at(Math.min(distance, stage.length));
  return {
    position: {
      x: s.position.x + s.left.x * lateral,
      y: s.position.y,
      z: s.position.z + s.left.z * lateral,
    },
    speed: 30,
  } as VehicleState;
}

/** Drive from `from` to `to` metres, holding a constant lateral offset. */
function drive(race: Race, to: number, lateral: number, from = 0): void {
  for (let d = from; d <= to; d += 1) race.update(at(d, lateral), 1 / 120);
}

describe('gates', () => {
  it('counts a checkpoint taken between the posts', () => {
    const race = new Race(stage);
    drive(race, stage.length, 0);
    expect(race.missed).toEqual([]);
    expect(race.checkpointsPassed).toBe(stage.checkpoints.length);
    expect(race.phase).toBe('finished');
  });

  it('still counts one taken wide, out on the verge', () => {
    // The verge is part of the stage and running onto it already costs grip.
    // The rule is not there to referee a wheel on the grass.
    const race = new Race(stage);
    drive(race, stage.length, stage.checkpoints[0]!.width + 2);
    expect(race.missed).toEqual([]);
    expect(race.phase).toBe('finished');
  });

  it('does not count one taken off the stage altogether', () => {
    const race = new Race(stage);
    const gate = stage.checkpoints[0]!;
    drive(race, stage.length, gate.width + OUTSIDE);
    expect(race.missed).toContain(0);
    expect(race.phase).not.toBe('finished');
  });

  it('lets a missed gate be retaken by going back for it', () => {
    const race = new Race(stage);
    const gate = stage.checkpoints[0]!;
    drive(race, gate.distance + 70, gate.width + OUTSIDE);
    expect(race.missed).toContain(0);

    // Back up past the gate and come through it properly.
    for (let d = gate.distance + 70; d >= gate.distance - 15; d -= 1) {
      race.update(at(d, 0.5), 1 / 120);
    }
    drive(race, stage.length, 0, gate.distance - 15);

    expect(race.missed).toEqual([]);
    expect(race.phase).toBe('finished');
  });

  it('holds the splits until the gates behind them are cleared', () => {
    const race = new Race(stage);
    const first = stage.checkpoints[0]!;
    // Miss the first, take the second and third properly.
    for (let d = 0; d <= stage.length; d += 1) {
      const wide = Math.abs(d - first.distance) < 12;
      race.update(at(d, wide ? first.width + OUTSIDE : 0), 1 / 120);
    }
    expect(race.missed).toEqual([0]);
    // Two gates were driven through, but neither can put a split on the board
    // while the one before them is still outstanding.
    expect(race.splits).toEqual([]);
    expect(race.phase).not.toBe('finished');
  });

  it('will not take a finish crossed off the stage', () => {
    const race = new Race(stage);
    const last = stage.spline.samples[stage.spline.samples.length - 1]!;
    // Every checkpoint taken cleanly, then away over the bank at the line.
    for (let d = 0; d <= stage.length; d += 1) {
      race.update(at(d, d > stage.length - 14 ? last.width + OUTSIDE : 0), 1 / 120);
    }
    expect(race.missed).toEqual([]);
    expect(race.checkpointsPassed).toBe(stage.checkpoints.length);
    expect(race.phase).not.toBe('finished');
  });

  it('forgets missed gates on a restart', () => {
    const race = new Race(stage);
    const gate = stage.checkpoints[0]!;
    drive(race, gate.distance + 70, gate.width + OUTSIDE);
    expect(race.missed.length).toBeGreaterThan(0);
    race.reset();
    expect(race.missed).toEqual([]);
    expect(race.checkpointsPassed).toBe(0);
  });
});
