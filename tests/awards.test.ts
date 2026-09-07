/**
 * What a run was worth, beyond the money.
 *
 * These are the moments a player replays a stage for, so what matters is that
 * they are announced when they happen, not announced when they did not, and
 * ordered so a celebration builds instead of shouting everything at once.
 */

import { describe, expect, it } from 'vitest';
import { awardsFor, boardAwards, sweepProgress } from '../src/game/awards.js';
import type { StageRecord } from '../src/game/save.js';

const keys = ['a:day', 'b:day', 'c:day'];
const rec = (time: number, medal: StageRecord['medal']): StageRecord => ({
  time,
  medal,
  setAt: 1,
});

const run = (before: Record<string, StageRecord>, after: Record<string, StageRecord>, key = 'a:day') =>
  awardsFor({ keys, before, after, key, name: 'Pine Loop · Day' });

describe('what gets celebrated', () => {
  it('marks the first finish of a career, once', () => {
    const first = run({}, { 'a:day': rec(60, 'bronze') });
    expect(first.some((a) => a.kind === 'first')).toBe(true);

    const second = run({ 'a:day': rec(60, 'bronze') }, {
      'a:day': rec(60, 'bronze'),
      'b:day': rec(70, 'finish'),
    }, 'b:day');
    expect(second.some((a) => a.kind === 'first')).toBe(false);
  });

  it('does not call a first time a record', () => {
    // Every time is a personal best the first time round, and saying so
    // cheapens the word for the run that actually beats something.
    const awards = run({}, { 'a:day': rec(60, 'bronze') });
    expect(awards.some((a) => a.kind === 'record')).toBe(false);
  });

  it('announces a personal best with what it beat', () => {
    const awards = run({ 'a:day': rec(60, 'bronze') }, { 'a:day': rec(58.4, 'bronze') });
    const record = awards.find((a) => a.kind === 'record');
    expect(record).toBeDefined();
    expect(record!.detail).toContain('1.60s faster');
  });

  it('announces a better medal, and only a better one', () => {
    const up = run({ 'a:day': rec(60, 'bronze') }, { 'a:day': rec(50, 'gold') });
    expect(up.find((a) => a.kind === 'medal')?.title).toBe('GOLD');

    // A quicker time that stays in the same tier is a record, not a medal.
    const same = run({ 'a:day': rec(52, 'gold') }, { 'a:day': rec(51, 'gold') });
    expect(same.some((a) => a.kind === 'medal')).toBe(false);
    expect(same.some((a) => a.kind === 'record')).toBe(true);
  });

  it('celebrates completing the set, and names the tier', () => {
    const before = { 'a:day': rec(60, 'bronze'), 'b:day': rec(60, 'bronze') };
    const after = { ...before, 'c:day': rec(60, 'bronze') };
    const sweep = run(before, after, 'c:day').find((a) => a.kind === 'sweep');
    expect(sweep?.title).toBe('ALL BRONZE');
    expect(sweep?.weight).toBe(3);
  });

  it('announces the highest sweep only', () => {
    // A run that completes the golds has necessarily completed the bronzes and
    // the silvers too, and being told all three is being told none of them.
    const before = {
      'a:day': rec(50, 'gold'),
      'b:day': rec(50, 'gold'),
      'c:day': rec(60, 'finish'),
    };
    const after = { ...before, 'c:day': rec(50, 'gold') };
    const sweeps = run(before, after, 'c:day').filter((a) => a.kind === 'sweep');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]!.title).toBe('ALL GOLD');
  });

  it('builds: the medal lands before the sweep it completed', () => {
    const before = { 'a:day': rec(60, 'bronze'), 'b:day': rec(60, 'bronze') };
    const after = { ...before, 'c:day': rec(60, 'bronze') };
    const awards = run(before, after, 'c:day');
    const medal = awards.findIndex((a) => a.kind === 'medal');
    const sweep = awards.findIndex((a) => a.kind === 'sweep');
    expect(medal).toBeGreaterThanOrEqual(0);
    expect(sweep).toBeGreaterThan(medal);
  });

  it('says nothing about a run that finished nothing', () => {
    expect(run({ 'a:day': rec(60, 'bronze') }, { 'a:day': rec(60, 'bronze') })).toEqual([]);
  });
});

describe('progress toward the next sweep', () => {
  it('counts a better medal toward every tier below it', () => {
    const records = { 'a:day': rec(50, 'gold'), 'b:day': rec(60, 'bronze') };
    const progress = sweepProgress(keys, records);
    const at = (medal: string) => progress.find((p) => p.medal === medal)!;
    expect(at('finish').have).toBe(2);
    expect(at('bronze').have).toBe(2);
    expect(at('silver').have).toBe(1);
    expect(at('gold').have).toBe(1);
    expect(at('author').have).toBe(0);
    expect(at('gold').of).toBe(3);
  });
});

describe('what an arcade or multiplayer run was worth', () => {
  const run = (over: Partial<Parameters<typeof boardAwards>[0]> = {}) =>
    boardAwards({ name: 'Pine Loop · Day', time: 41.02, ...over });

  it('says nothing about a run that beat nothing', () => {
    // Not every lap is an event. A game that celebrates all of them has stopped
    // celebrating any of them.
    expect(run()).toEqual([]);
    expect(run({ rank: null })).toEqual([]);
  });

  it('marks a personal best whether or not it went near the board', () => {
    // The whole reason personal times are kept: most players will never see the
    // top ten, and their own improvement still has to count for something.
    const awards = run({ beat: 44.5, rank: null });
    expect(awards).toHaveLength(1);
    expect(awards[0]!.kind).toBe('record');
    expect(awards[0]!.detail).toContain('3.48s faster');
    // Quiet. It happens most sessions, and shouting about it makes the shouting
    // worth nothing when something rare actually happens.
    expect(awards[0]!.weight).toBe(0);
  });

  it('reads a first time as a personal best rather than as nothing', () => {
    const awards = run({ beat: null });
    expect(awards[0]!.title).toBe('FIRST TIME SET');
  });

  it('builds to the biggest thing when a run earns more than one', () => {
    // Celebrations queue biggest last, so a personal best that also took the
    // top plays as two beats rising rather than two shouts at once.
    const awards = run({ beat: 44.5, rank: 0, dethroned: 'Ari' });
    expect(awards.map((a) => a.kind)).toEqual(['record', 'board']);
    expect(awards[0]!.weight).toBeLessThan(awards[1]!.weight);
  });

  it('is excessive only at the very top', () => {
    const first = run({ rank: 0 })[0]!;
    expect(first.title).toBe('FASTEST IN THE WORLD');
    expect(first.weight).toBe(3);

    // And everything else on the board is smaller than that.
    for (const rank of [1, 2, 3, 5, 9]) {
      expect(run({ rank })[0]!.weight, `rank ${rank}`).toBeLessThan(3);
    }
  });

  it('names the place rather than saying "top ten"', () => {
    // Third is not second. A board you are climbing is only worth climbing if
    // it tells you where you are on it.
    expect(run({ rank: 1 })[0]!.title).toBe('2ND IN THE WORLD');
    expect(run({ rank: 2 })[0]!.title).toBe('3RD IN THE WORLD');
    expect(run({ rank: 3 })[0]!.title).toBe('4TH IN THE WORLD');
    expect(run({ rank: 9 })[0]!.title).toBe('10TH IN THE WORLD');
    // The ordinal rule everybody gets wrong, kept honest even though a
    // ten-place board cannot currently reach it.
    expect(run({ rank: 10 })[0]!.title).toBe('11TH IN THE WORLD');
    expect(run({ rank: 12 })[0]!.title).toBe('13TH IN THE WORLD');
    expect(run({ rank: 20 })[0]!.title).toBe('21ST IN THE WORLD');
  });

  it('only claims a throne when one was actually taken', () => {
    expect(run({ rank: 0, dethroned: 'Ari' })[0]!.detail).toContain('taken it from Ari');
    // Beating your own record is holding the top, not taking it from somebody.
    expect(run({ rank: 0, dethroned: null })[0]!.detail).toContain('nobody has gone quicker');
  });
});
