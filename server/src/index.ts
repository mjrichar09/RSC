/**
 * The room broker: a Cloudflare Worker in front of one Durable Object.
 *
 * It holds an offer and the reply to it for a few seconds so two browsers can
 * find each other, and then forgets. It never carries game traffic — once the
 * data channel opens the players are talking directly and this could vanish
 * mid-race without anyone noticing.
 *
 * See `../README.md` for why this is a Durable Object and not KV. The short
 * version: taking an offer must be atomic, because an offer belongs to exactly
 * one peer connection, and an eventually consistent store cannot promise that.
 *
 * This file is only the platform glue — routing, CORS preflight, and the object
 * binding. Everything that can actually be wrong lives in `rooms.ts`, which has
 * no Cloudflare types in it and is exercised directly by the repository's tests.
 */

import { ROOM_CODE, RoomStore, empty, json } from './rooms.js';
import { BoardStore, TRACK_KEY, safeDecode } from './board.js';

export interface Env {
  ROOMS: DurableObjectNamespace;
  BOARDS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return empty(204);

    const parts = new URL(request.url).pathname.split('/').filter(Boolean);

    // /b/:track — the leaderboard. Read with GET, submit with POST. A separate
    // object from the rooms because the two have nothing to do with each other
    // and opposite lifetimes: a room is sixty seconds of state nobody minds
    // losing, a board is the only thing here meant to be permanent. Sharing one
    // object would put every leaderboard read behind the handshake traffic of
    // whoever happened to be starting a race.
    if (parts[0] === 'b' || parts[0] === 'bs') {
      if (request.method !== 'GET' && request.method !== 'POST') return empty(405);
      const url = new URL(request.url);
      // Decoded before it is checked: the key carries a colon, which the
      // client percent-encodes into the path.
      const track = parts[1] ? safeDecode(parts[1]) : undefined;
      // Checked at the edge so a malformed key never reaches the object and
      // can never allocate storage. The batch read carries its keys in the
      // query string instead, and `many` filters them the same way.
      if (parts[0] === 'b' && (parts.length !== 2 || !track || !TRACK_KEY.test(track))) {
        return json({ error: 'bad track' }, 400);
      }
      const boards = env.BOARDS.get(env.BOARDS.idFromName('boards'));
      return boards.fetch(
        new Request(
          `https://boards/${parts[0]}${track ? `/${encodeURIComponent(track)}` : ''}${url.search}`,
          {
            method: request.method,
            headers: { 'content-type': 'application/json' },
            ...(request.method === 'POST' ? { body: await request.text() } : {}),
          },
        ),
      );
    }

    if (request.method !== 'POST') return empty(405);
    // /r/:code/:action
    if (parts.length !== 3 || parts[0] !== 'r') return empty(404);
    const code = parts[1]!.toUpperCase();
    // Checked at the edge so a malformed code never reaches the object and can
    // never allocate a room. This is the only input validation that matters:
    // everything else the store holds is opaque and length-capped.
    if (!ROOM_CODE.test(code)) return json({ error: 'bad room code' }, 400);

    // One object for everything. At this scale a single-threaded actor handling
    // a handful of requests a second is not a bottleneck, and it keeps every
    // room in one place where the claim is trivially atomic. If it ever became
    // one, the shard key is the room code and nothing else changes.
    const id = env.ROOMS.idFromName('rooms');
    // The body is read here and forwarded as a string rather than piped through
    // as a stream. Forwarding `request.body` along with the original headers
    // means handing on a `content-length` that describes a body the runtime is
    // now re-framing, and it killed the object mid-request. There is at most
    // four kilobytes of it; buffering costs nothing and removes a whole class
    // of question.
    const body = await request.text();
    return env.ROOMS.get(id).fetch(
      new Request(`https://rooms/${code}/${parts[2]}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
  },
};

/**
 * The Durable Object.
 *
 * All of its behaviour is `RoomStore`, and all of its *state* is
 * `state.storage` — deliberately not a field on this class. An object is
 * evicted when idle and rebuilt on the next request, so anything held in a
 * field is gone by the time the second half of a handshake arrives.
 */
/**
 * The leaderboard object.
 *
 * One for every track, for the same reason the rooms share one: a
 * single-threaded actor handling a handful of requests a second is not a
 * bottleneck at this scale, and it makes "insert this time and keep the best
 * ten" trivially atomic — which is the one thing a leaderboard has to get
 * right, and the reason this is a Durable Object rather than KV. Two players
 * finishing at once against an eventually consistent store is one of them
 * silently overwriting the other's place.
 */
export class Boards {
  private readonly store: BoardStore;

  constructor(state: DurableObjectState) {
    this.store = new BoardStore(state.storage);
  }

  fetch(request: Request): Promise<Response> {
    return this.store.fetch(request);
  }
}

export class Rooms {
  private readonly store: RoomStore;

  constructor(state: DurableObjectState) {
    this.store = new RoomStore(state.storage);
  }

  fetch(request: Request): Promise<Response> {
    return this.store.fetch(request);
  }
}
