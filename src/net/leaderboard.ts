/**
 * The global times board.
 *
 * Ten times per track with a name against each, held by the same Cloudflare
 * Worker as the room broker (`server/src/board.ts`), plus the lap of whoever
 * is top — one ghost per track and no more. See that file for why ten was
 * never on, and why the one that is travels base64.
 *
 * ### Nothing here is allowed to matter
 *
 * Every call fails soft and returns null or false. The board is decoration on
 * top of a game that has always run as a static site with no server, and it
 * has to stay that way: the broker is optional, it is free-tier, and it can be
 * down or blocked or simply not configured on a fork. A stage list that will
 * not open because a leaderboard fetch hung is a far worse bug than a stage
 * list with no times in it, so there is a timeout on every request and no error
 * is ever raised at a caller.
 *
 * ### Only arcade times are sent
 *
 * A career car carries upgrades, and a board that puts a twice-upgraded engine
 * next to a stock one is not measuring the same thing twice — it is measuring
 * the garage. Arcade is the level field, which is the whole reason it now
 * builds its world from stock tuning rather than the player's.
 */

import { brokerBase } from './roomHttp.js';

/** How long any call is allowed to take before it is abandoned, ms. */
const TIMEOUT = 4000;

/**
 * How long a ghost transfer gets instead, ms.
 *
 * A board read is a few hundred bytes and four seconds is generous for it. A
 * ghost is up to 370 KB encoded, which is several seconds of a phone's uplink
 * on its own — abandoning that at the same deadline would mean the record lap
 * never arrives on exactly the connections that most need a longer one. Still
 * bounded, and still fails soft: a slow link gets no gold car rather than a
 * menu that will not open.
 */
const GHOST_TIMEOUT = 15000;

export interface BoardEntry {
  name: string;
  time: number;
  at: number;
}

/** The record holder's lap: who set it, what it took, and where the car went. */
export interface BoardGhost {
  name: string;
  time: number;
  frames: Float32Array;
}

/**
 * Base64 in both directions, byte for byte.
 *
 * `btoa`/`atob` rather than anything cleverer, and one character at a time
 * rather than `String.fromCharCode(...bytes)` — spreading a quarter of a
 * megabyte into an argument list overflows the stack, which is a crash on
 * exactly the longest stage and on nothing shorter. A chunked loop is the
 * boring fix and the only one that holds at Grand Traverse's size.
 */
const CHUNK = 0x8000;

function toBase64(frames: Float32Array): string {
  const bytes = new Uint8Array(frames.buffer, frames.byteOffset, frames.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Float32Array | null {
  try {
    const binary = atob(encoded);
    // A Float32Array needs whole floats and an aligned buffer; a truncated or
    // corrupted blob would otherwise throw inside the constructor, from a
    // stack that says nothing about where it came from.
    if (binary.length === 0 || binary.length % 4 !== 0) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  } catch {
    return null;
  }
}
/**
 * Keep only the rows that are actually rows.
 *
 * The board is the one thing in the game that hands back text somebody else
 * typed, and the callers treat what comes out of here as a `BoardEntry` — they
 * call `.toLowerCase()` on the name and `.toFixed()` on the time. A response
 * that is merely *shaped* wrong (a null name, a time that is a string) is then
 * a thrown exception on the finish panel, which is the screen that must never
 * be the thing that breaks. Escaping happens where it is drawn; this is only
 * about the shape.
 */
const entriesIn = (raw: unknown): BoardEntry[] =>
  Array.isArray(raw)
    ? (raw.filter(
        (row) =>
          typeof (row as BoardEntry)?.name === 'string' &&
          typeof (row as BoardEntry)?.time === 'number' &&
          Number.isFinite((row as BoardEntry).time),
      ) as BoardEntry[])
    : [];

export class Leaderboard {
  constructor(private readonly base: string) {}

  private async call(
    path: string,
    init?: RequestInit,
    timeout = TIMEOUT,
  ): Promise<unknown | null> {
    // `AbortSignal.timeout` rather than a race against a timer: the point is to
    // stop *waiting*, and a promise race leaves the request itself running and
    // the connection held.
    try {
      const response = await fetch(`${this.base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  /** The fastest `limit` times for a track, or null if they cannot be had. */
  async top(track: string, limit = 10): Promise<BoardEntry[] | null> {
    const body = (await this.call(`/b/${encodeURIComponent(track)}?n=${limit}`)) as {
      top?: unknown;
    } | null;
    return Array.isArray(body?.top) ? entriesIn(body.top) : null;
  }

  /**
   * Every board the arcade screen needs, in one request.
   *
   * Not `top()` in a loop: the screen lists every stage under every condition,
   * so that would be forty requests to open a menu — slow for the player and
   * the fastest way to spend a free tier there is.
   */
  async many(tracks: string[], limit = 3): Promise<Record<string, BoardEntry[]> | null> {
    if (tracks.length === 0) return {};
    const query = `?n=${limit}&t=${tracks.map(encodeURIComponent).join(',')}`;
    const body = (await this.call(`/bs${query}`)) as {
      boards?: Record<string, unknown>;
    } | null;
    if (!body?.boards || typeof body.boards !== 'object') return null;
    const out: Record<string, BoardEntry[]> = {};
    for (const [track, rows] of Object.entries(body.boards)) out[track] = entriesIn(rows);
    return out;
  }

  /**
   * Send a time, and get the board back with it.
   *
   * One request rather than a submit and then a read: the finish panel wants
   * both — where you came and who is above you — and the server has the whole
   * board in its hand at the moment it decides. `rank` is null when the time
   * did not place; `top` still arrives, because the panel shows the leaders
   * whether or not you are among them.
   *
   * Null overall means it could not be sent. A player whose wifi dropped and a
   * player who finished eleventh both want the same thing from this screen,
   * which is for it to get out of the way.
   */
  async submit(
    track: string,
    name: string,
    time: number,
  ): Promise<{ rank: number | null; top: BoardEntry[]; was: string | null } | null> {
    const body = (await this.call(`/b/${encodeURIComponent(track)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, time }),
    })) as { rank?: unknown; top?: unknown; was?: unknown } | null;
    if (!body || !Array.isArray(body.top)) return null;
    return {
      rank: typeof body.rank === 'number' && body.rank >= 0 ? body.rank : null,
      top: entriesIn(body.top),
      was: typeof body.was === 'string' ? body.was : null,
    };
  }

  /**
   * The lap of whoever is top of this track, or null.
   *
   * Null is the ordinary answer, not an error: most tracks have a board and no
   * ghost behind it, because only a run posted from a build with this in it
   * ever uploads one. Every caller treats it as "no gold car today".
   */
  async ghost(track: string): Promise<BoardGhost | null> {
    const body = (await this.call(
      `/g/${encodeURIComponent(track)}`,
      undefined,
      GHOST_TIMEOUT,
    )) as { ghost?: { name?: unknown; time?: unknown; frames?: unknown } | null } | null;
    const stored = body?.ghost;
    if (!stored || typeof stored.name !== 'string' || typeof stored.time !== 'number') return null;
    if (typeof stored.frames !== 'string') return null;
    const frames = fromBase64(stored.frames);
    return frames ? { name: stored.name, time: stored.time, frames } : null;
  }

  /**
   * Attach a lap to a time that has just gone top of the board.
   *
   * Called only after `submit` came back with rank 0, because that is the only
   * case the server accepts — it checks the name and the time against first
   * place rather than taking the client's word for either. Fails soft like
   * everything else here: a record with no ghost behind it is a board entry,
   * which is what every record was until now.
   */
  async submitGhost(
    track: string,
    name: string,
    time: number,
    frames: Float32Array,
  ): Promise<boolean> {
    const body = (await this.call(
      `/g/${encodeURIComponent(track)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, time, frames: toBase64(frames) }),
      },
      GHOST_TIMEOUT,
    )) as { stored?: unknown } | null;
    return body?.stored === true;
  }
}

/**
 * The board to use, or null when there is none.
 *
 * `?rooms=` points the game at a local `wrangler dev`, exactly as it does for
 * the broker — the board lives in the same worker, so one switch moves both and
 * there is no second address to keep in step. That is now literally true:
 * the address and the rules about overriding it are `roomHttp.ts`'s, and this
 * file had its own copy of the URL until one of them would have been changed
 * alone.
 */
export function boardFor(params: URLSearchParams): Leaderboard | null {
  const base = brokerBase(params);
  return base ? new Leaderboard(base) : null;
}
