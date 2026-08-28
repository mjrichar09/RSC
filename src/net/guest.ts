/**
 * The predicted side.
 *
 * A guest runs the whole game — the same `SimWorld`, the same physics, the same
 * damage — and is wrong about all of it. The host is the truth. What this class
 * does is keep the two close enough together that the difference is invisible
 * while still letting the local car respond to the wheel in the same frame the
 * driver moved it.
 *
 * Two different problems, solved two different ways:
 *
 *   - **Your own car** is *predicted*. It is simulated locally from your input,
 *     with no waiting, and the authoritative position is folded in as a small
 *     positional correction spread over a fraction of a second. A car that
 *     teleported every time a packet arrived would be unusable at 80 ms, and
 *     one that waited for the host to confirm the throttle would feel like
 *     driving through treacle.
 *   - **Everyone else's car** is *interpolated*, deliberately in the past. Their
 *     snapshots are buffered and played back `INTERP_DELAY` behind the newest
 *     one, so a late or lost packet is covered by the buffer instead of showing
 *     as a stutter. Being a tenth of a second behind on a car you are not
 *     driving costs nothing; being a tenth of a second wrong about where it is
 *     costs a collision.
 *
 * One wrinkle that is worth the trouble it saves: the host numbers the cars and
 * a guest is rarely car zero, but the whole game above the simulation — the
 * camera, the HUD, the damage panel, the rescue — is written around the local
 * car being the first one. So the guest swaps its own car with car zero in its
 * own world and undoes the swap at the wire. `slots` hands the same permutation
 * to the grid, so both copies of the race line up identically.
 *
 * The remote cars are still real rigid bodies rather than ghosts, so you can
 * hit them. Their state is written from the buffer each step, velocity
 * included, because a body moved by hand with no velocity behaves like a wall
 * instead of a car in a shunt.
 */

import type { SimWorld } from '../sim/world.js';
import type { DriverInput } from '../sim/input.js';
import { NEUTRAL_INPUT } from '../sim/input.js';
import type { Quat, Vec3 } from '../sim/math.js';
import { clamp, length, lerpVec, slerp, sub } from '../sim/math.js';
import {
  type CarSnapshot,
  INPUT_HZ,
  type Link,
  type NetMessage,
  type PlayerId,
  type PlayerInfo,
  PROTOCOL_VERSION,
  type RaceSetup,
} from './protocol.js';

/**
 * How far behind the newest snapshot remote cars are played back, in seconds.
 *
 * Two snapshot intervals at 20 Hz: one packet can vanish entirely and the
 * buffer still has something either side of the playback time to interpolate
 * between.
 */
export const INTERP_DELAY = 0.1;

/** Seconds over which a prediction error is blended away. */
const BLEND_TIME = 0.25;

/**
 * Metres of disagreement beyond which the correction stops being a nudge.
 *
 * Below this the local car is merely in the wrong place and can be walked back.
 * Above it, something happened on the host that the prediction never saw — a
 * collision with a car whose input arrived late, a rescue, a respawn — and
 * blending would drag the car through the scenery on the way. Snap instead: one
 * jarring frame beats four seconds of being quietly wrong.
 */
const HARD_SNAP = 2.5;

/** Angular disagreement, in radians of quaternion distance, that also snaps. */
const HARD_SNAP_ANGLE = 0.7;

interface Sample {
  /** Host clock time this state is from. */
  time: number;
  p: Vec3;
  q: Quat;
  v: Vec3;
  w: Vec3;
  health: number;
  progress: number;
}

export interface GuestOptions {
  name?: string;
  /** The lobby changed. */
  onLobby?: (players: PlayerInfo[]) => void;
  /** The host has started a race; build a world for this setup and `attach` it. */
  onStart?: (setup: RaceSetup) => void;
  /** Somebody finished or retired. */
  onResult?: (player: PlayerId, time: number | null, retired: boolean) => void;
  /** The host hung up, or refused us. */
  onClose?: () => void;
}

const toVec = (a: readonly [number, number, number]): Vec3 => ({ x: a[0], y: a[1], z: a[2] });
const toQuat = (a: readonly [number, number, number, number]): Quat => ({
  x: a[0],
  y: a[1],
  z: a[2],
  w: a[3],
});

/** How far apart two rotations are, in radians. Sign-insensitive. */
function angleBetween(a: Quat, b: Quat): number {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(clamp(d, -1, 1));
}

export class RaceGuest {
  /** Our own player id, once the host has told us. Null until then. */
  you: PlayerId | null = null;
  /** Which car we are in the *host's* numbering. Ours is always 0 locally. */
  car = 0;
  players: PlayerInfo[] = [];
  setup: RaceSetup | null = null;
  /** Round-trip time in milliseconds, once a ping has come back. */
  rtt: number | null = null;

  private readonly link: Link;
  private readonly options: GuestOptions;
  private world: SimWorld | null = null;
  private open = true;
  private started = false;

  /** Snapshot history per car index, oldest first. */
  private readonly buffers = new Map<number, Sample[]>();
  /** Latest host clock time seen in any snapshot. */
  private newest = 0;
  /** Our playback clock, which chases `newest - INTERP_DELAY`. */
  private playback = 0;

  private seq = 0;
  private sinceInput = 0;
  private sincePing = 0;
  private clock = 0;

  /** Outstanding prediction error for our own car, in world metres. */
  private correction: Vec3 = { x: 0, y: 0, z: 0 };

  /** Corrections applied so far, for the tests and the netgraph. */
  readonly stats = { snapshots: 0, blends: 0, snaps: 0, worstError: 0 };

  constructor(link: Link, options: GuestOptions = {}) {
    this.link = link;
    this.options = options;
    link.onMessage((message) => this.receive(message));
    link.onClose(() => {
      this.open = false;
      this.options.onClose?.();
    });
    link.send({ t: 'hello', version: PROTOCOL_VERSION, name: options.name ?? 'Guest' });
  }

  get connected(): boolean {
    return this.open;
  }

  get racing(): boolean {
    return this.started;
  }

  /**
   * Grid slots for our copy of the world, so `new SimWorld({ cars, slots })`
   * puts every car where the host has it while ours stays index 0.
   */
  get slots(): number[] {
    const count = Math.max(this.players.length, this.car + 1);
    return Array.from({ length: count }, (_, i) => this.swap(i));
  }

  /**
   * Our car and car zero trade places. Its own inverse, which is why one
   * function serves both directions.
   */
  private swap(index: number): number {
    if (index === 0) return this.car;
    if (index === this.car) return 0;
    return index;
  }

  /** Tell the host whether we are ready to start. */
  ready(ready: boolean): void {
    this.link.send({ t: 'ready', ready });
  }

  /** Hand over the world built for the setup we were given. */
  attach(world: SimWorld): void {
    this.world = world;
    this.buffers.clear();
    this.correction = { x: 0, y: 0, z: 0 };
  }

  /**
   * Tell the host we finished or retired, so it can publish it to everyone.
   *
   * The host cannot work this out for itself: it knows how far along the stage
   * a car is, but crossing the line and retiring are decided by the race rules
   * running on the machine whose car it is.
   */
  report(time: number | null, retired: boolean): void {
    if (!this.open || this.you === null) return;
    this.link.send({ t: 'result', player: this.you, time, retired });
  }

  leave(): void {
    if (!this.open) return;
    this.link.send({ t: 'bye' });
    this.link.close();
    this.open = false;
  }

  /** Latest known condition of a car, 0..1, for drawing everyone's damage. */
  healthOf(car: number): number {
    const buffer = this.buffers.get(car);
    return buffer?.length ? buffer[buffer.length - 1]!.health : 1;
  }

  /** Latest known distance along the stage, for the standings. */
  progressOf(car: number): number {
    const buffer = this.buffers.get(car);
    return buffer?.length ? buffer[buffer.length - 1]!.progress : 0;
  }

  private receive(message: NetMessage): void {
    switch (message.t) {
      case 'welcome':
        this.you = message.you;
        this.setup = message.setup;
        this.car = message.setup.players.find((p) => p.id === message.you)?.car ?? 0;
        this.players = message.setup.players;
        break;
      case 'lobby':
        this.players = message.players;
        // Slots can move while people join and leave, so re-read our own.
        if (this.you !== null) {
          const mine = message.players.find((p) => p.id === this.you);
          if (mine) this.car = mine.car;
        }
        this.options.onLobby?.(message.players);
        break;
      case 'start':
        this.setup = message.setup;
        this.car = message.setup.players.find((p) => p.id === this.you)?.car ?? this.car;
        this.players = message.setup.players;
        this.started = true;
        this.options.onStart?.(message.setup);
        break;
      case 'snap':
        this.absorb(message.cars, message.time);
        break;
      case 'result':
        this.options.onResult?.(message.player, message.time, message.retired);
        break;
      case 'pong':
        this.rtt = Math.max(0, this.clock * 1000 - message.sent);
        break;
      case 'bye':
        if (message.player === undefined) {
          this.open = false;
          this.link.close();
          this.options.onClose?.();
        }
        break;
      default:
        break;
    }
  }

  /**
   * File a snapshot.
   *
   * Snapshots older than one already held are dropped rather than inserted:
   * with an unordered channel a straggler is not news, and applying it would
   * pull a car backwards through space.
   */
  private absorb(cars: readonly CarSnapshot[], time: number): void {
    this.stats.snapshots++;
    if (time < this.newest) return;
    this.newest = time;

    for (const snapshot of cars) {
      // Filed under our own numbering, so nothing downstream has to know that
      // the host calls this car something else.
      const index = this.swap(snapshot.car);
      let buffer = this.buffers.get(index);
      if (!buffer) {
        buffer = [];
        this.buffers.set(index, buffer);
      }
      buffer.push({
        time,
        p: toVec(snapshot.p),
        q: toQuat(snapshot.q),
        v: toVec(snapshot.v),
        w: toVec(snapshot.w),
        health: snapshot.health,
        progress: snapshot.progress,
      });
      // Keep a little over the interpolation window and no more.
      while (buffer.length > 2 && buffer[1]!.time < time - INTERP_DELAY * 3) buffer.shift();
    }

    if (this.playback === 0) this.playback = Math.max(0, time - INTERP_DELAY);
    if (this.world) this.reconcile();
  }

  /**
   * Compare the newest authoritative state of our own car with where we think
   * we are, and decide whether to argue or to concede.
   */
  private reconcile(): void {
    const world = this.world;
    if (!world) return;
    const buffer = this.buffers.get(0);
    const latest = buffer?.[buffer.length - 1];
    const car = world.cars[0];
    if (!latest || !car) return;

    const body = car.vehicle.body;
    const here = body.translation() as Vec3;
    // The error we would still have after the blend in flight lands.
    const error = sub(latest.p, { x: here.x + this.correction.x, y: here.y + this.correction.y, z: here.z + this.correction.z });
    const off = length(error);
    this.stats.worstError = Math.max(this.stats.worstError, off);

    const turned = angleBetween(body.rotation() as Quat, latest.q);
    if (off > HARD_SNAP || turned > HARD_SNAP_ANGLE) {
      body.setTranslation(latest.p, true);
      body.setRotation(latest.q, true);
      body.setLinvel(latest.v, true);
      body.setAngvel(latest.w, true);
      this.correction = { x: 0, y: 0, z: 0 };
      this.stats.snaps++;
      return;
    }

    this.correction = {
      x: this.correction.x + error.x,
      y: this.correction.y + error.y,
      z: this.correction.z + error.z,
    };
    this.stats.blends++;
  }

  /**
   * One fixed step of the local world.
   *
   * Our car is driven by our own input immediately; everyone else's body is
   * written from the interpolation buffer afterwards, so the physics step never
   * gets to disagree with the host about where they are.
   */
  step(localInput: DriverInput, dt: number): void {
    this.clock += dt;
    this.sinceInput += dt;
    this.sincePing += dt;

    if (this.open && this.sinceInput >= 1 / INPUT_HZ) {
      this.sinceInput = 0;
      this.link.send({ t: 'input', seq: ++this.seq, input: { ...localInput } });
    }
    if (this.open && this.sincePing >= 1) {
      this.sincePing = 0;
      this.link.send({ t: 'ping', sent: this.clock * 1000 });
    }

    const world = this.world;
    if (!world) return;

    const inputs: DriverInput[] = new Array(world.cars.length).fill(NEUTRAL_INPUT);
    inputs[0] = localInput;
    world.step(inputs);

    this.applyCorrection(dt);
    this.playRemotes(dt);
  }

  /** Walk our own car toward the authority, a slice at a time. */
  private applyCorrection(dt: number): void {
    const world = this.world;
    const car = world?.cars[0];
    if (!car) return;
    const remaining = length(this.correction);
    if (remaining < 1e-4) return;

    const slice = Math.min(1, dt / BLEND_TIME);
    const step = { x: this.correction.x * slice, y: this.correction.y * slice, z: this.correction.z * slice };
    const here = car.vehicle.body.translation() as Vec3;
    car.vehicle.body.setTranslation(
      { x: here.x + step.x, y: here.y + step.y, z: here.z + step.z },
      true,
    );
    this.correction = {
      x: this.correction.x - step.x,
      y: this.correction.y - step.y,
      z: this.correction.z - step.z,
    };
  }

  /**
   * Write every other car from its buffer, played back `INTERP_DELAY` behind.
   *
   * The playback clock runs on local time and is pulled gently toward the
   * host's, rather than being set from it: snapping the clock every packet
   * would show as the same stutter the buffer exists to hide.
   */
  private playRemotes(dt: number): void {
    const world = this.world;
    if (!world) return;
    const target = this.newest - INTERP_DELAY;
    if (this.playback === 0) return;
    this.playback += dt;
    // A tenth of a percent per step of drift correction; enough to hold station,
    // slow enough to be invisible.
    this.playback += (target - this.playback) * Math.min(1, dt * 2);

    for (const [index, buffer] of this.buffers) {
      if (index === 0) continue;
      const car = world.cars[index];
      if (!car || buffer.length === 0) continue;
      const state = this.sampleAt(buffer, this.playback);
      const body = car.vehicle.body;
      body.setTranslation(state.p, true);
      body.setRotation(state.q, true);
      body.setLinvel(state.v, true);
      body.setAngvel(state.w, true);
    }
  }

  /** Interpolate a buffer at a host time, holding the ends. */
  private sampleAt(buffer: readonly Sample[], time: number): Sample {
    const first = buffer[0]!;
    const last = buffer[buffer.length - 1]!;
    if (time <= first.time) return first;
    if (time >= last.time) return last;
    for (let i = 1; i < buffer.length; i++) {
      const b = buffer[i]!;
      if (b.time < time) continue;
      const a = buffer[i - 1]!;
      const span = b.time - a.time;
      const t = span > 0 ? (time - a.time) / span : 1;
      return {
        time,
        p: lerpVec(a.p, b.p, t),
        q: slerp(a.q, b.q, t),
        v: lerpVec(a.v, b.v, t),
        w: lerpVec(a.w, b.w, t),
        health: b.health,
        progress: b.progress,
      };
    }
    return last;
  }
}
