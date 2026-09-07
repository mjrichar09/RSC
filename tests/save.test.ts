/**
 * Persistence rules.
 *
 * Run in Node, where there is no IndexedDB, so these exercise the in-memory
 * fallback — which is deliberately the same code path players hit in private
 * browsing or with site data blocked. Persistence failing should cost history,
 * never the session.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { STARTING_MONEY, SaveStore, emptyProfile, migrateProfile } from '../src/game/save.js';
import { GHOST_STRIDE, type Ghost } from '../src/sim/replay.js';
import { DEFAULT_LIVERY } from '../src/data/liveries.js';

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

describe('profile migration', () => {
  it('accepts a current profile unchanged', () => {
    const current = { ...emptyProfile(), money: 4200, upgrades: { engine: 2 } };
    const out = migrateProfile(current);
    expect(out.money).toBe(4200);
    expect(out.upgrades).toEqual({ engine: 2 });
  });

  it('brings a v1 profile forward, giving it a real starting balance', () => {
    const v1 = { version: 1, records: { 'pine-loop': { time: 50, medal: 'gold', setAt: 0 } }, money: 0, upgrades: {} };
    const out = migrateProfile(v1);
    expect(out.version).toBeGreaterThanOrEqual(2);
    expect(out.money).toBe(STARTING_MONEY);
    // v3 keys records by stage *and* conditions, so an old bare stage key
    // becomes that stage in clear daylight — the conditions it was set under.
    expect(out.records['pine-loop:day-clear']?.time).toBe(50);
    expect(out.records['pine-loop']).toBeUndefined();
    expect(out.carHealth).toEqual({});
    expect(out.totals.earned).toBe(0);
  });

  it('re-keys v2 records to the clear-daylight variant without losing any', () => {
    // Losing a record to a migration is losing the player's whole history with
    // a stage, so this checks the medal and ghost key survive, not just a time.
    const v2 = {
      version: 2,
      money: 3000,
      records: {
        'pine-loop': { time: 50, medal: 'gold', setAt: 7 },
        'quarry-run': { time: 91.5, medal: 'silver', setAt: 8 },
      },
    };
    const out = migrateProfile(v2);
    expect(Object.keys(out.records).sort()).toEqual(['pine-loop:day-clear', 'quarry-run:day-clear']);
    expect(out.records['pine-loop:day-clear']).toEqual({ time: 50, medal: 'gold', setAt: 7 });
    expect(out.records['quarry-run:day-clear']?.medal).toBe('silver');
  });

  it('leaves records that are already variant-keyed alone', () => {
    const out = migrateProfile({
      version: 2,
      records: { 'pine-loop:night-rain': { time: 70, medal: 'bronze', setAt: 1 } },
    });
    expect(out.records['pine-loop:night-rain']?.time).toBe(70);
    expect(out.records['pine-loop:night-rain:day-clear']).toBeUndefined();
  });

  it('keeps a v1 profile that already had money', () => {
    expect(migrateProfile({ version: 1, money: 9000 }).money).toBe(9000);
  });

  it('survives a profile that is damaged rather than merely old', () => {
    // A save that bricks the game on load is worse than a lost one, because
    // there is no way past it.
    for (const junk of [null, undefined, 42, 'nonsense', [], { version: 'x' }]) {
      const out = migrateProfile(junk);
      expect(typeof out.money).toBe('number');
      expect(out.upgrades).toBeTypeOf('object');
      expect(out.carHealth).toBeTypeOf('object');
    }
  });

  it('replaces nulls where objects belong', () => {
    // The spread that used to do this left `upgrades: null` intact, and the
    // first purchase then threw.
    const out = migrateProfile({ version: 2, upgrades: null, carHealth: null, records: null, totals: null });
    expect(out.upgrades).toEqual({});
    expect(out.carHealth).toEqual({});
    expect(out.records).toEqual({});
    expect(out.totals.earned).toBe(0);
  });

  it('rejects impossible money and clamps impossible damage', () => {
    expect(migrateProfile({ version: 2, money: -500 }).money).toBe(0);
    expect(migrateProfile({ version: 2, money: Number.NaN }).money).toBe(STARTING_MONEY);

    const out = migrateProfile({
      version: 2,
      carHealth: { engine: 5, cooling: -3, turbo: Number.NaN, tyreFL: 0.4 },
    });
    expect(out.carHealth.engine).toBe(1);
    expect(out.carHealth.cooling).toBe(0);
    expect(out.carHealth.turbo).toBeUndefined();
    expect(out.carHealth.tyreFL).toBe(0.4);
  });
});


describe('carried dents', () => {
  it('keeps the shape of the damage, not only its price', () => {
    const profile = migrateProfile({
      version: 5,
      carDents: [{ at: { x: 0, y: 0, z: 1.9 }, depth: 0.6, reach: 1.1 }],
    });
    expect(profile.carDents).toHaveLength(1);
    expect(profile.carDents[0]!.depth).toBe(0.6);
  });

  it('gives an older profile a car that is broken but straight', () => {
    // Inventing folds for damage nobody saw happen would be worse than a car
    // that reads as slightly too tidy for its repair bill.
    expect(migrateProfile({ version: 4, carHealth: { engine: 0.3 } }).carDents).toEqual([]);
  });

  it('throws out anything that would deform the car into nonsense', () => {
    const profile = migrateProfile({
      version: 5,
      carDents: [
        { at: { x: 0, y: 0, z: 1.9 }, depth: 4, reach: 90 },
        { at: { x: 0, y: 0 }, depth: 0.5, reach: 1 },
        { at: { x: NaN, y: 0, z: 0 }, depth: 0.5, reach: 1 },
        'not a dent',
      ],
    });
    expect(profile.carDents).toHaveLength(1);
    expect(profile.carDents[0]!.depth).toBe(1);
    // Clamped to the widest fold the damage model can produce. A structural
    // impact spreads the crumple across the car rather than pressing a deeper
    // hole in one place, so the cap is 3.4 m rather than the 2 m it was when
    // every dent was local.
    expect(profile.carDents[0]!.reach).toBe(3.4);
  });
});


describe('paint and number', () => {
  it('gives a new profile the works orange and a number', () => {
    const profile = migrateProfile({});
    expect(profile.livery).toBe(DEFAULT_LIVERY.id);
    expect(profile.raceNumber).toBeGreaterThan(0);
  });

  it('keeps a livery it recognises and refuses one it does not', () => {
    expect(migrateProfile({ version: 6, livery: 'rally-blue' }).livery).toBe('rally-blue');
    // An id from a future version, or a corrupted one, falls back to the paint
    // the car has worn since the first commit rather than to no paint at all.
    expect(migrateProfile({ version: 6, livery: 'chrome-lightning' }).livery).toBe(
      DEFAULT_LIVERY.id,
    );
  });

  it('keeps the number to something that fits on a roof', () => {
    expect(migrateProfile({ version: 6, raceNumber: 1200 }).raceNumber).toBe(99);
    expect(migrateProfile({ version: 6, raceNumber: 0 }).raceNumber).toBe(1);
    expect(migrateProfile({ version: 6, raceNumber: 'seven' }).raceNumber).toBeGreaterThan(0);
  });
});

describe('the two-level upgrade cap', () => {
  it('clamps a car bought under the old four-level ladder', () => {
    // The cap has to be true of the *car*, not only of the shop. `maxLevel`
    // reads the costs array so the garage stops offering a third level on its
    // own, but `tuneFor` scales straight off the stored number — so without
    // this a returning player keeps the +36% engine they bought when it
    // existed, and every medal time is measured against a car nobody else can
    // buy any more.
    const old = { ...emptyProfile(), version: 6, upgrades: { engine: 4, turbo: 3, brakes: 1 } };
    const out = migrateProfile(old);

    expect(out.upgrades.engine).toBe(2);
    expect(out.upgrades.turbo).toBe(2);
    // Untouched where it was already inside the cap.
    expect(out.upgrades.brakes).toBe(1);
  });

  it('does not refund the difference', () => {
    // The money bought a car that was faster for as long as those levels
    // existed. Paying it back would hand every existing save a windfall the
    // balance was never built for.
    const old = { ...emptyProfile(), version: 6, money: 500, upgrades: { engine: 4 } };
    expect(migrateProfile(old).money).toBe(500);
  });

  it('drops an upgrade level that is not a number at all', () => {
    const damaged = {
      ...emptyProfile(),
      version: 6,
      upgrades: { engine: 'lots', turbo: Number.NaN, brakes: 0, tyres: -3 },
    };
    const out = migrateProfile(damaged as never).upgrades as Record<string, number>;

    expect(out.engine).toBeUndefined();
    expect(out.turbo).toBeUndefined();
    // Zero and negative are "not fitted", which is the absence of a key.
    expect(out.brakes).toBeUndefined();
    expect(out.tyres).toBeUndefined();
  });
});

describe('the driver name', () => {
  it('starts empty, so arcade has to ask', () => {
    expect(emptyProfile().driverName).toBe('');
    expect(migrateProfile({ ...emptyProfile(), version: 6 }).driverName).toBe('');
  });

  it('survives a reload, and is kept to a length that fits', () => {
    expect(migrateProfile({ ...emptyProfile(), driverName: '  Ari  ' }).driverName).toBe('Ari');
    expect(migrateProfile({ ...emptyProfile(), driverName: 'x'.repeat(50) }).driverName).toHaveLength(16);
    expect(migrateProfile({ ...emptyProfile(), driverName: 42 } as never).driverName).toBe('');
  });
});

describe('arcade personal bests', () => {
  it('keeps a table of its own, separate from career records', async () => {
    // They cannot share one. A career time is set in whatever the garage has
    // built and an arcade time in a stock car, so the same number means two
    // different drives — and career records are what the medal tables are read
    // against, so a stock-car time landing in them would rewrite what a gold is.
    await save.submitArcadeRun('pine-loop:day-clear', 44.0);
    expect(save.arcadeRecordFor('pine-loop:day-clear')?.time).toBe(44.0);
    expect(save.recordFor('pine-loop:day-clear')).toBeNull();
  });

  it('reports the time it beat, and nothing when it beat nothing', async () => {
    // A first time is a personal best and has to read as one.
    expect(await save.submitArcadeRun('pine-loop:day-clear', 44.0)).toEqual({ beat: null });
    expect(await save.submitArcadeRun('pine-loop:day-clear', 41.5)).toEqual({ beat: 44.0 });
    // Slower changes nothing and says so.
    expect(await save.submitArcadeRun('pine-loop:day-clear', 43.0)).toBeNull();
    expect(save.arcadeRecordFor('pine-loop:day-clear')?.time).toBe(41.5);
    // And an exact tie is not an improvement.
    expect(await save.submitArcadeRun('pine-loop:day-clear', 41.5)).toBeNull();
  });

  it('drops a record that could never be beaten', () => {
    // A NaN wins every comparison it appears in and would stand as an
    // unbeatable personal best forever.
    const damaged = {
      ...emptyProfile(),
      version: 7,
      arcadeRecords: {
        good: { time: 40, at: 1 },
        nan: { time: Number.NaN, at: 1 },
        text: { time: '40', at: 1 },
        negative: { time: -3, at: 1 },
      },
    };
    const out = migrateProfile(damaged as never).arcadeRecords;

    expect(out.good?.time).toBe(40);
    expect(out.nan).toBeUndefined();
    expect(out.text).toBeUndefined();
    expect(out.negative).toBeUndefined();
  });

  it('starts empty for a profile that predates it', () => {
    expect(migrateProfile({ ...emptyProfile(), version: 7 }).arcadeRecords).toEqual({});
  });
});
