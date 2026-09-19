/**
 * The leaderboard's actual logic, with no Cloudflare in it.
 *
 * Split from `index.ts` for the same reason `rooms.ts` is: this is the part
 * that can be wrong, and keeping the platform out of it is what lets
 * `tests/board.test.ts` drive the *real* board — not a reimplementation — with
 * no wrangler and no deploy.
 *
 * ### What it is, and what it deliberately is not
 *
 * Ten times per track, each with a name, and **one** ghost: the leader's.
 *
 * Ten ghosts per track was the thing rejected here, and it still is — a ghost
 * is 148 KB for a short stage and 277 KB for Grand Traverse, so ten of them is
 * three orders of magnitude more data than the number and the name a track
 * picker needs. One is a different feature: it is the gold car arcade puts on
 * the road beside you, and there is exactly one world record to chase.
 * Sixty-odd tracks at a quarter of a megabyte is single-digit megabytes in
 * total.
 *
 * It is held as base64 rather than as bytes, because the worker in `index.ts`
 * forwards every board request by reading the body as *text*. Binary through
 * that is corrupted binary. The 33% it costs buys a store, a wire format and a
 * test suite that are all plain JSON, and the object's value limit is 2 MiB.
 *
 * A ghost is only ever attached to a time already on the board, and only by
 * the name holding first place. That is not proof of anything — see below —
 * but it means the blob can never be anything other than the leader's own
 * claim, and a new leader's upload replaces it.
 *
 * It is also **not verified, and cannot be**. `sim/replay.ts` records sampled
 * transforms rather than inputs, so there is nothing here to re-simulate; and
 * recording inputs instead would not save it, because Rapier is not
 * deterministic across machines — the same fact that ruled out rollback
 * netcode. So the checks below are bounds, not proof: they reject a time no car
 * could set and a name that would break a layout, and that is the honest limit.
 * Anyone determined can post a fiction. That is a known property of an
 * anonymous board with no accounts behind it, not an oversight to find later.
 *
 * ### State lives in storage
 *
 * Same rule as the rooms, and for a more obvious reason here: a leaderboard is
 * the one thing in this project that is *supposed* to outlive the object
 * holding it. A Durable Object is evicted when idle and rebuilt on the next
 * request, so anything in a field is gone — and unlike a room, losing this is
 * not a lobby reopening with a new code, it is everyone's times.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });

/** How many times are kept per track. */
export const BOARD_SIZE = 10;

/**
 * A track key: a stage id and a variant, as the game's `variantKey` builds it.
 *
 * Checked at the edge so a malformed key can never allocate storage. The board
 * is keyed by what was actually driven, because a stage in the wet and the same
 * stage in the dry are not the same race.
 */
export const TRACK_KEY = /^[a-z0-9][a-z0-9-]{0,40}:[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * How many boards one batch read may ask for.
 *
 * The arcade screen lists every stage under every condition — thirteen stages
 * and their variants — and asking for each separately would be forty requests
 * to open a menu. That is the difference between a free tier that lasts and
 * one that does not, so the whole screen is one call. The cap is here because
 * the parameter is a list from the open internet.
 */
export const MAX_BATCH = 64;

/** The longest a driver's name may be. */
export const MAX_NAME = 16;

/**
 * The largest ghost accepted, in base64 characters.
 *
 * Grand Traverse is the longest stage in the game and records at 277 KB, which
 * is 370 000 characters encoded. Half a megabyte of raw frames — 700 000
 * characters — is comfortably above anything this game can produce and
 * comfortably under the Durable Object's 2 MiB value limit, which is the
 * ceiling that actually exists. A stage long enough to need more than this
 * wants the limit re-measured, not raised on a guess.
 */
export const MAX_GHOST = 700_000;

/**
 * Bounds a real lap falls inside.
 *
 * The shortest stage is Scrubbed Flats at 973 m, which the AI drives in 44 s;
 * the longest is Grand Traverse at 1859 m in 83 s. An hour is not a lap and
 * neither is four seconds. Deliberately generous at both ends — this rejects
 * garbage and overflow, it does not adjudicate a close time it cannot check.
 */
const MIN_TIME = 5;
const MAX_TIME = 3600;

export interface Entry {
  name: string;
  /** Finish time in seconds. */
  time: number;
  /** When it was set, epoch milliseconds. */
  at: number;
}

/**
 * The record holder's lap, as `sim/replay.ts` records it.
 *
 * `name` and `time` are carried with the frames rather than inferred from the
 * board, so a ghost can be told apart from the board it was uploaded against.
 * When a faster time arrives the blob is left where it is and simply stops
 * matching — `ghost()` checks it against first place and hands back nothing if
 * it has been outdriven. Deleting instead would need a storage method for it
 * and would fail open in the one direction that matters: a stale ghost served
 * as the record is a gold car driving a lap nobody holds.
 */
export interface StoredGhost {
  name: string;
  /** Finish time in seconds, matching the board entry it belongs to. */
  time: number;
  /** `Float32Array` frames, base64 encoded. See the note at the top. */
  frames: string;
}

/** The subset of `DurableObjectStorage` this needs. See `rooms.ts`. */
export interface BoardStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/**
 * Clean a submitted name, or reject it.
 *
 * Control characters are stripped rather than rejected: they arrive from a
 * paste far more often than from malice, and dropping a stray tab is kinder
 * than refusing a run somebody just drove. What is left has to be non-empty
 * after trimming, which is the actual requirement.
 */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim();
  return stripped.length > 0 ? stripped : null;
}

/** `decodeURIComponent` throws on a malformed escape; a bad key is a 400. */
export function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/** Where a time would place in a board, or -1 if it would not make it. */
export function placeOf(board: Entry[], time: number): number {
  const at = board.findIndex((e) => time < e.time);
  if (at >= 0) return at;
  return board.length < BOARD_SIZE ? board.length : -1;
}

export class BoardStore {
  constructor(private readonly storage: BoardStorage) {}

  private async read(track: string): Promise<Entry[]> {
    return (await this.storage.get<Entry[]>(`b:${track}`)) ?? [];
  }

  /**
   * The ghost of the lap currently at the top, or null.
   *
   * Null covers three cases that are the same case to a caller: nothing was
   * ever uploaded, the board is empty, and the stored ghost belongs to a time
   * that has since been beaten.
   */
  async ghost(track: string): Promise<StoredGhost | null> {
    const stored = await this.storage.get<StoredGhost>(`g:${track}`);
    if (!stored) return null;
    const leader = (await this.read(track))[0];
    if (!leader || leader.name !== stored.name || leader.time !== stored.time) return null;
    return stored;
  }

  /**
   * Attach a ghost to a time already at the top of the board.
   *
   * Refused for anything else, which is the whole of the rule: a client posts
   * its time, is told it came first, and only then has somewhere to put the
   * lap. It cannot upload against a place it does not hold, and it cannot
   * invent a track — the board entry had to exist first.
   */
  async putGhost(track: string, name: string, time: number, frames: string): Promise<boolean> {
    const leader = (await this.read(track))[0];
    if (!leader || leader.name !== name || leader.time !== time) return false;
    await this.storage.put(`g:${track}`, { name, time, frames } satisfies StoredGhost);
    return true;
  }

  async top(track: string, limit = BOARD_SIZE): Promise<Entry[]> {
    const board = await this.read(track);
    return board.slice(0, Math.max(0, Math.min(limit, BOARD_SIZE)));
  }

  /**
   * Record a time, keeping the ten best.
   *
   * One entry per name per track. A board where the same driver holds six of
   * the ten places is not a leaderboard, it is one person's practice log — and
   * that is what happens by default, because the person who plays most is also
   * the person who improves most. Their slot moves when they beat themselves
   * and is left alone when they do not.
   */
  async submit(
    track: string,
    name: string,
    time: number,
  ): Promise<{ rank: number; top: Entry[]; was: string | null }> {
    const board = await this.read(track);
    // Who held the top before this run. Returned because only the server can
    // know it: the caller sees the board *after* its own insert, where the name
    // now sitting second may be the leader it displaced or may be the same
    // second place as before — and "you have taken it from Ari" is worth saying
    // only when it is actually true.
    const leader = board[0]?.name ?? null;

    const mine = board.findIndex((e) => e.name.toLowerCase() === name.toLowerCase());
    if (mine >= 0) {
      if (board[mine]!.time <= time) return { rank: -1, top: board, was: leader };
      board.splice(mine, 1);
    }

    const rank = placeOf(board, time);
    if (rank < 0) return { rank: -1, top: board, was: leader };

    board.splice(rank, 0, { name, time, at: Date.now() });
    board.length = Math.min(board.length, BOARD_SIZE);
    await this.storage.put(`b:${track}`, board);
    // Only a *different* name counts as dethroned. Beating your own record is
    // holding on to the top, not taking it from somebody.
    const took = rank === 0 && leader !== null && leader.toLowerCase() !== name.toLowerCase();
    return { rank, top: board, was: took ? leader : null };
  }

  /**
   * Route one request. `GET /b/:track` reads; `POST /b/:track` submits.
   *
   * The whole path is here rather than in the object, so the tests drive
   * exactly what the deployed worker runs.
   */
  /** Several boards at once, keyed by track. Unknown tracks come back empty. */
  async many(tracks: string[], limit: number): Promise<Record<string, Entry[]>> {
    const out: Record<string, Entry[]> = {};
    for (const track of tracks.slice(0, MAX_BATCH)) {
      if (TRACK_KEY.test(track)) out[track] = await this.top(track, limit);
    }
    return out;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // /bs?t=a:b,c:d — every board the arcade screen needs, in one request.
    if (parts[0] === 'bs') {
      const asked = Number(url.searchParams.get('n') ?? 3);
      const tracks = (url.searchParams.get('t') ?? '').split(',').filter(Boolean);
      const limit = Number.isFinite(asked) ? asked : 3;
      return json({ boards: await this.many(tracks, limit) });
    }

    // /g/:track — the record holder's lap. GET reads it, POST attaches one.
    if (parts[0] === 'g') {
      const key = parts[1] ? safeDecode(parts[1]) : '';
      if (!key || !TRACK_KEY.test(key)) return json({ error: 'bad track' }, 400);
      if (request.method === 'GET') return json({ ghost: await this.ghost(key) });

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return json({ error: 'bad body' }, 400);
      }
      const {
        name: rawName,
        time,
        frames,
      } = (payload ?? {}) as { name?: unknown; time?: unknown; frames?: unknown };
      const who = cleanName(rawName);
      if (!who) return json({ error: 'bad name' }, 400);
      if (typeof time !== 'number' || !Number.isFinite(time)) {
        return json({ error: 'bad time' }, 400);
      }
      // Length before shape: a rejected blob should cost one comparison rather
      // than a regex over most of a megabyte.
      if (typeof frames !== 'string' || frames.length === 0 || frames.length > MAX_GHOST) {
        return json({ error: 'bad ghost' }, 400);
      }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(frames)) return json({ error: 'bad ghost' }, 400);
      // Rounded exactly as `submit` rounds, or a ghost could never match the
      // entry it was posted against.
      const stored = await this.putGhost(key, who, Math.round(time * 1000) / 1000, frames);
      return json({ stored });
    }

    // Decoded, because a track key contains a colon and the client percent-
    // encodes it into the path. `pathname` hands back the raw, still-encoded
    // segment, so without this every single-track request arrives as
    // `quarry-run%3Aday-clear`, fails the pattern and 400s — while the batch
    // read carries its keys in the query string, where `searchParams` decodes
    // them, and works. That split is why it looked like the board was simply
    // empty rather than unreachable.
    const track = parts[1] ? safeDecode(parts[1]) : undefined;
    if (parts[0] !== 'b' || !track || !TRACK_KEY.test(track)) {
      return json({ error: 'bad track' }, 400);
    }

    if (request.method === 'GET') {
      const asked = Number(url.searchParams.get('n') ?? BOARD_SIZE);
      return json({ top: await this.top(track, Number.isFinite(asked) ? asked : BOARD_SIZE) });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad body' }, 400);
    }
    const { name: rawName, time } = (body ?? {}) as { name?: unknown; time?: unknown };

    const name = cleanName(rawName);
    if (!name) return json({ error: 'bad name' }, 400);
    if (typeof time !== 'number' || !Number.isFinite(time) || time < MIN_TIME || time > MAX_TIME) {
      return json({ error: 'bad time' }, 400);
    }

    // Rounded on the way in, so a place can never be won by floating-point
    // noise a player cannot see and could not have driven differently.
    return json(await this.submit(track, name, Math.round(time * 1000) / 1000));
  }
}

/** A Map-backed `BoardStorage`, for the tests and for nothing else. */
export class MemoryBoardStorage implements BoardStorage {
  private readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
}
