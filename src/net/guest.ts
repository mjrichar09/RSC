/**
 * A guest's side of a race.
 *
 * A guest runs the whole game — the same `SimWorld`, the same physics, the same
 * damage — and is the authority on exactly one thing in it: its own car. That
 * car is simulated here from the local controls and nowhere else; every input
 * goes up with the state it produced, and the host plays the car back from
 * those reports the way this class plays everyone else's back from the host's.
 *
 *   - **Your own car** is yours. It is never corrected. It used to be
 *     *predicted* — simulated here, simulated again on the host from the
 *     inputs, and walked back toward the host's copy whenever they disagreed.
 *     They always disagreed: an input reaches the host late and lands on
 *     whatever step happens to be next rather than the one it was pressed on,
 *     and a rally car on gravel turns a step's difference into metres. Only
 *     position was ever corrected, so a host copy that had lost a little speed
 *     dragged the guest back every snapshot while the guest's own engine pulled
 *     it forward again. That was the rubber-banding, and no amount of tuning
 *     the blend was going to remove it, because both copies were right about a
 *     different race.
 *   - **Everyone else's car** is *interpolated*, deliberately in the past — see
 *     `playback.ts`.
 *
 * One wrinkle that is worth the trouble it saves: the host numbers the cars and
 * a guest is rarely car zero, but the whole game above the simulation — the
 * camera, the HUD, the damage panel, the rescue — is written around the local
 * car being the first one. So the guest swaps its own car with car zero in its
 * own world and undoes the swap at the wire. `slots` hands the same permutation
 * to the grid, so both copies of the race line up identically.
 *
 * The remote cars are still real rigid bodies rather than ghosts, so you can
 * hit them — kinematic ones, moved with the motion behind them.
 */

import type { SimWorld } from '../sim/world.js';
import type { DriverInput } from '../sim/input.js';
import { NEUTRAL_INPUT } from '../sim/input.js';
import {
  type CarSnapshot,
  type CarState,
  INPUT_HZ,
  INPUT_HZ_CONGESTED,
  type Link,
  type NetMessage,
  type PlayerId,
  type PlayerInfo,
  PROTOCOL_VERSION,
  type RaceSetup,
  round3,
} from './protocol.js';
import { PlaybackClock, type Sample, file, pose, sampleAt, toQuat, toVec } from './playback.js';

export { INTERP_DELAY } from './playback.js';

/**
 * How long the input rate stays halved after the link last looked congested.
 *
 * Two seconds, because the thing being waited out is a congested radio leg and
 * those clear in seconds rather than in frames. Shorter and the rate flaps
 * against its own effect; much longer and a link that briefly hiccuped drives
 * at half rate for the rest of the corner.
 */
const EASE_OFF = 2;

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
  /** Which race this is, as the host numbers them. Snapshots from any other are dropped. */
  private race = 0;
  /**
   * The race the attached world belongs to. Between a `start` and the new
   * world being attached, the world here is still the last race's, and its
   * state tagged with the new race's number would hand the host a clock from
   * the wrong race — the same freeze, the other way round.
   */
  private attachedTo = -1;

  /** Snapshot history per car index, oldest first. */
  private readonly buffers = new Map<number, Sample[]>();
  /** The host's clock, as its snapshots show it. */
  private readonly clockOfHost = new PlaybackClock();

  private seq = 0;
  /** Seconds left at the reduced input rate. See where it is set. */
  private easeOff = 0;
  private sinceInput = 0;
  private sincePing = 0;
  private clock = 0;

  /**
   * Snapshots taken in, and ones thrown away as stale or from another race,
   * for the tests and the netgraph.
   */
  stats = { snapshots: 0, dropped: 0 };

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
    this.attachedTo = this.race;
    this.buffers.clear();
    // Every race starts the host's world clock at zero again. This clock kept
    // the last race's newest time, so every snapshot of the next race read as
    // older than one already held and was thrown away — and the host's car sat
    // on the grid, as far as this screen knew, while the host drove it.
    this.clockOfHost.reset();
    this.sinceInput = 0;
    // The counters are a readout of *this* race now that something reads them.
    this.stats = { snapshots: 0, dropped: 0 };
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
        this.race = typeof message.race === 'number' ? message.race : this.race + 1;
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
        if (message.race !== this.race) {
          this.stats.dropped++;
          break;
        }
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
   *
   * Our own car is in it too, as the host has it — which is *our* report played
   * back, so it is filed for the standings and never applied.
   */
  private absorb(cars: readonly CarSnapshot[], time: number): void {
    if (!this.clockOfHost.note(time)) {
      this.stats.dropped++;
      return;
    }
    this.stats.snapshots++;

    for (const snapshot of cars) {
      // Filed under our own numbering, so nothing downstream has to know that
      // the host calls this car something else.
      const index = this.swap(snapshot.car);
      let buffer = this.buffers.get(index);
      if (!buffer) {
        buffer = [];
        this.buffers.set(index, buffer);
      }
      file(buffer, {
        time,
        p: toVec(snapshot.p),
        q: toQuat(snapshot.q),
        v: toVec(snapshot.v),
        w: toVec(snapshot.w),
        health: snapshot.health,
        progress: snapshot.progress,
      });
    }
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

    const world = this.world;
    if (world) {
      const inputs: DriverInput[] = new Array(world.cars.length).fill(NEUTRAL_INPUT);
      inputs[0] = localInput;
      world.step(inputs);
      this.playRemotes(dt);
    }

    /*
     * Full rate while the link is keeping up, half while it is not.
     *
     * Sending into a queue that is already behind buys nothing: the packet is
     * dropped by the transport anyway, and on a phone it costs a radio
     * transmission to find that out.
     *
     * Held for a while after the link looks clear again, and that is not
     * caution — it is what stops the two rates fighting. Backing off empties
     * the queue, an empty queue reads as healthy, and going straight back to
     * full rate fills it again; measured, that flapping left more standing
     * error than either fixed rate. `EASE_OFF` is long enough that the link
     * has to be genuinely clear, not merely clear for one packet.
     *
     * After the step, so the state that goes up is the one this input made.
     */
    if (this.link.congested) this.easeOff = EASE_OFF;
    else this.easeOff = Math.max(this.easeOff - dt, 0);
    const rate = this.easeOff > 0 ? INPUT_HZ_CONGESTED : INPUT_HZ;
    if (this.open && this.sinceInput >= 1 / rate) {
      this.sinceInput = 0;
      const state = this.attachedTo === this.race ? this.ownState() : null;
      this.link.send({
        t: 'input',
        seq: ++this.seq,
        input: { ...localInput },
        race: this.race,
        ...(state ? { state } : {}),
      });
    }
    if (this.open && this.sincePing >= 1) {
      this.sincePing = 0;
      this.link.send({ t: 'ping', sent: this.clock * 1000 });
    }
  }

  /** Our own car as we have it: the only report of it anybody gets. */
  private ownState(): CarState | null {
    const world = this.world;
    const car = world?.cars[0];
    if (!world || !car) return null;
    const body = car.vehicle.body;
    const p = body.translation();
    const q = body.rotation();
    const v = body.linvel();
    const w = body.angvel();
    return {
      time: round3(world.time),
      p: [round3(p.x), round3(p.y), round3(p.z)],
      q: [round3(q.x), round3(q.y), round3(q.z), round3(q.w)],
      v: [round3(v.x), round3(v.y), round3(v.z)],
      w: [round3(w.x), round3(w.y), round3(w.z)],
      health: Math.round((car.damage?.condition ?? 1) * 100) / 100,
    };
  }

  /** Write every other car from its buffer, played back `INTERP_DELAY` behind. */
  private playRemotes(dt: number): void {
    const world = this.world;
    if (!world || !this.clockOfHost.running) return;
    const playback = this.clockOfHost.advance(dt);
    for (const [index, buffer] of this.buffers) {
      if (index === 0) continue;
      const car = world.cars[index];
      if (!car || buffer.length === 0) continue;
      pose(car.vehicle, sampleAt(buffer, playback));
    }
  }
}
