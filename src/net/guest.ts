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

/** How much of our own past to keep, seconds. Comfortably over a round trip. */
const HISTORY_SECONDS = 1;

/**
 * How far past the newest snapshot a remote car may be carried, seconds.
 *
 * Two snapshot intervals. Long enough to cover a lost packet, short enough that
 * a car whose owner has genuinely stopped sending does not sail off across the
 * scenery on a velocity from a third of a second ago.
 */
const EXTRAPOLATE_LIMIT = 0.1;
/**
 * How fast the best-round-trip estimate is allowed to rot, ms per pong.
 *
 * Without it one lucky early packet pins the clock offset for the whole race
 * and a route that gets slower is never noticed. Pings are one a second, so
 * this forgets a good sample over about half a minute.
 */
const CLOCK_DECAY_MS = 30;



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
  /** Paint and number picked in the lobby. */
  livery?: string;
  number?: number;
  /** The lobby changed, including what the host has picked to race. */
  onLobby?: (players: PlayerInfo[], pick: { stageId: string; variantId: string }) => void;
  /** The host has started a race; build a world for this setup and `attach` it. */
  onStart?: (setup: RaceSetup) => void;
  /** Everybody is on the grid: start the countdown. */
  onGo?: () => void;
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

  /**
   * Where we thought we were, stamped with the host's clock.
   *
   * The whole point of this class is to be ahead of the host — that is what
   * makes the wheel respond in the frame it was turned. So comparing the
   * authority's position against where we are *now* measures the lead as
   * though it were error, and the lead is one-way delay plus snapshot age
   * worth of entirely legitimate motion. Measured on the loopback harness at
   * 30 m/s: 0.25 m of mean error at no latency, 2.23 m at 120 ms, 3.72 m at
   * 200 ms — a straight line through the latency, which is the signature of a
   * timing mistake rather than of the physics disagreeing.
   *
   * Worse, `HARD_SNAP` is 2.5 m, so past about 100 ms that manufactured error
   * crosses the teleport threshold and the car is *snapped* rather than nudged
   * — 39 times in thirty seconds at 120 ms, 57 at 200 ms. That is the jolt.
   *
   * So we keep our own past. A snapshot stamped host-time T is compared with
   * where we thought we were at T, and the difference is the only thing that
   * is really error.
   */
  private readonly history: { t: number; p: Vec3; q: Quat }[] = [];

  /**
   * Host clock minus our clock, in seconds, or null until a pong lands.
   *
   * From the *lowest-RTT* pong rather than the most recent. A round trip can
   * only ever be delayed, never hurried, so the quickest exchange seen is the
   * one least polluted by queueing — taking the latest instead would make the
   * offset jitter by exactly the amount of jitter on the link, which is the
   * thing being corrected for.
   */
  private hostOffset: number | null = null;
  private bestRtt = Infinity;

  /** Corrections applied so far, for the tests and the netgraph. */
  stats = { snapshots: 0, blends: 0, snaps: 0, worstError: 0 };

  constructor(link: Link, options: GuestOptions = {}) {
    this.link = link;
    this.options = options;
    link.onMessage((message) => this.receive(message));
    link.onClose(() => {
      this.open = false;
      this.options.onClose?.();
    });
    link.send({
      t: 'hello',
      version: PROTOCOL_VERSION,
      name: options.name ?? 'Guest',
      livery: options.livery ?? 'works',
      number: options.number ?? 2,
    });
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
    // Our own past belongs to the world that made it: a new stage restarts the
    // relationship between the two clocks, and a stale entry would be compared
    // against a snapshot from somewhere else entirely.
    this.history.length = 0;
    // The counters are a readout of *this* race now that something reads them.
    // `worstError` kept a lifetime maximum across every race in the session, so
    // one bad moment in practice made the connection look broken for the
    // evening.
    this.stats = { snapshots: 0, blends: 0, snaps: 0, worstError: 0 };
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

  /** Repaint. Only the lobby honours it; the host ignores it mid-race. */
  repaint(livery: string, number: number): void {
    this.link.send({ t: 'livery', livery, number });
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
        this.options.onLobby?.(message.players, {
          stageId: message.stageId,
          variantId: message.variantId,
        });
        break;
      case 'start':
        this.setup = message.setup;
        this.car = message.setup.players.find((p) => p.id === this.you)?.car ?? this.car;
        this.players = message.setup.players;
        this.started = true;
        this.options.onStart?.(message.setup);
        // Report in. The host holds the whole grid until everyone has a world,
        // so the green comes up at the same moment on every screen rather than
        // whenever each machine happened to finish loading.
        this.link.send({ t: 'ready', ready: true });
        break;
      case 'go':
        this.options.onGo?.();
        break;
      case 'snap':
        this.absorb(message.cars, message.time);
        break;
      case 'result':
        this.options.onResult?.(message.player, message.time, message.retired);
        break;
      case 'pong': {
        const rtt = Math.max(0, this.clock * 1000 - message.sent);
        this.rtt = rtt;
        // `hostTime` has always been on the wire and was always thrown away.
        // The host stamped it on the way back, so it was current half a round
        // trip ago.
        if (rtt <= this.bestRtt || this.hostOffset === null) {
          this.bestRtt = rtt;
          this.hostOffset = message.hostTime + rtt / 2000 - this.clock;
        } else {
          // Let the best decay, or one lucky early packet pins the estimate for
          // the rest of the race and a route change is never picked up.
          this.bestRtt += CLOCK_DECAY_MS;
        }
        break;
      }
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

    // Like for like: what the authority says about host-time T against what we
    // thought at host-time T, not against where we have since driven to. Before
    // the first pong there is no clock to line them up with, so this falls back
    // to the old comparison — wrong, but wrong for a fraction of a second at
    // the very start rather than for the whole race.
    const then = this.predictedAt(latest.time);
    const mine = then ? then.p : { x: here.x + this.correction.x, y: here.y + this.correction.y, z: here.z + this.correction.z };
    const error = sub(latest.p, mine);
    const off = length(error);
    this.stats.worstError = Math.max(this.stats.worstError, off);

    // The heading at the same moment, for the same reason.
    const turned = angleBetween(then ? then.q : (body.rotation() as Quat), latest.q);
    if (off > HARD_SNAP || turned > HARD_SNAP_ANGLE) {
      body.setTranslation(latest.p, true);
      body.setRotation(latest.q, true);
      body.setLinvel(latest.v, true);
      body.setAngvel(latest.w, true);
      this.correction = { x: 0, y: 0, z: 0 };
      this.history.length = 0;
      this.stats.snaps++;
      return;
    }

    // Replaces rather than accumulates: `error` is measured against our own
    // past, so it already accounts for everything still in flight.
    this.correction = error;

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

    this.remember();
    this.applyCorrection(dt);
    this.playRemotes(dt);
  }

  /**
   * File where we ended this step, on the host's clock.
   *
   * After the physics and before the correction, because what the host is
   * about to disagree with is our *prediction* — folding the previous
   * correction back in would be comparing the authority against itself.
   */
  private remember(): void {
    const car = this.world?.cars[0];
    if (!car || this.hostOffset === null) return;
    const body = car.vehicle.body;
    this.history.push({
      t: this.clock + this.hostOffset,
      p: { ...(body.translation() as Vec3) },
      q: { ...(body.rotation() as Quat) },
    });
    // A second is far more than a round trip and costs a few kilobytes.
    const cutoff = this.clock + this.hostOffset - HISTORY_SECONDS;
    while (this.history.length > 2 && this.history[0]!.t < cutoff) this.history.shift();
  }

  /** Where we thought we were at a host time, or null if it is off the end. */
  private predictedAt(time: number): { p: Vec3; q: Quat } | null {
    if (this.history.length < 2) return null;
    const first = this.history[0]!;
    const last = this.history[this.history.length - 1]!;
    // Clamped at both ends rather than refused. Falling back to "where we are
    // now" costs a whole round trip of manufactured error — the very thing this
    // exists to remove — while clamping costs only however far past the end the
    // request landed, which is a step or two whenever the clock estimate is
    // roughly right. Measured at 200 ms and 100 ms of jitter, refusing here was
    // still producing 58 teleports in thirty seconds; clamping removes them.
    if (time <= first.t) return { p: first.p, q: first.q };
    if (time >= last.t) return { p: last.p, q: last.q };
    for (let i = 1; i < this.history.length; i++) {
      const b = this.history[i]!;
      if (b.t < time) continue;
      const a = this.history[i - 1]!;
      const span = b.t - a.t;
      const k = span > 1e-6 ? (time - a.t) / span : 0;
      return { p: lerpVec(a.p, b.p, k), q: slerp(a.q, b.q, k) };
    }
    return { p: last.p, q: last.q };
  }

  /** Walk our own car toward the authority, a slice at a time. */
  private applyCorrection(dt: number): void {
    const world = this.world;
    const car = world?.cars[0];
    if (!car) return;

    // Position only, deliberately.
    //
    // Blending *rotation* was tried and removed, and the way it failed is worth
    // keeping: slerping the current heading toward the authority's repeats the
    // exact timing mistake this class was just fixed for, one field over. The
    // snapshot's heading is from half a round trip ago, and during a slalom the
    // car has legitimately turned since — so the blend drags the nose backwards
    // and makes things worse the higher the latency. Measured, it added twenty
    // teleports in thirty seconds at 200 ms. Doing it properly means applying
    // the *rotational delta* measured at the snapshot's own timestamp, which
    // needs quaternion multiply and inverse that this project does not have.
    // A gross heading error is still caught by the snap branch, as before.
    //
    // Velocity is left alone for a different reason: the vehicle model
    // re-derives suspension, load and slip from the body every step, so writing
    // a velocity from a stale snapshot fights the tyre model rather than
    // helping it.
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

  /** Interpolate a buffer at a host time, extrapolating a little past the end. */
  private sampleAt(buffer: readonly Sample[], time: number): Sample {
    const first = buffer[0]!;
    const last = buffer[buffer.length - 1]!;
    if (time <= first.time) return first;
    if (time >= last.time) {
      // Carried forward on its last known velocity rather than stopped dead. A
      // car that freezes and then jumps reads as a far bigger fault than one
      // that keeps going and is quietly corrected — and a frozen car is also
      // the wrong thing to try to overtake. Capped hard, because a car held on
      // a stale velocity through a corner ends up somewhere it never went.
      const ahead = Math.min(time - last.time, EXTRAPOLATE_LIMIT);
      return {
        ...last,
        p: {
          x: last.p.x + last.v.x * ahead,
          y: last.p.y + last.v.y * ahead,
          z: last.p.z + last.v.z * ahead,
        },
      };
    }
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
