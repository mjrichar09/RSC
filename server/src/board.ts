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
 * How much one address may do per minute, by what it is asking for.
 *
 * Reading is generous because the arcade screen is one `/bs` per open and a
 * player flicking through conditions is not an attack. Writing is not: a human
 * finishes a stage every minute or two at the very best, so ten is already far
 * past what playing can produce, and a ghost is up to 370 KB so it gets less
 * still.
 *
 * These are a cost ceiling and a nuisance floor, not a security control —
 * anything that needs to be *true* needs an account behind it, which this
 * board deliberately does not have. What they stop is one bored person filling
 * every slot on every track in a minute, and a runaway client emptying the
 * free tier by lunchtime.
 */
export const RATE_LIMITS = { read: 120, submit: 10, ghost: 5 } as const;

/** The window those counts apply to, ms. */
const RATE_WINDOW = 60_000;

/**
 * How many addresses are tracked before the oldest are forgotten.
 *
 * Held in memory rather than storage on purpose. Rate-limit state is worth
 * nothing once it is stale, and a write per request would cost more — in
 * Durable Object storage operations, which are billed — than the traffic it is
 * protecting against. A Durable Object is evicted when idle, so the counters
 * reset after a quiet spell, which is the correct behaviour: an attacker who
 * pauses long enough to be forgotten has already stopped attacking, and one
 * who does not keeps the object alive and keeps the limits with it.
 */
const RATE_TABLE_MAX = 5000;

export type RateKind = keyof typeof RATE_LIMITS;

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
 * Measured rather than guessed: the AI drives the fastest stage in the game,
 * Vieux Village, in 33.0 s, and nothing else is under 37. A human record is
 * slower than the AI's author lap, not faster, so 25 s is comfortably below
 * anything anybody can actually drive and comfortably above the numbers a
 * forger types. An hour is not a lap either.
 *
 * It still does not adjudicate a close time — nothing here can. It rejects
 * garbage, overflow, and the lazy `"time": 6`.
 */
export const MIN_TIME = 25;
const MAX_TIME = 3600;

/**
 * How much recording a lap of a given length has to come with, bytes of
 * base64 per second of lap.
 *
 * A record has to arrive with the lap that set it — that is the one check here
 * that is expensive to forge, because a fake time then needs a fake recording
 * whose length agrees with it.
 *
 * Derived from what the recorder actually produces. `sim/replay.ts` samples at
 * 60 Hz and writes 14 floats a frame, so a second of lap is 60 x 56 = 3360
 * bytes raw and 4480 encoded. Measured across all fourteen stages the ratio
 * comes out flat, as it must: Vieux Village 33.0 s / 144 KB, Pine Loop 41.0 s
 * / 179 KB, Grand Traverse 90.2 s / 395 KB, Coldwater Pass 126.5 s / 554 KB —
 * 4470 bytes per second every time.
 *
 * Set at 70% of that, so a slow connection truncating nothing and a recorder
 * that starts a frame late both still pass, and a submission carrying a token
 * gesture of a ghost does not.
 *
 * A flat floor was the other option and it cannot work: 200 KB would have been
 * more than the whole ghost of six of the fourteen stages, including Pine
 * Loop, which is the free one everybody plays.
 */
const GHOST_BYTES_PER_SECOND = 3130;

/**
 * And an absolute floor, whatever the arithmetic says.
 *
 * The shortest possible legitimate ghost is a 25 s lap, which is 112 KB. Half
 * of that is a number no real recording is under and no gesture is over.
 */
const MIN_RECORD_GHOST = 56_000;

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
 * Letters and nothing else, with the usual dodges undone.
 *
 * A filter that matches the literal word catches nobody: the first thing
 * anyone tries is a zero for an o and a dollar for an s, then a dot between
 * every letter. This flattens the substitutions, drops everything that is not
 * a letter, and collapses runs of the same letter — so `f.u.u.c.k`, `PH-U-C-K`
 * and `fuuuck` all land on the same string as the word itself.
 *
 * Deliberately aggressive, because it is only ever used to *compare*. The name
 * that gets stored is what the player typed.
 */
function flatten(name: string): string {
  return name
    .toLowerCase()
    .replace(/[4@]/g, 'a')
    .replace(/[8]/g, 'b')
    .replace(/[3€]/g, 'e')
    .replace(/[6]/g, 'g')
    .replace(/[1l|!]/g, 'i')
    .replace(/[0°]/g, 'o')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[2]/g, 'z')
    .replace(/ph/g, 'f')
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1{1,}/g, '$1');
}

/**
 * Words a public leaderboard should not display.
 *
 * Stored flattened, because that is what they are compared against — writing
 * them the normal way and flattening at startup would be tidier and would also
 * mean `cleanName` did work on every call for a list that never changes.
 *
 * This is a first line, not a solution. It covers the common English
 * profanity and the slurs somebody reaches for in the first thirty seconds; it
 * will not cover everything, and it is not supposed to. Anything that needs to
 * be *right* wants a maintained word list and somebody able to delete an entry
 * after the fact — see the note on `fetch` about that second part being the
 * one that actually matters.
 */
const BANNED = [
  'fuck', 'shit', 'cunt', 'bitch', 'bastard', 'wanker', 'twat', 'prick',
  'dick', 'cock', 'pussy', 'arsehole', 'asshole', 'bollocks', 'wank',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'spastic', 'tranny',
  'paki', 'chink', 'kike', 'spic', 'coon', 'wetback', 'gook',
  'rape', 'rapist', 'nazi', 'hitler', 'pedo', 'paedo',
  'cum', 'jizz', 'anal', 'penis', 'vagina', 'porn',
].map(flatten);

/**
 * Words short enough that a substring match would eat innocent names.
 *
 * `fag` inside `Fagan`, `cum` inside `Cumbria`, `coon` inside `Cocoon`. These
 * have to match the whole name or nothing. Three letters was four once, which
 * quietly meant `fuck` and `shit` only matched on their own — `shitter` went
 * straight through, which is how this number got measured rather than picked.
 */
const WHOLE_ONLY = 3;

/**
 * The ones worth catching even with the vowels mangled.
 *
 * Vowel substitution is the second thing everybody tries — `f4ck`, `fck`,
 * `sh!t` — and no table of letter swaps catches it, because the digit is not
 * standing in for the letter it usually means. Comparing consonants only does
 * catch it, and it is too blunt to use on the whole list: run it on `cunt` and
 * `Canute` goes with it. So it is a short list of the words most likely to be
 * dressed up, and the cost is a handful of unlucky real names.
 */
const SKELETONS = ['fuck', 'shit', 'nigger', 'faggot', 'cunt'].map((w) =>
  flatten(w).replace(/[aeiou]/g, ''),
);

/**
 * Real words that contain a banned one, and are allowed anyway.
 *
 * Matching substrings means the Scunthorpe problem is real rather than
 * theoretical: `cunt` is inside Scunthorpe, `cock` inside Hitchcock, `anal`
 * inside analysis, `dick` inside Dickens. Somebody's actual name being refused
 * by a leaderboard is a worse failure than a rude one getting through, so the
 * collisions anybody can predict are listed here.
 *
 * Matched against the *whole* flattened name, not as a substring: `Scunthorpe`
 * is a person's town and `xXScunthorpeXx` is somebody who has read this list.
 *
 * It is a starting set, and it is supposed to grow. The first time a real
 * player is refused their own name, their name goes here.
 */
const ALLOWED = [
  'scunthorpe', 'cockburn', 'hitchcock', 'woodcock', 'cocktail',
  'dickens', 'dickinson', 'dickson', 'dicky', 'benedick',
  'penistone', 'clitheroe', 'lightwater', 'assington',
  'analysis', 'analyst', 'analogue', 'banal', 'canal',
  'cumbria', 'cummings', 'cumberland', 'circumstance',
  'shiitake', 'bassett', 'grape', 'grapes', 'drape', 'scrape', 'therapist',
].map(flatten);

/**
 * Whether a name is one of those, or contains one.
 *
 * Substring rather than whole word, because `xXfuckerXx` is the same problem
 * as `fucker` — and then `ALLOWED` takes back the collisions that creates.
 */
export function offensive(name: string): boolean {
  const flat = flatten(name);
  if (!flat) return false;
  if (ALLOWED.includes(flat)) return false;
  if (BANNED.some((word) => (word.length <= WHOLE_ONLY ? flat === word : flat.includes(word)))) {
    return true;
  }
  const bones = flat.replace(/[aeiou]/g, '');
  // Only on names with enough consonants to mean anything: a two-letter name
  // has a one-letter skeleton and would match almost anything.
  return bones.length >= 3 && SKELETONS.some((skeleton) => bones.includes(skeleton));
}

/**
 * Clean a submitted name, or reject it.
 *
 * Control characters are stripped rather than rejected: they arrive from a
 * paste far more often than from malice, and dropping a stray tab is kinder
 * than refusing a run somebody just drove. What is left has to be non-empty
 * after trimming, which is the actual requirement.
 *
 * And it has to be something a stranger's board can display. Rejected rather
 * than masked: a name replaced with asterisks is a puzzle to be solved by
 * trying again, and the player gets told rather than quietly renamed.
 */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim();
  if (stripped.length === 0 || offensive(stripped)) return null;
  return stripped;
}

/**
 * The name on a delete, which is *not* run through the word filter.
 *
 * Whatever is being taken down got onto the board before the filter caught it,
 * or before the filter existed. Refusing to name it because it is offensive
 * would make exactly the entries this endpoint is for the ones it cannot
 * remove.
 */
function cleanNameForDelete(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NAME).trim();
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
  /** Per-address counters, by kind. See `RATE_TABLE_MAX`. */
  private readonly hits = new Map<string, { until: number; n: number }>();

  constructor(private readonly storage: BoardStorage) {}

  /**
   * Count one request against an address, and say whether it may proceed.
   *
   * A fixed window rather than a sliding one: it is a handful of arithmetic
   * per request and the failure mode — twice the allowance across a window
   * boundary — does not matter for a limit chosen this far above real play.
   *
   * `now` is a parameter so the tests can drive the clock rather than sleep.
   */
  allow(kind: RateKind, address: string, now = Date.now()): boolean {
    // No address means the request did not come through the edge — a direct
    // object call, or a test. Nothing to attribute it to, so nothing to limit.
    if (!address) return true;

    if (this.hits.size > RATE_TABLE_MAX) {
      for (const [key, seen] of this.hits) if (seen.until <= now) this.hits.delete(key);
      // Still full of live entries: this is either a very popular minute or a
      // distributed flood, and either way the table itself must not grow
      // without bound. Dropping it costs one window of accounting.
      if (this.hits.size > RATE_TABLE_MAX) this.hits.clear();
    }

    const key = `${kind}:${address}`;
    const seen = this.hits.get(key);
    if (!seen || seen.until <= now) {
      this.hits.set(key, { until: now + RATE_WINDOW, n: 1 });
      return true;
    }
    seen.n++;
    return seen.n <= RATE_LIMITS[kind];
  }

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
  /**
   * How much ghost a claimed time has to be accompanied by, in base64 bytes.
   *
   * Exported shape rather than a literal at the call site so the rule and the
   * error message cannot drift apart.
   */
  static ghostNeededFor(time: number): number {
    return Math.max(MIN_RECORD_GHOST, Math.floor(time * GHOST_BYTES_PER_SECOND));
  }

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

  /**
   * Remove one entry, and the ghost behind it if it was the record.
   *
   * There is no moderation on a board with no accounts, so the only thing that
   * makes it safe to show strangers is being able to take something down
   * afterwards. Everything else here guesses in advance; this is the one that
   * fixes what got through.
   */
  async remove(track: string, name: string): Promise<{ removed: boolean; top: Entry[] }> {
    const board = await this.read(track);
    const at = board.findIndex((e) => e.name.toLowerCase() === name.toLowerCase());
    if (at < 0) return { removed: false, top: board };

    const wasLeader = at === 0;
    board.splice(at, 1);
    await this.storage.put(`b:${track}`, board);
    // The ghost belongs to whoever was first. Dropping the leader without it
    // leaves a lap on the road with nobody's name against it — `ghost()` would
    // refuse to serve it anyway, so this only saves the space, but a blob that
    // can never be read again is not worth keeping.
    if (wasLeader) await this.storage.put(`g:${track}`, undefined as unknown as StoredGhost);
    return { removed: true, top: board };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    /*
     * Who is asking, and may they.
     *
     * The address arrives as a header the worker in `index.ts` copies off
     * `CF-Connecting-IP`, which Cloudflare sets at the edge and a client
     * cannot forge — a header of the same name sent by the client is
     * overwritten before it reaches the worker.
     */
    const from = request.headers.get('x-from') ?? '';
    const kind: RateKind =
      request.method !== 'POST' ? 'read' : parts[0] === 'g' ? 'ghost' : 'submit';
    if (!this.allow(kind, from)) {
      return new Response(JSON.stringify({ error: 'slow down' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(Math.ceil(RATE_WINDOW / 1000)),
          ...CORS,
        },
      });
    }

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

    /*
     * DELETE /b/:track?name=… — take one entry down.
     *
     * The worker has already checked the secret; by the time a request is
     * here it is authorised or it is not a DELETE. Nothing about the key is
     * visible in this file, which is the same reason the rate limiter reads an
     * address it was handed rather than a header it trusts.
     */
    if (request.method === 'DELETE') {
      const name = cleanNameForDelete(url.searchParams.get('name'));
      if (!name) return json({ error: 'bad name' }, 400);
      return json(await this.remove(track, name));
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
    const at = Math.round(time * 1000) / 1000;

    /*
     * A new best has to arrive with the lap that set it.
     *
     * Checked before anything is written, so a record can never exist on this
     * board without the recording behind it — which is the one check here that
     * is genuinely expensive to forge, because the ghost has to be long enough
     * to agree with the time being claimed.
     *
     * Only for first place. Everything below it is a name and a number and
     * always was; asking every finisher to upload 300 KB to sit ninth would
     * cost far more than it is worth.
     */
    const board = await this.read(track);
    const wouldLead = placeOf(board, at) === 0 && (board[0] === undefined || at < board[0].time);
    const frames = (body as { frames?: unknown }).frames;
    if (wouldLead) {
      const need = BoardStore.ghostNeededFor(at);
      const have = typeof frames === 'string' ? frames.length : 0;
      if (have < need) {
        return json({ error: 'a record needs its ghost', needsGhost: true, need, have }, 400);
      }
      if (have > MAX_GHOST || !/^[A-Za-z0-9+/]+={0,2}$/.test(frames as string)) {
        return json({ error: 'bad ghost' }, 400);
      }
    }

    const result = await this.submit(track, name, at);
    // Stored after the entry, so the ghost is never the thing left behind by a
    // submission that did not place.
    if (result.rank === 0 && typeof frames === 'string') {
      await this.putGhost(track, name, at, frames);
    }
    return json(result);
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
