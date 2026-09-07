/**
 * The global times board.
 *
 * Ten times per track with a name against each, held by the same Cloudflare
 * Worker as the room broker (`server/src/board.ts`). No ghosts — see that file
 * for why — so this carries a name and a number and nothing else.
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

const ROOM_BROKER = 'https://rsc-rooms.rsc-rooms.workers.dev';

/** How long any call is allowed to take before it is abandoned, ms. */
const TIMEOUT = 4000;

export interface BoardEntry {
  name: string;
  time: number;
  at: number;
}

export class Leaderboard {
  constructor(private readonly base: string) {}

  private async call(path: string, init?: RequestInit): Promise<unknown | null> {
    // `AbortSignal.timeout` rather than a race against a timer: the point is to
    // stop *waiting*, and a promise race leaves the request itself running and
    // the connection held.
    try {
      const response = await fetch(`${this.base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT),
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
      top?: BoardEntry[];
    } | null;
    return Array.isArray(body?.top) ? body.top : null;
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
      boards?: Record<string, BoardEntry[]>;
    } | null;
    return body?.boards ?? null;
  }

  /**
   * Send a time. Resolves to the place it took, or null if it did not place
   * or could not be sent.
   *
   * The two are deliberately the same answer. A player who has just finished
   * outside the top ten and a player whose wifi dropped both want the same
   * thing from this screen, which is for it to say nothing and get out of the
   * way — and there is no useful action either of them could take.
   */
  async submit(track: string, name: string, time: number): Promise<number | null> {
    const body = (await this.call(`/b/${encodeURIComponent(track)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, time }),
    })) as { rank?: number } | null;
    return typeof body?.rank === 'number' && body.rank >= 0 ? body.rank : null;
  }
}

/**
 * The board to use, or null when there is none.
 *
 * `?rooms=` points the game at a local `wrangler dev`, exactly as it does for
 * the broker — the board lives in the same worker, so one switch moves both and
 * there is no second address to keep in step.
 */
export function boardFor(params: URLSearchParams): Leaderboard | null {
  const base = params.get('rooms') ?? ROOM_BROKER;
  return base ? new Leaderboard(base) : null;
}
