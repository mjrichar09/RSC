/**
 * The netcode, over a wire that lies.
 *
 * Everything here runs in one process against `LoopbackWire`, which delays and
 * drops packets on a clock the test controls. That is deliberate: every
 * property worth protecting is a property of the protocol rather than of
 * WebRTC, and a test that opened a real data channel would be testing the
 * browser instead — slowly, and only at whatever latency the machine happened
 * to have that day.
 *
 * The number that matters is the last one: how far the guest's own car ends up
 * from where the host says it is, after a minute of driving at a realistic
 * ping. If that stays small, the game is playable; if it does not, no amount of
 * lobby correctness helps.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type SimWorld } from '../src/sim/world.js';
import type { DriverInput } from '../src/sim/input.js';
import { NEUTRAL_INPUT } from '../src/sim/input.js';
import { RaceHost } from '../src/net/host.js';
import { RaceGuest } from '../src/net/guest.js';
import { LoopbackWire } from '../src/net/loopback.js';
import { MAX_PLAYERS, PROTOCOL_VERSION, type NetMessage } from '../src/net/protocol.js';
import { MultiplayerSession } from '../src/game/multiplayer.js';

const DT = 1 / 120;

const SETUP = {
  stageId: 'test',
  variantId: 'day-clear',
  conditions: { timeOfDay: 'day', weather: 'clear' } as const,
  seed: 7,
};

/** A host and one guest, wired together, both with a world of `cars` cars. */
async function pair(options: { latency?: number; loss?: number; cars?: number } = {}) {
  const cars = options.cars ?? 2;
  const wire = new LoopbackWire({
    latency: options.latency ?? 0,
    loss: options.loss ?? 0,
    // Seeded, so a run that fails fails again.
    random: (() => {
      let s = 12345;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    })(),
  });

  const host = new RaceHost({ name: 'Host' });
  host.accept(wire.a);

  let guestWorld: SimWorld | null = null;
  const guest = new RaceGuest(wire.b, { name: 'Guest' });
  wire.flush();

  const hostWorld = await createWorld({ baseSurface: 'tarmac', cars });
  // The guest builds its world the way the game does: its own car at index 0,
  // in the grid slot the host has it in.
  guestWorld = await createWorld({ baseSurface: 'tarmac', cars, slots: guest.slots });
  host.start(SETUP, hostWorld);
  wire.flush();
  guest.attach(guestWorld);

  const progressOf = (car: number) => hostWorld.cars[car]!.vehicle.body.translation().z;

  /** Drive both ends for `steps` fixed steps. */
  const run = (steps: number, hostInput: DriverInput, guestInput: DriverInput) => {
    for (let i = 0; i < steps; i++) {
      host.step(hostInput, DT);
      host.maybeSnapshot(DT, progressOf);
      guest.step(guestInput, DT);
      wire.advance(DT * 1000);
    }
  };

  return { wire, host, guest, hostWorld, guestWorld, run };
}

/** How far apart the host's car `hostCar` is from the guest's `guestCar`. */
function disagreement(a: SimWorld, b: SimWorld, hostCar: number, guestCar = hostCar): number {
  const p = a.cars[hostCar]!.vehicle.body.translation();
  const q = b.cars[guestCar]!.vehicle.body.translation();
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

describe('the lobby', () => {
  it('seats a guest and gives it a car of its own', async () => {
    const wire = new LoopbackWire();
    const host = new RaceHost({ name: 'Host' });
    host.accept(wire.a);
    const guest = new RaceGuest(wire.b, { name: 'Guest' });
    wire.flush();

    expect(host.playerCount).toBe(2);
    expect(guest.you).toBe(1);
    expect(guest.car).toBe(1);
    expect(guest.players.map((p) => p.name)).toEqual(['Host', 'Guest']);
  });

  it('waits for everyone to be ready', async () => {
    const wire = new LoopbackWire();
    const host = new RaceHost();
    host.accept(wire.a);
    const guest = new RaceGuest(wire.b);
    wire.flush();

    expect(host.everyoneReady).toBe(false);
    guest.ready(true);
    wire.flush();
    expect(host.everyoneReady).toBe(true);
    guest.ready(false);
    wire.flush();
    expect(host.everyoneReady).toBe(false);
  });

  it('refuses a guest speaking a different protocol', async () => {
    const wire = new LoopbackWire();
    const host = new RaceHost();
    host.accept(wire.a);

    const seen: NetMessage[] = [];
    wire.b.onMessage((m) => seen.push(m));
    wire.b.send({ t: 'hello', version: PROTOCOL_VERSION + 1, name: 'Stranger' });
    wire.flush();

    expect(host.playerCount).toBe(1);
    expect(seen.map((m) => m.t)).toContain('bye');
  });

  it('refuses a fifth car', async () => {
    const host = new RaceHost();
    const guests = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const wire = new LoopbackWire();
      host.accept(wire.a);
      guests.push(new RaceGuest(wire.b, { name: `G${i}` }));
      wire.flush();
    }
    expect(host.playerCount).toBe(MAX_PLAYERS);
    expect(host.full).toBe(true);
    // The fourth guest is the one too many: host plus three.
    expect(guests[MAX_PLAYERS - 1]!.you).toBeNull();
  });

  it('frees the seat again when a guest leaves', async () => {
    const wire = new LoopbackWire();
    const host = new RaceHost();
    host.accept(wire.a);
    const guest = new RaceGuest(wire.b);
    wire.flush();
    expect(host.playerCount).toBe(2);

    guest.leave();
    wire.flush();
    expect(host.playerCount).toBe(1);
  });
});

describe('the grid, as two copies of it', () => {
  it('spawns the guest on its own slot rather than on pole', async () => {
    // The guest keeps its own car at index 0 locally, which would put it on
    // pole in its own world if the permutation stopped at the wire.
    const { hostWorld, guestWorld, guest } = await pair();
    const mine = guestWorld.cars[0]!.vehicle.body.translation();
    const truth = hostWorld.cars[guest.car]!.vehicle.body.translation();
    expect(Math.hypot(mine.x - truth.x, mine.z - truth.z)).toBeLessThan(1e-6);

    // And the host's car is where the host has it, one slot over.
    const theirs = guestWorld.cars[1]!.vehicle.body.translation();
    const host0 = hostWorld.cars[0]!.vehicle.body.translation();
    expect(Math.hypot(theirs.x - host0.x, theirs.z - host0.z)).toBeLessThan(1e-6);
  });
});

describe('inputs going up', () => {
  it('drives the guest car on the host', async () => {
    const { host, hostWorld, run } = await pair();
    const before = hostWorld.cars[1]!.vehicle.body.translation().z;
    run(240, NEUTRAL_INPUT, { ...NEUTRAL_INPUT, throttle: 1 });
    expect(hostWorld.cars[1]!.vehicle.body.translation().z).toBeGreaterThan(before + 5);
    expect(host.playerCount).toBe(2);
  });

  it('lets go of the throttle when a guest goes silent', async () => {
    // A stuck packet must not become a car driving itself off the stage.
    const { hostWorld, host, wire, run } = await pair();
    run(240, NEUTRAL_INPUT, { ...NEUTRAL_INPUT, throttle: 1 });

    // Pull the plug on the guest's sending without closing the link, which is
    // what a wifi drop looks like from the host's side.
    wire.b.send = () => {};
    let peak = 0;
    for (let i = 0; i < 120 * 30; i++) {
      host.step(NEUTRAL_INPUT, DT);
      wire.advance(DT * 1000);
      peak = Math.max(peak, Math.abs(hostWorld.cars[1]!.vehicle.body.linvel().z));
    }
    // Coasting on drag alone, not still accelerating on a stuck throttle.
    const speed = Math.abs(hostWorld.cars[1]!.vehicle.body.linvel().z);
    expect(speed).toBeLessThan(peak * 0.5);
  });

  it('ignores an input that arrives out of order', async () => {
    const wire = new LoopbackWire();
    const host = new RaceHost();
    host.accept(wire.a);
    new RaceGuest(wire.b);
    wire.flush();

    const world = await createWorld({ baseSurface: 'tarmac', cars: 2 });
    host.start(SETUP, world);
    wire.flush();

    wire.b.send({ t: 'input', seq: 10, input: { ...NEUTRAL_INPUT, throttle: 1 } });
    wire.flush();
    wire.b.send({ t: 'input', seq: 4, input: { ...NEUTRAL_INPUT, brake: 1 } });
    wire.flush();

    // The stale packet did not replace the newer one.
    host.step(NEUTRAL_INPUT, DT);
    for (let i = 0; i < 200; i++) host.step(NEUTRAL_INPUT, DT);
    expect(world.cars[1]!.vehicle.body.linvel().z).toBeGreaterThan(1);
  });
});

describe('snapshots coming down', () => {
  it('arrive at about the advertised rate', async () => {
    const { guest, run } = await pair();
    run(120, NEUTRAL_INPUT, NEUTRAL_INPUT);
    // One second of racing, twenty snapshots, give or take the first interval.
    expect(guest.stats.snapshots).toBeGreaterThanOrEqual(18);
    expect(guest.stats.snapshots).toBeLessThanOrEqual(22);
  });

  it('carry everyone condition and progress', async () => {
    const { guest, run } = await pair();
    run(240, { ...NEUTRAL_INPUT, throttle: 1 }, NEUTRAL_INPUT);
    // Local numbering: 0 is us, 1 is the host, who has been driving.
    expect(guest.progressOf(1)).toBeGreaterThan(guest.progressOf(0));
    expect(guest.healthOf(1)).toBe(1);
  });
});

/**
 * Driving in a circle rather than in a straight line, for a dull reason: the
 * headless tarmac pad is 400 m across and twenty seconds of full throttle
 * drives off the edge of it. A car falling through the void diverges the way
 * any two integrations of free fall diverge, and it measures nothing about the
 * netcode. A circle keeps both copies on the ground and puts a continuous
 * rotation through the reconciliation as a bonus.
 */
const CIRCLE: DriverInput = { throttle: 0.7, brake: 0, steer: 0.35, handbrake: 0 };

describe('results', () => {
  it('carries a guest finish to the host and to the other guests', async () => {
    // Only the machine running a car's race rules knows it crossed the line;
    // only the host can tell everybody. So it goes up and comes back down.
    const results: Array<[number, number | null, boolean]> = [];
    const host = new RaceHost({ onResult: (p, t, r) => results.push([p, t, r]) });

    const wireA = new LoopbackWire();
    host.accept(wireA.a);
    const first = new RaceGuest(wireA.b, { name: 'First' });
    wireA.flush();

    const heard: Array<[number, number | null, boolean]> = [];
    const wireB = new LoopbackWire();
    host.accept(wireB.a);
    new RaceGuest(wireB.b, { name: 'Second', onResult: (p, t, r) => heard.push([p, t, r]) });
    wireB.flush();

    first.report(87.42, false);
    wireA.flush();
    wireB.flush();

    expect(results).toEqual([[1, 87.42, false]]);
    expect(heard).toEqual([[1, 87.42, false]]);
  });
});

describe('the session', () => {
  it('drives the world from either side without the game knowing which', async () => {
    const { host, guest, hostWorld, guestWorld, wire } = await pair();
    const hostSide = new MultiplayerSession(
      { host },
      { world: hostWorld, setup: { ...SETUP, players: host.players }, progressOf: () => 0 },
    );
    const guestSide = new MultiplayerSession(
      { guest },
      { world: guestWorld, setup: { ...SETUP, players: guest.players }, progressOf: () => 0 },
    );

    // A second of wall clock, in whatever steps the accumulator decides on.
    for (let i = 0; i < 60; i++) {
      hostSide.advance(1 / 60, { ...NEUTRAL_INPUT, throttle: 1 });
      guestSide.advance(1 / 60, { ...NEUTRAL_INPUT, throttle: 1 });
      wire.advance(1000 / 60);
    }
    expect(hostWorld.steps).toBe(120);
    expect(guestWorld.steps).toBe(120);

    // Both are driving their own car, which each of them calls index 0.
    expect(hostWorld.cars[0]!.vehicle.body.linvel().z).toBeGreaterThan(1);
    expect(guestWorld.cars[0]!.vehicle.body.linvel().z).toBeGreaterThan(1);

    // The guest's names are in its own numbering, so a tag over a car is the
    // right name and not the one sitting in that slot on the host.
    expect(hostSide.names[0]).toBe('Host');
    expect(guestSide.names[0]).toBe('Guest');
    expect(guestSide.names[1]).toBe('Host');
    expect(guestSide.toHost(0)).toBe(1);
  });
});

describe('prediction', () => {
  it('keeps the guest car where the host says it is, at 80 ms', async () => {
    const { hostWorld, guestWorld, guest, run } = await pair({ latency: 40 });
    run(120 * 20, CIRCLE, CIRCLE);

    const off = disagreement(hostWorld, guestWorld, guest.car, 0);
    // Twenty seconds of full throttle, and the two copies of the car are still
    // within a car length of each other.
    expect(off).toBeLessThan(4);
    // And it got there by blending, not by teleporting every packet.
    expect(guest.stats.blends).toBeGreaterThan(guest.stats.snaps * 10);
  });

  it('survives one packet in five going missing', async () => {
    const { hostWorld, guestWorld, guest, run } = await pair({ latency: 40, loss: 0.2 });
    run(120 * 20, NEUTRAL_INPUT, CIRCLE);
    expect(disagreement(hostWorld, guestWorld, guest.car, 0)).toBeLessThan(6);
  });

  it('follows the other car closely enough to race it', async () => {
    // Remote cars are played back behind real time on purpose, so this is
    // allowed to lag — but only by about what the delay plus the latency buys.
    const { hostWorld, guestWorld, run } = await pair({ latency: 40 });
    run(120 * 20, CIRCLE, NEUTRAL_INPUT);

    // Measured as time rather than distance, because distance is just speed
    // times the delay and would fail on a faster car for no good reason.
    const v = hostWorld.cars[0]!.vehicle.body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    // The host's car 0 is the guest's car 1, because the guest keeps its own
    // car first — so this also checks the permutation is applied at the wire.
    const behind = disagreement(hostWorld, guestWorld, 0, 1) / Math.max(speed, 1);
    expect(behind).toBeLessThan(0.25);
  });
});
