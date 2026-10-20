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
 * Each machine is the authority on its own car, so the numbers that matter are
 * how far *behind* each side's picture of the other car runs — in seconds, not
 * metres, because metres are only speed times the delay — and that a guest's
 * own car is never moved by anything but its own physics. If those hold, the
 * game is playable; if they do not, no amount of lobby correctness helps.
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
import { codec } from '../src/net/webrtc.js';

const DT = 1 / 120;

/** Full throttle and a fixed lock: a car going round and round, for the host. */
const CIRCLE: DriverInput = { throttle: 0.7, brake: 0, steer: 0.35, handbrake: 0 };

const SETUP = {
  stageId: 'test',
  variantId: 'day-clear',
  conditions: { timeOfDay: 'day', weather: 'clear' } as const,
  seed: 7,
};

/** A host and one guest, wired together, both with a world of `cars` cars. */
async function pair(
  options: {
    latency?: number;
    uplink?: number;
    loss?: number;
    burst?: number;
    jitter?: number;
    capacity?: number;
    cars?: number;
  } = {},
) {
  const cars = options.cars ?? 2;
  const wire = new LoopbackWire({
    latency: options.latency ?? 0,
    uplink: options.uplink ?? 0,
    loss: options.loss ?? 0,
    burst: options.burst ?? 1,
    jitter: options.jitter ?? 0,
    capacity: options.capacity ?? 0,
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

  // Both build their worlds the way the game does: their own car at index 0
  // and everybody else's kinematic, because it is driven from the wire rather
  // than by the physics. The guest's own car sits in the grid slot the host
  // has it in.
  const hostWorld = await createWorld({
    baseSurface: 'tarmac',
    cars,
    remote: Array.from({ length: cars - 1 }, (_, i) => i + 1),
  });
  guestWorld = await createWorld({
    baseSurface: 'tarmac',
    cars,
    slots: guest.slots,
    remote: Array.from({ length: cars - 1 }, (_, i) => i + 1),
  });
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

  /**
   * The same, with the guest driving a slalom.
   *
   * Its own helper because the clock has to carry across calls: a test that
   * samples something every step calls this one step at a time, and a slalom
   * restarted from zero on each call is a constant input wearing a disguise.
   */
  let slalomClock = 0;
  const runSlalom = (steps: number, hostInput: DriverInput = CIRCLE) => {
    for (let i = 0; i < steps; i++) {
      slalomClock += DT;
      host.step(hostInput, DT);
      host.maybeSnapshot(DT, progressOf);
      guest.step(
        { throttle: 0.7, brake: 0, steer: Math.sin(slalomClock * 1.6) * 0.6, handbrake: 0 },
        DT,
      );
      wire.advance(DT * 1000);
    }
  };

  return { wire, host, guest, hostWorld, guestWorld, run, runSlalom };
}

/** How far apart the host's car `hostCar` is from the guest's `guestCar`. */
function disagreement(a: SimWorld, b: SimWorld, hostCar: number, guestCar = hostCar): number {
  const p = a.cars[hostCar]!.vehicle.body.translation();
  const q = b.cars[guestCar]!.vehicle.body.translation();
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

/**
 * How far behind a played-back copy runs, in seconds: the distance to the car
 * it copies over that car's speed. `truth` is the world that simulates the car.
 */
function lag(truth: SimWorld, truthCar: number, copy: SimWorld, copyCar: number): number {
  const v = truth.cars[truthCar]!.vehicle.body.linvel();
  const speed = Math.hypot(v.x, v.y, v.z);
  // A copy of a parked car is on top of it whatever the netcode does, which is
  // how a first draft of these tests measured a car the other one had rolled
  // into the verge and reported zero lag. Nothing here drives slower than this.
  if (speed < 3) throw new Error(`the car being followed is barely moving (${speed.toFixed(2)} m/s)`);
  return disagreement(truth, copy, truthCar, copyCar) / Math.max(speed, 1);
}

/** A state report for the guest's car, as `RaceGuest` would send one. */
const report = (time: number, z: number) => ({
  time,
  p: [0, 0.5, z] as [number, number, number],
  q: [0, 0, 0, 1] as [number, number, number, number],
  v: [0, 0, 0] as [number, number, number],
  w: [0, 0, 0] as [number, number, number],
  health: 1,
});

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
    wire.b.send({ t: 'hello', version: PROTOCOL_VERSION + 1, name: 'Stranger', livery: 'works', number: 3 });
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

describe('the lobby between races', () => {
  it('carries everyone\'s paint and number to everyone', async () => {
    const wire = new LoopbackWire();
    const host = new RaceHost({ name: 'Host', livery: 'martini', number: 7 });
    host.accept(wire.a);
    const guest = new RaceGuest(wire.b, { name: 'Guest', livery: 'ember', number: 42 });
    wire.flush();

    // A multiplayer car is a fresh one, so paint is the only thing that makes
    // it yours — and it has to reach the other screens or nobody can tell four
    // cars apart in a cloud of gravel.
    expect(guest.players.map((p) => [p.livery, p.number])).toEqual([
      ['martini', 7],
      ['ember', 42],
    ]);

    guest.repaint('forest-green', 9);
    wire.flush();
    expect(host.players[1]!.livery).toBe('forest-green');
    expect(host.players[1]!.number).toBe(9);
  });

  it('tells a guest what the host has picked to race', async () => {
    const wire = new LoopbackWire();
    const host = new RaceHost();
    host.accept(wire.a);
    let seen: { stageId: string; variantId: string } | null = null;
    new RaceGuest(wire.b, { onLobby: (_, pick) => (seen = pick) });
    wire.flush();

    // The host picks *after* everyone has joined, because the point of a lobby
    // is racing your friends rather than racing a stage. A guest that cannot
    // see the choice is agreeing to something nobody told it.
    host.setStage('quarry-run', 'night');
    wire.flush();
    expect(seen).toEqual({ stageId: 'quarry-run', variantId: 'night' });
  });

  it('keeps a tally of wins that belongs to the room', async () => {
    const wire = new LoopbackWire();
    const host = new RaceHost();
    host.accept(wire.a);
    const guest = new RaceGuest(wire.b);
    wire.flush();

    host.creditWin(1);
    wire.flush();
    expect(guest.players.find((p) => p.id === 1)?.wins).toBe(1);
    expect(guest.players.find((p) => p.id === 0)?.wins).toBe(0);

    // And a reopened lobby keeps it: the tally is the reason to race again.
    host.reopen();
    wire.flush();
    expect(guest.players.find((p) => p.id === 1)?.wins).toBe(1);
  });

  it('refuses a repaint once the race has started', async () => {
    const { host, guest, wire } = await pair();
    guest.repaint('ember', 11);
    wire.flush();
    // `pair` has already called host.start, so this is mid-race: changing the
    // colour people are using to tell each other apart, while they are using it.
    expect(host.players[1]!.livery).not.toBe('ember');
  });
});

describe('a level grid', () => {
  it('holds the countdown until every guest has a world', async () => {
    const wire = new LoopbackWire();
    let hostGo = 0;
    const host = new RaceHost({ onGo: () => hostGo++ });
    host.accept(wire.a);
    let guestGo = 0;
    new RaceGuest(wire.b, { onGo: () => guestGo++ });
    wire.flush();

    const world = await createWorld({ baseSurface: 'tarmac', cars: 2 });
    host.start(SETUP, world);
    // The guest has been told what to build but has not said it is ready, so
    // nobody counts down yet. Building a world is asynchronous and takes a
    // different length of time on every machine — each side running its own
    // countdown from whenever it finished loading is what left the joiner on
    // the line while the host was two corners away.
    expect(hostGo).toBe(0);

    // `RaceGuest` reports in on `start`, so one flush is the whole handshake.
    wire.flush();
    expect(hostGo).toBe(1);
    expect(guestGo).toBe(1);
  });

  it('releases the grid anyway when a guest never reports in', async () => {
    const wire = new LoopbackWire();
    let hostGo = 0;
    const host = new RaceHost({ onGo: () => hostGo++ });
    host.accept(wire.a);
    new RaceGuest(wire.b);
    wire.flush();

    const world = await createWorld({ baseSurface: 'tarmac', cars: 2 });
    host.start(SETUP, world);
    // Whatever happened to them, the race cannot wait forever.
    host.releaseGrid();
    expect(hostGo).toBe(1);
    // And it only ever fires once.
    host.releaseGrid();
    expect(hostGo).toBe(1);
  });

  it('counts down immediately for a host racing alone', async () => {
    let hostGo = 0;
    const host = new RaceHost({ onGo: () => hostGo++ });
    const world = await createWorld({ baseSurface: 'tarmac' });
    host.start(SETUP, world);
    expect(hostGo).toBe(1);
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

  it('parks a guest car when the guest goes silent', async () => {
    // A stuck packet must not become a car driving itself off the stage. The
    // host no longer drives the car at all, so silence means it stays where it
    // was last seen — carried a tenth of a second on its last velocity, then
    // held.
    const { hostWorld, host, wire, run } = await pair();
    run(240, NEUTRAL_INPUT, { ...NEUTRAL_INPUT, throttle: 1 });

    // Pull the plug on the guest's sending without closing the link, which is
    // what a wifi drop looks like from the host's side.
    wire.b.send = () => {};
    for (let i = 0; i < 60; i++) {
      host.step(NEUTRAL_INPUT, DT);
      wire.advance(DT * 1000);
    }
    const parked = hostWorld.cars[1]!.vehicle.body.translation().z;
    for (let i = 0; i < 120 * 3; i++) {
      host.step(NEUTRAL_INPUT, DT);
      wire.advance(DT * 1000);
    }
    expect(Math.abs(hostWorld.cars[1]!.vehicle.body.translation().z - parked)).toBeLessThan(0.01);
  });

  it('ignores a report that arrives out of order', async () => {
    const wire = new LoopbackWire();
    const host = new RaceHost();
    host.accept(wire.a);
    new RaceGuest(wire.b);
    wire.flush();

    const world = await createWorld({ baseSurface: 'tarmac', cars: 2, remote: [1] });
    host.start(SETUP, world);
    wire.flush();

    // Two reports in order a short way down the road, then a straggler from
    // further back in time that would pull the car back to the line.
    wire.b.send({ t: 'input', seq: 10, input: NEUTRAL_INPUT, race: 1, state: report(1.0, 20) });
    wire.b.send({ t: 'input', seq: 11, input: NEUTRAL_INPUT, race: 1, state: report(1.1, 21) });
    wire.flush();
    wire.b.send({ t: 'input', seq: 4, input: NEUTRAL_INPUT, race: 1, state: report(0.4, 0) });
    wire.flush();

    for (let i = 0; i < 120; i++) host.step(NEUTRAL_INPUT, DT);
    expect(world.cars[1]!.vehicle.body.translation().z).toBeGreaterThan(19);
  });

  it('refuses a report that would put a NaN into the world', async () => {
    const wire = new LoopbackWire();
    const host = new RaceHost();
    host.accept(wire.a);
    new RaceGuest(wire.b);
    wire.flush();
    const world = await createWorld({ baseSurface: 'tarmac', cars: 2, remote: [1] });
    host.start(SETUP, world);
    wire.flush();

    const bad = { ...report(1, 5), p: [0, Number.NaN, 5] };
    wire.b.send({ t: 'input', seq: 1, input: NEUTRAL_INPUT, race: 1, state: bad as never });
    wire.b.send({ t: 'input', seq: 2, input: NEUTRAL_INPUT, race: 1, state: { nonsense: true } as never });
    wire.flush();
    for (let i = 0; i < 60; i++) host.step(NEUTRAL_INPUT, DT);
    const p = world.cars[1]!.vehicle.body.translation();
    expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
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

describe("a guest's own car", () => {
  it('is never moved by anything but its own physics', async () => {
    // The whole of the rubber-banding fix. The guest's car used to be walked
    // toward the host's copy of it, which had driven a slightly different race
    // from late inputs. Now the guest's world is the only one that simulates
    // it: the same car, driven the same way in a world with no network at all,
    // ends up exactly where the networked one does.
    const { guestWorld, guest, run } = await pair({ latency: 60, loss: 0.1, jitter: 40 });
    const twin = await createWorld({ baseSurface: 'tarmac', cars: 2, slots: guest.slots, remote: [1] });

    // The host's car is in both worlds and can be touched, so the twin's copy
    // of it is moved exactly as the guest's is: what is under test is that the
    // snapshots never reach the guest's *own* car, not that two different
    // worlds agree.
    const theirs = guestWorld.cars[1]!.vehicle.body;
    const mirror = twin.cars[1]!.vehicle.body;
    for (let i = 0; i < 120 * 10; i++) {
      run(1, NEUTRAL_INPUT, CIRCLE);
      twin.step([CIRCLE, NEUTRAL_INPUT]);
      mirror.setNextKinematicTranslation(theirs.nextTranslation());
      mirror.setNextKinematicRotation(theirs.nextRotation());
    }

    expect(guest.stats.snapshots).toBeGreaterThan(100);
    expect(disagreement(guestWorld, twin, 0, 0)).toBeLessThan(1e-6);
  });

  it('is followed closely by the host at 80 ms', async () => {
    const { hostWorld, guestWorld, runSlalom } = await pair({ latency: 40 });
    runSlalom(120 * 20, NEUTRAL_INPUT);
    // Played back `INTERP_DELAY` behind its newest report, which is one
    // one-way delay old when it lands: 0.14 s, give or take a send interval.
    expect(lag(guestWorld, 0, hostWorld, 1)).toBeLessThan(0.2);
  });

  it('survives one packet in five going missing', async () => {
    const { hostWorld, guestWorld, runSlalom } = await pair({ latency: 40, loss: 0.2 });
    runSlalom(120 * 20, NEUTRAL_INPUT);
    expect(lag(guestWorld, 0, hostWorld, 1)).toBeLessThan(0.25);
  });
});

describe("the host's car, on a guest", () => {
  it('is followed closely enough to race it', async () => {
    // Remote cars are played back behind real time on purpose, so this is
    // allowed to lag — but only by about what the delay plus the latency buys.
    // The host's car 0 is the guest's car 1, because the guest keeps its own
    // car first — so this also checks the permutation is applied at the wire.
    const { hostWorld, guestWorld, run } = await pair({ latency: 40 });
    run(120 * 20, CIRCLE, NEUTRAL_INPUT);
    expect(lag(hostWorld, 0, guestWorld, 1)).toBeLessThan(0.25);
  });
});

describe('a second race in the same lobby', () => {
  it("shows the host's car moving, and the guest's on the host", async () => {
    // Reported as "the joiner saw the host's car sitting still at the start
    // line when the host was actually driving". Every race starts its world
    // clock at zero again, and the guest kept the last race's newest snapshot
    // time — so every snapshot of the second race read as older than one
    // already held and was thrown away, until the second race's clock passed
    // the first race's length. Latency, so packets of the first race are still
    // in flight when the second starts.
    const { host, guest, wire, run } = await pair({ latency: 40 });
    run(120 * 8, CIRCLE, CIRCLE);

    host.reopen();
    const hostWorld = await createWorld({ baseSurface: 'tarmac', cars: 2, remote: [1] });
    const guestWorld = await createWorld({ baseSurface: 'tarmac', cars: 2, slots: guest.slots, remote: [1] });
    host.start(SETUP, hostWorld);
    // Not flushed: the first race's stragglers arrive after the second starts,
    // and the guest goes on stepping its old world until it has a new one.
    for (let i = 0; i < 12; i++) {
      host.step(CIRCLE, DT);
      guest.step(CIRCLE, DT);
      wire.advance(DT * 1000);
    }
    guest.attach(guestWorld);

    const progressOf = (c: number) => hostWorld.cars[c]!.vehicle.body.translation().z;
    const flat: DriverInput = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
    for (let i = 0; i < 120 * 4; i++) {
      host.step(flat, DT);
      host.maybeSnapshot(DT, progressOf);
      guest.step(flat, DT);
      wire.advance(DT * 1000);
    }

    // The host's car, on the guest: following, not parked on the grid.
    expect(guest.stats.snapshots).toBeGreaterThan(60);
    expect(lag(hostWorld, 0, guestWorld, 1)).toBeLessThan(0.25);
    // And the guest's car, on the host.
    expect(lag(guestWorld, 0, hostWorld, 1)).toBeLessThan(0.25);
  });
});

describe('invite codes', () => {
  // A real Chrome offer for a data-channel-only connection, with the mDNS host
  // candidate Chrome actually emits and a server-reflexive one behind it.
  const OFFER = [
    'v=0',
    'o=- 2515236907401582204 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 60896 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 203.0.113.7',
    'a=candidate:1 1 udp 2113937151 6f1a2b3c-0000-4000-8000-000000000000.local 60896 typ host generation 0',
    'a=candidate:2 1 udp 1677729535 203.0.113.7 51820 typ srflx raddr 0.0.0.0 rport 0 generation 0',
    'a=candidate:3 1 tcp 1518280447 203.0.113.7 9 typ host tcptype active',
    'a=ice-ufrag:b9d6',
    'a=ice-pwd:4YVFwSg4x1swi1rAMzVgeUEZ',
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':')}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');

  it('carries everything the far side needs to connect', async () => {
    const code = await codec.encode({ type: 'offer', sdp: OFFER });
    const back = await codec.decode(code);

    expect(back.type).toBe('offer');
    expect(back.sdp).toContain('a=ice-ufrag:b9d6');
    expect(back.sdp).toContain('a=ice-pwd:4YVFwSg4x1swi1rAMzVgeUEZ');
    expect(back.sdp).toContain('a=fingerprint:sha-256 00:01:02:03');
    expect(back.sdp).toContain('a=setup:actpass');
    expect(back.sdp).toContain('UDP/DTLS/SCTP webrtc-datachannel');
    expect(back.sdp).toContain('a=end-of-candidates');
  });

  it('is short enough to read out loud', async () => {
    const code = await codec.encode({ type: 'offer', sdp: OFFER });
    // The whole SDP, deflated and base64'd, came to about 560 characters.
    expect(code.length).toBeLessThan(160);
  });

  it('keeps the candidate that can actually connect and drops the ones that cannot', async () => {
    const back = await codec.decode(await codec.encode({ type: 'offer', sdp: OFFER }));
    // The public address survives.
    expect(back.sdp).toContain('203.0.113.7 51820 typ srflx');
    // Chrome's mDNS host name only resolves on its own network, and the TCP
    // candidate is not something this transport uses. Both are pure weight.
    expect(back.sdp).not.toContain('.local');
    expect(back.sdp).not.toContain('tcp');
  });

  it('keeps the answer an answer, with its DTLS role', async () => {
    const answer = OFFER.replace('a=setup:actpass', 'a=setup:active');
    const back = await codec.decode(await codec.encode({ type: 'answer', sdp: answer }));
    expect(back.type).toBe('answer');
    expect(back.sdp).toContain('a=setup:active');
  });

  it('still reads a code from the old long format', async () => {
    // Built the way the previous build built them: the whole description as
    // JSON, base64'd with a 'P' marker. Somebody will paste one of these.
    const json = JSON.stringify({ t: 'offer', s: OFFER });
    const old = `P${btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    const back = await codec.decode(old);
    expect(back.sdp).toBe(OFFER);
  });

  it('keeps everything when the code does not have to be short', async () => {
    // The compact form buys its 96 characters by dropping candidates, and the
    // expensive one is Chrome's `.local` mDNS host candidate — which it drops
    // whenever STUN worked, i.e. always. That candidate *is* the local network:
    // two players in the same room were having the one path that would have
    // connected them in a millisecond stripped out, and were reaching each
    // other through their router's public address instead.
    //
    // Over the room broker nobody copies the code, and the worker takes four
    // kilobytes, so there is nothing to buy. `decode` has always read this
    // format, so only the sender changes.
    const full = await codec.encodeFull({ type: 'offer', sdp: OFFER });
    const back = await codec.decode(full);
    expect(back.sdp).toBe(OFFER);
    expect(back.sdp).toContain('.local');
    expect(back.sdp).toContain('203.0.113.7 51820 typ srflx');
  });

  it('keeps the mDNS name when there is nothing else to go on', async () => {
    // Two players on the same wifi with STUN blocked have only these, and they
    // do resolve — on that network. Dropping them outright broke LAN play.
    const lanOnly = OFFER.split('\r\n')
      .filter((line) => !line.includes('typ srflx'))
      .join('\r\n');
    const back = await codec.decode(await codec.encode({ type: 'offer', sdp: lanOnly }));
    expect(back.sdp).toContain('.local 60896 typ host');
  });

  it('survives an IPv6 address', async () => {
    const v6 = OFFER.replace(
      'a=candidate:2 1 udp 1677729535 203.0.113.7 51820 typ srflx raddr 0.0.0.0 rport 0 generation 0',
      'a=candidate:2 1 udp 1677729535 2001:db8::1 51820 typ srflx generation 0',
    );
    const back = await codec.decode(await codec.encode({ type: 'offer', sdp: v6 }));
    expect(back.sdp).toContain('2001:db8:0:0:0:0:0:1 51820 typ srflx');
  });
});

describe('a guest on a jittery link', () => {
  it('is still followed closely by the host', async () => {
    const { hostWorld, guestWorld, runSlalom } = await pair({ latency: 60, loss: 0.05, jitter: 30 });
    runSlalom(120 * 10, NEUTRAL_INPUT);
    expect(lag(guestWorld, 0, hostWorld, 1)).toBeLessThan(0.3);
  });

  it('does not get further out the further away the host is', async () => {
    /** Mean lag of the host's copy of the guest's car, through a slalom. */
    const drive = async (latency: number, loss = 0, jitter = 0) => {
      const { hostWorld, guestWorld, runSlalom } = await pair({ latency, loss, jitter });
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 120 * 20; i++) {
        runSlalom(1, NEUTRAL_INPUT);
        if (i > 120 * 3) {
          sum += lag(guestWorld, 0, hostWorld, 1);
          n++;
        }
      }
      return sum / n;
    };
    // The copy is played back behind its newest report, so it trails by the
    // buffer plus one one-way delay — and by nothing that grows on its own.
    const near = await drive(0);
    const far = await drive(200, 0.1, 100);
    expect(near).toBeLessThan(0.15);
    expect(far).toBeLessThan(0.4);
  }, 60_000);
});

describe("somebody else's car, on a guest", () => {
  it('is kinematic rather than a dynamic body being teleported', async () => {
    // The distinction is the whole bug. A dynamic body moved with
    // `setTranslation` every step arrives inside whatever it has caught up
    // with, carrying no motion the solver can resolve the contact against, so
    // the overlap is pushed out with an impulse the size of how far in it got.
    // Locally that is being hit by nothing, shoved off the road, or wedged
    // against an obstacle that is not there — and since the host simulated no
    // such shove, the guest then diverges and is dragged back, which is the
    // stutter and the car appearing to steer itself.
    const { guestWorld, hostWorld } = await pair({ cars: 2 });

    expect(guestWorld.cars[1]!.vehicle.remote).toBe(true);
    expect(guestWorld.cars[1]!.vehicle.body.isKinematic()).toBe(true);
    // Each side's own car is a real car, because that side simulates it.
    expect(guestWorld.cars[0]!.vehicle.remote).toBe(false);
    expect(guestWorld.cars[0]!.vehicle.body.isKinematic()).toBe(false);
    expect(hostWorld.cars[0]!.vehicle.body.isKinematic()).toBe(false);
    // And the host plays the guest's car back the same way.
    expect(hostWorld.cars[1]!.vehicle.body.isKinematic()).toBe(true);
  });

  it('is still moved to where the host says it is', async () => {
    // The other half, and the more expensive mistake of the two: kinematic must
    // not mean stationary. A remote car that stopped following the wire would
    // be a worse bug than one that shoves, because it would be invisible until
    // somebody tried to race it.
    const { host, guest, hostWorld, guestWorld, wire } = await pair({ latency: 40, cars: 2 });
    const flat: DriverInput = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
    const idle: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

    const before = guestWorld.cars[1]!.vehicle.body.translation().z;
    for (let i = 0; i < 120 * 6; i++) {
      host.step(flat, DT);
      host.maybeSnapshot(DT, (c) => hostWorld.cars[c]!.vehicle.body.translation().z);
      guest.step(idle, DT);
      wire.advance(DT * 1000);
    }
    const moved = guestWorld.cars[1]!.vehicle.body.translation().z - before;
    const hostMoved = hostWorld.cars[0]!.vehicle.body.translation().z;

    expect(moved).toBeGreaterThan(20);
    // It trails, and it is supposed to: a remote car is drawn `INTERP_DELAY`
    // plus one one-way delay in the past, which is the buffer that lets it be
    // interpolated between two real samples rather than guessed at. 0.14 s at
    // the ~40 m/s this reaches is about 5.5 m, and that is what it measures.
    // The assertion is that the lag is *bounded*, not that it is absent.
    expect(Math.abs(moved - hostMoved)).toBeLessThan(9);
  }, 60_000);
});

/**
 * A phone on a mobile network, which is where this stopped being pleasant.
 *
 * Reported as "works fine on the same network, really bad for the guest over
 * mobile". Latency, jitter and loss turned out not to be the cause at all — a
 * guest at 200 ms with 4% burst loss holds together fine, and the *asymmetric*
 * profile measured better than the symmetric one at the same round trip. What
 * a symmetric, uncapped wire could not reproduce was the actual fault:
 *
 * A leg that is offered more packets than it can carry does not drop the
 * excess, it queues it. WebRTC data channels ride SCTP, which applies
 * congestion control to the association even where the channel is unordered
 * with no retransmits — so nothing is lost, everything is simply late, and
 * each packet is later than the one before it. The guest was sending sixty
 * inputs a second into a leg that is narrow in *packets* rather than in bytes.
 *
 * Measured over twenty seconds of slalom before the fix:
 *
 *     uplink 70 pkt/s    1 snap     1.44 m worst    20 ms queued
 *     uplink 55 pkt/s   56 snaps    4.41 m worst   1337 ms queued
 *     uplink 45 pkt/s  107 snaps    5.11 m worst   6031 ms queued
 *     uplink 35 pkt/s  111 snaps    5.17 m worst  13465 ms queued
 *
 * A cliff, sitting just under the rate the guest was sending at, with a guest
 * whose inputs reach the host seconds after they were pressed on the far side
 * of it. Two things fixed it and both are needed: the fast channel refuses to
 * queue, so congestion becomes loss the netcode already covers; and the input
 * rate halved, so far fewer links reach the cliff at all.
 */
const MOBILE = { latency: 70, uplink: 60, jitter: 50, loss: 0.04, burst: 8 };

describe('a guest on a mobile link', () => {
  it('holds together at 200 ms with burst loss', async () => {
    // A slalom rather than a fixed lock, and not only for the usual reason. A
    // car held at 0.35 of lock on full throttle is balanced on its tyres, where
    // two copies of the same physics diverge on their own and the snaps are
    // chaos rather than netcode — measured, that input snaps 38 times on a
    // perfect link. The wire is not what this is meant to be measuring.
    const { hostWorld, guestWorld, runSlalom } = await pair(MOBILE);
    let worst = 0;
    for (let i = 0; i < 120 * 20; i++) {
      runSlalom(1, NEUTRAL_INPUT);
      if (i > 120 * 3) worst = Math.max(worst, lag(guestWorld, 0, hostWorld, 1));
    }
    // Played back behind the buffer and the one-way delay (0.1 + 0.13 s),
    // through bursts of loss the buffer cannot always cover. Measured 0.25 s.
    expect(worst).toBeLessThan(0.4);
  });

  it('does not fall off a cliff when the uplink runs out of packets', async () => {
    /*
     * The regression this whole investigation was about. 35 packets a second
     * is well under the rate the guest offers even after halving it, so the
     * link is genuinely saturated and packets are genuinely being dropped —
     * the point is that dropping them is survivable and queueing them is not.
     */
    const { hostWorld, guestWorld, runSlalom } = await pair({ ...MOBILE, capacity: 35 });
    let worst = 0;
    for (let i = 0; i < 120 * 20; i++) {
      runSlalom(1, NEUTRAL_INPUT);
      if (i > 120 * 3) worst = Math.max(worst, lag(guestWorld, 0, hostWorld, 1));
    }
    // Queued, a report would reach the host seconds late and this would read
    // in seconds; dropped, it stays within the buffer and the delay. Measured
    // 0.30 s.
    expect(worst).toBeLessThan(0.45);
  });

  it('never lets the uplink queue grow without bound', async () => {
    // The mechanism, measured directly rather than through its consequences.
    // Before: 13.5 seconds of backlog. A queue this size is the fault itself.
    const { wire, runSlalom } = await pair({ ...MOBILE, capacity: 35 });
    let worst = 0;
    for (let i = 0; i < 120 * 20; i++) {
      runSlalom(1);
      worst = Math.max(worst, wire.backlog(true));
    }
    expect(worst).toBeLessThan(250);
  });

  it('plays the other car smoothly through jitter wider than the buffer', async () => {
    /*
     * The other half of "bad": a rival played back from an under-filled buffer
     * runs out of samples, extrapolates, and lurches when the next packet
     * lands. Nothing measured it, so this counts frames in which the rival
     * barely moved. It reads 0% at every jitter up to 250 ms — and the check
     * that it is measuring anything at all is that with `INTERP_DELAY` set to
     * zero it climbs to 9%, which is how this number was trusted.
     */
    const { guestWorld, runSlalom } = await pair({ latency: 70, jitter: 250, loss: 0.02, burst: 6 });
    const steps: number[] = [];
    let last: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < 120 * 20; i++) {
      runSlalom(1);
      const r = guestWorld.cars[1]!.vehicle.body.translation();
      // After the launch: a car accelerating from rest genuinely moves very
      // little per frame, and counting that as a stall measures the start line.
      if (last && i > 120 * 5) steps.push(Math.hypot(r.x - last.x, r.y - last.y, r.z - last.z));
      last = { x: r.x, y: r.y, z: r.z };
    }
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const stalls = steps.filter((d) => d < mean * 0.25).length / steps.length;
    expect(stalls).toBeLessThan(0.02);
  });
});
