/**
 * A pair of links that talk to each other in this process.
 *
 * This is what makes the netcode testable. Every property worth protecting —
 * that a guest's car ends up where the host says, that a dropped guest's car
 * stops being driven, that a snapshot arriving late is not applied backwards —
 * is a property of the *protocol*, not of WebRTC, and testing it through a real
 * data channel would mean testing the browser instead.
 *
 * Latency and loss are simulated, because netcode that has only ever run at
 * zero milliseconds is netcode that has never run.
 */

import type { Link, NetMessage } from './protocol.js';

export interface LoopbackOptions {
  /** One-way delay in milliseconds. */
  latency?: number;
  /**
   * Extra one-way delay on the way *to* `a`, milliseconds.
   *
   * `a` is where the host sits, here and in the game, so this is the uplink —
   * and on a mobile network the uplink is the slow half. An LTE or 5G handset
   * has to ask for a transmit slot before it can send, which routinely costs
   * tens of milliseconds that the downlink does not pay.
   *
   * It exists because the wire was symmetric, and a symmetric wire cannot see
   * a whole class of bug: anything that estimates one-way delay as half a round
   * trip is exactly right on this wire by construction, and wrong by half the
   * asymmetry on a real phone. That is the same shape of blind spot as a wire
   * with fixed latency, which can never deliver out of order and quietly made
   * every test assert that reordering does not happen.
   */
  uplink?: number;
  /**
   * Variation either side of that delay, milliseconds, on the unordered
   * traffic only.
   *
   * Without it the wire delivers strictly in send order and every test written
   * against it is quietly asserting that reordering never happens — which is
   * exactly what the `fast` channel does not promise.
   */
  jitter?: number;
  /** Fraction of messages to drop, 0..1. */
  loss?: number;
  /**
   * Mean length of a run of dropped packets. 1 is independent loss.
   *
   * Radio links do not lose packets independently — a handset behind a lorry
   * loses a burst and then nothing. It matters because the netcode's response
   * to one missing input and to twelve missing inputs are different responses:
   * a single gap is covered, and a burst is long enough for the host to start
   * fading a guest's throttle toward zero while the guest keeps predicting
   * full commitment. Independent loss at the same rate never reaches that.
   */
  burst?: number;
  /**
   * Packets a second each leg can actually carry. 0 is unlimited.
   *
   * The one property of a real link that delay and loss together cannot
   * imitate, and the one that matters most on a phone: a leg that is offered
   * more than it can carry does not *drop* the excess, it queues it. WebRTC
   * data channels ride SCTP, which applies congestion control to the whole
   * association even where the channel itself is unordered with no
   * retransmits — so the packets are not lost, they go out later, and later,
   * and later. Every input the guest sends arrives further behind than the one
   * before it, which is a different failure from loss and needs a different
   * answer.
   *
   * A radio uplink is usually narrow in *packets* rather than in bytes, so
   * this is a rate of packets and not of bits.
   */
  capacity?: number;
  /** Deterministic stream for the loss rolls. */
  random?: () => number;
  /** Clock, in milliseconds. Defaults to a manual one driven by `advance`. */
  now?: () => number;
}

interface Pending {
  at: number;
  message: NetMessage;
  to: LoopbackLink;
}

/**
 * Two ends of one wire, plus the queue between them.
 *
 * Time does not pass on its own: `advance` moves the clock and delivers
 * whatever is due. A test that controls the clock can assert what a client does
 * with a snapshot that arrives 200 ms late, which is the interesting case and
 * the one real hardware refuses to reproduce on demand.
 */
export class LoopbackWire {
  readonly a: LoopbackLink;
  readonly b: LoopbackLink;

  private queue: Pending[] = [];
  private clock = 0;
  private readonly latency: number;
  private readonly uplink: number;
  private readonly jitter: number;
  private readonly loss: number;
  private readonly burst: number;
  private readonly capacity: number;
  private readonly random: () => number;
  /** Packets still to drop in the current burst, per direction. */
  private readonly dropping = new Map<LoopbackLink, number>();
  /** When each leg is next free to put a packet on the wire. */
  private readonly busyUntil = new Map<LoopbackLink, number>();

  constructor(options: LoopbackOptions = {}) {
    this.latency = options.latency ?? 0;
    this.uplink = options.uplink ?? 0;
    this.jitter = options.jitter ?? 0;
    this.loss = options.loss ?? 0;
    this.burst = Math.max(options.burst ?? 1, 1);
    this.capacity = options.capacity ?? 0;
    this.random = options.random ?? (() => 0.5);
    this.a = new LoopbackLink(this);
    this.b = new LoopbackLink(this);
    this.a.peer = this.b;
    this.b.peer = this.a;
  }

  get now(): number {
    return this.clock;
  }

  /** Queue a message for the other end. */
  post(to: LoopbackLink, message: NetMessage): void {
    // Never drop the messages that set a race up: a lost `welcome` is a bug in
    // the transport's reliability, not a case the game logic should handle.
    const droppable = message.t === 'input' || message.t === 'snap';
    if (droppable && this.dropped(to)) return;
    // Jitter applies only to the unordered traffic, and that is the whole point
    // of it: `control` is an ordered, reliable channel and cannot reorder, while
    // `fast` is unordered with no retransmits and routinely does. A wire with
    // fixed latency can never deliver out of order, so every test written
    // against one was quietly asserting that reordering does not happen.
    const spread = droppable && this.jitter > 0 ? (this.random() - 0.5) * 2 * this.jitter : 0;
    // Toward `a` is toward the host, and that is the leg the asymmetry is on.
    const delay = this.latency + (to === this.a ? this.uplink : 0);

    /*
     * Wait for the leg to be free, then fly.
     *
     * This is what turns "too many packets" into a growing delay rather than
     * into loss. Offered more than it can carry, the queue never empties and
     * every packet leaves later than the one before it — which is precisely
     * what a saturated mobile uplink does to a guest sending sixty inputs a
     * second, and what no amount of latency or loss on their own can imitate.
     */
    let sendAt = this.clock;
    if (this.capacity > 0) {
      const gap = 1000 / this.capacity;
      sendAt = Math.max(this.clock, this.busyUntil.get(to) ?? 0);
      this.busyUntil.set(to, sendAt + gap);
    }
    this.queue.push({ at: sendAt + Math.max(delay + spread, 0), message, to });
  }

  /** How far behind a leg has fallen, milliseconds. The bufferbloat readout. */
  backlog(toHost = true): number {
    const to = toHost ? this.a : this.b;
    return Math.max((this.busyUntil.get(to) ?? 0) - this.clock, 0);
  }

  /**
   * Is this leg already behind on its realtime traffic?
   *
   * The wire's stand-in for a data channel's `bufferedAmount`, and it exists
   * for the same reason: a sender that cannot see the queue in front of it will
   * keep adding to it. `LoopbackLink.send` asks this before putting anything on
   * the fast path, so the drop-rather-than-queue rule is the one the game is
   * tested against and not merely the one the browser gets.
   */
  saturated(to: LoopbackLink): boolean {
    if (this.capacity <= 0) return false;
    // One packet-time of slack, the same "is the last one still going out"
    // question `FAST_BACKLOG` asks in bytes.
    return this.backlog(to === this.a) > 1000 / this.capacity;
  }

  /**
   * Should this packet be dropped?
   *
   * A two-state model rather than a coin per packet: once a burst starts, the
   * whole run goes. The chance of *starting* one is scaled down by the burst
   * length so the overall loss rate still comes out at `loss`, and per
   * direction because a phone's two legs fail independently.
   */
  private dropped(to: LoopbackLink): boolean {
    if (this.loss <= 0) return false;
    const left = this.dropping.get(to) ?? 0;
    if (left > 0) {
      this.dropping.set(to, left - 1);
      return true;
    }
    if (this.random() >= this.loss / this.burst) return false;
    this.dropping.set(to, this.burst - 1);
    return true;
  }

  /** Move time forward and deliver everything that has arrived. */
  advance(milliseconds: number): void {
    this.clock += milliseconds;
    const due = this.queue.filter((entry) => entry.at <= this.clock);
    this.queue = this.queue.filter((entry) => entry.at > this.clock);
    // In arrival order, which with jitter is *not* send order — a packet posted
    // later can be due earlier, and the client has to cope with that because the
    // real data channel does exactly this.
    due.sort((x, y) => x.at - y.at);
    for (const entry of due) entry.to.deliver(entry.message);
  }

  /**
   * Deliver anything already queued for one end, now.
   *
   * A refusal is a message immediately followed by a hang-up, and on an
   * ordered, reliable channel the message still arrives. Without this the
   * queued `bye` would be thrown away by the close that was explaining it, and
   * the far end would see an unexplained disconnection.
   */
  drain(to: LoopbackLink): void {
    const due = this.queue.filter((entry) => entry.to === to);
    this.queue = this.queue.filter((entry) => entry.to !== to);
    for (const entry of due) entry.to.deliver(entry.message);
  }

  /**
   * Deliver everything, including whatever the deliveries themselves send.
   *
   * A handshake is several round trips — hello, welcome, lobby — and a single
   * `advance` only moves one hop, because a reply posted during delivery is
   * queued behind the clock that just moved. Settling the wire means running
   * until nothing is left.
   */
  flush(): void {
    const hop = this.latency + this.uplink + this.jitter + 1;
    for (let i = 0; i < 32 && this.queue.length > 0; i++) this.advance(hop);
  }
}

export class LoopbackLink implements Link {
  peer!: LoopbackLink;
  rtt: number | null = null;

  /** Whether this leg is already behind, so the sender can slow down. */
  get congested(): boolean {
    return this.wire.saturated(this.peer);
  }

  private readonly wire: LoopbackWire;
  private handler: ((message: NetMessage) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private closed = false;
  private dropped = 0;

  constructor(wire: LoopbackWire) {
    this.wire = wire;
  }

  send(message: NetMessage): void {
    if (this.closed) return;
    // Inputs and snapshots are worth nothing late, so they are never queued
    // behind a leg that is already struggling — the same rule the real data
    // channel follows against `bufferedAmount`.
    const fast = message.t === 'input' || message.t === 'snap';
    if (fast && this.wire.saturated(this.peer)) {
      this.dropped++;
      return;
    }
    this.wire.post(this.peer, message);
  }

  /** Fast packets dropped rather than queued. */
  get droppedForBacklog(): number {
    return this.dropped;
  }

  onMessage(handler: (message: NetMessage) => void): void {
    this.handler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.wire.drain(this.peer);
    this.closed = true;
    this.closeHandler?.();
    this.peer.remoteClosed();
  }

  /** Called on the far end when this one hangs up. */
  remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
  }

  deliver(message: NetMessage): void {
    if (this.closed) return;
    this.handler?.(message);
  }
}
