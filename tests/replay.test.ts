/**
 * Ghost recording and playback.
 *
 * Ghosts are recorded from a real AI run rather than from synthetic data, so
 * these check the thing that actually ships: that a recorded run plays back on
 * the road it was driven on, and that a delta can be read off it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { STAGES } from '../src/data/stages/index.js';
import { GHOST_STRIDE, GhostPlayer, GhostRecorder, type Ghost } from '../src/sim/replay.js';
import { runStage } from '../src/sim/runStage.js';
import { Stage } from '../src/sim/stage.js';
import { stageById } from '../src/data/stages/index.js';
import { createWorld } from '../src/sim/world.js';
import { Driver } from '../src/sim/driver.js';
import { Race } from '../src/game/race.js';
import { NEUTRAL_INPUT } from '../src/sim/input.js';
import type { VehicleState } from '../src/sim/vehicle.js';

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


/** A car sitting still, for feeding the recorder without a simulation. */
function stillCar(): VehicleState {
  const wheel = {
    grounded: true,
    compression: 0.5,
    load: 3000,
    saturation: 0,
    slipAngle: 0,
    slipRatio: 0,
    spin: 0,
    rotation: 0,
    steer: 0,
    surface: { id: 'tarmac' },
    contact: { x: 0, y: 0, z: 0 },
  };
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 0 },
    speed: 0,
    rpm: 1000,
    gear: 1,
    engineLoad: 0,
    shifting: false,
    driftAngle: 0,
    wheels: [wheel, wheel, wheel, wheel],
  } as unknown as VehicleState;
}

describe('a ghost of your own lap', () => {
  it('sits exactly on top of the lap it recorded', async () => {
    // The bug this protects against: the player assumed frame `i` happened at
    // `i / recordHz`, while the recorder fires on the first fixed step past
    // each interval — so every lookup returned a frame from slightly further
    // into the run, the error grew through the lap, and the ghost appeared to
    // get a head start off the line. Driving the identical lap again is the
    // only test that catches it, because every part of it is individually fine.
    const stage = new Stage(stageById('pine-loop'));
    const lap = await runStage(stage, { recordGhost: true });
    expect(lap.ghost).not.toBeNull();
    const ghost = new GhostPlayer(lap.ghost!);

    const world = await createWorld({ stage });
    const driver = new Driver(stage);
    const race = new Race(stage);
    for (let i = 0; i < 60; i++) world.step(NEUTRAL_INPUT);
    world.time = 0;

    let worst = 0;
    while (world.time < 20 && race.phase !== 'finished') {
      world.step(driver.input(world.state(), world.dt));
      race.update(world.state(), world.dt);
      if (race.phase !== 'running') continue;
      const sample = ghost.sampleAt(race.time);
      if (!sample) continue;
      const here = world.state().position;
      worst = Math.max(worst, Math.hypot(sample.position.x - here.x, sample.position.z - here.z));
    }
    // Within a centimetre for twenty seconds. It used to be four metres.
    expect(worst).toBeLessThan(0.01);
  }, 60_000);

  it('records on a fixed schedule rather than drifting off it', () => {
    // Setting the next capture from the moment this one landed carries the
    // overshoot forward, and a recording made that way slides later and later
    // away from the clock it is supposed to share with the player.
    const recorder = new GhostRecorder();
    const state = stillCar();
    for (let step = 0; step < 1200; step++) {
      recorder.capture(step / 120, step * 0.1, state);
    }
    const ghost = recorder.finish('test', 10);
    const times: number[] = [];
    for (let i = 0; i < ghost.frames.length / GHOST_STRIDE; i++) {
      times.push(ghost.frames[i * GHOST_STRIDE]!);
    }
    const last = times[times.length - 1]!;
    // Sixty a second for ten seconds, and the last frame still lands where the
    // clock says it should rather than a fifth of a second late.
    expect(times.length).toBeGreaterThan(590);
    expect(Math.abs(last - 9.99)).toBeLessThan(0.02);
  });
});
