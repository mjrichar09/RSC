/**
 * What a run was worth, beyond the money.
 *
 * These are the moments a player replays a stage for, so what matters is that
 * they are announced when they happen, not announced when they did not, and
 * ordered so a celebration builds instead of shouting everything at once.
 */

import { describe, expect, it } from 'vitest';
import { awardsFor, sweepProgress } from '../src/game/awards.js';
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
