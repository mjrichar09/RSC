/**
 * Ghost recording and playback.
 *
 * Ghosts are recorded from a real AI run rather than from synthetic data, so
 * these check the thing that actually ships: that a recorded run plays back on
 * the road it was driven on, and that a delta can be read off it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { STAGES } from '../src/data/stages/index.js';
import { GHOST_STRIDE, GhostPlayer, type Ghost } from '../src/sim/replay.js';
import { runStage } from '../src/sim/runStage.js';
import { Stage } from '../src/sim/stage.js';

const stage = new Stage(STAGES[0]!);
let ghost: Ghost;
let player: GhostPlayer;

beforeAll(async () => {
  const result = await runStage(stage, { recordGhost: true });
  expect(result.ghost).not.toBeNull();
  ghost = result.ghost!;
  player = new GhostPlayer(ghost);
}, 30_000);

describe('recording', () => {
  it('records a whole frame for every sample', () => {
    expect(ghost.frames.length % GHOST_STRIDE).toBe(0);
    expect(ghost.frames.length / GHOST_STRIDE).toBeGreaterThan(100);
    for (const v of ghost.frames) expect(Number.isFinite(v)).toBe(true);
  });

  it('covers the run it recorded', () => {
    expect(ghost.time).toBeGreaterThan(10);
    // The last frame lands within one sample interval of the finish.
    expect(player.duration).toBeGreaterThan(ghost.time - 0.2);
    expect(player.duration).toBeLessThanOrEqual(ghost.time + 0.05);
  });

  it('stays small enough to persist comfortably', () => {
    // Float32 per value: a minute of racing should cost a couple of hundred KB,
    // not megabytes.
    expect(ghost.frames.byteLength).toBeLessThan(400_000);
  });
});

describe('playback', () => {
  it('plays back on the road it was driven on', () => {
    for (let t = 1; t < player.duration; t += 2) {
      const sample = player.sampleAt(t)!;
      const here = stage.progressAt(sample.position);
      // Generous: the AI does use the verge. The point is that playback lands
      // on the stage rather than drifting off into space.
      expect(Math.abs(here.lateral)).toBeLessThan(14);
    }
  });

  it('is continuous — no jumps between adjacent samples', () => {
    let previous = player.sampleAt(0)!.position;
    for (let t = 0.05; t < player.duration; t += 0.05) {
      const p = player.sampleAt(t)!.position;
      const step = Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z);
      // 0.05 s of travel: even at 200 km/h that is under 3 m.
      expect(step).toBeLessThan(4);
      previous = p;
    }
  });

  it('returns unit quaternions', () => {
    for (let t = 0; t < player.duration; t += 3) {
      const r = player.sampleAt(t)!.rotation;
      expect(Math.hypot(r.x, r.y, r.z, r.w)).toBeCloseTo(1, 4);
    }
  });

  it('clamps outside the recorded run instead of returning nothing', () => {
    expect(player.sampleAt(-5)).not.toBeNull();
    expect(player.sampleAt(player.duration + 100)).not.toBeNull();
  });
});

describe('deltas', () => {
  it('reports when the ghost reached a given distance, monotonically', () => {
    let previous = -Infinity;
    for (let d = 0; d < stage.length; d += 25) {
      const t = player.timeAtDistance(d)!;
      expect(t).toBeGreaterThanOrEqual(previous);
      previous = t;
    }
  });

  it('reaches the finish line at the finish time', () => {
    const t = player.timeAtDistance(stage.length)!;
    expect(t).toBeCloseTo(ghost.time, 0);
  });

  it('clamps distances beyond either end of the run', () => {
    expect(player.timeAtDistance(-100)).toBeGreaterThanOrEqual(0);
    expect(player.timeAtDistance(stage.length * 4)).toBeCloseTo(player.duration, 1);
  });

  it('gives a zero delta against itself', () => {
    // Replaying a run against its own ghost must show no time gained or lost
    // anywhere — the property the live delta depends on. Both sides use the
    // recorded distance, which is the same monotonic value the race feeds in
    // during play; an instantaneous position lookup is a different measure and
    // would not be a fair comparison.
    const frames = ghost.frames.length / GHOST_STRIDE;
    let checked = 0;
    for (let i = 1; i < frames; i++) {
      const time = ghost.frames[i * GHOST_STRIDE]!;
      const distance = ghost.frames[i * GHOST_STRIDE + 13]!;
      const previous = ghost.frames[(i - 1) * GHOST_STRIDE + 13]!;

      // Skip frames where the distance did not advance — sitting on the start
      // line, or a moment spent stationary. There the answer is genuinely
      // ambiguous, and returning the earliest time the ghost got that far is
      // the behaviour a delta wants.
      if (distance - previous < 0.05) continue;

      // Not exactly zero: distance plateaus whenever the car runs wide, and the
      // lookup deliberately reports when the ghost *first* reached a point. A
      // few sample intervals of slack is inherent; a broken lookup would be out
      // by seconds, which this still catches.
      expect(Math.abs(player.timeAtDistance(distance)! - time)).toBeLessThan(0.15);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('interpolates between recorded frames rather than snapping to them', () => {
    const a = ghost.frames[10 * GHOST_STRIDE + 13]!;
    const b = ghost.frames[11 * GHOST_STRIDE + 13]!;
    if (b > a) {
      const mid = player.timeAtDistance((a + b) / 2)!;
      expect(mid).toBeGreaterThan(ghost.frames[10 * GHOST_STRIDE]!);
      expect(mid).toBeLessThan(ghost.frames[11 * GHOST_STRIDE]!);
    }
  });
});
