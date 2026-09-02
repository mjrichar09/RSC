/**
 * The rendezvous: where two browsers find each other.
 *
 * WebRTC needs an out-of-band channel to swap two strings — an offer and an
 * answer — before it can open a direct connection. Everything after that is
 * peer-to-peer and costs nobody anything, which is why this game has always
 * been able to run as a static site with no server at all: it made the *players*
 * the channel. The host sends an invite code, the guest sends a reply code back,
 * and whatever chat window they were already talking in did the signalling.
 *
 * That is free forever and it is friction every single time. This is the other
 * option: a broker small enough to be nearly free, holding two strings for a
 * few seconds so the players only have to agree on a room name.
 *
 * `Room` is deliberately the smallest interface that can do it — four calls and
 * no notion of players, lobbies, or the game. That is what makes it swappable:
 * the Cloudflare Worker in `server/` is one implementation, `LoopbackRoom` below
 * is another, and the tests use the second to check the choreography without a
 * network. The paste path in `webrtc.ts` is not deleted and is not a legacy
 * path — it is what the game falls back to when there is no broker, on a LAN
 * with no internet, or on the day this service stops being paid for.
 *
 * ### Why a claim rather than a read
 *
 * An offer belongs to exactly one `RTCPeerConnection` on the host. If two
 * guests read the same offer, both answer it, and the host can only use one —
 * the other guest waits forever for a connection nobody is completing. So
 * taking an offer is a *claim*: atomic, and it can succeed only once. That is
 * the one thing a backend here has to get right, and it is why an eventually
 * consistent store is not usable for this however cheap it is.
 */

/** A ticket identifies one handshake: one offer and the reply to it. */
export interface Handshake {
  ticket: string;
  offer: string;
}

export interface Reply {
  ticket: string;
  reply: string;
}

export interface Room {
  /**
   * Host: put an offer up for the next guest. Resolves to its ticket.
   *
   * Replaces any unclaimed offer already there. A host that has been waiting
   * and has given up on an unclaimed offer must be able to leave a fresh one
   * without the stale one being taken a moment later.
   */
  publish(code: string, offer: string): Promise<string>;

  /**
   * Guest: take the outstanding offer, atomically. Null when there is none —
   * which is normal, not an error: the host may be between offers.
   */
  claim(code: string): Promise<Handshake | null>;

  /** Guest: post the answer to a claimed ticket. */
  reply(code: string, ticket: string, reply: string): Promise<void>;

  /**
   * Host: take every reply posted since the last call.
   *
   * Draining rather than reading, so a reply is delivered once and the room
   * does not grow. The host is the only caller, so there is no question of two
   * readers racing for one reply.
   */
  collect(code: string): Promise<Reply[]>;

  /** Host: the race has started or the lobby closed. Best-effort. */
  close(code: string): Promise<void>;
}

/**
 * The alphabet room codes are drawn from.
 *
 * No 0/O, no 1/I/L. A room code's whole job is to survive being read aloud
 * across a table or typed from a text message, and those are the characters
 * that do not survive it. 31 symbols over 6 places is 887 million codes, which
 * is far more than enough for collisions never to matter at any scale this game
 * will see — and the check on joining is "is anybody in this room", so a
 * collision is a failed join rather than two races merging.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

/** A fresh room code, formatted the way it is shown: `K7F-M29`. */
export function makeRoomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
    if (i === 2) out += '-';
  }
  return out;
}

/**
 * Normalise whatever the player typed.
 *
 * Case, spaces and the dash are all noise — somebody reading a code down a
 * phone will say "K 7 F M 2 9" and somebody copying it from a message may keep
 * the dash or not. Both are the same room. Returns null when what is left could
 * not be a code at all, so the UI can say so before a pointless round trip.
 */
export function normaliseRoomCode(input: string): string | null {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (stripped.length !== CODE_LENGTH) return null;
  for (const ch of stripped) if (!ALPHABET.includes(ch)) return null;
  return stripped;
}

/** How a code is shown once it is known to be valid. */
export function formatRoomCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/**
 * A room broker in this process.
 *
 * The `LoopbackWire` of signalling, and it exists for the same reason: the
 * choreography — claiming exactly once, matching a reply to its ticket, a guest
 * that arrives before the host has published — is where the bugs are, and none
 * of it needs a network to test. Two real browsers are for proving the
 * transport, and they are far too slow to be the first place a mistake is
 * found.
 *
 * `latency` makes the interleavings that matter reachable: with every call
 * resolving instantly, two guests racing for one offer is a race the test can
 * never actually run.
 */
export class LoopbackRoom implements Room {
  private readonly rooms = new Map<
    string,
    { offer: { ticket: string; offer: string } | null; replies: Reply[] }
  >();
  private tickets = 0;

  /** Simulated round-trip, milliseconds. */
  constructor(private readonly latency = 0) {}

  /** Every call goes through here, so latency applies to all of them equally. */
  private async trip<T>(value: () => T): Promise<T> {
    if (this.latency > 0) await new Promise((r) => setTimeout(r, this.latency));
    return value();
  }

  private room(code: string) {
    let entry = this.rooms.get(code);
    if (!entry) {
      entry = { offer: null, replies: [] };
      this.rooms.set(code, entry);
    }
    return entry;
  }

  publish(code: string, offer: string): Promise<string> {
    return this.trip(() => {
      const ticket = `t${++this.tickets}`;
      this.room(code).offer = { ticket, offer };
      return ticket;
    });
  }

  claim(code: string): Promise<Handshake | null> {
    return this.trip(() => {
      const entry = this.room(code);
      const held = entry.offer;
      // The claim is the whole point: whoever gets here first takes it, and the
      // next caller finds nothing rather than a second copy.
      entry.offer = null;
      return held;
    });
  }

  reply(code: string, ticket: string, reply: string): Promise<void> {
    return this.trip(() => {
      this.room(code).replies.push({ ticket, reply });
    });
  }

  collect(code: string): Promise<Reply[]> {
    return this.trip(() => this.room(code).replies.splice(0));
  }

  close(code: string): Promise<void> {
    return this.trip(() => {
      this.rooms.delete(code);
    });
  }

  /** Test helper: is anybody holding this room open? */
  has(code: string): boolean {
    return this.rooms.has(code);
  }
}
