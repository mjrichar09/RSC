/**
 * Where the stage passes over itself.
 *
 * Grand Traverse crosses its own road twice, and until there were bridges the
 * upper corridor was a ribbon hanging in the sky with nothing under it — the
 * terrain takes the *lowest* nearby road, so the ground beneath an overpass
 * drops away, and from the lower leg it read as the game being broken.
 *
 * The crossings are found rather than authored, which is the only thing that
 * keeps a bridge under the road once a control point moves. So what is worth
 * testing is not that a particular bridge exists at a particular metre, but the
 * three properties that make a found one correct: it is over a genuine height
 * gap, it is long enough to reach the ground on both sides, and its piers are
 * not standing in the road going underneath.
 */

import { describe, expect, it } from 'vitest';
import { Stage } from '../src/sim/stage.js';
import { STAGES, stageById } from '../src/data/stages/index.js';
import { CORRIDOR } from '../src/sim/corridor.js';

describe('bridges', () => {
  it('finds both of Grand Traverse’s crossings and no others', () => {
    const stage = new Stage(stageById('grand-traverse'));
    expect(stage.crossings.length).toBe(2);
    for (const crossing of stage.crossings) {
      // A genuine overpass, not two roads in each other. Below about eight
      // metres the lower corridor's wall is inside the upper one.
      expect(crossing.headroom).toBeGreaterThanOrEqual(8);
      // Long enough to reach past the corridor it crosses at both ends: a deck
      // that stops at the edge of the road below it is a slab in mid-air.
      const under = stage.spline.at(crossing.under);
      const needed =
        2 * (under.width + CORRIDOR.vergeWidth + CORRIDOR.bankWidth + CORRIDOR.wallWidth);
      expect(crossing.span[1] - crossing.span[0]).toBeGreaterThan(needed);
      expect(crossing.span[0]).toBeGreaterThanOrEqual(0);
      expect(crossing.span[1]).toBeLessThanOrEqual(stage.length);
    }
  });

  it('leaves every other stage alone', () => {
    for (const def of STAGES) {
      if (def.id === 'grand-traverse') continue;
      expect(new Stage(def).crossings, def.id).toHaveLength(0);
    }
  });

  it('stands its piers clear of the road they pass', () => {
    for (const def of STAGES) {
      const stage = new Stage(def);
      for (const pier of stage.props.filter((p) => p.kind === 'pier')) {
        // Only road at a height the pier's shaft actually passes through can be
        // blocked by it — the deck it holds up is directly overhead and is
        // supposed to be.
        for (const sample of stage.spline.samples) {
          if (sample.position.y < pier.position.y - 2) continue;
          if (sample.position.y > pier.position.y + pier.height) continue;
          const flat = Math.hypot(
            sample.position.x - pier.position.x,
            sample.position.z - pier.position.z,
          );
          expect(flat, `${def.id} pier at ${sample.distance.toFixed(0)}m`).toBeGreaterThan(
            sample.width + pier.radius,
          );
        }
      }
    }
  });

  it('gives every crossing something to hold it up', () => {
    const stage = new Stage(stageById('grand-traverse'));
    const piers = stage.props.filter((p) => p.kind === 'pier');
    // Two columns at each end of each span.
    expect(piers.length).toBe(stage.crossings.length * 4);
    // A pier reaches from the ground to just under the deck. One that is a few
    // metres tall is a plinth, and one that is not under its own deck is a
    // column standing in a field.
    for (const pier of piers) {
      expect(pier.height).toBeGreaterThan(3);
      const above = stage.spline.locate(pier.position);
      expect(Math.abs(above.lateral)).toBeLessThanOrEqual(above.sample.width);
    }
  });
});
