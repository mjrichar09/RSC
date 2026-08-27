/**
 * Centreline spline for a rally stage.
 *
 * A Catmull-Rom curve through the stage's control points, resampled at a fixed
 * arc-length interval so that everything downstream — road geometry, surface
 * lookup, checkpoints, camera zones, the AI driver — can index by distance
 * along the stage rather than by curve parameter.
 *
 * The nearest-sample query is the hot path: it runs four times per physics step
 * (once per wheel) to resolve the surface, so it goes through a uniform grid
 * rather than scanning every sample.
 */

import {
  type Vec3,
  add,
  clamp,
  cross,
  dot,
  length,
  lerp,
  normalize,
  scale,
  sub,
  v3,
} from './math.js';
import type { SurfaceId } from './surfaces.js';

export interface ControlPoint {
  pos: Vec3;
  /** Half-width of the driveable road at this point, metres. */
  width: number;
  surface: SurfaceId;
  /** Banking in radians; positive rolls the road toward the inside of a left turn. */
  banking?: number;
}

export interface SplineSample {
  /** Arc length from the start of the stage, metres. */
  distance: number;
  position: Vec3;
  /** Unit tangent, pointing along the direction of travel. */
  forward: Vec3;
  /** Unit right vector in the road plane. */
  right: Vec3;
  /** Unit up vector, tilted by banking. */
  up: Vec3;
  width: number;
  surface: SurfaceId;
  /** Signed curvature, 1/m. Positive turns right. Drives AI speed and camera zoom. */
  curvature: number;
}

/** Catmull-Rom position at parameter `t` within the segment p1 -> p2. */
function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return v3(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}

const WORLD_UP = v3(0, 1, 0);

export class Spline {
  readonly samples: SplineSample[] = [];
  readonly length: number;

  /** Uniform grid of sample indices, keyed by cell, for nearest-point queries. */
  private readonly grid = new Map<string, number[]>();
  private readonly cellSize = 16;

  constructor(points: readonly ControlPoint[], step = 2) {
    if (points.length < 2) throw new Error('a stage spline needs at least two control points');

    // Duplicate the endpoints so the curve passes through the first and last
    // control points rather than starting a segment short of them.
    const pts = [points[0]!, ...points, points[points.length - 1]!];

    // Sample densely in curve space first, then resample by arc length so the
    // spacing is even regardless of how far apart the control points are.
    const dense: { pos: Vec3; width: number; surface: SurfaceId; banking: number }[] = [];
    const perSegment = 24;
    for (let i = 1; i < pts.length - 2; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const c = pts[i + 1]!;
      const d = pts[i + 2]!;
      for (let j = 0; j < perSegment; j++) {
        const t = j / perSegment;
        dense.push({
          pos: catmullRom(a.pos, b.pos, c.pos, d.pos, t),
          width: lerp(b.width, c.width, t),
          // Surface changes at the control point rather than blending, so a
          // tarmac-to-gravel transition is a crisp line you can see and feel.
          surface: t < 0.5 ? b.surface : c.surface,
          banking: lerp(b.banking ?? 0, c.banking ?? 0, t),
        });
      }
    }
    dense.push({
      pos: points[points.length - 1]!.pos,
      width: points[points.length - 1]!.width,
      surface: points[points.length - 1]!.surface,
      banking: points[points.length - 1]!.banking ?? 0,
    });

    // Resample at even arc length.
    let carried = 0;
    let distance = 0;
    const picked: typeof dense = [dense[0]!];
    for (let i = 1; i < dense.length; i++) {
      const segment = length(sub(dense[i]!.pos, dense[i - 1]!.pos));
      carried += segment;
      while (carried >= step) {
        carried -= step;
        const t = segment > 1e-6 ? 1 - carried / segment : 1;
        picked.push({
          pos: add(dense[i - 1]!.pos, scale(sub(dense[i]!.pos, dense[i - 1]!.pos), t)),
          width: lerp(dense[i - 1]!.width, dense[i]!.width, t),
          surface: t < 0.5 ? dense[i - 1]!.surface : dense[i]!.surface,
          banking: lerp(dense[i - 1]!.banking, dense[i]!.banking, t),
        });
      }
    }

    for (let i = 0; i < picked.length; i++) {
      const p = picked[i]!;
      const prev = picked[Math.max(i - 1, 0)]!;
      const next = picked[Math.min(i + 1, picked.length - 1)]!;

      const forward = normalize(sub(next.pos, prev.pos));
      const flatForward = normalize(v3(forward.x, 0, forward.z));
      let right = normalize(cross(WORLD_UP, flatForward));
      let up = normalize(cross(forward, right));

      if (p.banking !== 0) {
        // Roll the road frame about its own forward axis.
        const c = Math.cos(p.banking);
        const s = Math.sin(p.banking);
        const rolledRight = add(scale(right, c), scale(up, s));
        up = normalize(sub(scale(up, c), scale(right, s)));
        right = normalize(rolledRight);
      }

      if (i > 0) distance += length(sub(p.pos, prev.pos));

      // Signed curvature from the turn between the incoming and outgoing
      // tangents, positive to the right.
      const inDir = normalize(v3(p.pos.x - prev.pos.x, 0, p.pos.z - prev.pos.z));
      const outDir = normalize(v3(next.pos.x - p.pos.x, 0, next.pos.z - p.pos.z));
      const turn = Math.asin(clamp(dot(cross(inDir, outDir), WORLD_UP), -1, 1));
      const span = length(sub(next.pos, prev.pos));
      const curvature = span > 1e-6 ? -turn / (span / 2) : 0;

      this.samples.push({
        distance,
        position: p.pos,
        forward,
        right,
        up,
        width: p.width,
        surface: p.surface,
        curvature,
      });
    }

    this.length = distance;
    this.buildGrid();
  }

  private key(x: number, z: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`;
  }

  private buildGrid(): void {
    for (let i = 0; i < this.samples.length; i++) {
      const p = this.samples[i]!.position;
      // Register in a 3x3 cell neighbourhood so a query never has to look at
      // adjacent cells to find a candidate.
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = this.key(p.x + dx * this.cellSize, p.z + dz * this.cellSize);
          let bucket = this.grid.get(k);
          if (!bucket) this.grid.set(k, (bucket = []));
          if (bucket[bucket.length - 1] !== i) bucket.push(i);
        }
      }
    }
  }

  /** Index of the sample nearest to `point` on the XZ plane. */
  nearestIndex(point: Vec3, hint?: number): number {
    // A hint from the previous query (the car has not teleported) turns this
    // into a short local scan.
    if (hint !== undefined) {
      const span = 24;
      let best = hint;
      let bestD = Infinity;
      const lo = Math.max(0, hint - span);
      const hi = Math.min(this.samples.length - 1, hint + span);
      for (let i = lo; i <= hi; i++) {
        const d = this.flatDistanceSq(i, point);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      // Only trust the local answer if it is genuinely close; otherwise fall
      // through to the grid so a reset or a big jump still resolves correctly.
      if (bestD < 400) return best;
    }

    const bucket = this.grid.get(this.key(point.x, point.z));
    let best = 0;
    let bestD = Infinity;
    if (bucket) {
      for (const i of bucket) {
        const d = this.flatDistanceSq(i, point);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }

    for (let i = 0; i < this.samples.length; i++) {
      const d = this.flatDistanceSq(i, point);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private flatDistanceSq(i: number, point: Vec3): number {
    const p = this.samples[i]!.position;
    const dx = p.x - point.x;
    const dz = p.z - point.z;
    return dx * dx + dz * dz;
  }

  /** Sample at a given arc length, clamped to the ends of the stage. */
  at(distance: number): SplineSample {
    const step = this.length / Math.max(this.samples.length - 1, 1);
    const i = clamp(Math.round(distance / step), 0, this.samples.length - 1);
    return this.samples[i]!;
  }

  /**
   * Where a world point sits relative to the road: how far along, how far to
   * the side, and how far above the road surface.
   */
  locate(point: Vec3, hint?: number): {
    index: number;
    sample: SplineSample;
    distance: number;
    /** Signed lateral offset, metres. Positive is to the right of the centreline. */
    lateral: number;
    height: number;
  } {
    const index = this.nearestIndex(point, hint);
    const sample = this.samples[index]!;
    const delta = sub(point, sample.position);
    return {
      index,
      sample,
      distance: sample.distance,
      lateral: dot(delta, sample.right),
      height: dot(delta, sample.up),
    };
  }
}
