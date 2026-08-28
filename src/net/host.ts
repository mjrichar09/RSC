/**
 * The authoritative side.
 *
 * The host runs the only real simulation. Guests send it inputs and it sends
 * back what happened. It is the same `SimWorld` the single-player game runs —
 * that is the whole reason this was cheap to build, and it is what the very
 * first structural rule of this project bought: the simulation never imported
 * three.js, so it can be the truth for a race rather than a picture of one.
 *
 * The host is also a player. Its own car is index 0, so it drives with zero
 * latency and everyone else is corrected toward it.
 */

import type { SimWorld } from '../sim/world.js';
import type { DriverInput } from '../sim/input.js';
import { NEUTRAL_INPUT } from '../sim/input.js';
import {
  type CarSnapshot,
  type Link,
  MAX_PLAYERS,
  type NetMessage,
  type PlayerId,
  type PlayerInfo,
  PROTOCOL_VERSION,
  type RaceSetup,
  SNAPSHOT_HZ,
  packCar,
} from './protocol.js';

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
}

export interface HostOptions {
  name?: string;
  /** Called when the lobby changes, so the UI can redraw. */
  onLobby?: (players: PlayerInfo[]) => void;
  /** Called when a player finishes or retires. */
  onResult?: (player: PlayerId, time: number | null, retired: boolean) => void;
}

/** Seconds of silence before a guest's car stops being driven by them. */
const SILENT_TIMEOUT = 5;

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
      name: options.name ?? 'Host',
      host: true,
      car: 0,
      ready: true,
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

      const id = this.nextId++;
      const info: PlayerInfo = {
        id,
        name: message.name.slice(0, 16) || `Player ${id + 1}`,
        host: false,
        car: this.players.length,
        ready: false,
      };
      this.players.push(info);
      this.guests.set(id, { id, link, info, input: { ...NEUTRAL_INPUT }, seq: -1, silent: 0 });

      link.send({ t: 'welcome', you: id, setup: this.describeSetup() });
      this.broadcastLobby();
      return;
    }

    const guest = [...this.guests.values()].find((entry) => entry.link === link);
    if (!guest) return;
    guest.silent = 0;

    switch (message.t) {
      case 'ready':
        guest.info.ready = message.ready;
        this.broadcastLobby();
        break;
      case 'input':
        // Out-of-order arrivals are dropped rather than applied backwards: an
        // input that is older than one already used is not news.
        if (message.seq > guest.seq) {
          guest.seq = message.seq;
          guest.input = message.input;
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

  /** Tell everyone what is being raced and when it begins. */
  start(setup: Omit<RaceSetup, 'players'>, world: SimWorld): void {
    this.setup = { ...setup, players: this.players.map((player) => ({ ...player })) };
    this.world = world;
    this.started = true;
    this.broadcast({ t: 'start', setup: this.setup, at: 0 });
  }

  /**
   * Advance one fixed step, using whatever each guest last sent.
   *
   * A guest who has gone quiet keeps their last input briefly — a dropped
   * packet should not stab the brakes — and is then neutralised, because a car
   * driving itself into the scenery on a stuck throttle is worse than one that
   * coasts to a halt.
   */
  step(localInput: DriverInput, dt: number): void {
    if (!this.world) return;

    const inputs: DriverInput[] = new Array(this.world.cars.length).fill(NEUTRAL_INPUT);
    inputs[0] = localInput;

    for (const guest of this.guests.values()) {
      guest.silent += dt;
      if (guest.silent > SILENT_TIMEOUT) guest.input = { ...NEUTRAL_INPUT };
      const car = guest.info.car;
      if (car < inputs.length) inputs[car] = guest.input;
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

    const cars: CarSnapshot[] = this.world.cars.map((car, index) => {
      const body = car.vehicle.body;
      return packCar(
        index,
        body.translation(),
        body.rotation(),
        body.linvel(),
        body.angvel(),
        car.damage?.condition ?? 1,
        progressOf(index),
      );
    });

    for (const guest of this.guests.values()) {
      guest.link.send({
        t: 'snap',
        tick: this.world.steps,
        time: this.world.time,
        cars,
        // Echoing their own latest sequence is what lets a guest tell how far
        // behind the authority its own prediction is.
        ack: guest.seq,
      });
    }
  }

  /** Announce a finish or a retirement to everyone. */
  report(player: PlayerId, time: number | null, retired: boolean): void {
    this.broadcast({ t: 'result', player, time, retired });
    this.options.onResult?.(player, time, retired);
  }

  private broadcastLobby(): void {
    this.broadcast({ t: 'lobby', players: this.players.map((player) => ({ ...player })) });
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
