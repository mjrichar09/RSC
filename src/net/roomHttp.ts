/**
 * The `Room` implementation that talks to the broker in `server/`.
 *
 * Five POSTs and nothing else. There is no socket to hold open, no library, no
 * reconnection logic and no state: each call is a request, and if one fails the
 * next poll tries again a second later. That is the entire reason the transport
 * is HTTP rather than a WebSocket — the handshake is two messages, and a
 * protocol that survives a dropped request by making another one is a great
 * deal less code than one that has to notice a connection died.
 *
 * Nothing here knows about WebRTC. It carries two opaque strings; what they mean
 * is `signalling.ts`'s business.
 */

import type { Handshake, Reply, Room } from './room.js';

/**
 * Where the broker lives.
 *
 * Empty means there is none, and that is a supported state rather than a broken
 * one: the lobby falls back to the invite-code paste, which needs no
 * infrastructure and never stops working. That fallback is not legacy, it is
 * the floor this feature sits on — on a LAN with no internet, or on the day
 * this service stops being paid for, it is what multiplayer still is.
 *
 * The worker is in `server/`; `server/README.md` says how to deploy your own.
 */
export const ROOM_BROKER = 'https://rsc-rooms.rsc-rooms.workers.dev';

/**
 * How long any one call is allowed to take, milliseconds.
 *
 * Short, because every one of these is inside a poll loop that will simply try
 * again. A request hanging for the browser's default is a poll loop that has
 * stopped polling, which shows up as a lobby doing nothing.
 */
const REQUEST_TIMEOUT = 8_000;

export class HttpRoom implements Room {
  constructor(private readonly base: string) {}

  private async call(code: string, action: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetch(`${this.base.replace(/\/$/, '')}/r/${code}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 204) {
        throw new Error(`the room service answered ${response.status}`);
      }
      return response;
    } catch (error) {
      // One message for every way a fetch can fail — offline, DNS, CORS, the
      // abort above — because to a player they are all the same thing and the
      // browser's own wording for them is not.
      if (error instanceof Error && error.message.startsWith('the room service')) throw error;
      throw new Error('could not reach the room service');
    } finally {
      clearTimeout(timer);
    }
  }

  async publish(code: string, offer: string): Promise<string> {
    const response = await this.call(code, 'publish', { offer });
    const body = (await response.json()) as { ticket: string };
    return body.ticket;
  }

  async claim(code: string): Promise<Handshake | null> {
    const response = await this.call(code, 'claim');
    // 204 is the normal empty case, not a failure: the host is between offers.
    if (response.status === 204) return null;
    return (await response.json()) as Handshake;
  }

  async reply(code: string, ticket: string, reply: string): Promise<void> {
    await this.call(code, 'reply', { ticket, reply });
  }

  async collect(code: string): Promise<Reply[]> {
    const response = await this.call(code, 'collect');
    if (response.status === 204) return [];
    const body = (await response.json()) as { replies: Reply[] };
    return body.replies ?? [];
  }

  async close(code: string): Promise<void> {
    // Best effort. The room expires on its own a minute later, so a failure
    // here costs nothing and must not be reported to a player who is closing
    // a lobby and has stopped caring.
    await this.call(code, 'close').catch(() => {});
  }
}

/**
 * The broker to use, or null when there is none.
 *
 * `?rooms=http://localhost:8787` points the game at a local `wrangler dev`,
 * which is how this gets tested without deploying — and the same switch is what
 * `netcheck` uses to drive the room path against a broker it started itself.
 */
export function brokerFor(params: URLSearchParams): Room | null {
  const override = params.get('rooms');
  const base = override ?? ROOM_BROKER;
  if (!base) return null;
  return new HttpRoom(base);
}
