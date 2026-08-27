/**
 * Persistence rules.
 *
 * Run in Node, where there is no IndexedDB, so these exercise the in-memory
 * fallback — which is deliberately the same code path players hit in private
 * browsing or with site data blocked. Persistence failing should cost history,
 * never the session.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { STARTING_MONEY, SaveStore, emptyProfile } from '../src/game/save.js';
import { GHOST_STRIDE, type Ghost } from '../src/sim/replay.js';

const ghostOf = (time: number): Ghost => ({
  stageId: 'pine-loop',
  time,
  recordedAt: Date.now(),
  frames: new Float32Array(GHOST_STRIDE * 4),
});

let save: SaveStore;

beforeEach(async () => {
  save = new SaveStore();
  await save.open();
});

describe('SaveStore', () => {
  it('degrades to memory when IndexedDB is unavailable, without throwing', () => {
    expect(save.persistent).toBe(false);
    expect(save.getProfile()).toEqual(emptyProfile());
  });

  it('has no record for an unraced stage', () => {
    expect(save.recordFor('pine-loop')).toBeNull();
  });

  it('stores a first run', async () => {
    expect(await save.submitRun('pine-loop', 60, 'silver', ghostOf(60))).toBe(true);
    expect(save.recordFor('pine-loop')?.time).toBe(60);
    expect(save.recordFor('pine-loop')?.medal).toBe('silver');
  });

  it('keeps the faster run and rejects a slower one', async () => {
    await save.submitRun('pine-loop', 60, 'silver', ghostOf(60));

    expect(await save.submitRun('pine-loop', 65, 'bronze', ghostOf(65))).toBe(false);
    expect(save.recordFor('pine-loop')?.time).toBe(60);

    expect(await save.submitRun('pine-loop', 55, 'gold', ghostOf(55))).toBe(true);
    expect(save.recordFor('pine-loop')?.time).toBe(55);
    expect(save.recordFor('pine-loop')?.medal).toBe('gold');
  });

  it('rejects a run that merely ties, so the stored ghost is never churned', async () => {
    await save.submitRun('pine-loop', 60, 'silver', ghostOf(60));
    expect(await save.submitRun('pine-loop', 60, 'silver', ghostOf(60))).toBe(false);
  });

  it('keeps a separate record and ghost per stage', async () => {
    await save.submitRun('pine-loop', 60, 'silver', ghostOf(60));
    await save.submitRun('quarry-run', 40, 'gold', ghostOf(40));

    expect(save.recordFor('pine-loop')?.time).toBe(60);
    expect(save.recordFor('quarry-run')?.time).toBe(40);
    expect((await save.loadGhost('quarry-run'))?.time).toBe(40);
    expect(await save.loadGhost('north-pass')).toBeNull();
  });

  it('returns the ghost belonging to the stored best', async () => {
    await save.submitRun('pine-loop', 60, 'silver', ghostOf(60));
    await save.submitRun('pine-loop', 55, 'gold', ghostOf(55));
    expect((await save.loadGhost('pine-loop'))?.time).toBe(55);
  });

  it('clears everything', async () => {
    await save.submitRun('pine-loop', 60, 'silver', ghostOf(60));
    await save.clear();
    expect(save.recordFor('pine-loop')).toBeNull();
    expect(await save.loadGhost('pine-loop')).toBeNull();
  });

  it('starts a new profile with money, no upgrades and an undamaged car', () => {
    const profile = save.getProfile();
    expect(profile.money).toBe(STARTING_MONEY);
    expect(profile.upgrades).toEqual({});
    expect(profile.carHealth).toEqual({});
    expect(profile.version).toBeGreaterThan(0);
  });
});
