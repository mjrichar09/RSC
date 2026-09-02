/**
 * Running the WebRTC handshake through a room instead of through two people.
 *
 * `webrtc.ts` already has both halves of the exchange and neither of them
 * changes here: the host still calls `createInvite()` and gets a code, the
 * guest still calls `acceptInvite(code)` and gets a reply. All this does is
 * carry those two strings, which used to be carried by a chat window.
 *
 * Everything above the wire is untouched — `RaceHost` takes an `RtcLink` the
 * same way whichever route it arrived by, and the paste path still works.
 *
 * ### One guest at a time, on purpose
 *
 * An offer belongs to one peer connection, so the host cannot put out a single
 * offer and let three guests take it. It could hold three in flight; it does
 * not, because serial is simpler to reason about and the cost is that the
 * second of two simultaneous joiners waits about a second. What the host does
 * do is republish the *instant* an offer is claimed rather than waiting for the
 * connection it belongs to to finish opening — so the queue is never empty for
 * longer than a round trip, and a slow connection does not block the next
 * player behind it.
 *
 * ### The handshake is injected
 *
 * `createInvite` and `acceptInvite` are parameters with real defaults, for the
 * same reason the damage model takes a random stream: it makes the interesting
 * part testable without the expensive part. The choreography — claiming once,
 * matching a reply to its ticket, a guest arriving before the host published,
 * an offer nobody ever answers — is all reachable over `LoopbackRoom` with fake
 * handshakes, in milliseconds. Two real browsers prove the transport, and they
 * are much too slow to be where a logic mistake is first noticed.
 */

import { acceptInvite as realAccept, createInvite as realCreate, type RtcLink } from './webrtc.js';
import type { Room } from './room.js';

/** The two halves of `webrtc.ts`, injectable so the choreography can be tested. */
export interface Handshaker<L = RtcLink> {
  createInvite: () => Promise<{
    code: string;
    accept: (reply: string) => Promise<void>;
    link: L;
    connected: Promise<void>;
    cancel: () => void;
  }>;
  acceptInvite: (code: string) => Promise<{
    reply: string;
    link: Promise<L>;
    connected: Promise<void>;
  }>;
}

const REAL: Handshaker = {
  createInvite: realCreate,
  acceptInvite: (code) => realAccept(code),
};

export interface ServeOptions<L = RtcLink> {
  room: Room;
  code: string;
  /** How many guests to accept before the room stops offering. */
  slots: number;
  /** A guest connected. This is where `RaceHost.accept` goes. */
  onLink: (link: L) => void;
  /** Progress and trouble, for the lobby to show. */
  onStatus?: (message: string) => void;
  /** Milliseconds between polls for a reply. */
  poll?: number;
  /**
   * How long to wait for the answer to a claimed offer, milliseconds.
   *
   * A guest can claim an offer and then close the tab, and that offer is spent
   * — nobody else can take it. Without a deadline the room would sit there
   * holding a handshake that is never going to complete, looking to everyone
   * else like a host that has stopped accepting players.
   */
  replyTimeout?: number;
  handshake?: Handshaker<L>;
}

export interface ServedRoom {
  /** Stop offering and drop the room. Safe to call twice. */
  close: () => void;
  /** Guests connected so far. */
  readonly connected: number;
}

const DEFAULT_POLL = 900;
const DEFAULT_REPLY_TIMEOUT = 25_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Host side: hold a room open and connect whoever turns up.
 *
 * Returns immediately; the work happens in the background loop.
 */
export function serveRoom<L = RtcLink>(options: ServeOptions<L>): ServedRoom {
  const {
    room,
    code,
    slots,
    onLink,
    onStatus = () => {},
    poll = DEFAULT_POLL,
    replyTimeout = DEFAULT_REPLY_TIMEOUT,
    handshake = REAL as unknown as Handshaker<L>,
  } = options;

  let closed = false;
  let connected = 0;
  /** Handshakes accepted but not yet open. They hold a slot so it is not oversold. */
  let inFlight = 0;
  /**
   * Replies that arrived for a ticket we were not waiting on.
   *
   * `collect` drains, so a reply read while waiting for a different ticket
   * would otherwise be thrown away — and the guest that sent it would wait for
   * a connection the host had already discarded.
   */
  const stray = new Map<string, string>();

  const waitForReply = async (ticket: string): Promise<string | null> => {
    const until = Date.now() + replyTimeout;
    while (!closed && Date.now() < until) {
      const held = stray.get(ticket);
      if (held !== undefined) {
        stray.delete(ticket);
        return held;
      }
      for (const reply of await room.collect(code)) {
        if (reply.ticket === ticket) return reply.reply;
        stray.set(reply.ticket, reply.reply);
      }
      await sleep(poll);
    }
    return null;
  };

  /**
   * Throw an invite away without ever having accepted a reply for it.
   *
   * `connected` has to be silenced explicitly. It is a promise that rejects on
   * a timeout whether or not anybody is listening, and on every path here that
   * abandons an invite nobody is: the result is an unhandled rejection landing
   * in the console some seconds later, pointing at a handshake that was
   * deliberately discarded. Found by the choreography tests, which surface it
   * as eight errors beside ten passes rather than as a browser warning nobody
   * reads.
   */
  const discard = (invite: { cancel: () => void; connected: Promise<void> }) => {
    invite.connected.catch(() => {});
    invite.cancel();
  };

  const loop = async () => {
    while (!closed && connected + inFlight < slots) {
      const invite = await handshake.createInvite();
      if (closed) {
        discard(invite);
        return;
      }
      const ticket = await room.publish(code, invite.code);
      onStatus(`Room open. Waiting for players…`);

      const reply = await waitForReply(ticket);
      if (closed) {
        discard(invite);
        return;
      }
      if (reply === null) {
        // Either nobody came, or somebody took the offer and vanished. Either
        // way this handshake is spent; put a fresh one up.
        discard(invite);
        continue;
      }

      try {
        await invite.accept(reply);
      } catch (error) {
        onStatus(`A player could not be connected: ${message(error)}`);
        discard(invite);
        continue;
      }

      // Counted from here, not from `connected`, so the loop cannot publish a
      // fourth offer while a third player is still opening their channel.
      inFlight++;
      void invite.connected
        .then(() => {
          inFlight--;
          connected++;
          onLink(invite.link);
          onStatus(
            connected + inFlight >= slots
              ? 'The grid is full.'
              : 'A player joined. Waiting for more, or start the race.',
          );
        })
        .catch((error: unknown) => {
          // The slot comes back: a player whose connection failed is not
          // occupying a place on the grid.
          inFlight--;
          onStatus(`A player dropped out before connecting: ${message(error)}`);
          if (!closed) void loop();
        });
      // Straight back round: the next offer goes up while this one is opening.
    }
  };

  void loop().catch((error: unknown) => onStatus(`Room closed: ${message(error)}`));

  return {
    close: () => {
      if (closed) return;
      closed = true;
      void room.close(code).catch(() => {});
    },
    get connected() {
      return connected;
    },
  };
}

export interface JoinOptions<L = RtcLink> {
  room: Room;
  code: string;
  onStatus?: (message: string) => void;
  /** How long to keep looking for an offer before giving up, milliseconds. */
  timeout?: number;
  poll?: number;
  handshake?: Handshaker<L>;
}

/**
 * Guest side: take an offer out of a room and connect to whoever left it.
 *
 * Retries rather than failing on the first empty claim, because an empty room
 * is the *normal* state between a host's offers — the gap is one round trip
 * wide and a guest that gave up on it would fail perhaps half the time.
 */
export async function joinRoom<L = RtcLink>(options: JoinOptions<L>): Promise<L> {
  const {
    room,
    code,
    onStatus = () => {},
    timeout = 20_000,
    poll = 700,
    handshake = REAL as unknown as Handshaker<L>,
  } = options;

  const until = Date.now() + timeout;
  let held: { ticket: string; offer: string } | null = null;
  onStatus('Looking for the room…');
  while (Date.now() < until) {
    held = await room.claim(code);
    if (held) break;
    await sleep(poll);
  }
  if (!held) {
    throw new Error(
      `Nobody is holding room ${code}. Check the code, or ask them to open the lobby first.`,
    );
  }

  onStatus('Found it — connecting…');
  const { reply, link, connected } = await handshake.acceptInvite(held.offer);
  // The reply goes back before the channel exists, and that ordering is not an
  // optimisation: the host cannot finish the connection until it has the reply,
  // and the channels do not arrive until the connection is finished. Waiting
  // for a channel before sending the reply deadlocks both sides.
  await room.reply(code, held.ticket, reply);
  onStatus('Reply sent — waiting for the host…');
  await connected;
  return link;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
