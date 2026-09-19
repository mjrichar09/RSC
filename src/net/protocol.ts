/**
 * What goes over the wire.
 *
 * One host, up to three guests. The host is authoritative: it runs the real
 * `SimWorld` and everyone else runs a copy that is continuously corrected
 * toward it. That is not a preference — Rapier is deterministic for a given
 * build on a given machine but not across machines and browser versions, so
 * lockstep would desync within seconds and there would be no way to tell which
 * copy was right.
 *
 * Guests send inputs; the host sends snapshots. Inputs are four numbers and a
 * sequence, snapshots are a transform and a velocity per car, so the whole
 * protocol fits comfortably in a few hundred bytes per packet at 20 Hz.
 *
 * Everything here is plain data. No transport, no sockets, no three.js: the
 * same messages go over a data channel, over a loopback pipe in the tests, and
 * would go over a WebSocket to a Node host without changing a line.
 */

import type { DriverInput } from '../sim/input.js';
import type { Conditions } from '../sim/conditions.js';

/** Protocol version. A mismatch is refused rather than half-understood. */
export const PROTOCOL_VERSION = 1;

/** How many cars can share a race. */
export const MAX_PLAYERS = 4;

/**
 * Guest input send rate, Hz, and the slower rate used on a struggling link.
 *
 * Two of them because neither number is right on its own. Measured over twenty
 * seconds of slalom: at 60 Hz on a healthy link the guest's mean standing error
 * is 0.55 m and at 30 Hz it is 0.80 m, because the host's picture of the wheel
 * is twice as old. But a mobile uplink is narrow in *packets* rather than in
 * bytes, and 60 a second is more than some of them can carry — at 35 packets a
 * second of capacity, 60 Hz had 510 of 1200 inputs thrown away where 30 Hz had
 * none, and measured worse for it.
 *
 * So the rate follows the link: full speed while the transport says it is
 * keeping up, half speed while it is not. `Link.congested` is that signal, and
 * it comes from the transport because the transport is the only thing that can
 * see its own queue.
 */
export const INPUT_HZ = 60;
export const INPUT_HZ_CONGESTED = 30;
/** Host snapshot rate, Hz. Below about 15 the interpolation starts to show. */
export const SNAPSHOT_HZ = 20;

export type PlayerId = number;

export interface PlayerInfo {
  id: PlayerId;
  name: string;
  /** True for the player running the authoritative simulation. */
  host: boolean;
  /** Index into `SimWorld.cars`. Assigned by the host and never reused. */
  car: number;
  ready: boolean;
  /**
   * Paint and number, chosen in the lobby.
   *
   * A multiplayer car is a fresh one — nobody brings their career's wreck to
   * somebody else's race — so the only thing that makes it *yours* is what it
   * looks like. Everyone's choice reaches everyone, and rival cars are painted
   * from this rather than from a fixed rotation of three colours.
   */
  livery: string;
  number: number;
  /** Races won in this lobby. Reset only by leaving it. */
  wins: number;
}

/** Everything a guest needs to build the same world the host is running. */
export interface RaceSetup {
  stageId: string;
  variantId: string;
  conditions: Conditions;
  /** Seeds anything stochastic, so every copy has the same deer in the road. */
  seed: number;
  players: PlayerInfo[];
}

/** One car's authoritative state, as the host sees it. */
export interface CarSnapshot {
  car: number;
  /** Position. */
  p: [number, number, number];
  /** Rotation, as a quaternion. */
  q: [number, number, number, number];
  /** Linear velocity — needed, or a corrected car arrives with no momentum. */
  v: [number, number, number];
  /** Angular velocity. */
  w: [number, number, number];
  /** Condition 0..1, for the other cars' damage to be visible. */
  health: number;
  /** Distance along the stage, for the standings. */
  progress: number;
  /** Finish time in seconds, once they are done. */
  finished?: number;
}

export type NetMessage =
  /** Guest → host, once, on connecting. */
  | { t: 'hello'; version: number; name: string; livery: string; number: number }
  /** Host → guest, in reply: who you are and what we are racing. */
  | { t: 'welcome'; you: PlayerId; setup: RaceSetup }
  /** Host → everyone, whenever the lobby changes. */
  | { t: 'lobby'; players: PlayerInfo[]; stageId: string; variantId: string }
  /** Guest → host: repaint me. Allowed in the lobby, ignored during a race. */
  | { t: 'livery'; livery: string; number: number }
  /** Guest → host: ready or not. */
  | { t: 'ready'; ready: boolean }
  /** Host → everyone: build a world for this setup, then say when you have. */
  | { t: 'start'; setup: RaceSetup; at: number }
  /**
   * Host → everyone: everybody has a world, start the countdown now.
   *
   * Separate from `start` because building a world is asynchronous and takes a
   * different amount of time on every machine. Each side used to run its own
   * countdown from the moment it happened to finish loading, so the green came
   * up at a different instant on each screen and the grid was never level.
   */
  | { t: 'go' }
  /** Guest → host, at `INPUT_HZ`. */
  | { t: 'input'; seq: number; input: DriverInput }
  /** Host → everyone, at `SNAPSHOT_HZ`. */
  | { t: 'snap'; tick: number; time: number; cars: CarSnapshot[]; ack: number }
  /** Host → everyone: somebody finished, or retired. */
  | { t: 'result'; player: PlayerId; time: number | null; retired: boolean }
  /** Either way, on leaving. */
  | { t: 'bye'; player?: PlayerId }
  /** Either way: a clock probe, echoed back with the same `sent`. */
  | { t: 'ping'; sent: number }
  | { t: 'pong'; sent: number; hostTime: number };

/**
 * A duplex link to one peer.
 *
 * Deliberately tiny: a data channel, a WebSocket and an in-process pipe all
 * satisfy it, which is what lets the whole netcode be tested headlessly with no
 * network at all.
 */
export interface Link {
  send: (message: NetMessage) => void;
  onMessage: (handler: (message: NetMessage) => void) => void;
  onClose: (handler: () => void) => void;
  close: () => void;
  /** Round-trip time in milliseconds, or null before the first ping. */
  readonly rtt: number | null;
  /**
   * True while this link is behind on its realtime traffic.
   *
   * The transport is the only layer that can see its own send queue, and the
   * only one that knows a packet handed to it now will not leave now. Optional
   * so a link that cannot tell simply never claims to be struggling.
   */
  readonly congested?: boolean;
}

/** The longest a driver's name may be, here and on the leaderboard. */
export const MAX_NAME = 16;

/**
 * Bounds on what another player is allowed to call themselves.
 *
 * A `hello` is the first thing a stranger sends, and nothing above the link
 * checks the shape of it: `message.name.slice(0, 16)` was a `TypeError` thrown
 * inside the host's own message handler for anybody who sent a number instead
 * of a string, which is a guest able to knock over the lobby it is joining.
 * Control characters go because a name is drawn into one line of markup; the
 * escaping at the point of render is the other half of this, and neither half
 * is enough on its own.
 */
export function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim();
  return stripped.length > 0 ? stripped : fallback;
}

/**
 * A competition number, as the lobby offers it: 1 to 99, two digits on a roof.
 *
 * Bounded on arrival rather than where it is drawn, because it reaches the
 * car's roof texture as well as the lobby list.
 */
export function cleanNumber(raw: unknown, fallback = 1): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.round(raw), 1), 99);
}

/**
 * A livery id, or something `liveryById` will answer for.
 *
 * It resolves an unknown id to the default paint already, so all this has to
 * guarantee is that it is handed a string to resolve. Kept beside the other
 * two so everything that arrives over the wire is bounded in one place.
 */
export function cleanLivery(raw: unknown): string {
  return typeof raw === 'string' ? raw.slice(0, 40) : '';
}

/**
 * A guest's controls, bounded before the host's world is driven with them.
 *
 * This is the one message from a stranger that reaches the physics, and the
 * physics has no defence against it: `clamp` passes `NaN` straight through
 * (it is neither below the floor nor above the ceiling), so a single input
 * with a missing field puts a `NaN` into a rigid body and every car in the
 * race leaves the world together. Bounded here, at the wire, rather than in
 * `sim/` — the simulation's inputs come from a driver or from the AI and both
 * of those are already numbers.
 */
export function cleanInput(raw: unknown): DriverInput {
  const axis = (value: unknown, lo: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return value < lo ? lo : value > 1 ? 1 : value;
  };
  const input = (raw ?? {}) as Partial<DriverInput>;
  return {
    throttle: axis(input.throttle, 0),
    brake: axis(input.brake, 0),
    steer: axis(input.steer, -1),
    handbrake: axis(input.handbrake, 0),
  };
}

/** Pack a snapshot's floats a little, since these go out twenty times a second. */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function packCar(
  car: number,
  position: { x: number; y: number; z: number },
  rotation: { x: number; y: number; z: number; w: number },
  velocity: { x: number; y: number; z: number },
  angular: { x: number; y: number; z: number },
  health: number,
  progress: number,
  finished?: number,
): CarSnapshot {
  return {
    car,
    p: [round3(position.x), round3(position.y), round3(position.z)],
    q: [round3(rotation.x), round3(rotation.y), round3(rotation.z), round3(rotation.w)],
    v: [round3(velocity.x), round3(velocity.y), round3(velocity.z)],
    w: [round3(angular.x), round3(angular.y), round3(angular.z)],
    health: Math.round(health * 100) / 100,
    progress: Math.round(progress * 10) / 10,
    ...(finished === undefined ? {} : { finished: Math.round(finished * 1000) / 1000 }),
  };
}
