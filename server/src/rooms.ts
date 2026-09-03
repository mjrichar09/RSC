/**
 * The room broker's actual logic, with no Cloudflare in it.
 *
 * Split out from `index.ts` for one reason: this is the part that can be wrong,
 * and separating it from the platform glue is what lets `tests/rooms.test.ts`
 * run the *real* broker — not a reimplementation of it — through the same
 * choreography the game uses, in milliseconds, with no wrangler and no deploy.
 *
 * ### State lives in storage, not in a field
 *
 * The first version kept rooms in a `Map`, reasoning that a room is sixty
 * seconds of state that never needs to survive anything. That reasoning was
 * wrong and the real runtime said so within a minute of being asked: a Durable
 * Object is *not* a process that stays running. It is evicted when idle and
 * reconstructed on the next request, and everything held in a field goes with
 * it. In-memory state is a cache, never a record.
 *
 * A handshake spans several seconds and four requests, which is comfortably
 * long enough to be evicted in the middle of. The symptom is the worst kind:
 * nothing errors, `collect` simply returns no replies, and the guest waits
 * forever for a host that never saw its answer. Found by driving the deployed
 * worker rather than the fake — `LoopbackRoom` has no eviction to reproduce,
 * and never could have caught it.
 *
 * So everything goes through `RoomStorage`, which is the shape of the Durable
 * Object's own storage. The tests hand it a Map-backed implementation; the
 * object hands it `state.storage`. That is also what the SQLite-backed
 * namespace the free plan insists on is actually for.
 */

const CORS = {
  // The game is served from GitHub Pages and from wherever anyone forks it to,
  // and the broker holds nothing worth protecting: two opaque strings that are
  // useless without the room code, and gone in a minute. An origin allowlist
  // here would be a maintenance burden pretending to be a security control.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });

export const empty = (status: number): Response =>
  new Response(null, { status, headers: CORS });

/** A room code as the broker will accept it: six unambiguous characters. */
export const ROOM_CODE = /^[2-9A-HJ-NP-Z]{6}$/;

/**
 * How long a room survives without being touched, milliseconds.
 *
 * Both sides poll while they are waiting, so an open lobby keeps itself alive
 * without needing a heartbeat of its own, and a browser that was closed takes
 * its room with it a minute later. Long enough to survive a slow handshake,
 * short enough that an abandoned code is free again quickly.
 */
export const ROOM_TTL = 60_000;

/** Offers and replies are compact codes; anything much longer is not one. */
const MAX_FIELD = 4_000;

/**
 * The subset of `DurableObjectStorage` this needs.
 *
 * Declared rather than imported so this file stays free of Cloudflare types and
 * can be driven directly from the repository's tests.
 */
export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

/** A Map-backed `RoomStorage`, for the tests and for nothing else. */
export class MemoryStorage implements RoomStorage {
  private readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.data) {
      if (!options?.prefix || key.startsWith(options.prefix)) out.set(key, value as T);
    }
    return out;
  }
}

interface RoomState {
  /** The offer waiting to be claimed, if any. Cleared *by* the claim. */
  offer: { ticket: string; offer: string } | null;
  /** Replies the host has not collected yet. */
  replies: { ticket: string; reply: string }[];
  touched: number;
  /** Monotonic per room, so a ticket is unique without a global counter. */
  issued: number;
}

const KEY = 'r:';

export class RoomStore {
  constructor(private readonly storage: RoomStorage) {}

  /**
   * Read a room, treating an expired one as absent.
   *
   * Lazily rather than on a timer: a room that nobody touches again is only
   * taking up a few bytes, and the sweep on `publish` clears those. Checking on
   * read is what makes the TTL actually mean something, because a room read
   * two minutes later must not still be handing out its stale offer.
   */
  private async read(code: string, now: number): Promise<RoomState | null> {
    const room = await this.storage.get<RoomState>(KEY + code);
    if (!room) return null;
    if (now - room.touched > ROOM_TTL) {
      await this.storage.delete(KEY + code);
      return null;
    }
    return room;
  }

  private async write(code: string, room: RoomState, now: number): Promise<void> {
    room.touched = now;
    await this.storage.put(KEY + code, room);
  }

  /**
   * Drop everything that has expired.
   *
   * Only on `publish`, which happens a few times per race — the read path is
   * hit by every poll from both sides and must stay a single key lookup.
   */
  private async sweep(now: number): Promise<void> {
    const all = await this.storage.list<RoomState>({ prefix: KEY });
    for (const [key, room] of all) {
      if (now - room.touched > ROOM_TTL) await this.storage.delete(key);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const now = Date.now();
    const [, code, action] = new URL(request.url).pathname.split('/');
    if (!code || !action) return empty(404);

    switch (action) {
      case 'publish': {
        const body = (await request.json().catch(() => null)) as { offer?: unknown } | null;
        if (typeof body?.offer !== 'string' || body.offer.length > MAX_FIELD) {
          return json({ error: 'no offer' }, 400);
        }
        await this.sweep(now);
        const room = (await this.read(code, now)) ?? {
          offer: null,
          replies: [],
          touched: now,
          issued: 0,
        };
        const ticket = `t${++room.issued}`;
        // Replaces whatever was there. A host that gave up waiting on an
        // unclaimed offer must be able to leave a fresh one without the stale
        // one being taken a moment later by somebody it can no longer answer.
        room.offer = { ticket, offer: body.offer };
        await this.write(code, room, now);
        return json({ ticket });
      }

      case 'claim': {
        const room = await this.read(code, now);
        if (!room?.offer) {
          // Still a touch: a guest polling an empty room is a guest waiting on
          // a host that is between offers, and the room must not expire under
          // them while they wait.
          if (room) await this.write(code, room, now);
          return empty(204);
        }
        const held = room.offer;
        // The atomic bit, and the reason this is a Durable Object: the object
        // is single-threaded, so no other request runs between this read and
        // the write below. Whoever gets here first takes it; the next caller
        // finds nothing.
        room.offer = null;
        await this.write(code, room, now);
        return json(held);
      }

      case 'reply': {
        const body = (await request.json().catch(() => null)) as {
          ticket?: unknown;
          reply?: unknown;
        } | null;
        if (
          typeof body?.ticket !== 'string' ||
          typeof body.reply !== 'string' ||
          body.reply.length > MAX_FIELD
        ) {
          return json({ error: 'no reply' }, 400);
        }
        // Not created here: a reply to a room nobody is holding is a guest
        // whose host has gone, and inventing the room would leave it sitting
        // there until it expired.
        const room = await this.read(code, now);
        if (!room) return empty(204);
        room.replies.push({ ticket: body.ticket, reply: body.reply });
        await this.write(code, room, now);
        return empty(204);
      }

      case 'collect': {
        const room = await this.read(code, now);
        if (!room) return json({ replies: [] });
        // Draining, so a reply is delivered once and the room does not grow.
        // The host is the only caller, so there is no second reader to race.
        const replies = room.replies;
        room.replies = [];
        await this.write(code, room, now);
        return json({ replies });
      }

      case 'close': {
        await this.storage.delete(KEY + code);
        return empty(204);
      }

      default:
        return empty(404);
    }
  }
}
