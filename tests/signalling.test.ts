/**
 * Finding each other by room code.
 *
 * The transport is not what is tested here — `netcheck` does that with two real
 * browsers, and it is far too slow to be where a logic mistake is first found.
 * What is tested is the choreography, which is where the mistakes actually are:
 * two guests reaching for one offer, a reply that has to find the handshake it
 * belongs to, a guest arriving in the gap between offers, and an offer claimed
 * by somebody who then walks away.
 *
 * Both halves of the WebRTC exchange are injected, so a "connection" here is a
 * string matching a string. That is the same trade `LoopbackWire` makes for the
 * netcode and it is the reason this file runs in milliseconds.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackRoom, formatRoomCode, makeRoomCode, normaliseRoomCode } from '../src/net/room.js';
import { joinRoom, serveRoom, type Handshaker } from '../src/net/signalling.js';

/**
 * A fake handshake where an offer is a name and the reply is that name echoed.
 *
 * Enough to prove the right reply reached the right offer, which is the only
 * thing the choreography can get wrong.
 */
function fakeHandshake(): { handshake: Handshaker<string>; offers: string[] } {
  const offers: string[] = [];
  let n = 0;
  const handshake: Handshaker<string> = {
    createInvite: async () => {
      const code = `offer-${++n}`;
      offers.push(code);
      let settle: () => void = () => {};
      let fail: (e: Error) => void = () => {};
      const connected = new Promise<void>((res, rej) => {
        settle = res;
        fail = rej;
      });
      return {
        code,
        accept: async (reply: string) => {
          if (reply !== `reply-to-${code}`) throw new Error(`wrong reply for ${code}: ${reply}`);
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
  return { handshake, offers };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('room codes', () => {
  it('avoids the characters that do not survive being read aloud', () => {
    for (let i = 0; i < 200; i++) {
      const code = makeRoomCode();
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/);
      // The ones a listener confuses: no zero/O, no one/I/L.
      expect(code).not.toMatch(/[01ILO]/);
    }
  });

  it('takes a code however it was typed', () => {
    // Down a phone, out of a chat message, with or without the dash.
    for (const typed of ['K7F-M29', 'k7fm29', ' K7F M29 ', 'k7f-m29\n']) {
      expect(normaliseRoomCode(typed), typed).toBe('K7FM29');
    }
    expect(formatRoomCode('K7FM29')).toBe('K7F-M29');
  });

  it('rejects what could not be a code before making a round trip', () => {
    expect(normaliseRoomCode('K7F')).toBeNull();
    expect(normaliseRoomCode('K7F-M290')).toBeNull();
    // Contains characters the alphabet deliberately excludes.
    expect(normaliseRoomCode('K0F-M29')).toBeNull();
    expect(normaliseRoomCode('KIF-M29')).toBeNull();
  });
});

describe('a room with somebody in it', () => {
  it('connects a guest to the host', async () => {
    const room = new LoopbackRoom();
    const { handshake } = fakeHandshake();
    const links: string[] = [];
    const served = serveRoom({
      room,
      code: 'K7FM29',
      slots: 3,
      onLink: (l) => links.push(l),
      poll: 5,
      handshake,
    });

    const link = await joinRoom({ room, code: 'K7FM29', poll: 5, handshake });
    await settle();

    expect(link).toBe('link-offer-1');
    expect(links).toEqual(['link-offer-1']);
    expect(served.connected).toBe(1);
    served.close();
  });

  it('puts a fresh offer up the moment one is taken', async () => {
    // Three guests one after another. Each must get its own offer: an offer
    // belongs to one peer connection, so two guests answering the same one
    // leaves the host able to complete only one of them.
    const room = new LoopbackRoom();
    const { handshake } = fakeHandshake();
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
    expect(new Set(links).size).toBe(3);
    expect(served.connected).toBe(3);
    served.close();
  });

  it('gives one offer to exactly one of two guests racing for it', async () => {
    // The claim is the whole reason this interface has a `claim` and not a
    // `read`. With latency in the way both guests are genuinely in flight at
    // once, which is the interleaving that matters and the one an instant
    // in-process store can never produce.
    const room = new LoopbackRoom(4);
    const { handshake } = fakeHandshake();
    const links: string[] = [];
    const served = serveRoom({
      room,
      code: 'K7FM29',
      slots: 3,
      onLink: (l) => links.push(l),
      poll: 5,
      handshake,
    });
    await settle();

    const both = await Promise.all([
      joinRoom({ room, code: 'K7FM29', poll: 5, handshake }),
      joinRoom({ room, code: 'K7FM29', poll: 5, handshake }),
    ]);
    await settle();

    // Both joined, and they did not both get the same handshake.
    expect(new Set(both).size).toBe(2);
    expect(new Set(links).size).toBe(2);
    served.close();
  });

  it('waits through the gap between offers instead of failing', async () => {
    // The room is empty for a round trip every time an offer is claimed. A
    // guest that gave up on the first empty claim would fail about half the
    // time on a busy lobby.
    const room = new LoopbackRoom(6);
    const { handshake } = fakeHandshake();
    const served = serveRoom({
      room,
      code: 'K7FM29',
      slots: 3,
      onLink: () => {},
      poll: 5,
      handshake,
    });

    // Join immediately — before the host has published anything at all.
    const link = await joinRoom({ room, code: 'K7FM29', poll: 5, handshake });
    expect(link).toBe('link-offer-1');
    served.close();
  });
});

describe('a room with nobody in it', () => {
  it('says so rather than hanging', async () => {
    const room = new LoopbackRoom();
    const { handshake } = fakeHandshake();
    await expect(
      joinRoom({ room, code: 'AAA222', timeout: 40, poll: 5, handshake }),
    ).rejects.toThrow(/Nobody is holding room AAA222/);
  });
});

describe('a guest that claims an offer and walks away', () => {
  it('does not leave the room stuck on a handshake nobody will finish', async () => {
    const room = new LoopbackRoom();
    const { handshake, offers } = fakeHandshake();
    const served = serveRoom({
      room,
      code: 'K7FM29',
      slots: 3,
      onLink: () => {},
      poll: 5,
      // Short, so the test does not sit through the real 25 s.
      replyTimeout: 60,
      handshake,
    });
    await settle();

    // Take the offer and never reply — a closed tab, mid-handshake.
    const stolen = await room.claim('K7FM29');
    expect(stolen).not.toBeNull();
    const abandoned = offers.length;

    // The host gives up on it and puts a new one out.
    await new Promise((r) => setTimeout(r, 160));
    expect(offers.length).toBeGreaterThan(abandoned);

    // And the room still works for somebody who does turn up.
    const link = await joinRoom({ room, code: 'K7FM29', poll: 5, handshake });
    expect(link).toMatch(/^link-offer-/);
    served.close();
  });
});

describe('closing a room', () => {
  it('drops it, so a stale code stops working', async () => {
    const room = new LoopbackRoom();
    const { handshake } = fakeHandshake();
    const served = serveRoom({
      room,
      code: 'K7FM29',
      slots: 3,
      onLink: () => {},
      poll: 5,
      handshake,
    });
    await settle();
    served.close();
    await settle();

    expect(room.has('K7FM29')).toBe(false);
    await expect(
      joinRoom({ room, code: 'K7FM29', timeout: 40, poll: 5, handshake }),
    ).rejects.toThrow(/Nobody is holding/);
  });
});
