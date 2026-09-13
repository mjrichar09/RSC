/**
 * What arrives from somebody else, and what it is allowed to do.
 *
 * Every value in here crossed a trust boundary: an invite code pasted from a
 * chat window or opened from a `?join=` link, a `hello` from whoever took the
 * room code, a reply posted to a broker by anyone who knows one. None of it
 * was checked at the boundary it crossed, so each of these is a fix with a
 * test rather than a test with a fix.
 *
 * Deliberately cheap — no world, no browser, no wire. These are properties of
 * the parsing, and the expensive integration paths in `net.test.ts` cannot
 * tell you what happens to a name that is not a string, because a well-behaved
 * client never sends one.
 */

import { describe, expect, it } from 'vitest';
import { RaceHost } from '../src/net/host.js';
import {
  type Link,
  type NetMessage,
  PROTOCOL_VERSION,
  cleanInput,
  cleanName,
  cleanNumber,
} from '../src/net/protocol.js';
import { codec } from '../src/net/webrtc.js';
import { brokerBase } from '../src/net/roomHttp.js';
import { MemoryStorage, RoomStore } from '../server/src/rooms.js';

/** A link that records what the host sends and lets a test send anything back. */
class FakeLink implements Link {
  readonly sent: NetMessage[] = [];
  closed = false;
  rtt: number | null = null;
  private handler: ((message: NetMessage) => void) | null = null;

  send(message: NetMessage): void {
    this.sent.push(message);
  }
  onMessage(handler: (message: NetMessage) => void): void {
    this.handler = handler;
  }
  onClose(): void {}
  close(): void {
    this.closed = true;
  }
  /** Say anything at all, including things the type says are impossible. */
  say(message: unknown): void {
    this.handler?.(message as NetMessage);
  }
}

const helloFrom = (link: FakeLink, extra: Record<string, unknown>) =>
  link.say({ t: 'hello', version: PROTOCOL_VERSION, livery: 'works', number: 7, ...extra });

describe('a guest the host has never met', () => {
  it('cannot knock the lobby over by sending a name that is not a name', () => {
    const host = new RaceHost({ name: 'Host' });
    const link = new FakeLink();
    host.accept(link);

    // `message.name.slice(0, 16)` threw a TypeError inside the host's own
    // message handler for this, which is a guest able to break the lobby it
    // is joining just by being wrong about the protocol.
    expect(() => helloFrom(link, { name: 42 })).not.toThrow();
    expect(host.players).toHaveLength(2);
    expect(typeof host.players[1]!.name).toBe('string');
  });

  it('is named rather than allowed to be nameless', () => {
    const host = new RaceHost();
    const link = new FakeLink();
    host.accept(link);
    helloFrom(link, { name: '   ' });
    expect(host.players[1]!.name).toBe('Player 2');
  });

  it('cannot put control characters into a name the lobby draws', () => {
    expect(cleanName('a\u0000b\u001fc', 'x')).toBe('a b c');
    expect(cleanName('x'.repeat(40), 'x')).toHaveLength(16);
  });

  it('races under a number that fits on a roof', () => {
    const host = new RaceHost();
    const link = new FakeLink();
    host.accept(link);
    helloFrom(link, { name: 'Guest', number: 1e9 });
    expect(host.players[1]!.number).toBe(99);

    expect(cleanNumber(Number.NaN)).toBe(1);
    expect(cleanNumber(-5)).toBe(1);
    expect(cleanNumber('7' as unknown)).toBe(1);
  });

  it('cannot drive the host world with a number that is not one', () => {
    // `clamp` passes NaN through — it is neither below the floor nor above
    // the ceiling — so one input with a missing field used to reach a rigid
    // body and take every car in the race out of the world with it.
    expect(cleanInput({ throttle: Number.NaN, brake: 0, steer: 0, handbrake: 0 })).toEqual({
      throttle: 0,
      brake: 0,
      steer: 0,
      handbrake: 0,
    });
    expect(cleanInput(null).steer).toBe(0);
    expect(cleanInput({ steer: 1e9 }).steer).toBe(1);
    expect(cleanInput({ steer: -1e9 }).steer).toBe(-1);
    expect(cleanInput({ throttle: -1 }).throttle).toBe(0);
    // A real input is untouched.
    expect(cleanInput({ throttle: 0.5, brake: 0, steer: -0.25, handbrake: 1 })).toEqual({
      throttle: 0.5,
      brake: 0,
      steer: -0.25,
      handbrake: 1,
    });
  });
});

/**
 * A code that was written rather than generated.
 *
 * `putTogether` builds an SDP by joining lines with CRLF, and three of the
 * values it interpolates come out of the code. SDP has no escaping — the
 * grammar is one value per line — so a ufrag carrying a newline is however
 * many extra lines the sender wanted in a description this side is about to
 * hand to `setRemoteDescription`.
 */
describe('a hand-written invite code', () => {
  /** The compact format, built by hand so the fields can be poisoned. */
  const compactCode = (ufrag: string, pwd: string, candidates: string[] = []): string => {
    const text = new TextEncoder();
    const parts: number[] = [];
    const push = (bytes: Uint8Array | number[]) => parts.push(...bytes);
    // setup 'actpass' (index 0), offer, version 1.
    parts.push(1);
    const u = text.encode(ufrag);
    parts.push(u.length);
    push(u);
    const p = text.encode(pwd);
    parts.push(p.length);
    push(p);
    push(new Uint8Array(32));
    parts.push(candidates.length);
    for (const name of candidates) {
      const bytes = text.encode(name);
      // family 0 (a name rather than an IP), type 'host'.
      parts.push(0x00, bytes.length);
      push(bytes);
      parts.push(0x20, 0x00);
    }
    let raw = '';
    for (const byte of parts) raw += String.fromCharCode(byte);
    return `C${btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  };

  it('cannot smuggle extra SDP lines through the ICE credentials', async () => {
    const poisoned = compactCode('ab\r\na=candidate:9 1 udp 1 10.0.0.1 1 typ host', 'pwd');
    await expect(codec.decode(poisoned)).rejects.toThrow(/readable invite/);
  });

  it('refuses a password that could not have come from a browser', async () => {
    await expect(codec.decode(compactCode('abcd', 'pw\r\na=setup:passive'))).rejects.toThrow(
      /readable invite/,
    );
  });

  it('drops a candidate address that is neither an IP nor a hostname', async () => {
    const back = await codec.decode(
      compactCode('abcd', 'efghijkl', ['host.local', 'x\r\na=setup:passive']),
    );
    expect(back.sdp).toContain('host.local');
    expect(back.sdp).not.toContain('a=setup:passive');
    // And the whole description is still one well-formed block of lines.
    expect(back.sdp!.split('\r\n').filter((l) => l && !/^[a-z]=/.test(l))).toEqual([]);
  });

  it('refuses a truncated code rather than building half a description', async () => {
    const whole = compactCode('abcd', 'efghijkl');
    await expect(codec.decode(whole.slice(0, 8))).rejects.toThrow(/readable invite/);
    // And one that is not base64 at all, which is what half a paste looks like.
    await expect(codec.decode('C!!!')).rejects.toThrow(/readable invite/);
  });

  it('still reads a code a browser produced', async () => {
    const sdp = [
      'v=0',
      'o=- 1 1 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'a=ice-ufrag:b9d6',
      'a=ice-pwd:4YVFwSg4x1swi1rAMzVgeUEZ',
      'a=fingerprint:sha-256 00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F',
      'a=setup:actpass',
      'a=candidate:1 1 udp 1677729535 203.0.113.7 51820 typ srflx',
      '',
    ].join('\r\n');
    const back = await codec.decode(await codec.encode({ type: 'offer', sdp }));
    expect(back.sdp).toContain('203.0.113.7 51820 typ srflx');
  });
});

/**
 * Where a link is allowed to point the game.
 *
 * `?rooms=` is a developer switch for a local `wrangler dev`, and it was read
 * straight out of the URL — so a link was a redirect. Everything the lobby
 * does and every leaderboard submission (a name and a time) would have gone
 * to whoever wrote the link, with nothing on screen to say so.
 */
describe('the broker address', () => {
  const base = (search: string) => brokerBase(new URLSearchParams(search));

  it('is the shipped one when nothing says otherwise', () => {
    expect(base('')).toContain('workers.dev');
  });

  it('is nothing at all for an empty override, which is the paste-only lobby', () => {
    expect(base('rooms=')).toBeNull();
  });

  it('follows an override to this machine, which is what it is for', () => {
    expect(base('rooms=http://localhost:8787')).toBe('http://localhost:8787');
    expect(base('rooms=http://127.0.0.1:9/none')).toBe('http://127.0.0.1:9/none');
  });

  it('ignores one pointing anywhere else', () => {
    expect(base('rooms=https://somewhere.else')).toContain('workers.dev');
    expect(base('rooms=//somewhere.else')).toContain('workers.dev');
    expect(base('rooms=javascript:alert(1)')).toContain('workers.dev');
  });
});

describe('the broker, under someone who is not playing', () => {
  const post = (store: RoomStore, code: string, action: string, body: unknown) =>
    store.fetch(
      new Request(`https://rooms/${code}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('does not let a room grow without bound on replies nobody asked for', async () => {
    const store = new RoomStore(new MemoryStorage());
    await post(store, 'ABCDEF', 'publish', { offer: 'o' });
    for (let i = 0; i < 200; i++) {
      await post(store, 'ABCDEF', 'reply', { ticket: `t${i}`, reply: 'x'.repeat(4000) });
    }
    const collected = (await (await post(store, 'ABCDEF', 'collect', {})).json()) as {
      replies: unknown[];
    };
    expect(collected.replies.length).toBeLessThanOrEqual(16);
    // The newest survive: an old one belongs to a handshake that timed out.
    expect(collected.replies).toContainEqual({ ticket: 't199', reply: 'x'.repeat(4000) });
  });

  it('refuses a ticket that is not one', async () => {
    const store = new RoomStore(new MemoryStorage());
    await post(store, 'ABCDEF', 'publish', { offer: 'o' });
    const bad = await post(store, 'ABCDEF', 'reply', { ticket: 't'.repeat(500), reply: 'r' });
    expect(bad.status).toBe(400);
  });

  it('still delivers a real reply to the ticket that asked for it', async () => {
    const store = new RoomStore(new MemoryStorage());
    const published = (await (await post(store, 'ABCDEF', 'publish', { offer: 'o' })).json()) as {
      ticket: string;
    };
    await post(store, 'ABCDEF', 'reply', { ticket: published.ticket, reply: 'answer' });
    const collected = (await (await post(store, 'ABCDEF', 'collect', {})).json()) as {
      replies: { ticket: string; reply: string }[];
    };
    expect(collected.replies).toEqual([{ ticket: published.ticket, reply: 'answer' }]);
  });
});
