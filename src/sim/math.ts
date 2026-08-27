/**
 * Minimal vector/quaternion helpers.
 *
 * `sim/` deliberately does not import three.js (see the architecture rule in the
 * plan), so it carries its own tiny math layer. Everything here is plain objects
 * that are structurally compatible with Rapier's Vector3/Rotation types.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const length = (a: Vec3): number => Math.sqrt(dot(a, a));

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-9 ? scale(a, 1 / l) : v3();
}

/** Rotate `v` by unit quaternion `q` (v' = q * v * q⁻¹, expanded). */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return v3(
    v.x + w * tx + (y * tz - z * ty),
    v.y + w * ty + (z * tx - x * tz),
    v.z + w * tz + (x * ty - y * tx),
  );
}

/** Rotate `v` by the inverse of unit quaternion `q` (world -> local). */
export const rotateInverse = (q: Quat, v: Vec3): Vec3 =>
  rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);

export const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  return Math.abs(d) <= maxDelta ? target : current + Math.sign(d) * maxDelta;
}

/**
 * Sample a piecewise-linear curve defined by ascending [x, y] pairs.
 * Values outside the domain clamp to the end points.
 */
export function sampleCurve(curve: readonly (readonly [number, number])[], x: number): number {
  if (curve.length === 0) return 0;
  const first = curve[0]!;
  if (x <= first[0]) return first[1];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!;
    const b = curve[i]!;
    if (x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0] || 1);
      return lerp(a[1], b[1], t);
    }
  }
  return curve[curve.length - 1]![1];
}

/** Shortest-arc spherical interpolation between two unit quaternions. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    // Nearly parallel — lerp and renormalise to avoid a division blow-up.
    const x = a.x + (bx - a.x) * t;
    const y = a.y + (by - a.y) * t;
    const z = a.z + (bz - a.z) * t;
    const w = a.w + (bw - a.w) * t;
    const l = Math.hypot(x, y, z, w) || 1;
    return { x: x / l, y: y / l, z: z / l, w: w / l };
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const ka = Math.sin((1 - t) * theta) / sin;
  const kb = Math.sin(t * theta) / sin;
  return { x: a.x * ka + bx * kb, y: a.y * ka + by * kb, z: a.z * ka + bz * kb, w: a.w * ka + bw * kb };
}

export const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 =>
  v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
