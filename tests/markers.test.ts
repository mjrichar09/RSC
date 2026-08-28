/**
 * Roadside marker poles.
 *
 * They were painted scenery — an instanced box the car drove straight through —
 * and a thing that stands at the edge of the road and cannot be touched teaches
 * the player that the edge of the road is not there.
 *
 * The properties worth protecting: they mark the road (both sides, outside the
 * driveable width), clipping one costs something, and what it costs stays
 * small. A marker that could end a run would make the sensible line a metre
 * inside the road edge, which is the opposite of the point.
 */

import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/data/stages/index.js';
import { Stage } from '../src/sim/stage.js';
import { Markers } from '../src/sim/markers.js';
import { createWorld } from '../src/sim/world.js';
import { v3 } from '../src/sim/math.js';
import { DamageModel } from '../src/sim/damage.js';

const UPRIGHT = { x: 0, y: 0, z: 0, w: 1 };
const stage = new Stage(STAGES[0]!);
const build = () => new Markers(stage.spline, stage.length);

describe('where they stand', () => {
  it('lines both verges the length of the stage', () => {
    const markers = build();
    expect(markers.all.length).toBeGreaterThan(stage.length / 20);
    expect(markers.all.some((m) => m.side === -1)).toBe(true);
    expect(markers.all.some((m) => m.side === 1)).toBe(true);
    expect(Math.max(...markers.all.map((m) => m.distance))).toBeLessThan(stage.length);
  });

  it('stands them clear of the road rather than on it', () => {
    for (const marker of build().all) {
      const here = stage.progressAt(marker.position);
      expect(here.onRoad).toBe(false);
      // Just outside, not out in the scenery: they have to read as the edge.
      expect(Math.abs(here.lateral) - stage.spline.at(marker.distance).width).toBeLessThan(1.5);
    }
  });
});

describe('clipping one', () => {
  it('knocks it over and charges for it', () => {
    const markers = build();
    const target = markers.all[4]!;
    const hit = markers.strike(target.distance, target.position, v3(0, 0, 25), UPRIGHT);

    expect(hit).not.toBeNull();
    expect(target.fallen).toBeGreaterThan(0);
    expect(hit!.impulse).toBeGreaterThan(1200);
    // Nothing here may end a run: the cheapest component that can fail outright
    // needs far more than this.
    expect(hit!.impulse).toBeLessThan(4000);
  });

  it('costs more the faster you are going', () => {
    const slow = build();
    const fast = build();
    const at = slow.all[4]!;
    const a = slow.strike(at.distance, at.position, v3(0, 0, 4), UPRIGHT)!;
    const b = fast.strike(at.distance, at.position, v3(0, 0, 40), UPRIGHT)!;
    expect(b.impulse).toBeGreaterThan(a.impulse * 1.5);
  });

  it('lands the hit on the side of the car it came down', () => {
    const markers = build();
    const target = markers.all[5]!;
    // A pole a metre to one side of the car's centre.
    const beside = { x: target.position.x + 0.8, y: 0, z: target.position.z };
    const hit = markers.strike(target.distance, beside, v3(0, 0, 20), UPRIGHT);
    expect(hit).not.toBeNull();
    expect(Math.sign(hit!.at.x)).toBe(-1);
  });

  it('only knocks a pole over once', () => {
    const markers = build();
    const target = markers.all[4]!;
    expect(markers.strike(target.distance, target.position, v3(0, 0, 25), UPRIGHT)).not.toBeNull();
    expect(markers.strike(target.distance, target.position, v3(0, 0, 25), UPRIGHT)).toBeNull();
    expect(markers.flattened).toBe(1);
  });

  it('ignores everything the car is nowhere near', () => {
    const markers = build();
    const far = markers.all[markers.all.length - 1]!;
    // Right on top of it in space, but reported as being elsewhere on the road:
    // the search window is what keeps this off the per-step budget.
    expect(markers.strike(0, far.position, v3(0, 0, 25), UPRIGHT)).toBeNull();
    expect(markers.flattened).toBe(0);
  });

  it('goes over in the direction it was hit, and lies down in a third of a second', () => {
    const markers = build();
    const target = markers.all[4]!;
    markers.strike(target.distance, target.position, v3(20, 0, 0), UPRIGHT);
    expect(target.knockedToward).toBeCloseTo(Math.PI / 2, 3);

    for (let i = 0; i < 40; i++) markers.update(1 / 120);
    expect(target.fallen).toBe(1);
  });

  it('stands them all back up for the next attempt', () => {
    const markers = build();
    const target = markers.all[4]!;
    markers.strike(target.distance, target.position, v3(0, 0, 25), UPRIGHT);
    markers.reset();
    expect(markers.flattened).toBe(0);
  });
});

describe('in a world', () => {
  it('dents the car without meaningfully damaging it', async () => {
    const world = await createWorld({ stage, damage: true });
    const target = world.markers!.all[6]!;

    // Line the car up a dozen metres short of a pole and drive at it.
    world.vehicle.reset({ x: target.position.x, y: 1.4, z: target.position.z - 14 }, 0);
    // `lastImpact` is the peak of the step just taken, so it has to be watched
    // rather than read at the end — by then the thump is long over.
    let heard = 0;
    for (let i = 0; i < 120 * 6; i++) {
      world.step({ throttle: 0.55, brake: 0, steer: 0, handbrake: 0 });
      heard = Math.max(heard, world.lastImpact);
    }

    expect(world.markers!.flattened).toBeGreaterThan(0);
    // A mark on the bodywork you can see, and a thump you can hear.
    expect(world.damage!.dents.length).toBeGreaterThan(0);
    expect(heard).toBeGreaterThan(1200);
    expect(world.damage!.failures.size).toBe(0);
  });

  it('costs almost nothing on its own', async () => {
    // Measured through the damage model rather than through a drive, because a
    // car positioned to clip a pole is also a car with two wheels on the verge,
    // and what the verge costs is not what the pole costs.
    const markers = build();
    const target = markers.all[4]!;
    const hit = markers.strike(target.distance, target.position, v3(0, 0, 33), UPRIGHT)!;

    const damage = new DamageModel();
    damage.applyImpact(hit.at, hit.impulse);
    expect(damage.dents).toHaveLength(1);
    expect(damage.condition).toBeGreaterThan(0.995);
    expect(damage.repairBill().total).toBeLessThan(120);
  });
});
