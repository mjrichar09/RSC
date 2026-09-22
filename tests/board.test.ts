/**
 * The leaderboard, driven through the same paths the deployed worker runs.
 *
 * Same approach as `rooms.test.ts`: `board.ts` has no Cloudflare types in it,
 * so this exercises the real store rather than a reimplementation of it, in
 * milliseconds, with no wrangler and no deploy. The things worth checking are
 * all orderings and edge cases — a board is almost entirely off-by-one risk.
 */

import { describe, expect, it } from 'vitest';
import {
  BOARD_SIZE,
  BoardStore,
  MAX_GHOST,
  MemoryBoardStorage,
  MIN_TIME,
  RATE_LIMITS,
  offensive,
  type StoredGhost,
  cleanName,
} from '../server/src/board.js';

const store = () => new BoardStore(new MemoryBoardStorage());

/**
 * Post a time the way the worker would, and hand back the parsed body.
 *
 * Carries a ghost of about the size a lap that long really records — 4470
 * bytes of base64 per second, measured across all fourteen stages — because a
 * time that takes first place is refused without one. The tests below this are
 * about ordering and dedupe and should not each have to think about that; the
 * ones that *are* about it post for themselves.
 */
const post = async (board: BoardStore, track: string, name: string, time: number) => {
  const response = await board.fetch(
    new Request(`https://boards/b/${track}`, {
      method: 'POST',
      body: JSON.stringify({ name, time, frames: 'A'.repeat(Number.isFinite(time) ? Math.max(0, Math.round(time * 4470)) : 0) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const read = async (board: BoardStore, track: string, query = '') => {
  const response = await board.fetch(new Request(`https://boards/b/${track}${query}`));
  return (await response.json()) as { top: { name: string; time: number }[] };
};

describe('a leaderboard', () => {
  it('keeps the fastest ten and drops the eleventh', async () => {
    const board = store();
    // Submitted worst-first, so every one of them has to displace the last.
    for (let i = 0; i < 14; i++) await post(board, 'pine-loop:day-clear', `driver${i}`, 100 - i);

    const { top } = await read(board, 'pine-loop:day-clear');
    expect(top).toHaveLength(BOARD_SIZE);
    expect(top[0]!.time).toBe(87);
    expect(top[9]!.time).toBe(96);
    // Ascending, which is the whole contract.
    expect(top.map((e) => e.time)).toEqual([...top.map((e) => e.time)].sort((a, b) => a - b));
  });

  it('reports where a time placed, and that it did not', async () => {
    const board = store();
    for (let i = 0; i < BOARD_SIZE; i++) await post(board, 'pine-loop:day-clear', `driver${i}`, 50 + i);

    // Straight to the top, which pushes everything else down one and drops
    // the old last place: the board is now 30, 50, 51 ... 58. Thirty rather
    // than ten because nothing under `MIN_TIME` is a lap any more.
    expect((await post(board, 'pine-loop:day-clear', 'quick', 30)).body.rank).toBe(0);
    // Into the middle — ahead of 53, which that shift left at index 4.
    expect((await post(board, 'pine-loop:day-clear', 'middling', 52.5)).body.rank).toBe(4);
    // Nowhere: the board is full and this is slower than all of it.
    expect((await post(board, 'pine-loop:day-clear', 'slow', 999)).body.rank).toBe(-1);
  });

  it('gives one driver one place, not six', async () => {
    // A board where the person who plays most holds most of the places is a
    // practice log rather than a leaderboard, and it is what happens by default
    // — improving is exactly what a returning player does.
    const board = store();
    for (const time of [90, 80, 70, 60]) await post(board, 'pine-loop:day-clear', 'Ari', time);
    await post(board, 'pine-loop:day-clear', 'Bo', 85);

    const { top } = await read(board, 'pine-loop:day-clear');
    expect(top.filter((e) => e.name === 'Ari')).toHaveLength(1);
    expect(top[0]).toMatchObject({ name: 'Ari', time: 60 });
    expect(top).toHaveLength(2);
  });

  it('does not let a driver push themselves down the board', async () => {
    // The other half of one-place-each: a slower run by the same person must
    // leave their existing place alone rather than replace it.
    const board = store();
    await post(board, 'pine-loop:day-clear', 'Ari', 60);
    const worse = await post(board, 'pine-loop:day-clear', 'ARI', 75);

    expect(worse.body.rank).toBe(-1);
    const { top } = await read(board, 'pine-loop:day-clear');
    expect(top).toEqual([expect.objectContaining({ name: 'Ari', time: 60 })]);
  });

  it('keeps one board per track and variant', async () => {
    // A stage in the wet and the same stage in the dry are not the same race,
    // so the key is what was driven rather than which stage it was.
    const board = store();
    await post(board, 'pine-loop:day-clear', 'Ari', 60);
    await post(board, 'pine-loop:night-snow', 'Bo', 90);

    expect((await read(board, 'pine-loop:day-clear')).top).toHaveLength(1);
    expect((await read(board, 'pine-loop:night-snow')).top[0]!.name).toBe('Bo');
    expect((await read(board, 'quarry-run:day-clear')).top).toEqual([]);
  });

  it('refuses what could not have been driven', async () => {
    const board = store();
    // The bounds are generous on purpose: they reject garbage and overflow,
    // they do not adjudicate a close time nothing here can check.
    for (const time of [0, -5, 1, 4.9, 3601, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await post(board, 'pine-loop:day-clear', 'Ari', time)).status, String(time)).toBe(400);
    }
    expect((await post(board, 'pine-loop:day-clear', '   ', 60)).status).toBe(400);
    expect((await post(board, 'pine-loop:day-clear', '', 60)).status).toBe(400);
    expect((await read(board, 'pine-loop:day-clear')).top).toEqual([]);

    // A malformed track never reaches storage.
    const bad = await board.fetch(new Request('https://boards/b/Pine%20Loop!'));
    expect(bad.status).toBe(400);
  });

  it('takes a name as typed and makes it fit', async () => {
    expect(cleanName('  Ari  ')).toBe('Ari');
    expect(cleanName('a'.repeat(40))).toHaveLength(16);
    // Stripped rather than refused: control characters arrive from a paste far
    // more often than from malice, and losing a run to a stray tab is worse.
    expect(cleanName('Ari\tKo\n')).toBe('Ari Ko');
    expect(cleanName('')).toBeNull();
    expect(cleanName('\u0000\u0001')).toBeNull();
    expect(cleanName(42)).toBeNull();
    expect(cleanName(null)).toBeNull();
  });

  it('answers a short board for the track-select strip', async () => {
    // Picking a track shows three; the board holds ten. Asking for more than
    // there are, or more than exist, must not invent rows or throw.
    const board = store();
    for (let i = 0; i < 5; i++) await post(board, 'pine-loop:day-clear', `driver${i}`, 60 + i);

    expect((await read(board, 'pine-loop:day-clear', '?n=3')).top).toHaveLength(3);
    expect((await read(board, 'pine-loop:day-clear', '?n=99')).top).toHaveLength(5);
    expect((await read(board, 'pine-loop:day-clear', '?n=nonsense')).top).toHaveLength(5);
    expect((await read(board, 'pine-loop:day-clear', '?n=0')).top).toEqual([]);
  });

  it('answers the whole arcade screen in one request', async () => {
    // Thirteen stages and their variants is about forty boards. Asking for each
    // separately would be forty requests to open a menu, which is the
    // difference between a free tier that lasts and one that does not.
    const board = store();
    await post(board, 'pine-loop:day-clear', 'Ari', 60);
    await post(board, 'pine-loop:day-clear', 'Bo', 61);
    await post(board, 'pine-loop:day-clear', 'Cy', 62);
    await post(board, 'pine-loop:day-clear', 'Dee', 63);
    await post(board, 'quarry-run:day-clear', 'Eve', 70);

    const response = await board.fetch(
      new Request('https://boards/bs?n=3&t=pine-loop:day-clear,quarry-run:day-clear,north-pass:day-clear'),
    );
    const { boards } = (await response.json()) as { boards: Record<string, { name: string }[]> };

    expect(boards['pine-loop:day-clear']!.map((e) => e.name)).toEqual(['Ari', 'Bo', 'Cy']);
    expect(boards['quarry-run:day-clear']).toHaveLength(1);
    // A track nobody has driven answers empty rather than being absent, so the
    // caller never has to tell "no times yet" from "you asked wrong".
    expect(boards['north-pass:day-clear']).toEqual([]);
  });

  it('does not let a batch read ask for the world', async () => {
    // The list arrives from the open internet, so it is capped and filtered
    // rather than trusted.
    const board = store();
    const many = Array.from({ length: 200 }, (_, i) => `stage-${i}:day-clear`).join(',');
    const response = await board.fetch(new Request(`https://boards/bs?t=${many},NOT!VALID`));
    const { boards } = (await response.json()) as { boards: Record<string, unknown[]> };

    expect(Object.keys(boards).length).toBeLessThanOrEqual(64);
    expect(boards['NOT!VALID']).toBeUndefined();
  });

  it('survives the object being rebuilt under it', async () => {
    // A Durable Object is evicted when idle and reconstructed on the next
    // request, so anything held in a field is gone. For a room that is a lobby
    // reopening; for a board it would be everyone's times.
    const storage = new MemoryBoardStorage();
    await post(new BoardStore(storage), 'pine-loop:day-clear', 'Ari', 60);

    const rebuilt = new BoardStore(storage);
    expect((await read(rebuilt, 'pine-loop:day-clear')).top[0]).toMatchObject({ name: 'Ari', time: 60 });
  });
});

describe('who was dethroned', () => {
  it('names the leader a new best time took it from', async () => {
    // Only the server can answer this. The caller sees the board *after* its
    // own insert, where the name now sitting second may be the leader it
    // displaced or may be the same second place as before.
    const board = store();
    await post(board, 'pine-loop:day-clear', 'Ari', 41.0);
    await post(board, 'pine-loop:day-clear', 'Bo', 42.0);

    const taken = await post(board, 'pine-loop:day-clear', 'Cy', 40.0);
    expect(taken.body.rank).toBe(0);
    expect(taken.body.was).toBe('Ari');
  });

  it('does not claim a throne you already held', async () => {
    // Beating your own record is holding on to the top, not taking it from
    // somebody — and "you have taken it from yourself" is nonsense.
    const board = store();
    await post(board, 'pine-loop:day-clear', 'Ari', 41.0);
    const again = await post(board, 'pine-loop:day-clear', 'Ari', 39.0);

    expect(again.body.rank).toBe(0);
    expect(again.body.was).toBeNull();
  });

  it('does not claim a throne for a place further down', async () => {
    const board = store();
    await post(board, 'pine-loop:day-clear', 'Ari', 41.0);
    const second = await post(board, 'pine-loop:day-clear', 'Bo', 42.0);

    expect(second.body.rank).toBe(1);
    expect(second.body.was).toBeNull();
  });

  it('has nobody to dethrone on an empty board', async () => {
    const board = store();
    const first = await post(board, 'pine-loop:day-clear', 'Ari', 41.0);
    expect(first.body.rank).toBe(0);
    expect(first.body.was).toBeNull();
  });
});

describe('the track key on the wire', () => {
  it('accepts a key the client percent-encoded into the path', async () => {
    // A track key contains a colon, and the client encodes it. `pathname`
    // hands back the raw segment, so without decoding, every single-track
    // request arrives as `quarry-run%3Aday-clear` and 400s — while the batch
    // read carries its keys in the query string, where `searchParams` decodes
    // them, and works. That split is exactly why it looked like the board was
    // simply empty rather than unreachable: the arcade list was fine and every
    // submit was being rejected.
    const board = store();
    const posted = await board.fetch(
      new Request('https://boards/b/quarry-run%3Aday-clear', {
        method: 'POST',
        // With a lap, because this one takes first place on an empty board.
        body: JSON.stringify({ name: 'Ari', time: 41.1, frames: 'A'.repeat(184_000) }),
      }),
    );
    expect(posted.status).toBe(200);

    // And it reads back under both spellings, because they are one key.
    const encoded = await read(board, 'quarry-run%3Aday-clear');
    const plain = await read(board, 'quarry-run:day-clear');
    expect(encoded.top[0]!.name).toBe('Ari');
    expect(plain.top).toEqual(encoded.top);
  });

  it('refuses a malformed escape rather than throwing', async () => {
    // `decodeURIComponent` throws on a lone `%`, and an unhandled throw inside
    // a Durable Object is a 500 for something that is simply a bad request.
    const board = store();
    const response = await board.fetch(new Request('https://boards/b/quarry%2'));
    expect(response.status).toBe(400);
  });
});

/**
 * One ghost per track: the leader's.
 *
 * The cases worth checking are all about the blob and the board going out of
 * step, because they are stored separately and only one of them is ordered.
 */
describe('the record holder’s ghost', () => {
  const TRACK = 'pine-loop:day-clear';
  /** Base64 of a whole number of floats. The bytes themselves never matter here. */
  const LAP = 'AAAAAAAAAAAAAAAAAAAAAA==';
  const OTHER = 'BBBBBBBBBBBBBBBBBBBBBB==';

  const putGhost = async (board: BoardStore, name: string, time: number, frames = LAP) => {
    const response = await board.fetch(
      new Request(`https://boards/g/${TRACK}`, {
        method: 'POST',
        body: JSON.stringify({ name, time, frames }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const getGhost = async (board: BoardStore) => {
    const response = await board.fetch(new Request(`https://boards/g/${TRACK}`));
    return (await response.json()) as { ghost: StoredGhost | null };
  };

  it('keeps the lap of whoever is top, and hands it back', async () => {
    const board = store();
    await post(board, TRACK, 'Ari', 41.5);
    expect((await putGhost(board, 'Ari', 41.5)).body.stored).toBe(true);
    expect((await getGhost(board)).ghost).toEqual({ name: 'Ari', time: 41.5, frames: LAP });
  });

  it('refuses a lap from anyone who is not top', async () => {
    const board = store();
    await post(board, TRACK, 'Ari', 41.5);
    await post(board, TRACK, 'Bo', 44.0);

    // Second place has a board entry and still has nowhere to put a lap: there
    // is one ghost per track and it belongs to the record.
    expect((await putGhost(board, 'Bo', 44.0)).body.stored).toBe(false);
    // The right name against the wrong time is the stale-client case, refused
    // for the same reason: the blob would not match the time on the board.
    expect((await putGhost(board, 'Ari', 41.4)).body.stored).toBe(false);
    // A track nobody has posted a time to cannot be seeded with a ghost at all.
    expect((await putGhost(store(), 'Ari', 41.5)).body.stored).toBe(false);
  });

  it('hands the slot straight to whoever takes the record', async () => {
    // A record now arrives with its own lap, so the new leader's ghost is in
    // place the moment the entry is — there is no window where the board shows
    // one name and the gold car drives somebody else's line.
    const board = store();
    await post(board, TRACK, 'Ari', 41.5);
    expect((await getGhost(board)).ghost!.name).toBe('Ari');

    await post(board, TRACK, 'Bo', 40.2);
    expect((await getGhost(board)).ghost!.name).toBe('Bo');
    expect((await getGhost(board)).ghost!.time).toBe(40.2);
  });

  it('stops serving a lap that no longer belongs to first place', async () => {
    // Only reachable from older data now, but the rule still has to hold: the
    // blob is left in storage and simply stops matching, because serving it
    // would put a gold car on the road driving a lap nobody holds.
    const board = store();
    await board.submit(TRACK, 'Ari', 41.5);
    await board.putGhost(TRACK, 'Ari', 41.5, OTHER);
    expect((await getGhost(board)).ghost!.name).toBe('Ari');

    await board.submit(TRACK, 'Bo', 40.2);
    expect((await getGhost(board)).ghost).toBeNull();
  });

  it('rejects a blob that is not base64, or is too big to be a lap', async () => {
    const board = store();
    // Straight to `submit`, so no ghost is stored for it: this is about what
    // `/g` refuses, not about what a record arrives with.
    await board.submit(TRACK, 'Ari', 41.5);

    expect((await putGhost(board, 'Ari', 41.5, 'not base64!')).status).toBe(400);
    expect((await putGhost(board, 'Ari', 41.5, '')).status).toBe(400);
    expect((await putGhost(board, 'Ari', 41.5, 'A'.repeat(MAX_GHOST + 4))).status).toBe(400);
    // Nothing was stored by any of them.
    expect((await getGhost(board)).ghost).toBeNull();
  });

  it('answers with nothing rather than an error when there is no ghost', async () => {
    // The ordinary case: every track has a board and almost none of them have
    // a lap behind it. A caller must not have to tell that apart from a
    // failure, because it does the same thing either way.
    const board = store();
    expect((await getGhost(board)).ghost).toBeNull();
    // `submit` rather than a posted record, which would bring its own lap.
    await board.submit(TRACK, 'Ari', 41.5);
    expect((await getGhost(board)).ghost).toBeNull();
  });
});

/**
 * Rate limiting.
 *
 * A cost ceiling and a nuisance floor rather than a security control — the
 * board has no accounts and nothing here makes a posted time *true*. What it
 * stops is one person filling every slot on every track in a minute, and a
 * runaway client spending the free tier by lunchtime.
 */
describe('how fast one address may go', () => {
  const TRACK = 'pine-loop:day-clear';
  const from = (board: BoardStore, method: string, path: string, ip: string, body?: unknown) =>
    board.fetch(
      new Request(`https://boards${path}`, {
        method,
        headers: { 'x-from': ip },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  it('lets ordinary play through untouched', async () => {
    // Opening the arcade screen is one batch read. Nobody playing gets near
    // the ceiling, and a limit that catches a player is worse than no limit.
    const board = store();
    for (let i = 0; i < RATE_LIMITS.read; i++) {
      expect((await from(board, 'GET', '/bs?t=' + TRACK, '1.2.3.4')).status).toBe(200);
    }
  });

  it('stops an address that will not stop', async () => {
    const board = store();
    for (let i = 0; i < RATE_LIMITS.read; i++) await from(board, 'GET', '/bs?t=' + TRACK, '9.9.9.9');
    const over = await from(board, 'GET', '/bs?t=' + TRACK, '9.9.9.9');
    expect(over.status).toBe(429);
    // With something to act on rather than a bare refusal.
    expect(over.headers.get('retry-after')).toBeTruthy();
  });

  it('counts each address on its own', async () => {
    // One person hammering it must not lock everybody else out, which is the
    // failure mode of a single global counter.
    const board = store();
    for (let i = 0; i <= RATE_LIMITS.read; i++) await from(board, 'GET', '/bs?t=' + TRACK, 'a');
    expect((await from(board, 'GET', '/bs?t=' + TRACK, 'a')).status).toBe(429);
    expect((await from(board, 'GET', '/bs?t=' + TRACK, 'b')).status).toBe(200);
  });

  it('holds writes to far less than reads', async () => {
    // Ten submissions a minute is already past what finishing stages can
    // produce; reading is a menu opening and gets room to breathe.
    const board = store();
    expect(RATE_LIMITS.submit).toBeLessThan(RATE_LIMITS.read / 4);
    expect(RATE_LIMITS.ghost).toBeLessThan(RATE_LIMITS.submit);
    for (let i = 0; i < RATE_LIMITS.submit; i++) {
      await from(board, 'POST', `/b/${TRACK}`, 'c', { name: `d${i}`, time: 50 + i });
    }
    const over = await from(board, 'POST', `/b/${TRACK}`, 'c', { name: 'again', time: 44 });
    expect(over.status).toBe(429);
    // And nothing it refused reached the board.
    const { top } = await read(board, TRACK);
    expect(top.some((e) => e.name === 'again')).toBe(false);
  });

  it('forgets an address once its minute is up', async () => {
    const board = store();
    const now = 1_000_000;
    for (let i = 0; i < RATE_LIMITS.read; i++) expect(board.allow('read', 'x', now)).toBe(true);
    expect(board.allow('read', 'x', now)).toBe(false);
    expect(board.allow('read', 'x', now + 61_000)).toBe(true);
  });

  it('limits nothing when there is no address to limit', async () => {
    // A direct object call has not come through the edge, so there is nothing
    // to attribute it to — and every test above this one in the file relies on
    // that, which is why it is worth saying out loud.
    const board = store();
    for (let i = 0; i < RATE_LIMITS.read * 2; i++) expect(board.allow('read', '')).toBe(true);
  });
});

describe('names a stranger will read', () => {
  it('lets ordinary names through', () => {
    for (const name of ['Ari', 'Kaisa', 'BK', 'Solveig', 'marky', 'Ottó', 'x_x', 'Scunthorpe']) {
      expect(offensive(name), name).toBe(false);
    }
  });

  it('refuses the obvious ones', () => {
    for (const name of ['fuck', 'FUCK', 'shitter', 'a cunt']) {
      expect(offensive(name), name).toBe(true);
    }
  });

  it('sees through the first things anybody tries', () => {
    // Digits for letters, punctuation between them, and letters doubled up.
    for (const name of ['f4ck', 'sh1t', 'f.u.c.k', 'f u c k', 'fuuuck', '$hit', 'phuck']) {
      expect(offensive(name), name).toBe(true);
    }
  });

  it('gives somebody their own name back', () => {
    // The Scunthorpe problem, which substring matching makes real rather than
    // theoretical. A real player refused their own name is a worse failure
    // than a rude one getting through.
    for (const name of ['Scunthorpe', 'Cockburn', 'Dickens', 'Analyst', 'Cumbria']) {
      expect(offensive(name), name).toBe(false);
    }
    // But not somebody who has read the list.
    expect(offensive('xXScunthorpeXx')).toBe(true);
  });

  it('refuses a submission rather than quietly renaming it', async () => {
    // Masked with asterisks it is a puzzle to solve by trying again; the
    // player is told instead.
    const board = store();
    const posted = await post(board, 'pine-loop:day-clear', 'fuck', 41.5);
    expect(posted.status).toBe(400);
    expect(posted.body.error).toBe('bad name');
    const { top } = await read(board, 'pine-loop:day-clear');
    expect(top).toHaveLength(0);
  });

  it('keeps the name the player actually typed', () => {
    // The flattening is for comparing only. A board full of lowercase
    // alphabet-only names would be the filter leaking into the product.
    expect(cleanName('  Ottó  ')).toBe('Ottó');
    expect(cleanName('MaRkY 07')).toBe('MaRkY 07');
  });
});

/**
 * The three rules added before this board was shown to strangers.
 *
 * None of them makes a posted time *true* — nothing without accounts can — and
 * the last one is the only one that is expensive to get around.
 */
describe('what it takes to get on the board now', () => {
  const TRACK = 'pine-loop:day-clear';
  /** A ghost of roughly the size a lap of `secs` really produces. */
  const ghostFor = (secs: number) => 'A'.repeat(Math.round(secs * 4470));

  const submit = async (board: BoardStore, name: string, time: number, frames?: string) => {
    const res = await board.fetch(
      new Request(`https://boards/b/${TRACK}`, {
        method: 'POST',
        body: JSON.stringify({ name, time, ...(frames === undefined ? {} : { frames }) }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('refuses a time nobody could have driven', () => {
    // Measured: the AI drives the fastest stage in the game in 33.0 s and
    // nothing else is under 37, and a human record is slower than the AI's
    // author lap rather than faster.
    expect(MIN_TIME).toBeGreaterThanOrEqual(25);
  });

  it('turns away the lazy forgery', async () => {
    const board = store();
    for (const time of [0.1, 6, 24.9]) {
      const posted = await submit(board, 'nope', time, ghostFor(60));
      expect(posted.status, String(time)).toBe(400);
      expect(posted.body.error).toBe('bad time');
    }
    expect((await read(board, TRACK)).top).toHaveLength(0);
  });

  it('will not take a record without the lap that set it', async () => {
    const board = store();
    const bare = await submit(board, 'Ari', 41.0);
    expect(bare.status).toBe(400);
    expect(bare.body.needsGhost).toBe(true);
    // And nothing was written on the way to refusing it.
    expect((await read(board, TRACK)).top).toHaveLength(0);
  });

  it('will not take a gesture of one either', async () => {
    const board = store();
    const thin = await submit(board, 'Ari', 41.0, 'A'.repeat(4000));
    expect(thin.status).toBe(400);
    expect(thin.body.needsGhost).toBe(true);
    expect(Number(thin.body.need)).toBeGreaterThan(Number(thin.body.have));
  });

  it('takes a record that brings its own lap, and keeps the lap', async () => {
    const board = store();
    const posted = await submit(board, 'Ari', 41.0, ghostFor(41));
    expect(posted.status).toBe(200);
    expect(posted.body.rank).toBe(0);
    // Stored together: a record can no longer exist without its ghost.
    const got = await board.fetch(new Request(`https://boards/g/${TRACK}`));
    const { ghost } = (await got.json()) as { ghost: { name: string; time: number } | null };
    expect(ghost?.name).toBe('Ari');
    expect(ghost?.time).toBe(41);
  });

  it('asks for more ghost from a longer lap', async () => {
    // The floor is derived from the time rather than fixed, because a fixed
    // one cannot work: 200 KB is more than the entire ghost of six of the
    // fourteen stages, Pine Loop among them.
    expect(BoardStore.ghostNeededFor(120)).toBeGreaterThan(BoardStore.ghostNeededFor(40));
    // A short lap's real ghost still clears its own bar.
    expect(BoardStore.ghostNeededFor(33)).toBeLessThan(33 * 4470);
    expect(BoardStore.ghostNeededFor(126)).toBeLessThan(126 * 4470);
  });

  it('lets an ordinary finish through with no ghost at all', async () => {
    // Everything below first place is a name and a number, and always was.
    const board = store();
    await submit(board, 'Ari', 41.0, ghostFor(41));
    const ninth = await submit(board, 'Bo', 55.0);
    expect(ninth.status).toBe(200);
    expect(ninth.body.rank).toBe(1);
  });
});

describe('taking something down', () => {
  const TRACK = 'pine-loop:day-clear';
  const del = (board: BoardStore, name: string) =>
    board.fetch(
      new Request(`https://boards/b/${TRACK}?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    );

  it('removes the entry and leaves the rest in order', async () => {
    const board = store();
    for (const [name, time] of [['Ari', 41], ['Bo', 44], ['Cy', 47]] as const) {
      await post(board, TRACK, name, time);
    }
    const res = await del(board, 'Bo');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { removed: boolean }).removed).toBe(true);
    const { top } = await read(board, TRACK);
    expect(top.map((e) => e.name)).toEqual(['Ari', 'Cy']);
  });

  it('can name an entry the word filter would now refuse', async () => {
    // The point of the endpoint. Whatever is being taken down got on before
    // the filter caught it, so running the name through the filter would make
    // exactly these entries the ones that cannot be removed.
    const board = store();
    await board.submit(TRACK, 'fuck', 41);
    expect((await read(board, TRACK)).top).toHaveLength(1);
    await del(board, 'fuck');
    expect((await read(board, TRACK)).top).toHaveLength(0);
  });

  it('says so plainly when there was nothing to remove', async () => {
    const board = store();
    const res = await del(board, 'nobody');
    expect(((await res.json()) as { removed: boolean }).removed).toBe(false);
  });

  it('drops the record ghost with the record', async () => {
    const board = store();
    await board.submit(TRACK, 'Ari', 41);
    await board.putGhost(TRACK, 'Ari', 41, 'AAAA');
    await del(board, 'Ari');
    expect(await board.ghost(TRACK)).toBeNull();
  });
});
