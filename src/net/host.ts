/**
 * The authoritative side.
 *
 * The host runs the room and the race's bookkeeping, and is the hub every
 * car's state goes through. It is the authority on its own car (index 0) and
 * on nothing else: each guest simulates its own car and reports where it went,
 * and the host plays those reports back into kinematic bodies, exactly the way
 * a guest plays the host's car back from snapshots. The snapshots it sends
 * carry every car, so guests see each other through it.
 *
 * It used to simulate every guest's car itself, from their inputs, and correct
 * each guest toward its copy — which is the rubber-banding `guest.ts` describes.
 * It is still the same `SimWorld` the single-player game runs; what changed is
 * only whose physics each car obeys.
 */

import type { SimWorld } from '../sim/world.js';
import type { DriverInput } from '../sim/input.js';
import { NEUTRAL_INPUT } from '../sim/input.js';
import {
  type CarSnapshot,
  type CarState,
  type Link,
  MAX_PLAYERS,
  type NetMessage,
  type PlayerId,
  type PlayerInfo,
  PROTOCOL_VERSION,
  type RaceSetup,
  SNAPSHOT_HZ,
  cleanInput,
  cleanLivery,
  cleanName,
  cleanNumber,
  cleanState,
  packCar,
} from './protocol.js';
import { PlaybackClock, type Sample, file, pose, sampleAt, toQuat, toVec } from './playback.js';

interface Guest {
  id: PlayerId;
  link: Link;
  info: PlayerInfo;
  /** Their latest input, held until the next step consumes it. */
  input: DriverInput;
  /** Highest input sequence seen, echoed back so they can discard old state. */
  seq: number;
  /** Seconds since anything arrived from them. */
  silent: number;
  /** Their car as they reported it, oldest first, on their own clock. */
  reports: Sample[];
  clock: PlaybackClock;
  /** Condition of their car, as their own damage model has it. */
  health: number;
}

export interface HostOptions {
  name?: string;
  /** Paint and number this player picked in the lobby. */
  livery?: string;
  number?: number;
  /** Called when the lobby changes, so the UI can redraw. */
  onLobby?: (players: PlayerInfo[]) => void;
  /** Called when a player finishes or retires. */
  onResult?: (player: PlayerId, time: number | null, retired: boolean) => void;
  /** Everybody has a world; start the countdown. */
  onGo?: () => void;
}

/** Seconds of silence before a guest's last input is cleared outright. */
const SILENT_TIMEOUT = 5;

/*
 * A guest's input no longer drives anything on the host — their car is put
 * where they report it — but it still reaches the kinematic car's vehicle model,
 * which is what turns its front wheels, lights its brake lamps and revs its
 * engine on the host's screen. Faded for the same reasons it always was, which
 * are kept below: a held input looks exactly as wrong as it used to drive.
 */

/**
 * How long a guest's last input is trusted completely, seconds.
 *
 * Inputs arrive at 60 Hz, so this is nine of them: long enough that ordinary
 * loss and jitter never register, short enough that a device hitch does.
 */
const INPUT_FRESH = 0.15;

/**
 * How long it then takes to fade to nothing, seconds.
 *
 * The old behaviour was to hold the last input unchanged for five seconds and
 * then drop it. Measured, that is catastrophic and it is the whole of the
 * "other players drift off course" report: a guest mid-corner at full throttle
 * on three quarters of a turn of lock, whose phone hitches for one second, has
 * their car driven 29.8 m by the host — and 197 m over the full five. The car
 * does not stop doing what it was doing; it keeps doing it, which on a corner
 * means leaving the road entirely while its driver watches.
 *
 * Holding *something* is still right — a single dropped packet must not stab
 * the brakes — so this is a fade rather than a cliff.
 */
const INPUT_DECAY = 0.35;

/**
 * What a guest's last input is worth once it has stopped being refreshed.
 *
 * Steering decays fastest, squared against the rest, because it is the only
 * channel that changes a car's *course*: a stale throttle makes a car go
 * somewhere too fast, a stale lock makes it go somewhere else entirely. Brake
 * is held to the end, because the safe way to be wrong about a car nobody is
 * currently driving is for it to be slowing down.
 */
function stale(input: DriverInput, silent: number): DriverInput {
  const gone = Math.min(Math.max((silent - INPUT_FRESH) / INPUT_DECAY, 0), 1);
  if (gone <= 0) return input;
  const keep = 1 - gone;
  return {
    throttle: input.throttle * keep,
    brake: input.brake,
    steer: input.steer * keep * keep,
    handbrake: input.handbrake * keep,
  };
}

export class RaceHost {
  readonly players: PlayerInfo[] = [];
  private readonly guests = new Map<PlayerId, Guest>();
  private readonly options: HostOptions;
  private nextId = 1;
  private sinceSnapshot = 0;
  private setup: RaceSetup | null = null;
  private world: SimWorld | null = null;
  private started = false;

  constructor(options: HostOptions = {}) {
    this.options = options;
    this.players.push({
      id: 0,
      name: cleanName(options.name, 'Host'),
      host: true,
      car: 0,
      ready: true,
      livery: options.livery ?? 'works',
      number: cleanNumber(options.number),
      wins: 0,
    });
  }

  get playerCount(): number {
    return this.players.length;
  }

  get full(): boolean {
    return this.players.length >= MAX_PLAYERS;
  }

  /** True once everyone in the lobby has said they are ready. */
  get everyoneReady(): boolean {
    return this.players.length > 1 && this.players.every((player) => player.ready);
  }

  /**
   * Take on a new guest.
   *
   * The car index is the player's slot and is never reused: a guest who leaves
   * and rejoins gets a fresh car rather than inheriting a wreck.
   */
  accept(link: Link): void {
    link.onMessage((message) => this.receive(link, message));
    link.onClose(() => this.dropByLink(link));
  }

  private receive(link: Link, message: NetMessage): void {
    if (message.t === 'hello') {
      if (message.version !== PROTOCOL_VERSION) {
        link.send({ t: 'bye' });
        link.close();
        return;
      }
      if (this.full || this.started) {
        link.send({ t: 'bye' });
        link.close();
        return;
      }

      // Everything in a `hello` was typed by a stranger and none of it has
      // been checked before here: the shape as much as the content, because a
      // guest that sends a number where a name belongs used to throw inside
      // this handler rather than be refused.
      const id = this.nextId++;
      const info: PlayerInfo = {
        id,
        name: cleanName(message.name, `Player ${id + 1}`),
        host: false,
        car: this.players.length,
        ready: false,
        livery: cleanLivery(message.livery),
        number: cleanNumber(message.number),
        wins: 0,
      };
      this.players.push(info);
      this.guests.set(id, {
        id,
        link,
        info,
        input: { ...NEUTRAL_INPUT },
        seq: -1,
        silent: 0,
        reports: [],
        clock: new PlaybackClock(),
        health: 1,
      });

      link.send({ t: 'welcome', you: id, setup: this.describeSetup() });
      this.broadcastLobby();
      return;
    }

    const guest = [...this.guests.values()].find((entry) => entry.link === link);
    if (!guest) return;
    guest.silent = 0;

    switch (message.t) {
      case 'ready':
        // Before the start this is lobby readiness. After it, it is a guest
        // saying its world is built and it is on the grid.
        if (this.started) {
          this.waitingFor.delete(guest.id);
          if (this.waitingFor.size === 0) this.releaseGrid();
          break;
        }
        guest.info.ready = message.ready;
        this.broadcastLobby();
        break;
      case 'livery':
        // Repainting is a lobby thing. Mid-race it would change a car people
        // are using to tell each other apart, in the middle of using it.
        if (!this.started) {
          guest.info.livery = cleanLivery(message.livery);
          guest.info.number = cleanNumber(message.number, guest.info.number);
          this.broadcastLobby();
        }
        break;
      case 'input':
        // Out-of-order arrivals are dropped rather than applied backwards: an
        // input that is older than one already used is not news.
        if (typeof message.seq === 'number' && message.seq > guest.seq) {
          guest.seq = message.seq;
          guest.input = cleanInput(message.input);
          // Bounded here because this is the thing a guest sends that reaches
          // the host's physics: it is where their kinematic body is put. And
          // only for this race — a report still in flight from the last one is
          // on a clock that has since restarted from zero.
          const state = cleanState(message.state);
          if (state && this.started && message.race === this.race) this.absorb(guest, state);
        }
        break;
      case 'result':
        // A guest is the only one who knows it crossed the line; the host is
        // the only one who can tell everybody else.
        this.report(guest.id, message.time, message.retired);
        break;
      case 'ping':
        guest.link.send({ t: 'pong', sent: message.sent, hostTime: this.world?.time ?? 0 });
        break;
      case 'bye':
        this.drop(guest.id);
        break;
      default:
        break;
    }
  }

  private dropByLink(link: Link): void {
    const guest = [...this.guests.values()].find((entry) => entry.link === link);
    if (guest) this.drop(guest.id);
  }

  /** Remove a player. Their car stays in the world, parked, until the race ends. */
  drop(id: PlayerId): void {
    const guest = this.guests.get(id);
    if (!guest) return;
    this.guests.delete(id);
    const at = this.players.findIndex((player) => player.id === id);
    if (at >= 0) this.players.splice(at, 1);
    guest.link.close();
    this.broadcast({ t: 'bye', player: id });
    this.broadcastLobby();
  }

  /** File a guest's report of its own car. */
  private absorb(guest: Guest, state: CarState): void {
    if (!guest.clock.note(state.time)) return;
    guest.health = state.health;
    file(guest.reports, {
      time: state.time,
      p: toVec(state.p),
      q: toQuat(state.q),
      v: toVec(state.v),
      w: toVec(state.w),
      health: state.health,
      progress: 0,
    });
  }

  /** Describe the race as it currently stands, for a joining guest. */
  private describeSetup(): RaceSetup {
    return (
      this.setup ?? {
        stageId: '',
        variantId: 'day-clear',
        conditions: { timeOfDay: 'day', weather: 'clear' },
        seed: 1,
        players: this.players.map((player) => ({ ...player })),
      }
    );
  }

  /**
   * Tell everyone what is being raced.
   *
   * The countdown does *not* start here. Building a world is asynchronous and
   * takes a different amount of time on every machine, so each side running
   * its own countdown from the moment it finished loading put the green up at
   * a different instant on every screen. The host waits until everyone has a
   * world and then sends one `go`; what is left is one-way latency, which is
   * tens of milliseconds rather than seconds.
   */
  start(setup: Omit<RaceSetup, 'players'>, world: SimWorld): void {
    this.setup = { ...setup, players: this.players.map((player) => ({ ...player })) };
    this.world = world;
    this.started = true;
    this.race++;
    // Every guest's world clock starts again at zero with this race.
    for (const guest of this.guests.values()) {
      guest.reports.length = 0;
      guest.clock.reset();
      guest.health = 1;
    }
    this.waitingFor = new Set(this.guests.keys());
    this.broadcast({ t: 'start', setup: this.setup, at: 0, race: this.race });
    // A host racing alone has nobody to wait for.
    if (this.waitingFor.size === 0) this.releaseGrid();
  }

  /** Guests who have not yet said they have a world. */
  private waitingFor = new Set<PlayerId>();

  /**
   * Everybody is on the grid: count down.
   *
   * Also the deadline: a guest that never reports in cannot hold the race up
   * forever, so `main.ts` gives this a few seconds and then calls it anyway.
   */
  releaseGrid(): void {
    if (this.gridReleased) return;
    this.waitingFor.clear();
    this.gridReleased = true;
    this.broadcast({ t: 'go' });
    this.options.onGo?.();
  }

  private gridReleased = false;

  /** Which race this is. Stamped on every snapshot; see `NetMessage`. */
  private race = 0;

  /**
   * Advance one fixed step: our own car from our controls, every guest's car
   * from their reports, played back `INTERP_DELAY` behind the newest.
   *
   * A guest who goes quiet is carried on their last velocity for a tenth of a
   * second and then held where they were last seen — parked, rather than
   * driven anywhere they did not go.
   */
  step(localInput: DriverInput, dt: number): void {
    if (!this.world) return;

    const inputs: DriverInput[] = new Array(this.world.cars.length).fill(NEUTRAL_INPUT);
    inputs[0] = localInput;

    for (const guest of this.guests.values()) {
      guest.silent += dt;
      // Past the timeout it is not a hitch, it is a player who has gone. Their
      // input is cleared outright so nothing lingers if they come back.
      if (guest.silent > SILENT_TIMEOUT) guest.input = { ...NEUTRAL_INPUT };
      const car = guest.info.car;
      if (car < inputs.length) inputs[car] = stale(guest.input, guest.silent);
      const vehicle = this.world.cars[car]?.vehicle;
      if (vehicle && guest.reports.length > 0) {
        pose(vehicle, sampleAt(guest.reports, guest.clock.advance(dt)));
      }
    }

    this.world.step(inputs);
  }

  /**
   * Send a snapshot if one is due.
   *
   * Called every frame; it decides for itself. Twenty a second is enough for
   * interpolation to hide the gaps and cheap enough that the whole race costs
   * a few kilobytes a second.
   */
  maybeSnapshot(dt: number, progressOf: (car: number) => number): void {
    if (!this.world || this.guests.size === 0) return;
    this.sinceSnapshot += dt;
    const interval = 1 / SNAPSHOT_HZ;
    if (this.sinceSnapshot < interval) return;
    // Subtract rather than zero: zeroing throws away the remainder every time
    // and quietly makes twenty snapshots a second into seventeen.
    this.sinceSnapshot -= interval;

    const health = new Map<number, number>();
    for (const guest of this.guests.values()) health.set(guest.info.car, guest.health);
    const cars: CarSnapshot[] = this.world.cars.map((car, index) => {
      const body = car.vehicle.body;
      return packCar(
        index,
        body.translation(),
        body.rotation(),
        body.linvel(),
        body.angvel(),
        // A guest's car is damaged in the guest's world, which is the one that
        // simulates it; the host's copy only stands where it is told.
        health.get(index) ?? car.damage?.condition ?? 1,
        progressOf(index),
      );
    });

    for (const guest of this.guests.values()) {
      guest.link.send({
        t: 'snap',
        tick: this.world.steps,
        time: this.world.time,
        race: this.race,
        cars,
        // Their own latest sequence, echoed: how far behind the host's picture
        // of them is.
        ack: guest.seq,
      });
    }
  }

  /** Announce a finish or a retirement to everyone. */
  report(player: PlayerId, time: number | null, retired: boolean): void {
    this.broadcast({ t: 'result', player, time, retired });
    this.options.onResult?.(player, time, retired);
  }

  /**
   * What the lobby is about to race.
   *
   * Carried with the player list because the host picks the stage *after*
   * everyone has joined — which is the order that makes sense when the point
   * is racing your friends rather than a stage — and a guest that cannot see
   * the choice is agreeing to something it has not been told.
   */
  private pending = { stageId: '', variantId: 'day-clear' };

  /** The host's own paint, chosen in the lobby like everyone else's. */
  repaint(livery: string, number: number): void {
    const me = this.players[0];
    if (!me || this.started) return;
    me.livery = livery;
    me.number = number;
    this.broadcastLobby();
  }

  /** The host picks, and everyone sees it immediately. */
  setStage(stageId: string, variantId: string): void {
    this.pending = { stageId, variantId };
    this.broadcastLobby();
  }

  /**
   * Credit a win and tell everyone.
   *
   * The tally belongs to the lobby, not to a profile: it is the reason to run
   * another race with the same people, and it means nothing outside the room.
   */
  creditWin(player: PlayerId): void {
    const winner = this.players.find((p) => p.id === player);
    if (!winner) return;
    winner.wins++;
    this.broadcastLobby();
  }

  /** Let everyone back into the lobby to pick again. */
  reopen(): void {
    this.started = false;
    this.gridReleased = false;
    this.waitingFor.clear();
    for (const player of this.players) player.ready = player.host;
    this.broadcastLobby();
  }

  private broadcastLobby(): void {
    this.broadcast({
      t: 'lobby',
      players: this.players.map((player) => ({ ...player })),
      ...this.pending,
    });
    this.options.onLobby?.(this.players);
  }

  private broadcast(message: NetMessage): void {
    for (const guest of this.guests.values()) guest.link.send(message);
  }

  /** Close every connection. The host's own race is unaffected. */
  shutdown(): void {
    for (const guest of this.guests.values()) {
      guest.link.send({ t: 'bye' });
      guest.link.close();
    }
    this.guests.clear();
    this.players.length = 1;
  }
}
