/**
 * What a broken car does, as opposed to what a repair bill says it costs.
 *
 * Every one of these was reported as "I could not feel it": damage that was in
 * the model, priced in the garage, and invisible from the driver's seat. A
 * component that changes nothing you can feel is a tax, not a consequence.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type SimWorld } from '../src/sim/world.js';
import type { ComponentId } from '../src/sim/damage.js';
import { COMPONENT_BY_ID } from '../src/sim/damage.js';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

/**
 * Drive up to speed, then hold the wheel straight and see where the car goes.
 *
 * Lateral deviation with the wheel centred is the whole question: a car that
 * pulls is one you have to hold, and a car that does not is one where the
 * damage is a number in a menu.
 */
async function driveStraight(broken: Partial<Record<ComponentId, number>>) {
  const world = await createWorld({ baseSurface: 'tarmac', damage: true });
  for (const [id, health] of Object.entries(broken)) {
    world.damage!.health.set(id as ComponentId, health);
  }
  world.damage!.refreshFailures();

  for (let i = 0; i < 240; i++) world.step({ ...NEUTRAL, throttle: 1 });
  const from = world.state().position;
  for (let i = 0; i < 240; i++) world.step({ ...NEUTRAL, throttle: 0.5 });
  const to = world.state().position;

  return {
    lateral: to.x - from.x,
    forward: to.z - from.z,
    speed: Math.abs(world.state().speed),
  };
}

describe('steering damage', () => {
  it('pulls hard enough to have to hold', async () => {
    const clean = await driveStraight({});
    const bent = await driveStraight({ steering: 0.5 });
    expect(Math.abs(clean.lateral)).toBeLessThan(0.5);
    // Metres of deviation in two seconds, hands-off, at 70 km/h.
    expect(Math.abs(bent.lateral)).toBeGreaterThan(5);
  });

  it('pulls toward the corner that was hit', async () => {
    // The side is derived from which front wing is worse, so the car pulls the
    // way the damage on it looks. A coin flip would be indistinguishable from
    // a bug the first time it disagreed with the bodywork.
    const left = await driveStraight({ steering: 0.4, wingFL: 0.2, wingFR: 1 });
    const right = await driveStraight({ steering: 0.4, wingFL: 1, wingFR: 0.2 });
    expect(Math.sign(left.lateral)).toBe(-Math.sign(right.lateral));
  });

  it('is reachable by an impact that folds the nose', async () => {
    // Measured with `npm run crash`: the rack used to survive a 95 km/h
    // nose-on hit at 87% health, which is a pull of about a degree and a half.
    const world = await createWorld({ baseSurface: 'tarmac', damage: true });
    world.damage!.applyImpact({ x: 0, y: -0.2, z: 1.9 }, 18_000);
    expect(world.damage!.get('steering')).toBeLessThan(0.85);
  });
});

describe('a flat tyre', () => {
  it('drags the car down and pulls it toward the flat', async () => {
    const clean = await driveStraight({});
    const flatLeft = await driveStraight({ tyreFL: 0 });
    const flatRight = await driveStraight({ tyreFR: 0 });

    // It costs real speed, not just grip in the corners.
    expect(flatLeft.speed).toBeLessThan(clean.speed - 3);
    // And it pulls, each toward its own side.
    expect(flatLeft.lateral).toBeLessThan(-2);
    expect(flatRight.lateral).toBeGreaterThan(2);
  });

  it('sits the corner down on its rim', async () => {
    const world = await createWorld({ baseSurface: 'tarmac', damage: true });
    for (let i = 0; i < 120; i++) world.step(NEUTRAL);
    const level = world.state().position.y;

    world.damage!.health.set('tyreFL', 0);
    world.damage!.refreshFailures();
    for (let i = 0; i < 120; i++) world.step(NEUTRAL);
    expect(world.state().position.y).toBeLessThan(level);
  });

  it('leaves a rear flat as a drag rather than a pull', async () => {
    // Rear flats do not fight the steering; they make the back end lazy. The
    // difference is worth protecting, or every puncture feels the same.
    const rear = await driveStraight({ tyreRL: 0 });
    expect(Math.abs(rear.lateral)).toBeLessThan(2);
    expect(rear.speed).toBeLessThan((await driveStraight({})).speed - 3);
  });
});

describe('a terminal failure', () => {
  /** Boil a holed radiator by driving hard until the engine gives up. */
  const boil = async (): Promise<SimWorld> => {
    const world = await createWorld({ baseSurface: 'tarmac', damage: true });
    world.damage!.health.set('cooling', 0);
    world.damage!.refreshFailures();
    for (let i = 0; i < 120 * 60 && !world.damage!.retired; i++) {
      world.step({ ...NEUTRAL, throttle: 1, steer: 0.32 });
    }
    return world;
  };

  it('steams for several seconds before it happens', async () => {
    const world = await createWorld({ baseSurface: 'tarmac', damage: true });
    world.damage!.health.set('cooling', 0);
    world.damage!.refreshFailures();

    let firstSteam = -1;
    let stalled = -1;
    for (let i = 0; i < 120 * 60 && stalled < 0; i++) {
      world.step({ ...NEUTRAL, throttle: 1, steer: 0.32 });
      if (firstSteam < 0 && world.damage!.boiling > 0) firstSteam = world.time;
      if (world.damage!.retired) stalled = world.time;
    }
    expect(firstSteam).toBeGreaterThan(0);
    // A warning that arrives with the failure is not a warning.
    expect(stalled - firstSteam).toBeGreaterThan(5);
  });

  it('stops the engine but leaves the car rolling', async () => {
    const world = await boil();
    expect(world.damage!.effects().stalled).toBe(true);

    const speed = Math.abs(world.state().speed);
    expect(speed).toBeGreaterThan(10);

    // Full throttle now does nothing at all, and the car coasts.
    for (let i = 0; i < 120; i++) world.step({ ...NEUTRAL, throttle: 1 });
    expect(world.state().rpm).toBe(0);
    expect(Math.abs(world.state().speed)).toBeLessThan(speed);
    // Still moving, though — this is the part that lets a dead car cross a
    // finish line under its own momentum.
    expect(Math.abs(world.state().speed)).toBeGreaterThan(5);
  });

  it('still brakes and still steers', async () => {
    const world = await boil();
    // Yaw, not the quaternion's y component. Those are only proportional near
    // zero, and the car turns most of a right angle here: read off the raw
    // component this looked like 0.007 of *something* and failed a 0.02 bar,
    // while the car was in fact rotating seventy degrees.
    const yaw = () => {
      const q = world.vehicle.body.rotation();
      return Math.atan2(2 * (q.w * q.y), 1 - 2 * q.y * q.y);
    };
    const before = yaw();
    // Three seconds of brake from about 95 km/h, with the wheel on full lock.
    for (let i = 0; i < 360; i++) world.step({ ...NEUTRAL, brake: 1, steer: 1 });
    expect(Math.abs(world.state().speed)).toBeLessThan(3);
    expect(Math.abs(yaw() - before)).toBeGreaterThan(0.2);
  });
});

describe('the components behind all this', () => {
  it('prices a steering rack as a repair you would think about', () => {
    const rack = COMPONENT_BY_ID.get('steering')!;
    expect(rack.repairCost).toBeGreaterThan(500);
    // Reachable by a hit that folds the nose, rather than theoretical.
    expect(rack.threshold).toBeLessThan(10_000);
  });
});
