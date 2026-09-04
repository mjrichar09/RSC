/**
 * Brake temperature, fade and the tyre model's braking side.
 *
 * The numbers here are in real units on purpose. A brake model in arbitrary
 * units cannot be argued with, and the whole point of this one is that it can:
 * a hard stop puts a measurable number of kilojoules into a disc of a stated
 * mass, and what comes out is a temperature a real brake would reach.
 */

import { describe, expect, it } from 'vitest';
import { DamageModel } from '../src/sim/damage.js';
import { createWorld } from '../src/sim/world.js';
import { tireForces } from '../src/sim/tires.js';
import { CAR } from '../src/data/tuning.js';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

/** Accelerate for `seconds`, then brake at `pedal` until slow. Returns the stop. */
async function stop(pedal: number, preheatC: number | null = null) {
  const world = await createWorld({ baseSurface: 'tarmac', damage: true });
  for (let i = 0; i < 60; i++) world.step(NEUTRAL);
  let t = 0;
  while (t < 8) {
    world.step({ ...NEUTRAL, throttle: 1 });
    t += world.dt;
  }
  if (preheatC !== null) world.damage!.brakeTemp.fill(preheatC);
  const v0 = world.state().speed;
  let bt = 0;
  while (world.state().speed > 8 && bt < 20) {
    world.step({ ...NEUTRAL, brake: pedal });
    bt += world.dt;
  }
  return {
    seconds: bt,
    g: (v0 - world.state().speed) / bt / 9.81,
    temps: [...world.damage!.brakeTemp],
    world,
  };
}

describe('brake heat', () => {
  it('puts a hard stop worth of energy into the discs', async () => {
    const run = await stop(0.5);
    // A stop from ~140 km/h is a few hundred kilojoules; the front discs take
    // the brake bias, so they must end up clearly hotter than the rears and in
    // the range a real disc reaches rather than a token few degrees.
    expect(run.temps[0]!).toBeGreaterThan(100);
    expect(run.temps[0]!).toBeLessThan(600);
    expect(run.temps[0]!).toBeGreaterThan(run.temps[2]!);
  });

  it('cools on the straight that follows, without wiping the slate', () => {
    // Both halves matter and they pull against each other. Discs that shed
    // everything in one straight can never accumulate over a stage, which is
    // the whole point of modelling them — but the old rate was so slow that the
    // first braking zone decided how the rest of the lap went, and heat sat
    // there for most of a stage with nothing the driver could do about it.
    //
    // Twenty seconds at 40 m/s is a long straight. It should take a real bite
    // out of a hot disc and still leave it hot.
    const damage = new DamageModel({ ambient: 0.8 });
    damage.brakeTemp.fill(400);
    for (let i = 0; i < 120 * 20; i++) damage.updateBrakes(1 / 120, [], 40);
    expect(damage.brakeTemp[0]!).toBeLessThan(240);
    expect(damage.brakeTemp[0]!).toBeGreaterThan(120);
    // And it is nowhere near cold: the next braking zone starts from here.
    expect(damage.brakeTemp[0]!).toBeGreaterThan(damage.ambientC + 60);
  });

  it('never runs away past what a disc can physically reach', () => {
    // Unbounded, a reverse manoeuvre was reading 1484 C — a number about
    // nothing. Iron gives up long before this and the model has nothing to say
    // past it.
    const damage = new DamageModel({ ambient: 0.8 });
    for (let i = 0; i < 120 * 60; i++) {
      damage.updateBrakes(1 / 120, [0, 1, 2, 3].map(() => ({ torque: 2400, spin: 120 })), 40);
    }
    for (const t of damage.brakeTemp) expect(t).toBeLessThanOrEqual(900);
  });

  it('makes no heat in a locked wheel, because the caliper does no work', () => {
    const damage = new DamageModel();
    damage.setAmbient(0.5);
    const before = damage.brakeTemp[0]!;
    for (let i = 0; i < 600; i++) {
      damage.updateBrakes(1 / 120, [{ torque: 2400, spin: 0 }], 30);
    }
    expect(damage.brakeTemp[0]).toBeCloseTo(before, 5);
  });

  it('cools better in cold air', () => {
    const run = (ambient: number) => {
      const damage = new DamageModel({ ambient });
      damage.brakeTemp.fill(600);
      for (let i = 0; i < 600; i++) damage.updateBrakes(1 / 120, [], 30);
      return damage.brakeTemp[0]!;
    };
    expect(run(0)).toBeLessThan(run(1));
  });
});

describe('brake fade', () => {
  it('shows up as reduced deceleration, not just as a colour', async () => {
    const cold = await stop(0.5);
    const cooked = await stop(0.5, 700);
    expect(cooked.g).toBeLessThan(cold.g * 0.75);
  });

  it('starts sooner on a damaged brake', () => {
    const healthy = new DamageModel();
    const worn = new DamageModel();
    worn.health.set('brakeFL', 0.3);
    healthy.brakeTemp.fill(400);
    worn.brakeTemp.fill(400);
    expect(worn.brakeFade(0)).toBeLessThan(healthy.brakeFade(0));
    // And a healthy brake at a temperature it will actually see is unaffected.
    expect(healthy.brakeFade(0)).toBe(1);
  });

  it('never fades away completely — the pedal always does something', () => {
    const damage = new DamageModel();
    damage.brakeTemp.fill(2000);
    expect(damage.brakeFade(0)).toBeGreaterThan(0.3);
  });
});

describe('the braking side of the tyre curve', () => {
  it('gives up more when locked than when sliding sideways', () => {
    const base = {
      load: 3000,
      mu: 1.35,
      slipAngle: 0,
      peakSlipAngle: CAR.peakSlipAngle,
      peakSlipRatio: CAR.peakSlipRatio,
      slideFloor: CAR.slideGripFloor,
      lockedFloor: CAR.lockedGripFloor,
      driveScale: 1,
    };
    const locked = Math.abs(tireForces({ ...base, slipRatio: -1 }).longitudinal);
    const spinning = Math.abs(tireForces({ ...base, slipRatio: 1 }).longitudinal);
    expect(locked).toBeLessThan(spinning);
  });

  it('makes threshold braking worth doing', async () => {
    // The measurement that produced the locked floor in the first place: with
    // one shared floor, stamping the pedal stopped the car as fast as
    // modulating it, so there was no skill in braking at all.
    const modulated = await stop(0.5);
    const stamped = await stop(1);
    expect(modulated.g).toBeGreaterThan(stamped.g * 1.1);
  });
});
