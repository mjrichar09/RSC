/**
 * The crash cinematic replays what happened; it does not re-stage it.
 *
 * The old cinematic played a *ghost* — where the car was — and posed everything
 * else from the present. Two things gave that away immediately and both are
 * what this file pins down:
 *
 * - The car was already wrecked before it hit anything, because damage was read
 *   live rather than recorded.
 * - Whatever it hit was not there, because the simulation had moved on.
 *
 * Neither is testable through the renderer, and neither needs to be: both are
 * properties of what the reel *records*, which is plain data.
 */

import { describe, expect, it } from 'vitest';
import { CrashReel, RecordedDamage, RecordedDebris } from '../src/game/crashReel.js';
import { DamageModel } from '../src/sim/damage.js';
import { DebrisModel, PART_BY_ID } from '../src/sim/debris.js';
import type { VehicleState } from '../src/sim/vehicle.js';
import type { Animal } from '../src/sim/wildlife.js';

const transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };

const state = {
  wheels: [0, 1, 2, 3].map(() => ({
    rotation: 0,
    steer: 0,
    compression: 0.5,
    grounded: true,
  })),
} as unknown as VehicleState;

/** Feed the reel `seconds` of wall time at 60 fps. */
function run(
  reel: CrashReel,
  seconds: number,
  damage: DamageModel | null,
  debris: DebrisModel | null,
  animals: Animal[] = [],
) {
  for (let i = 0; i < seconds * 60; i++) {
    reel.capture(1 / 60, transform, state, damage, debris, animals);
  }
}

describe('the crash reel', () => {
  it('remembers the car as it was, not as it ended up', () => {
    // The whole complaint, in one assertion: the fold you are about to watch
    // arrive must not already be on the car on the way in.
    const reel = new CrashReel();
    const damage = new DamageModel({ seed: 1 });
    run(reel, 1.0, damage, null);

    // The crash.
    damage.applyImpact({ x: 0, y: 0, z: 1.9 }, 30_000);
    run(reel, 0.2, damage, null);

    const strip = reel.take(1.25)!;
    expect(strip).not.toBeNull();
    const view = new RecordedDamage(strip.at(0));

    // At the start of the strip the car is whole.
    expect(view.at(strip.at(0)).get('lights')).toBe(1);
    expect(view.at(strip.at(0)).dents).toHaveLength(0);
    // At the end it is not.
    expect(view.at(strip.at(strip.duration)).get('lights')).toBeLessThan(1);
    expect(view.at(strip.at(strip.duration)).dents.length).toBeGreaterThan(0);
  });

  it('copies the dents rather than holding the live list', () => {
    // The live list is mutated in place as folds merge, so a reference would
    // give every recorded frame the *final* set — the same bug one level down.
    const reel = new CrashReel();
    const damage = new DamageModel({ seed: 1 });
    damage.applyImpact({ x: 0, y: 0, z: 1.9 }, 20_000);
    run(reel, 0.5, damage, null);
    const strip = reel.take(1.25)!;
    const early = strip.at(0).dents.map((d) => d.depth);

    damage.applyImpact({ x: 0, y: 0, z: 1.9 }, 40_000);
    expect(strip.at(0).dents.map((d) => d.depth)).toEqual(early);
  });

  it('keeps the animals that were standing there', () => {
    const reel = new CrashReel();
    const deer = {
      distance: 100,
      side: 1,
      state: 'bolting',
      position: { x: 3, y: 0, z: 40 },
      yaw: 1,
      crossed: 0.5,
    } as Animal;
    run(reel, 0.5, null, null, [deer]);

    const strip = reel.take(1.25)!;
    const seen = strip.at(0).animals;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.position.x).toBe(3);
    expect(seen[0]!.gone).toBe(false);

    // And once it is hit, the recorded frames before that still have it.
    deer.state = 'gone';
    expect(strip.at(0).animals[0]!.gone).toBe(false);
  });

  it('never grows past its window', () => {
    const reel = new CrashReel();
    run(reel, 30, null, null);
    const strip = reel.take(1.25)!;
    // A second and a quarter of a strip, not thirty seconds of one.
    expect(strip.duration).toBeGreaterThan(1);
    expect(strip.duration).toBeLessThan(1.5);
  });

  it('has nothing to show before a race has run', () => {
    expect(new CrashReel().take(1.25)).toBeNull();
  });

  it('forgets everything on a restart', () => {
    const reel = new CrashReel();
    run(reel, 3, null, null);
    reel.reset();
    expect(reel.take(1.25)).toBeNull();
  });

  it('reports parts as they were attached at the time', () => {
    const reel = new CrashReel();
    const debris = new DebrisModel({ seed: 1 });
    run(reel, 1.0, null, debris);
    debris.detach(PART_BY_ID.get('bumperFront')!);
    run(reel, 0.2, null, debris);

    const strip = reel.take(1.25)!;
    const view = new RecordedDebris(strip.at(0));
    expect(view.at(strip.at(0)).stateOf('bumperFront')).toBe('attached');
    expect(view.at(strip.at(strip.duration)).stateOf('bumperFront')).toBe('gone');
  });
});
