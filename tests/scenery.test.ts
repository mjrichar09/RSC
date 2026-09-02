/**
 * The wood is not wallpaper.
 *
 * Scenery used to be placed in the renderer, which meant a stage's trees,
 * boulders and houses existed on screen and nowhere else: the car drove through
 * every one of them. These tests are about the two halves of the fix. The
 * simulation has to *know* where the wood is — same list, same seed, every
 * machine — and hitting a trunk has to cost what hitting a trunk costs.
 *
 * The size threshold matters as much as the collider does. A quarry floor is
 * strewn with pebble-sized stones for texture, and making every one of them
 * solid is the difference between a rally stage and a cattle grid.
 *
 * There is a third case between those two now. A stone too small to be an
 * obstacle is still worth feeling, so it becomes a *bump*: same footprint, and
 * a hard cap on how far it stands above the ground. The cap is the only thing
 * making that safe, so it is the thing these tests check.
 */

import { describe, expect, it } from 'vitest';
import { Stage } from '../src/sim/stage.js';
import { createWorld } from '../src/sim/world.js';
import { stageById } from '../src/data/stages/index.js';
import { CORRIDOR } from '../src/sim/corridor.js';
import {
  BUMP_PROUD,
  MIN_BUMP_EXTENT,
  SOLID_MARGIN,
  scatterScenery,
  sinkFor,
} from '../src/sim/scenery.js';

describe('what stands beside the road', () => {
  it('is the same wood on every machine', () => {
    const def = stageById('pine-loop');
    const a = new Stage(def).scenery;
    const b = new Stage(def).scenery;
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(100);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.kind).toBe(b[i]!.kind);
      expect(a[i]!.position.x).toBeCloseTo(b[i]!.position.x, 6);
      expect(a[i]!.position.z).toBeCloseTo(b[i]!.position.z, 6);
    }
  });

  it('is built by the simulation, not by whoever happens to be drawing it', () => {
    const stage = new Stage(stageById('pine-loop'));
    const direct = scatterScenery('pine-loop', 'forest', stage.spline);
    expect(direct.length).toBe(stage.scenery.length);
  });

  it('gives every biome something solid to hit', () => {
    for (const id of ['pine-loop', 'quarry-run', 'north-pass', 'vieux-village', 'grand-traverse']) {
      const solid = new Stage(stageById(id)).scenery.filter((item) => item.solid);
      expect(solid.length, id).toBeGreaterThan(20);
    }
  });

  it('leaves grass and heather soft, and small stones as bumps', () => {
    for (const id of ['pine-loop', 'quarry-run', 'grand-traverse']) {
      for (const item of new Stage(stageById(id)).scenery) {
        if (item.kind === 'tuft' || item.kind === 'bush') {
          expect(item.solid, `${id} ${item.kind}`).toBeUndefined();
        }
        if (!item.solid) continue;

        if (!item.solid.bump) {
          // An obstacle has to be big enough to have been seen and avoided.
          // Nothing knee-high enough to trip a car without being seen.
          expect(item.solid.radius, `${id} ${item.kind}`).toBeGreaterThanOrEqual(0.55);
          continue;
        }

        // A bump is the deliberate exception: small enough that the bar above
        // rejects it, and safe only because its *height* is capped instead. So
        // that cap is what gets asserted — this is the property that keeps a
        // stony verge from becoming the boulder field that once left the AI
        // unable to finish Grand Traverse in snow at all.
        expect(item.solid.radius, `${id} ${item.kind}`).toBeGreaterThanOrEqual(MIN_BUMP_EXTENT);
        const ground = item.position.y + sinkFor(item.kind, item.size);
        const top = item.solid.center.y + item.solid.halfHeight;
        expect(top - ground, `${id} ${item.kind} stands too proud`).toBeLessThanOrEqual(
          BUMP_PROUD + 1e-6,
        );
        // And it is buried, not balanced: a bump whose base is off the ground
        // is a slab the car can hit the edge of.
        expect(item.solid.center.y - item.solid.halfHeight).toBeLessThanOrEqual(ground);
      }
    }
  });

  it('only makes bumps out of stone, and only where a car can reach them', () => {
    let bumps = 0;
    for (const id of ['quarry-run', 'north-pass', 'grand-traverse']) {
      const stage = new Stage(stageById(id));
      for (const item of stage.scenery) {
        if (!item.solid?.bump) continue;
        bumps++;
        // Heather and grass are brushed through; only rock makes a bump.
        expect(item.kind, id).toBe('boulder');
        // Past the wall nothing reaches them, so nothing there should pay for
        // a collider.
        const widest = Math.max(...stage.spline.samples.map((s) => s.width));
        expect(item.offset).toBeLessThanOrEqual(
          widest + CORRIDOR.vergeWidth + CORRIDOR.bankWidth + CORRIDOR.wallWidth,
        );
      }
    }
    expect(bumps).toBeGreaterThan(100);
  });

  it('does not pay for a backdrop no car can reach', () => {
    const stage = new Stage(stageById('grand-traverse'));
    for (const item of stage.scenery) {
      if (!item.solid) continue;
      // Widths vary along a stage, so this is the most generous corridor on it.
      const widest = Math.max(...stage.spline.samples.map((s) => s.width));
      const limit =
        widest + CORRIDOR.vergeWidth + CORRIDOR.bankWidth + CORRIDOR.wallWidth + SOLID_MARGIN;
      expect(item.offset).toBeLessThanOrEqual(limit);
    }
    // And most of the wood is still drawn, not just the part that is solid.
    const solid = stage.scenery.filter((i) => i.solid).length;
    expect(solid).toBeLessThan(stage.scenery.length / 2);
  });

  it('stops a car that drives into a tree', async () => {
    const stage = new Stage(stageById('pine-loop'));
    // One conifer planted on the road sixty metres out, and nothing else solid.
    const at = stage.spline.at(60);
    stage.props.length = 0;
    stage.scenery.length = 0;
    stage.scenery.push({
      kind: 'conifer',
      recipe: 0,
      position: { x: at.position.x, y: at.position.y, z: at.position.z },
      yaw: 0,
      size: 1,
      stretch: 1,
      mix: 0,
      pitch: 0,
      offset: 0,
      solid: {
        shape: 'cylinder',
        center: { x: at.position.x, y: at.position.y + 3.75, z: at.position.z },
        radius: 0.42,
        halfHeight: 3.75,
        halfDepth: 0.42,
        yaw: 0,
      },
    });

    const world = await createWorld({ stage, damage: true });
    for (let i = 0; i < 120 * 9; i++) world.step({ throttle: 1, brake: 0, steer: 0, handbrake: 0 });

    const damage = world.cars[0]!.damage!;
    // It is a tree, not a bollard: the car is hurt and it did not sail through.
    expect(damage.peakImpulse).toBeGreaterThan(3_000);
    expect(damage.condition).toBeLessThan(0.99);
    expect(world.state().position.z).toBeLessThan(at.position.z + 6);
  }, 40_000);
});
