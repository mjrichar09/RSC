/**
 * The leaderboard client against the real board, in process.
 *
 * `board.test.ts` drives the server and `untrusted.test.ts` the parsing, and
 * nothing drove the one thing a player does: the client posting a record to
 * the server. That gap hid two bugs that each refused every world record.
 *
 * - The handshake for a record is a refusal: post the time, get a 400 saying
 *   the lap is needed, post again with it. The client threw away any response
 *   that was not a 2xx, so it never saw the 400, never sent the lap, and no
 *   record was accepted from the day the board started asking for one.
 * - A lap longer than about 156 s was more ghost than the board would take, so
 *   a record could never be set on Coldwater Pass at all.
 *
 * `fetch` is pointed at the real `BoardStore`, and the lap is a real recording.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardStore, MemoryBoardStorage } from '../server/src/board.js';
import { Leaderboard } from '../src/net/leaderboard.js';
import { createWorld } from '../src/sim/world.js';
import { GhostRecorder } from '../src/sim/replay.js';

function connect(): { board: Leaderboard; store: BoardStore } {
  const store = new BoardStore(new MemoryBoardStorage());
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const { signal: _signal, ...rest } = init ?? {};
    return store.fetch(new Request(url, rest));
  });
  return { board: new Leaderboard('https://board.test'), store };
}

afterEach(() => vi.unstubAllGlobals());

/** A real lap: a world driven for `seconds` and recorded on its fixed steps. */
async function lap(seconds: number): Promise<Float32Array> {
  const world = await createWorld();
  const recorder = new GhostRecorder();
  world.onStep = () => recorder.capture(world.time, 0, world.state());
  while (world.time < seconds) world.advance(1 / 60, { throttle: 0.6, brake: 0, steer: 0.1, handbrake: 0 });
  return recorder.finish('test', world.time).frames;
}

describe('posting to the board', () => {
  it('takes a world record, lap and all', async () => {
    const { board } = connect();
    const frames = await lap(30);
    const posted = await board.submit('pine-loop:day-clear', 'Ari', 30, frames);
    expect(posted?.rank).toBe(0);
    expect(posted?.top[0]?.name).toBe('Ari');
    // And the gold car for everybody else is that lap.
    const ghost = await board.ghost('pine-loop:day-clear');
    expect(ghost?.name).toBe('Ari');
    expect(ghost?.frames.length).toBe(frames.length);
  });

  it('takes a record from someone who already holds one, and a place below it', async () => {
    const { board } = connect();
    expect((await board.submit('pine-loop:day-clear', 'Ari', 40, await lap(40)))?.rank).toBe(0);
    // Second place is a name and a number; no lap is asked for.
    expect((await board.submit('pine-loop:day-clear', 'Bo', 45))?.rank).toBe(1);
    // Beating your own record is still a record.
    expect((await board.submit('pine-loop:day-clear', 'Ari', 38, await lap(38)))?.rank).toBe(0);
  });

  it('takes a record on a long stage', async () => {
    const { board } = connect();
    // 200 s of recording at the recorder's rate, 14 floats a frame: the length
    // is what the board checks, so the lap need not be driven.
    const frames = new Float32Array(200 * 60 * 14);
    const posted = await board.submit('coldwater-pass:day-clear', 'Ari', 200, frames);
    expect(posted?.rank).toBe(0);
  });
});
