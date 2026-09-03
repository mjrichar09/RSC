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

export interface Env {
  ROOMS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return empty(204);
    if (request.method !== 'POST') return empty(405);

    const parts = new URL(request.url).pathname.split('/').filter(Boolean);
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
export class Rooms {
  private readonly store: RoomStore;

  constructor(state: DurableObjectState) {
    this.store = new RoomStore(state.storage);
  }

  fetch(request: Request): Promise<Response> {
    return this.store.fetch(request);
  }
}
