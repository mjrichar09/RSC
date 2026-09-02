/**
 * The room broker itself, not a stand-in for it.
 *
 * `signalling.test.ts` proves the choreography over `LoopbackRoom`, which is an
 * in-memory fake. That leaves the one property this service exists to provide —
 * that taking an offer is atomic — tested only against a fake that was written
 * to have it. So this file drives the *real* `RoomStore` out of `server/src`,
 * over HTTP-shaped `Request`s, through the same `serveRoom`/`joinRoom` the game
 * uses.
 *
 * It runs in milliseconds and needs no wrangler, no account and no deploy,
 * because the broker's logic was deliberately kept free of Cloudflare types.
 * The Worker in `index.ts` is thirty lines of routing on top of this and is the
 * only part that genuinely needs the platform to test.
 */

import { describe, expect, it } from 'vitest';
import { RoomStore } from '../server/src/rooms.js';
import type { Handshake, Reply, Room } from '../src/net/room.js';
import { joinRoom, serveRoom, type Handshaker } from '../src/net/signalling.js';

/**
 * The client adapter, pointed at a `RoomStore` instead of at a URL.
 *
 * Deliberately built the same way `HttpRoom` is — POST a JSON body, read a JSON
 * body, treat 204 as "nothing there" — so what is exercised is the real request
 * and response shapes rather than a method call dressed up as one.
 */
class DirectRoom implements Room {
  constructor(private readonly store: RoomStore) {}

  private async call(code: string, action: string, body?: unknown): Promise<Response> {
    return this.store.fetch(
      new Request(`https://rooms/${code}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    );
  }

  async publish(code: string, offer: string): Promise<string> {
    const r = await this.call(code, 'publish', { offer });
    return ((await r.json()) as { ticket: string }).ticket;
  }

  async claim(code: string): Promise<Handshake | null> {
    const r = await this.call(code, 'claim');
    return r.status === 204 ? null : ((await r.json()) as Handshake);
  }

  async reply(code: string, ticket: string, reply: string): Promise<void> {
    await this.call(code, 'reply', { ticket, reply });
  }

  async collect(code: string): Promise<Reply[]> {
    const r = await this.call(code, 'collect');
    return r.status === 204 ? [] : ((await r.json()) as { replies: Reply[] }).replies;
  }

  async close(code: string): Promise<void> {
    await this.call(code, 'close');
  }
}

function fakeHandshake(): Handshaker<string> {
  let n = 0;
  return {
    createInvite: async () => {
      const code = `offer-${++n}`;
      let settle: () => void = () => {};
      let fail: (e: Error) => void = () => {};
      const connected = new Promise<void>((res, rej) => {
        settle = res;
        fail = rej;
      });
      return {
        code,
        accept: async (reply: string) => {
          if (reply !== `reply-to-${code}`) throw new Error(`wrong reply for ${code}`);
          settle();
        },
        link: `link-${code}`,
        connected,
        cancel: () => fail(new Error('cancelled')),
      };
    },
    acceptInvite: async (code: string) => ({
      reply: `reply-to-${code}`,
      link: Promise.resolve(`link-${code}`),
      connected: Promise.resolve(),
    }),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('the broker', () => {
  it('hands one offer to exactly one claimer', async () => {
    // The property the whole service exists for. An offer belongs to one peer
    // connection; two guests answering the same one leaves the host able to
    // complete only one of them, and the other waits forever.
    const store = new RoomStore();
    const room = new DirectRoom(store);
    await room.publish('K7FM29', 'the-offer');

    const claims = await Promise.all([
      room.claim('K7FM29'),
      room.claim('K7FM29'),
      room.claim('K7FM29'),
    ]);
    expect(claims.filter((c) => c !== null)).toHaveLength(1);
    expect(claims.find((c) => c !== null)?.offer).toBe('the-offer');
  });

  it('replaces an unclaimed offer rather than queueing it', async () => {
    // A host that gave up waiting must be able to leave a fresh offer without
    // the stale one being taken a moment later by somebody it can no longer
    // answer — its peer connection is closed.
    const room = new DirectRoom(new RoomStore());
    await room.publish('K7FM29', 'stale');
    await room.publish('K7FM29', 'fresh');
    expect((await room.claim('K7FM29'))?.offer).toBe('fresh');
    expect(await room.claim('K7FM29')).toBeNull();
  });

  it('delivers each reply once', async () => {
    const room = new DirectRoom(new RoomStore());
    const ticket = await room.publish('K7FM29', 'o');
    await room.claim('K7FM29');
    await room.reply('K7FM29', ticket, 'r');
    expect(await room.collect('K7FM29')).toEqual([{ ticket, reply: 'r' }]);
    // Drained: collecting twice must not hand the host a reply it has already
    // used, or it would accept the same handshake a second time.
    expect(await room.collect('K7FM29')).toEqual([]);
  });

  it('says nothing rather than inventing a room nobody opened', async () => {
    const room = new DirectRoom(new RoomStore());
    expect(await room.claim('AAA222')).toBeNull();
    expect(await room.collect('AAA222')).toEqual([]);
    // A reply to a room with no host is a guest whose host has gone. Creating
    // the room here would leave it sitting there until the sweep.
    await room.reply('AAA222', 't1', 'r');
    expect(await room.collect('AAA222')).toEqual([]);
  });

  it('forgets a room when the host closes it', async () => {
    const room = new DirectRoom(new RoomStore());
    await room.publish('K7FM29', 'o');
    await room.close('K7FM29');
    expect(await room.claim('K7FM29')).toBeNull();
  });

  it('refuses an offer that is not a string, or is absurdly long', async () => {
    const store = new RoomStore();
    const bad = async (body: unknown) =>
      (
        await store.fetch(
          new Request('https://rooms/K7FM29/publish', {
            method: 'POST',
            body: JSON.stringify(body),
          }),
        )
      ).status;
    expect(await bad({})).toBe(400);
    expect(await bad({ offer: 42 })).toBe(400);
    expect(await bad({ offer: 'x'.repeat(10_000) })).toBe(400);
    // And nothing was allocated by any of them.
    expect(await new DirectRoom(store).claim('K7FM29')).toBeNull();
  });
});

describe('the broker, driven by the game', () => {
  it('connects three guests to a host, each on its own handshake', async () => {
    const room = new DirectRoom(new RoomStore());
    const handshake = fakeHandshake();
    const links: string[] = [];
    const served = serveRoom({
      room,
      code: 'K7FM29',
      slots: 3,
      onLink: (l) => links.push(l),
      poll: 5,
      handshake,
    });

    for (let i = 0; i < 3; i++) {
      await joinRoom({ room, code: 'K7FM29', poll: 5, handshake });
      await settle();
    }

    expect(links).toHaveLength(3);
    expect(new Set(links).size).toBe(3);
    served.close();
  });

  it('stops offering once the grid is full', async () => {
    const room = new DirectRoom(new RoomStore());
    const handshake = fakeHandshake();
    const served = serveRoom({
      room,
      code: 'K7FM29',
      slots: 1,
      onLink: () => {},
      poll: 5,
      handshake,
    });

    await joinRoom({ room, code: 'K7FM29', poll: 5, handshake });
    await settle();
    expect(served.connected).toBe(1);

    // A fourth player finds nothing to take, and is told so rather than hanging.
    await expect(
      joinRoom({ room, code: 'K7FM29', timeout: 60, poll: 5, handshake }),
    ).rejects.toThrow(/Nobody is holding/);
    served.close();
  });
});
