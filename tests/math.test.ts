import { describe, expect, it } from 'vitest';
import { rotate, sampleCurve, slerp, v3, normalize, moveToward } from '../src/sim/math.js';

const HALF_TURN_Y = { x: 0, y: 1, z: 0, w: 0 };
const QUARTER_TURN_Y = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };

describe('rotate', () => {
  it('leaves vectors untouched under the identity quaternion', () => {
    const r = rotate({ x: 0, y: 0, z: 0, w: 1 }, v3(1, 2, 3));
    expect(r.x).toBeCloseTo(1);
    expect(r.y).toBeCloseTo(2);
    expect(r.z).toBeCloseTo(3);
  });

  it('turns forward into backward under a half turn about Y', () => {
    const r = rotate(HALF_TURN_Y, v3(0, 0, 1));
    expect(r.z).toBeCloseTo(-1);
  });

  it('turns forward into +X under a quarter turn about Y', () => {
    const r = rotate(QUARTER_TURN_Y, v3(0, 0, 1));
    expect(r.x).toBeCloseTo(1);
    expect(r.z).toBeCloseTo(0);
  });
});

describe('slerp', () => {
  it('returns the endpoints exactly', () => {
    const a = { x: 0, y: 0, z: 0, w: 1 };
    expect(slerp(a, QUARTER_TURN_Y, 0).w).toBeCloseTo(1);
    expect(slerp(a, QUARTER_TURN_Y, 1).y).toBeCloseTo(QUARTER_TURN_Y.y);
  });

  it('stays unit length through the interpolation', () => {
    const a = { x: 0, y: 0, z: 0, w: 1 };
    for (const t of [0.1, 0.35, 0.5, 0.9]) {
      const q = slerp(a, HALF_TURN_Y, t);
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 6);
    }
  });

  it('takes the short way round when the quaternions are opposed in sign', () => {
    const a = { x: 0, y: 0, z: 0, w: 1 };
    const b = { x: 0, y: -Math.SQRT1_2, z: 0, w: -Math.SQRT1_2 };
    // Naive lerp would sweep 270°; the short arc is 90° the other way.
    const mid = slerp(a, b, 0.5);
    expect(mid.w).toBeGreaterThan(0.9);
  });
});

describe('sampleCurve', () => {
  const curve = [
    [0, 0],
    [10, 100],
    [20, 50],
  ] as const;

  it('clamps outside the domain', () => {
    expect(sampleCurve(curve, -5)).toBe(0);
    expect(sampleCurve(curve, 999)).toBe(50);
  });

  it('interpolates linearly between points', () => {
    expect(sampleCurve(curve, 5)).toBeCloseTo(50);
    expect(sampleCurve(curve, 15)).toBeCloseTo(75);
  });
});

describe('helpers', () => {
  it('normalizes to unit length and survives a zero vector', () => {
    expect(Math.hypot(...Object.values(normalize(v3(3, 0, 4))))).toBeCloseTo(1);
    expect(normalize(v3(0, 0, 0))).toEqual(v3(0, 0, 0));
  });

  it('moves toward a target without overshooting', () => {
    expect(moveToward(0, 1, 0.25)).toBeCloseTo(0.25);
    expect(moveToward(0.9, 1, 0.25)).toBe(1);
    expect(moveToward(-0.9, -1, 0.25)).toBe(-1);
  });
});
