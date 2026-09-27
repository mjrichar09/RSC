/**
 * The co-driver's notes: wording and timing, without a browser.
 */

import { describe, expect, it } from 'vitest';
import { buildPacenotes, dueCall, sayDistance } from '../src/game/pacenotes.js';
import type { Corner } from '../src/sim/corners.js';
import { Stage } from '../src/sim/stage.js';
import { stageById } from '../src/data/stages/index.js';

const corner = (entry: number, exit: number, direction: 'left' | 'right', severity: number, turnDegrees = 60): Corner => ({
  entry,
  apex: (entry + exit) / 2,
  exit,
  direction,
  radius: 40,
  severity,
  turnDegrees,
  toNext: null,
});

describe('what the co-driver says', () => {
  it('calls a corner by side and severity, and a hairpin by name', () => {
    const calls = buildPacenotes([corner(100, 130, 'left', 4), corner(400, 420, 'right', 1)]);
    expect(calls[0]!.text).toBe('left four, two fifty');
    expect(calls[1]!.text).toBe('hairpin right');
  });

  it('runs corners that follow closely into one call', () => {
    const calls = buildPacenotes([corner(100, 130, 'left', 4), corner(150, 170, 'right', 2)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe('left four into right two');
  });

  it('says long for a corner that turns more than a right angle', () => {
    expect(buildPacenotes([corner(100, 160, 'right', 3, 130)])[0]!.text).toBe('right three long');
  });

  it("warns not to cut a corner with sand on the inside, and about water", () => {
    const spill = { from: 110, to: 125, side: -1 as const, reach: 0.5 };
    const water = { from: 100, to: 140, side: 1 as const, reach: 0.5 };
    expect(buildPacenotes([corner(100, 130, 'left', 3)], { spills: [spill] })[0]!.text).toBe(
      "left three, don't cut",
    );
    expect(buildPacenotes([corner(100, 130, 'left', 3)], { water: [water] })[0]!.text).toBe(
      'left three, water',
    );
  });

  it('rounds distances the way a co-driver does', () => {
    expect(sayDistance(80)).toBeNull();
    expect(sayDistance(140)).toBe('one fifty');
    expect(sayDistance(210)).toBe('two hundred');
    expect(sayDistance(2000)).toBe('five hundred');
  });

  it('has a call for every corner on a real stage, in order', () => {
    const stage = new Stage(stageById('coldwater-pass'));
    const calls = buildPacenotes(stage.corners, { spills: stage.spills, water: stage.def.water });
    expect(calls.length).toBeGreaterThan(5);
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.at).toBeGreaterThan(calls[i - 1]!.at);
    // Coldwater has sand on the inside of corners, so somewhere it says so.
    expect(calls.some((c) => c.text.includes("don't cut"))).toBe(true);
  });
});

describe('when the co-driver says it', () => {
  const calls = [{ at: 300, text: 'left four' }];

  it('calls about four seconds out at speed', () => {
    // 30 m/s: due at 120 m out.
    expect(dueCall(calls, 0, 170, 30)).toBeNull();
    expect(dueCall(calls, 0, 185, 30)).toBe(0);
  });

  it('never leaves it later than 35 m, however slow the car', () => {
    expect(dueCall(calls, 0, 260, 2)).toBeNull();
    expect(dueCall(calls, 0, 266, 2)).toBe(0);
  });

  it('has nothing to say once every call is made', () => {
    expect(dueCall(calls, 1, 299, 30)).toBeNull();
  });
});
