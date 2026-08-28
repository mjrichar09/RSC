/**
 * The real wire: WebRTC data channels, with the handshake done by hand.
 *
 * The game is a static site on GitHub Pages. There is no server, so there is
 * nothing to run a signalling exchange — which is normally the one piece of
 * multiplayer you cannot avoid paying for. The way out is to make the players
 * the signalling channel: the host generates an invite code, the guest pastes
 * it in and gets a reply code back, the host pastes that, and the connection is
 * up. Whatever the two of them already use to talk to each other — a chat
 * window, a voice call — carries two strings, and nothing else is needed.
 *
 * It is clumsy for the first race and free forever after, which is the right
 * trade for a game nobody is hosting a server for. If one ever exists, the
 * `Link` interface is what a WebSocket would implement instead, and nothing
 * above this file would change.
 *
 * Two channels, because game traffic is not one kind of traffic:
 *
 *   - `control` is ordered and reliable. Lobby, start, results. Losing one of
 *     these breaks the race.
 *   - `fast` is unordered with no retransmits. Inputs and snapshots. A packet
 *     that arrives late is worse than one that never arrives at all: the
 *     netcode is built to cover a gap and cannot use stale news, so resending
 *     it would cost latency to deliver something that gets thrown away.
 */

import type { Link, NetMessage } from './protocol.js';

/**
 * STUN only. A TURN relay would make connections work behind the strictest
 * corporate NATs, but it costs money to run and this game has no server; two
 * players on home connections get through on STUN.
 */
const ICE: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

/** Messages that go down the lossy channel. The same set the loopback drops. */
const isFast = (message: NetMessage): boolean => message.t === 'input' || message.t === 'snap';

/** Wait for ICE gathering, so one code carries the candidates with it. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    // Trickle ICE would be faster, but it needs a channel to trickle down and
    // the whole point here is that there isn't one. A few seconds of gathering
    // buys a single self-contained code.
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 4000);
  });
}

/**
 * Squeeze a session description into something a person can paste.
 *
 * SDP is a few kilobytes of text with a great deal of repetition in it, so
 * deflate takes it down by about three quarters before base64 puts a third of
 * that back. Browsers without `CompressionStream` fall back to plain base64 and
 * a longer code.
 */
async function encode(description: RTCSessionDescriptionInit): Promise<string> {
  const text = JSON.stringify({ t: description.type, s: description.sdp });
  const bytes = new TextEncoder().encode(text);
  const packed = await squeeze(bytes, 'pack');
  return (packed ? 'Z' : 'P') + base64(packed ?? bytes);
}

async function decode(code: string): Promise<RTCSessionDescriptionInit> {
  const body = unbase64(code.slice(1).trim());
  const bytes = code[0] === 'Z' ? ((await squeeze(body, 'unpack')) ?? body) : body;
  const json = JSON.parse(new TextDecoder().decode(bytes)) as { t: RTCSdpType; s: string };
  return { type: json.t, sdp: json.s };
}

async function squeeze(bytes: Uint8Array, mode: 'pack' | 'unpack'): Promise<Uint8Array | null> {
  // Both directions name the *format*, which is 'deflate-raw' either way — the
  // stream class is what says which way it runs. Passing 'inflate-raw' to the
  // decompressor is a plausible-looking mistake that costs an invite code.
  const Stream =
    mode === 'pack'
      ? (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream
      : (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!Stream) return null;
  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new (Stream as new (f: string) => TransformStream)('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64(code: string): Uint8Array {
  const text = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** A `Link` over one peer connection's pair of data channels. */
export class RtcLink implements Link {
  rtt: number | null = null;

  private handler: ((message: NetMessage) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private closed = false;
  /** Queued until the channels open, so a `hello` sent too early survives. */
  private pending: NetMessage[] = [];
  private openNow!: () => void;
  /** Resolves when the reliable channel is up and messages will actually go. */
  readonly opened: Promise<void>;

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly control: RTCDataChannel,
    private readonly fast: RTCDataChannel,
  ) {
    this.opened = new Promise((resolve) => {
      this.openNow = resolve;
    });
    if (control.readyState === 'open') this.openNow();
    for (const channel of [control, fast]) {
      channel.onmessage = (event) => {
        if (this.closed) return;
        try {
          this.handler?.(JSON.parse(String(event.data)) as NetMessage);
        } catch {
          // A malformed frame is not worth tearing a race down for.
        }
      };
      channel.onopen = () => {
        this.drain();
        if (this.control.readyState === 'open') this.openNow();
      };
      channel.onclose = () => this.hangUp();
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.hangUp();
    };
  }

  send(message: NetMessage): void {
    if (this.closed) return;
    const channel = isFast(message) ? this.fast : this.control;
    if (channel.readyState !== 'open') {
      // Only the reliable traffic is worth holding: an input from before the
      // connection opened is of no interest by the time it does.
      if (!isFast(message)) this.pending.push(message);
      return;
    }
    channel.send(JSON.stringify(message));
  }

  onMessage(handler: (message: NetMessage) => void): void {
    this.handler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.hangUp();
  }

  private drain(): void {
    if (this.control.readyState !== 'open') return;
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) this.control.send(JSON.stringify(message));
  }

  private hangUp(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.pc.close();
    } catch {
      // Already gone.
    }
    this.closeHandler?.();
  }
}

/** Give up after a minute rather than leaving a lobby waiting forever. */
function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), 60_000)),
  ]);
}

/** An invitation in flight: the code to send, and what to do with the reply. */
export interface Invite {
  /** The string to send to the other player. */
  code: string;
  /** Feed their reply in to finish the connection. */
  accept: (reply: string) => Promise<void>;
  /** The link, usable as soon as `accept` resolves and the channel opens. */
  link: RtcLink;
  /** Resolves when the data channel is actually open. */
  connected: Promise<void>;
  cancel: () => void;
}

/** Host side: make an invite for one guest. Call it once per player you want. */
export async function createInvite(): Promise<Invite> {
  const pc = new RTCPeerConnection(ICE);
  const control = pc.createDataChannel('control', { ordered: true });
  const fast = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
  const link = new RtcLink(pc, control, fast);

  const connected = withTimeout(link.opened, 'the other player never connected');

  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);

  return {
    code: await encode(pc.localDescription!),
    accept: async (reply: string) => {
      await pc.setRemoteDescription(await decode(reply));
    },
    link,
    connected,
    cancel: () => pc.close(),
  };
}

/**
 * Guest side: take an invite code, give back the reply code and a link.
 *
 * The reply is returned *before* the channels exist, and that ordering is not
 * an optimisation — it is the only order that works. The host cannot finish
 * the connection until it has the reply, and the channels do not arrive until
 * the connection is finished, so waiting for a channel before handing back the
 * reply deadlocks the handshake with each side waiting for the other.
 */
export async function acceptInvite(
  code: string,
): Promise<{ reply: string; link: Promise<RtcLink>; connected: Promise<void> }> {
  const pc = new RTCPeerConnection(ICE);
  let control: RTCDataChannel | null = null;
  let fast: RTCDataChannel | null = null;

  const ready = new Promise<RtcLink>((resolve) => {
    pc.ondatachannel = (event) => {
      if (event.channel.label === 'control') control = event.channel;
      else fast = event.channel;
      if (control && fast) resolve(new RtcLink(pc, control, fast));
    };
  });

  await pc.setRemoteDescription(await decode(code));
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);

  return {
    reply: await encode(pc.localDescription!),
    link: withTimeout(ready, 'could not reach the host'),
    connected: ready.then((link) => withTimeout(link.opened, 'could not reach the host')),
  };
}

/** Exposed for the tests: the codes are a pure encoding of a description. */
export const codec = { encode, decode };
