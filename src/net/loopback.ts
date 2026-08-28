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
  /** Fraction of messages to drop, 0..1. */
  loss?: number;
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
  private readonly loss: number;
  private readonly random: () => number;

  constructor(options: LoopbackOptions = {}) {
    this.latency = options.latency ?? 0;
    this.loss = options.loss ?? 0;
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
    if (droppable && this.loss > 0 && this.random() < this.loss) return;
    this.queue.push({ at: this.clock + this.latency, message, to });
  }

  /** Move time forward and deliver everything that has arrived. */
  advance(milliseconds: number): void {
    this.clock += milliseconds;
    const due = this.queue.filter((entry) => entry.at <= this.clock);
    this.queue = this.queue.filter((entry) => entry.at > this.clock);
    // In arrival order, which with a fixed latency is send order.
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
    for (let i = 0; i < 32 && this.queue.length > 0; i++) this.advance(this.latency + 1);
  }
}

export class LoopbackLink implements Link {
  peer!: LoopbackLink;
  rtt: number | null = null;

  private readonly wire: LoopbackWire;
  private handler: ((message: NetMessage) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private closed = false;

  constructor(wire: LoopbackWire) {
    this.wire = wire;
  }

  send(message: NetMessage): void {
    if (this.closed) return;
    this.wire.post(this.peer, message);
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
