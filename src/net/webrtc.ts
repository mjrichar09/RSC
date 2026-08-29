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
const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };

let relay: RTCIceServer | null = null;

/**
 * Add a TURN relay.
 *
 * STUN gets two players through most home routers by telling each of them what
 * their public address looks like from outside. It cannot help when either end
 * is behind a NAT that gives a different public port to every destination —
 * there is no address to tell the other side about, and the only way through is
 * to bounce the traffic off a server in the middle.
 *
 * The game has no server, so it ships without one, and that is a real
 * limitation rather than an oversight: a relay carries every byte of every
 * race and costs money to run. Anyone who has one can point the game at it with
 * `?turn=turn:host:3478|user|password`, and anyone who does not gets told
 * plainly when a connection fails for this reason instead of watching a lobby
 * do nothing.
 */
export function useRelay(spec: string | null): void {
  if (!spec) {
    relay = null;
    return;
  }
  const [urls, username, credential] = spec.split('|');
  if (!urls) return;
  relay = {
    urls: urls.split(','),
    ...(username ? { username } : {}),
    ...(credential ? { credential } : {}),
  };
}

const config = (): RTCConfiguration => ({
  iceServers: relay ? [STUN, relay] : [STUN],
});

/** Messages that go down the lossy channel. The same set the loopback drops. */
const isFast = (message: NetMessage): boolean => message.t === 'input' || message.t === 'snap';

/**
 * Wait for ICE gathering, so one code carries the candidates with it.
 *
 * Trickle ICE would be faster, but it needs a channel to trickle down and the
 * whole point here is that there isn't one.
 *
 * The wait is capped twice. Once the public address is known — one
 * server-reflexive candidate, which is the one that actually connects two
 * players on different networks — there is a short grace for a second one and
 * then the code is good; the old flat four seconds cut gathering off mid-STUN
 * on a slow link and produced an invite with nothing usable in it. Failing
 * that, eight seconds and whatever has arrived — which is what a blocked STUN
 * server costs, once, before the code appears anyway.
 */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let grace: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      pc.removeEventListener('icegatheringstatechange', onState);
      pc.removeEventListener('icecandidate', onCandidate);
      if (grace) clearTimeout(grace);
      clearTimeout(cap);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) return finish();
      const type = event.candidate.type;
      if ((type === 'srflx' || type === 'relay') && !grace) grace = setTimeout(finish, 1500);
    };
    const cap = setTimeout(finish, 8000);
    pc.addEventListener('icegatheringstatechange', onState);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

/**
 * Squeeze a session description into something a person can paste.
 *
 * A browser's SDP for a data-channel connection is about 600 characters of
 * boilerplate wrapped around five things that actually matter: an ICE
 * username, an ICE password, a DTLS fingerprint, which side sets up the
 * handshake, and a handful of candidate addresses. Everything else is fixed
 * for every connection this game will ever make, so it is rebuilt on the far
 * side rather than carried.
 *
 * Deflating the whole SDP gave a 560-character code. Sending only the five
 * things gives about 120 — short enough to read out over a voice call, which
 * is the difference between "paste this" and "here, I'll message it to you".
 *
 * The old format is still understood, so a code from an older build still
 * works and so there is something to fall back to if a browser turns out to
 * dislike the rebuilt SDP.
 */

/** Candidate types, in the order their numeric tag encodes them. */
const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'] as const;

/** Typical ICE priorities per type. The exact value only orders the pairs. */
const PRIORITY: Record<string, number> = {
  host: 2113937151,
  srflx: 1677729535,
  prflx: 1677729535,
  relay: 41885439,
};

interface Candidate {
  type: string;
  address: string;
  port: number;
}

interface Compact {
  answer: boolean;
  /** DTLS role, verbatim: 'actpass', 'active' or 'passive'. */
  setup: string;
  ufrag: string;
  pwd: string;
  /** The sha-256 fingerprint, 32 bytes. */
  print: Uint8Array;
  candidates: Candidate[];
}

/**
 * True for a literal IPv4 or IPv6 address.
 *
 * Chrome hides local IPs behind `.local` mDNS names that only resolve on the
 * same network, so those candidates cost code length and can never connect two
 * players on different ones.
 */
const isNumericAddress = (address: string): boolean => {
  const plain = address.replace(/^\[|\]$/g, '');
  if (plain.includes(':')) return /^[0-9a-fA-F:]+$/.test(plain);
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(plain);
};

const one = (sdp: string, pattern: RegExp): string => pattern.exec(sdp)?.[1]?.trim() ?? '';

function pullApart(description: RTCSessionDescriptionInit): Compact | null {
  const sdp = description.sdp ?? '';
  const ufrag = one(sdp, /^a=ice-ufrag:(.*)$/m);
  const pwd = one(sdp, /^a=ice-pwd:(.*)$/m);
  const hex = one(sdp, /^a=fingerprint:sha-256 (.*)$/m);
  if (!ufrag || !pwd || !hex) return null;

  const print = new Uint8Array(hex.split(':').map((byte) => parseInt(byte, 16)));
  if (print.length !== 32 || print.some((b) => Number.isNaN(b))) return null;

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    const match = /^a=candidate:\S+ (\d+) (\S+) \d+ (\S+) (\d+) typ (\S+)/.exec(line);
    if (!match) continue;
    const [, component, transport, address, port, type] = match;
    // Component 1 only (there is no second one on a bundled data channel), UDP
    // only, and nothing whose address is a name rather than a number: Chrome
    // hides local IPs behind `.local` mDNS names that only resolve on the same
    // network, so carrying them costs code length to no possible benefit.
    if (component !== '1' || transport?.toLowerCase() !== 'udp') continue;
    if (!address) continue;
    if (!CANDIDATE_TYPES.includes((type ?? '') as (typeof CANDIDATE_TYPES)[number])) continue;
    const key = `${type} ${address} ${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ type: type!, address: address!, port: Number(port) });
  }

  // Chrome hides local IPs behind `.local` mDNS names, which only resolve on
  // the same network. They are dead weight once there is a public address —
  // and they are the only hope of connecting without one, which is what two
  // players on the same wifi with STUN blocked have. So: kept only when there
  // is nothing better, because dropping them outright broke LAN play.
  const routable = candidates.filter((c) => c.type !== 'host' && isNumericAddress(c.address));
  const kept = routable.length > 0 ? candidates.filter((c) => isNumericAddress(c.address)) : candidates;

  return {
    answer: description.type === 'answer',
    setup: one(sdp, /^a=setup:(.*)$/m) || (description.type === 'answer' ? 'active' : 'actpass'),
    ufrag,
    pwd,
    print,
    candidates: kept,
  };
}

/** Rebuild the SDP a browser will accept from the handful of fields above. */
function putTogether(c: Compact): RTCSessionDescriptionInit {
  const print = [...c.print].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const lines = [
    'v=0',
    'o=- 1 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    // Port 9 is the discard port, which is what a description whose addresses
    // all live in candidate lines is supposed to carry.
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${c.ufrag}`,
    `a=ice-pwd:${c.pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${print}`,
    `a=setup:${c.setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  c.candidates.forEach((candidate, i) => {
    const ip = candidate.address.replace(/^\[|\]$/g, '');
    lines.push(
      `a=candidate:${i + 1} 1 udp ${PRIORITY[candidate.type] ?? 1} ${ip} ${candidate.port} typ ${candidate.type}`,
    );
  });
  // Says the list is complete, so ICE starts checking rather than waiting for
  // a trickle that is never coming.
  lines.push('a=end-of-candidates');
  return { type: c.answer ? 'answer' : 'offer', sdp: `${lines.join('\r\n')}\r\n` };
}

const SETUPS = ['actpass', 'active', 'passive'];

function pack(c: Compact): Uint8Array {
  const text = new TextEncoder();
  const ufrag = text.encode(c.ufrag);
  const pwd = text.encode(c.pwd);
  const addresses = c.candidates.map((candidate) => packAddress(candidate.address));

  let size = 1 + 1 + ufrag.length + 1 + pwd.length + 32 + 1;
  for (let i = 0; i < addresses.length; i++) {
    size += 1 + (isNumericAddress(c.candidates[i]!.address) ? 0 : 1) + addresses[i]!.length + 2;
  }

  const out = new Uint8Array(size);
  let at = 0;
  out[at++] = (c.answer ? 0x80 : 0) | (SETUPS.indexOf(c.setup) << 4) | 1;
  out[at++] = ufrag.length;
  out.set(ufrag, at);
  at += ufrag.length;
  out[at++] = pwd.length;
  out.set(pwd, at);
  at += pwd.length;
  out.set(c.print, at);
  at += 32;
  out[at++] = addresses.length;
  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i]!;
    const candidate = c.candidates[i]!;
    const family = isNumericAddress(candidate.address) ? (address.length === 4 ? 4 : 6) : 0;
    out[at++] = (family << 4) | CANDIDATE_TYPES.indexOf(candidate.type as 'host');
    // A name is variable-length, so it carries one; the two IP families are
    // fixed at four and sixteen bytes and do not need to.
    if (family === 0) out[at++] = address.length;
    out.set(address, at);
    at += address.length;
    out[at++] = (candidate.port >> 8) & 0xff;
    out[at++] = candidate.port & 0xff;
  }
  return out;
}

function unpack(bytes: Uint8Array): Compact {
  const text = new TextDecoder();
  let at = 0;
  const head = bytes[at++]!;
  const answer = (head & 0x80) !== 0;
  const setup = SETUPS[(head >> 4) & 0x07] ?? 'actpass';
  const ufragLength = bytes[at++]!;
  const ufrag = text.decode(bytes.subarray(at, at + ufragLength));
  at += ufragLength;
  const pwdLength = bytes[at++]!;
  const pwd = text.decode(bytes.subarray(at, at + pwdLength));
  at += pwdLength;
  const print = bytes.slice(at, at + 32);
  at += 32;
  const count = bytes[at++]!;
  const candidates: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const tag = bytes[at++]!;
    const family = tag >> 4;
    const length = family === 4 ? 4 : family === 6 ? 16 : bytes[at++]!;
    const address =
      family === 0
        ? text.decode(bytes.subarray(at, at + length))
        : unpackAddress(bytes.subarray(at, at + length));
    at += length;
    const port = (bytes[at]! << 8) | bytes[at + 1]!;
    at += 2;
    candidates.push({ type: CANDIDATE_TYPES[tag & 0x0f] ?? 'host', address, port });
  }
  return { answer, setup, ufrag, pwd, print, candidates };
}

function packAddress(address: string): Uint8Array {
  const plain = address.replace(/^\[|\]$/g, '');
  // An mDNS name goes through as text; only the far side's resolver can do
  // anything with it, and only on the same network.
  if (!isNumericAddress(plain)) return new TextEncoder().encode(plain);
  if (!plain.includes(':')) {
    return new Uint8Array(plain.split('.').map((part) => Number(part) & 0xff));
  }
  // IPv6, expanded from whatever `::` shorthand the browser used.
  const [head, tail] = plain.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const out = new Uint8Array(16);
  groups.forEach((group, i) => {
    const value = parseInt(group || '0', 16);
    out[i * 2] = (value >> 8) & 0xff;
    out[i * 2 + 1] = value & 0xff;
  });
  return out;
}

function unpackAddress(bytes: Uint8Array): string {
  if (bytes.length === 4) return [...bytes].join('.');
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((bytes[i]! << 8) | bytes[i + 1]!) >>> 0).toString(16));
  return groups.join(':');
}

async function encode(description: RTCSessionDescriptionInit): Promise<string> {
  const compact = pullApart(description);
  if (compact) return `C${base64(pack(compact))}`;

  // Fallback: the whole SDP, deflated. Only reached if a browser's description
  // is missing something the compact form needs, which should not happen — but
  // an unreadable invite code is a worse failure than a long one.
  const text = JSON.stringify({ t: description.type, s: description.sdp });
  const bytes = new TextEncoder().encode(text);
  const packed = await squeeze(bytes, 'pack');
  return (packed ? 'Z' : 'P') + base64(packed ?? bytes);
}

async function decode(code: string): Promise<RTCSessionDescriptionInit> {
  const trimmed = code.trim();
  const body = unbase64(trimmed.slice(1));
  if (trimmed[0] === 'C') return putTogether(unpack(body));
  const bytes = trimmed[0] === 'Z' ? ((await squeeze(body, 'unpack')) ?? body) : body;
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
      // 'disconnected' is transient — ICE recovers from it on its own, and a
      // brief one is what a wifi handover looks like. Closing the peer
      // connection on it threw away races that were about to come back, and
      // left the lobby unable to accept a reply afterwards because the
      // connection it wanted to set it on was already gone.
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.hangUp();
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

/**
 * Give up eventually rather than leaving a lobby waiting forever.
 *
 * Five minutes, not one. The signalling channel here is two people copying
 * strings into a chat window, and a minute is not long enough to do that — the
 * old timeout fired while the exchange was still in progress and reported a
 * connection failure for a handshake that had not been attempted yet.
 */
function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), 300_000)),
  ]);
}

/** What the connection is doing, in words a player can act on. */
export type LinkPhase =
  | 'gathering'
  | 'waiting'
  | 'checking'
  | 'connected'
  | 'failed'
  | 'closed';

/**
 * Watch a peer connection and report its progress.
 *
 * Without this a failed connection is a lobby that says nothing, which is
 * exactly what it did: no candidates, a dead network, a NAT that needs a relay
 * and a code pasted into the wrong box all looked identical from the outside.
 */
function watch(pc: RTCPeerConnection, onPhase: (phase: LinkPhase, detail: string) => void): void {
  const report = () => {
    const ice = pc.iceConnectionState;
    if (pc.connectionState === 'connected' || ice === 'connected' || ice === 'completed') {
      onPhase('connected', '');
    } else if (pc.connectionState === 'failed' || ice === 'failed') {
      // The one failure worth naming: both sides gathered fine and still could
      // not find a pair that works, which is what a symmetric NAT looks like.
      onPhase('failed', 'your two networks would not connect to each other directly');
    } else if (pc.connectionState === 'closed') {
      onPhase('closed', '');
    } else if (ice === 'checking') {
      onPhase('checking', '');
    }
  };
  pc.addEventListener('connectionstatechange', report);
  pc.addEventListener('iceconnectionstatechange', report);
}

/** How many usable candidates a description carries, and of what kind. */
export function candidateSummary(description: RTCSessionDescriptionInit): string {
  const compact = pullApart(description);
  if (!compact || compact.candidates.length === 0) return 'no reachable addresses';
  const counts = new Map<string, number>();
  for (const candidate of compact.candidates) {
    counts.set(candidate.type, (counts.get(candidate.type) ?? 0) + 1);
  }
  return [...counts].map(([type, n]) => `${n} ${type}`).join(', ');
}

/** An invitation in flight: the code to send, and what to do with the reply. */
export interface Invite {
  /** The string to send to the other player. */
  code: string;
  /** What this side found to connect on, for the lobby to show. */
  addresses: string;
  /** Feed their reply in to finish the connection. */
  accept: (reply: string) => Promise<void>;
  /** True once the invite is dead and a new one is needed. */
  readonly spent: boolean;
  /** Called as the connection makes progress, or fails. */
  onPhase: ((phase: LinkPhase, detail: string) => void) | null;
  /** The link, usable as soon as `accept` resolves and the channel opens. */
  link: RtcLink;
  /** Resolves when the data channel is actually open. */
  connected: Promise<void>;
  cancel: () => void;
}

/** Host side: make an invite for one guest. Call it once per player you want. */
export async function createInvite(): Promise<Invite> {
  const pc = new RTCPeerConnection(config());
  const control = pc.createDataChannel('control', { ordered: true });
  const fast = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
  const link = new RtcLink(pc, control, fast);

  const connected = withTimeout(link.opened, 'the other player never connected');

  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);

  const invite: Invite = {
    code: await encode(pc.localDescription!),
    addresses: candidateSummary(pc.localDescription!),
    onPhase: null,
    get spent(): boolean {
      return pc.signalingState === 'closed';
    },
    accept: async (reply: string) => {
      // Checked here rather than left to the browser: setting a description on
      // a closed connection throws an InvalidStateError that reads as "your
      // reply code is broken", when what actually happened is that this invite
      // died and the player needs a fresh one.
      if (pc.signalingState === 'closed') {
        throw new Error('this invite has expired — make a new one and send that instead');
      }
      if (pc.signalingState === 'stable') {
        throw new Error('this invite has already been used by somebody');
      }
      await pc.setRemoteDescription(await decode(reply));
    },
    link,
    connected,
    cancel: () => pc.close(),
  };
  watch(pc, (phase, detail) => invite.onPhase?.(phase, detail));
  return invite;
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
  onPhase?: (phase: LinkPhase, detail: string) => void,
): Promise<{ reply: string; addresses: string; link: Promise<RtcLink>; connected: Promise<void> }> {
  const pc = new RTCPeerConnection(config());
  if (onPhase) watch(pc, onPhase);
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
    addresses: candidateSummary(pc.localDescription!),
    link: withTimeout(ready, 'could not reach the host'),
    connected: ready.then((link) => withTimeout(link.opened, 'could not reach the host')),
  };
}

/** Exposed for the tests: the codes are a pure encoding of a description. */
export const codec = { encode, decode };
