/**
 * The room broker's actual logic, with no Cloudflare in it.
 *
 * Split out from `index.ts` for one reason: this is the part that can be wrong,
 * and separating it from the platform glue is what lets `tests/rooms.test.ts`
 * run the *real* broker — not a reimplementation of it — through the same
 * choreography the game uses, in milliseconds, with no wrangler and no deploy.
 *
 * The atomic claim is the thing worth testing. If a reimplementation were tested
 * instead, the one property this service exists to provide would be the one
 * property nothing checked.
 *
 * Web-standard types only: `Request`, `Response`, `URL`. Those exist in the
 * Worker runtime and in Node, which is what makes the above possible.
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

/**
 * The most rooms one store will hold at once.
 *
 * Not a scaling limit — it is the ceiling on what a script hammering `publish`
 * with random codes can make this thing allocate. Reached, the oldest rooms go
 * first, which for a real lobby means the ones that already expired.
 */
const MAX_ROOMS = 5_000;

/** Offers and replies are compact codes; anything much longer is not one. */
const MAX_FIELD = 4_000;

interface RoomState {
  /** The offer waiting to be claimed, if any. Cleared *by* the claim. */
  offer: { ticket: string; offer: string } | null;
  /** Replies the host has not collected yet. */
  replies: { ticket: string; reply: string }[];
  touched: number;
}

export class RoomStore {
  private readonly rooms = new Map<string, RoomState>();
  private tickets = 0;

  private sweep(now: number): void {
    for (const [code, room] of this.rooms) {
      if (now - room.touched > ROOM_TTL) this.rooms.delete(code);
    }
    // Insertion order, so the oldest go first. Only reachable by abuse.
    while (this.rooms.size > MAX_ROOMS) {
      const oldest = this.rooms.keys().next().value;
      if (oldest === undefined) break;
      this.rooms.delete(oldest);
    }
  }

  private touch(code: string, now: number): RoomState {
    let room = this.rooms.get(code);
    if (!room) {
      room = { offer: null, replies: [], touched: now };
      this.rooms.set(code, room);
    }
    room.touched = now;
    return room;
  }

  async fetch(request: Request): Promise<Response> {
    const now = Date.now();
    this.sweep(now);

    const [, code, action] = new URL(request.url).pathname.split('/');
    if (!code || !action) return empty(404);

    switch (action) {
      case 'publish': {
        const body = (await request.json().catch(() => null)) as { offer?: unknown } | null;
        if (typeof body?.offer !== 'string' || body.offer.length > MAX_FIELD) {
          return json({ error: 'no offer' }, 400);
        }
        const room = this.touch(code, now);
        const ticket = `t${++this.tickets}`;
        // Replaces whatever was there. A host that gave up waiting on an
        // unclaimed offer must be able to leave a fresh one without the stale
        // one being taken a moment later by somebody it can no longer answer.
        room.offer = { ticket, offer: body.offer };
        return json({ ticket });
      }

      case 'claim': {
        const room = this.rooms.get(code);
        if (!room) return empty(204);
        room.touched = now;
        const held = room.offer;
        if (!held) return empty(204);
        // The atomic bit, and the reason this is a Durable Object: the object
        // is single-threaded, so between reading `offer` and clearing it no
        // other request can run. Whoever gets here first takes it; the next
        // caller finds nothing.
        room.offer = null;
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
        // there until the sweep.
        const room = this.rooms.get(code);
        if (!room) return empty(204);
        room.touched = now;
        room.replies.push({ ticket: body.ticket, reply: body.reply });
        return empty(204);
      }

      case 'collect': {
        const room = this.rooms.get(code);
        if (!room) return json({ replies: [] });
        room.touched = now;
        // Draining, so a reply is delivered once and the room does not grow.
        // The host is the only caller, so there is no second reader to race.
        return json({ replies: room.replies.splice(0) });
      }

      case 'close': {
        this.rooms.delete(code);
        return empty(204);
      }

      default:
        return empty(404);
    }
  }
}
