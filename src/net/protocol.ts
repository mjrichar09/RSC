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

/** Guest input send rate, Hz. */
export const INPUT_HZ = 60;
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
  /** Host → everyone: the race starts at this host clock time. */
  | { t: 'start'; setup: RaceSetup; at: number }
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
