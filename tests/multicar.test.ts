/**
 * More than one car in a world.
 *
 * This is the foundation multiplayer stands on, and almost all of it is the
 * absence of new code: a car is a vehicle with its own damage and its own
 * attachment state, contact between two of them is the same event as contact
 * with a rock, and one car is the same structure with one entry.
 *
 * The property worth protecting hardest is that last one — single-player must
 * not become a special case of a racing mode nobody has played yet.
 */

import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/data/stages/index.js';
import { Stage } from '../src/sim/stage.js';
import { createWorld } from '../src/sim/world.js';
import { PART_BY_ID } from '../src/sim/debris.js';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

describe('the grid', () => {
  it('defaults to one car', async () => {
    const world = await createWorld({ baseSurface: 'tarmac' });
    expect(world.cars).toHaveLength(1);
    expect(world.carCount).toBe(1);
    // And the old single-car handles still point at it.
    expect(world.vehicle).toBe(world.cars[0]!.vehicle);
  });

  it('lines four cars up without stacking them', async () => {
    const world = await createWorld({ stage: new Stage(STAGES[0]!), cars: 4 });
    expect(world.cars).toHaveLength(4);

    const places = world.cars.map((car) => car.vehicle.body.translation());
    for (let i = 0; i < places.length; i++) {
      for (let j = i + 1; j < places.length; j++) {
        const a = places[i]!;
        const b = places[j]!;
        const gap = Math.hypot(a.x - b.x, a.z - b.z);
        // Wider than the car, so nobody starts inside anybody.
        expect(gap, `cars ${i} and ${j}`).toBeGreaterThan(2.5);
      }
    }
  });

  it('starts them all on the road', async () => {
    const stage = new Stage(STAGES[0]!);
    const world = await createWorld({ stage, cars: 4 });
    for (const [i, car] of world.cars.entries()) {
      const here = stage.progressAt(car.vehicle.body.translation());
      expect(Math.abs(here.lateral), `car ${i}`).toBeLessThan(stage.spline.at(0).width + 2);
    }
  });
});

describe('damage belongs to a car', () => {
  it('gives every car its own', async () => {
    const world = await createWorld({ baseSurface: 'tarmac', damage: true, cars: 3 });
    for (const car of world.cars) expect(car.damage).not.toBeNull();

    const first = world.cars[0]!.damage!;
    const second = world.cars[1]!.damage!;
    expect(first).not.toBe(second);

    first.applyImpact({ x: 0, y: 0, z: 1.9 }, 30_000);
    expect(first.condition).toBeLessThan(1);
    expect(second.condition).toBe(1);
  });

  it('draws each car from its own random stream', async () => {
    // Four cars sharing a stream would shed their bumpers in lockstep.
    const world = await createWorld({ baseSurface: 'tarmac', damage: true, cars: 2 });
    const a = world.cars[0]!.damage!;
    const b = world.cars[1]!.damage!;
    const rollsA = Array.from({ length: 6 }, () => a.nextRandom());
    const rollsB = Array.from({ length: 6 }, () => b.nextRandom());
    expect(rollsA).not.toEqual(rollsB);
  });
});

describe('contact between cars', () => {
  it('damages both, each where it was hit', async () => {
    const world = await createWorld({ baseSurface: 'tarmac', damage: true, cars: 2 });
    const [rammer, victim] = world.cars;

    // A T-bone: one car driven into the flank of another.
    victim!.vehicle.reset({ x: 0, y: 1.2, z: 40 }, Math.PI / 2);
    rammer!.vehicle.reset({ x: 0, y: 1.2, z: 0 }, 0);
    rammer!.vehicle.body.setLinvel({ x: 0, y: 0, z: 17 }, true);

    let contact = 0;
    for (let i = 0; i < 400 && contact === 0; i++) {
      world.step([{ ...NEUTRAL, throttle: 1 }, NEUTRAL]);
      contact = world.lastImpact;
    }
    expect(contact).toBeGreaterThan(1000);
    for (let i = 0; i < 120; i++) world.step([NEUTRAL, NEUTRAL]);

    // The one doing the ramming takes it through the nose.
    expect(rammer!.damage!.get('panelFront')).toBeLessThan(1);
    // The one being rammed takes it through the side it was hit on.
    const flanks = Math.min(victim!.damage!.get('panelLeft'), victim!.damage!.get('panelRight'));
    expect(flanks).toBeLessThan(1);
    // Being rammed is not the same as ramming: the noses differ.
    expect(victim!.damage!.get('panelFront')).toBeGreaterThan(rammer!.damage!.get('panelFront'));
  });

  it('only shakes the camera for the local car', async () => {
    // `lastImpact` drives the local camera and the local sound, so a shunt
    // between two other cars must not shake the player's screen.
    const world = await createWorld({ baseSurface: 'tarmac', damage: true, cars: 3 });
    world.cars[0]!.vehicle.reset({ x: 200, y: 1.2, z: 200 }, 0);
    world.cars[1]!.vehicle.reset({ x: 0, y: 1.2, z: 0 }, 0);
    world.cars[2]!.vehicle.reset({ x: 0, y: 1.2, z: 12 }, Math.PI / 2);
    world.cars[1]!.vehicle.body.setLinvel({ x: 0, y: 0, z: 18 }, true);

    let sawContact = false;
    for (let i = 0; i < 300; i++) {
      world.step([NEUTRAL, { ...NEUTRAL, throttle: 1 }, NEUTRAL]);
      if (world.cars[1]!.damage!.condition < 1) sawContact = true;
      expect(world.lastImpact).toBe(0);
    }
    expect(sawContact).toBe(true);
  });
});

describe('debris with several cars', () => {
  it('tracks whose part it was, against one shared budget', async () => {
    const world = await createWorld({ baseSurface: 'tarmac', damage: true, cars: 2 });
    for (let i = 0; i < 60; i++) world.step([NEUTRAL, NEUTRAL]);

    world.cars[0]!.debris!.detach(PART_BY_ID.get('bumperFront')!);
    world.cars[1]!.debris!.detach(PART_BY_ID.get('doorLeft')!);
    world.step([NEUTRAL, NEUTRAL]);

    expect(world.loose).toHaveLength(2);
    expect(world.cars[0]!.loose.map((l) => l.id)).toEqual(['bumperFront']);
    expect(world.cars[1]!.loose.map((l) => l.id)).toEqual(['doorLeft']);

    world.clearDebris();
    expect(world.loose).toHaveLength(0);
    expect(world.cars[0]!.loose).toHaveLength(0);
    expect(world.cars[1]!.loose).toHaveLength(0);
  });
});

describe('one car is not a special case', () => {
  it('drives a single-car world exactly as it always did', async () => {
    // The refactor that made room for four cars must not have moved the car
    // that has been driven for the whole of the rest of this project.
    const drive = async () => {
      const world = await createWorld({ baseSurface: 'tarmac' });
      for (let i = 0; i < 240; i++) {
        world.step({ throttle: 1, brake: 0, steer: 0.3, handbrake: 0 });
      }
      const p = world.vehicle.body.translation();
      return [p.x, p.y, p.z];
    };
    expect(await drive()).toEqual(await drive());
  });

  it('steps a car with no input of its own rather than dropping it', async () => {
    // A disconnected player's car coasts until the host removes it.
    const world = await createWorld({ baseSurface: 'tarmac', cars: 2 });
    world.cars[1]!.vehicle.body.setLinvel({ x: 0, y: 0, z: 20 }, true);
    const before = world.cars[1]!.vehicle.body.translation().z;
    for (let i = 0; i < 60; i++) world.step([{ ...NEUTRAL, throttle: 1 }]);
    expect(world.cars[1]!.vehicle.body.translation().z).toBeGreaterThan(before + 5);
  });
});
