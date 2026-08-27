import { describe, expect, it } from 'vitest';
import { slipAngle, slipCurve, slipRatio, tireForces } from '../src/sim/tires.js';

const FLOOR = 0.75;

describe('slipCurve', () => {
  it('is zero at zero slip and peaks at the characteristic slip', () => {
    expect(slipCurve(0, FLOOR)).toBeCloseTo(0);
    expect(slipCurve(1, FLOOR)).toBeCloseTo(1);
  });

  it('rises monotonically up to the peak', () => {
    let prev = -1;
    for (let s = 0; s <= 1.0001; s += 0.05) {
      const f = slipCurve(s, FLOOR);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it('decays past the peak but never below the slide floor', () => {
    expect(slipCurve(2, FLOOR)).toBeLessThan(1);
    expect(slipCurve(4, FLOOR)).toBeLessThan(slipCurve(2, FLOOR));
    for (const s of [1.5, 3, 8, 40]) {
      expect(slipCurve(s, FLOOR)).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it('is odd — the same magnitude in both directions', () => {
    for (const s of [0.3, 1, 2.5]) {
      expect(slipCurve(-s, FLOOR)).toBeCloseTo(-slipCurve(s, FLOOR));
    }
  });

  it('keeps more force in a slide when the floor is higher', () => {
    expect(slipCurve(3, 0.9)).toBeGreaterThan(slipCurve(3, 0.5));
  });
});

describe('slip measures', () => {
  it('reports zero slip angle when travelling straight', () => {
    expect(slipAngle(20, 0)).toBeCloseTo(0);
  });

  it('grows the slip angle with lateral velocity', () => {
    expect(slipAngle(20, 5)).toBeGreaterThan(slipAngle(20, 1));
  });

  it('is positive under power and negative under braking', () => {
    expect(slipRatio(25, 20)).toBeGreaterThan(0);
    expect(slipRatio(15, 20)).toBeLessThan(0);
  });

  it('does not divide by zero at a standstill', () => {
    expect(Number.isFinite(slipRatio(0, 0))).toBe(true);
    expect(Number.isFinite(slipAngle(0, 0))).toBe(true);
  });
});

describe('tireForces', () => {
  const base = {
    load: 3000,
    mu: 1.3,
    slipAngle: 0,
    slipRatio: 0,
    peakSlipAngle: 0.16,
    peakSlipRatio: 0.14,
    slideFloor: FLOOR,
    driveScale: 1,
  };

  it('produces no force with no load', () => {
    const f = tireForces({ ...base, load: 0, slipAngle: 0.3 });
    expect(f.lateral).toBeCloseTo(0);
    expect(f.longitudinal).toBeCloseTo(0);
  });

  it('opposes lateral slip', () => {
    expect(tireForces({ ...base, slipAngle: 0.1 }).lateral).toBeLessThan(0);
    expect(tireForces({ ...base, slipAngle: -0.1 }).lateral).toBeGreaterThan(0);
  });

  it('never exceeds the friction circle', () => {
    const f = tireForces({ ...base, slipAngle: 0.5, slipRatio: 0.5 });
    expect(Math.hypot(f.lateral, f.longitudinal)).toBeLessThanOrEqual(base.load * base.mu + 1e-6);
  });

  it('reports saturation above 1 when both axes are demanded at once', () => {
    expect(tireForces({ ...base, slipAngle: 0.16, slipRatio: 0.14 }).saturation).toBeGreaterThan(1);
  });

  it('trades lateral grip away under hard braking — the basis of trail-braking', () => {
    const pure = tireForces({ ...base, slipAngle: 0.16 });
    const combined = tireForces({ ...base, slipAngle: 0.16, slipRatio: -0.14 });
    expect(Math.abs(combined.lateral)).toBeLessThan(Math.abs(pure.lateral));
  });

  it('scales with load, so weight transfer changes grip', () => {
    const light = tireForces({ ...base, load: 1500, slipAngle: 0.1 });
    const heavy = tireForces({ ...base, load: 4500, slipAngle: 0.1 });
    expect(Math.abs(heavy.lateral)).toBeGreaterThan(Math.abs(light.lateral));
  });
});
