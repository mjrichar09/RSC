/**
 * Edges of the driving model, found by an adversarial audit and each measured
 * before it was fixed. Every test here failed on the code it guards against.
 *
 * - Braking through a spin or a slide selected reverse at speed, and in reverse
 *   the brake pedal drives: the car never stopped.
 * - The brake in the air flipped the wheels' spin every step and the chatter
 *   heated the discs as if they were stopping the car.
 * - The in-air pitch control was right only upright and nose-first; upside
 *   down it ran away end over end.
 * - On the line, only the rear handbrake held the car and the driven front
 *   axle crept it forward before the green.
 * - The "perfect" launch was nearly a second wide and could be had by being
 *   early, and a throttle held at 89% never bogged.
 */

import { describe, expect, it } from 'vitest';
import { StartLights } from '../src/game/startLights.js';
import { rotate } from '../src/sim/math.js';
import { type SimWorld, createWorld } from '../src/sim/world.js';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
const speedOf = (w: SimWorld) => Math.hypot(w.state().velocity.x, w.state().velocity.z);

async function settled(options: Parameters<typeof createWorld>[0] = {}): Promise<SimWorld> {
  const world = await createWorld(options);
  for (let i = 0; i < 120; i++) world.step(NEUTRAL);
  return world;
}

/** Set the car moving at `speed`, at `angle` from its nose (π/2 is sideways). */
function launch(world: SimWorld, speed: number, angle: number): void {
  const along = rotate(world.vehicle.body.rotation(), { x: Math.sin(angle), y: 0, z: Math.cos(angle) });
  world.vehicle.body.setLinvel({ x: along.x * speed, y: 0, z: along.z * speed }, true);
}

describe('reverse', () => {
  for (const [label, angle] of [
    ['sideways', Math.PI / 2],
    ['backwards', Math.PI],
  ] as const) {
    it(`is not selected while the car is still moving ${label}`, async () => {
      const world = await settled();
      launch(world, 18, angle);
      let speedAtReverse: number | null = null;
      for (let i = 0; i < 120 * 6 && speedAtReverse === null; i++) {
        world.step({ ...NEUTRAL, brake: 1 });
        if ((world.vehicle as unknown as { gearIndex: number }).gearIndex === 0) speedAtReverse = speedOf(world);
      }
      // Holding the brake from a standstill is how you reverse, so it does
      // come — but only once the car has actually stopped.
      expect(speedAtReverse).not.toBeNull();
      expect(speedAtReverse!).toBeLessThan(0.6);
    });
  }

  it('brakes rather than runs away when rolling back faster than it drives', async () => {
    const world = await settled();
    // Facing up a 30% slope: gravity tilted back along the car.
    const slope = Math.atan(0.3);
    world.world.gravity = { x: 0, y: -9.81 * Math.cos(slope), z: -9.81 * Math.sin(slope) };
    let peak = 0;
    for (let i = 0; i < 120 * 5; i++) {
      world.step({ ...NEUTRAL, brake: 1 });
      peak = Math.max(peak, speedOf(world));
    }
    // Measured 15 m/s and still gaining before; reverse's own speed now.
    expect(peak).toBeLessThan(8);
  });
});

describe('drift', () => {
  it('reads nothing for a straight reverse, and a spin for a car that has spun', async () => {
    // Reversing: hold the brake from a standstill until reverse engages and
    // the car is backing up in a straight line.
    const reversing = await settled();
    for (let i = 0; i < 120 * 3; i++) reversing.step({ ...NEUTRAL, brake: 1 });
    expect(speedOf(reversing)).toBeGreaterThan(2);
    // Was 180° — "180° DRIFT" on the HUD for backing out of a ditch.
    expect(reversing.state().driftAngle).toBeLessThan(0.1);

    // Going backwards in a forward gear is a spin, and still says so.
    const spun = await settled();
    launch(spun, 10, Math.PI);
    spun.step(NEUTRAL);
    expect(spun.state().driftAngle).toBeGreaterThan(3);
  });
});

describe('in the air', () => {
  it('a braked wheel stops and the discs stay cold', async () => {
    const world = await settled({ damage: true });
    world.vehicle.body.setTranslation({ x: 0, y: 30, z: 0 }, true);
    world.world.gravity = { x: 0, y: 0, z: 0 };
    launch(world, 20, 0);
    const before = [...world.damage!.brakeTemp];
    for (let i = 0; i < 120 * 6; i++) world.step({ ...NEUTRAL, brake: 1, handbrake: 1 });
    for (const wheel of world.state().wheels) expect(Math.abs(wheel.spin)).toBeLessThan(0.5);
    // Was 27 → 128 °C at the front from the chatter alone.
    world.damage!.brakeTemp.forEach((t, i) => expect(t - before[i]!).toBeLessThan(5));
  });

  it('upside down, the pitch control settles rather than tumbling the car', async () => {
    const world = await settled();
    world.vehicle.body.setTranslation({ x: 0, y: 40, z: 0 }, true);
    world.vehicle.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
    world.vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    world.world.gravity = { x: 0, y: 0, z: 0 };
    world.vehicle.body.setLinvel({ x: 0, y: -8, z: 23 }, true);
    for (let i = 0; i < 120 * 3; i++) world.step(NEUTRAL);
    const spin = world.vehicle.body.angvel();
    expect(Math.hypot(spin.x, spin.y, spin.z)).toBeLessThan(0.2);
    // Still upside down — it was not flipped end over end.
    expect(rotate(world.vehicle.body.rotation(), { x: 0, y: 1, z: 0 }).y).toBeLessThan(-0.8);
  });
});

describe('on the line', () => {
  it('does not creep while held, at full throttle', async () => {
    const world = await settled();
    const start = { ...world.state().position };
    for (let i = 0; i < 432; i++) world.step({ ...NEUTRAL, throttle: 1, handbrake: 1, hold: true });
    const end = world.state().position;
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeLessThan(0.02);
  });
});

describe('the launch grade', () => {
  /** Count down with the throttle at `level` from `before` seconds ahead of the green. */
  function grade(level: number, before: number): string | null {
    const lights = new StartLights();
    lights.arm();
    const green = 3.6;
    for (let t = 0; t < green + 1.5; t += 1 / 120) {
      lights.update(1 / 120, t >= green - before ? level : 0);
    }
    return lights.launch;
  }

  it('is not perfect for being early', () => {
    expect(grade(1, 0.5)).toBe('clean');
    expect(grade(1, 0.85)).toBe('clean');
  });

  it('is still perfect for a reaction just ahead of the light', () => {
    expect(grade(1, 0.03)).toBe('perfect');
  });

  it('bogs a throttle held short of the stop through the countdown', () => {
    expect(grade(0.89, 3.6)).toBe('bogged');
  });
});
