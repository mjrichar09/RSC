/**
 * Stage construction.
 *
 * Turns a stage definition into the corridor the car actually drives: a ribbon
 * of geometry following the centreline spline, plus the analytic surface lookup
 * and progress tracking the rest of the game hangs off.
 *
 * The cross-section is a rally corridor rather than a floating road — flat
 * driveable width in the middle, a verge that drops slightly and slows you
 * down, then an embankment that rises on both sides. The bank is what keeps a
 * mistake on the stage instead of dropping the car into the void, and it is
 * generated rather than authored so every stage gets it for free.
 */

import { type Vec3, add, scale, v3 } from './math.js';
import { type ControlPoint, Spline, type SplineSample } from './spline.js';
import type { SurfaceId } from './surfaces.js';

export interface CameraZone {
  /** Arc length along the stage where this zone starts, metres. */
  from: number;
  /** Camera yaw in radians. Omit to keep the previous zone's value. */
  yaw?: number;
  pitch?: number;
  /** Orthographic half-height in metres. Smaller is closer in. */
  zoom?: number;
}

export interface MedalTimes {
  author: number;
  gold: number;
  silver: number;
  bronze: number;
}

export interface StageDef {
  id: string;
  name: string;
  biome: string;
  controlPoints: ControlPoint[];
  /** Surface of the verge either side of the road. */
  verge: SurfaceId;
  /** Surface of the embankment beyond the verge. */
  bank: SurfaceId;
  medals: MedalTimes;
  /** Cost to enter. Zero means the stage is always free to attempt. */
  entryFee: number;
  cameraZones?: CameraZone[];
  /** Number of intermediate checkpoints. They are spaced evenly along the stage. */
  checkpoints?: number;
}

/** Corridor cross-section, in metres either side of the driveable width. */
const VERGE_WIDTH = 3.2;
const VERGE_DROP = 0.18;
const BANK_WIDTH = 5.0;
const BANK_HEIGHT = 2.4;

/**
 * Flat apron extended straight out past each end of the centreline, metres.
 *
 * Without it the ribbon stops dead on the first and last samples, and a car
 * that drifts even a few centimetres backwards off the start line falls
 * straight through the world. It also gives the start somewhere to sit and the
 * finish somewhere to slow down, both of which the game needs regardless.
 */
const APRON_LENGTH = 24;
const APRON_STEP = 3;

/**
 * Near-vertical wall closing the outside of each embankment.
 *
 * The corridor is the entire world — there is nothing beyond it — so without a
 * wall a big slide simply carries the car over the bank and into an infinite
 * fall. Rally stages are lined with rock faces, trees and snowbanks anyway, so
 * this is honest as well as necessary.
 */
const WALL_WIDTH = 1.5;
const WALL_HEIGHT = 8.5;

export interface StageGeometry {
  /** Flat [x, y, z, ...] triples. */
  vertices: Float32Array;
  /** Triangle indices into `vertices`. */
  indices: Uint32Array;
  /** Per-vertex surface, parallel to the vertex list. Drives mesh colouring. */
  vertexSurfaces: SurfaceId[];
  /**
   * Per-vertex brightness, parallel to the vertex list.
   *
   * Road, verge, bank and wall are often the same surface — a snow stage is
   * snow all the way across — so without a shade difference the edge of the
   * driveable road is invisible. Shading the bands separately makes the road
   * read at a glance on every biome.
   */
  vertexShade: Float32Array;
}

export interface Checkpoint {
  /** Arc length along the stage, metres. */
  distance: number;
  position: Vec3;
  /** Half-width of the gate, for rendering markers. */
  width: number;
  right: Vec3;
}

export class Stage {
  readonly def: StageDef;
  readonly spline: Spline;
  readonly geometry: StageGeometry;
  readonly checkpoints: Checkpoint[];
  readonly start: { position: Vec3; heading: number };
  readonly length: number;

  constructor(def: StageDef) {
    this.def = def;
    this.spline = new Spline(def.controlPoints);
    this.length = this.spline.length;
    this.geometry = this.buildGeometry();
    this.checkpoints = this.buildCheckpoints(def.checkpoints ?? 3);

    // Sit the car a few metres up the road from the start line, well inside the
    // geometry, and let the apron cover anything behind it.
    const line = this.spline.at(5);
    this.start = {
      position: add(line.position, v3(0, 1.2, 0)),
      heading: Math.atan2(line.forward.x, line.forward.z),
    };
  }

  /**
   * Lateral offsets and heights of the corridor cross-section, from the left
   * bank across to the right bank.
   */
  private profile(width: number): { offset: number; height: number }[] {
    const edge = width;
    const verge = width + VERGE_WIDTH;
    const bank = verge + BANK_WIDTH;
    const wall = bank + WALL_WIDTH;
    return [
      { offset: -wall, height: WALL_HEIGHT },
      { offset: -bank, height: BANK_HEIGHT },
      { offset: -verge, height: -VERGE_DROP },
      { offset: -edge, height: 0 },
      { offset: 0, height: 0 },
      { offset: edge, height: 0 },
      { offset: verge, height: -VERGE_DROP },
      { offset: bank, height: BANK_HEIGHT },
      { offset: wall, height: WALL_HEIGHT },
    ];
  }

  /**
   * Centreline samples plus a straight apron extrapolated off each end. Used
   * for geometry only — arc length and progress still run start line to finish
   * line, so the aprons cost the player nothing.
   */
  private extendedSamples(): SplineSample[] {
    const inner = this.spline.samples;
    const first = inner[0]!;
    const last = inner[inner.length - 1]!;
    const count = Math.round(APRON_LENGTH / APRON_STEP);

    const lead: SplineSample[] = [];
    for (let i = count; i >= 1; i--) {
      lead.push({ ...first, position: add(first.position, scale(first.forward, -i * APRON_STEP)) });
    }
    const tail: SplineSample[] = [];
    for (let i = 1; i <= count; i++) {
      tail.push({ ...last, position: add(last.position, scale(last.forward, i * APRON_STEP)) });
    }
    return [...lead, ...inner, ...tail];
  }

  private buildGeometry(): StageGeometry {
    const samples = this.extendedSamples();
    const columns = 9;
    const vertices = new Float32Array(samples.length * columns * 3);
    const vertexSurfaces: SurfaceId[] = [];
    const vertexShade = new Float32Array(samples.length * columns);
    const indices = new Uint32Array((samples.length - 1) * (columns - 1) * 6);

    let v = 0;
    for (const s of samples) {
      for (const p of this.profile(s.width)) {
        const point = add(add(s.position, scale(s.right, p.offset)), scale(s.up, p.height));
        vertices[v * 3] = point.x;
        vertices[v * 3 + 1] = point.y;
        vertices[v * 3 + 2] = point.z;
        vertexSurfaces.push(this.surfaceForOffset(Math.abs(p.offset), s.width, s.surface));
        vertexShade[v] = this.shadeForOffset(Math.abs(p.offset), s.width);
        v++;
      }
    }

    let t = 0;
    for (let i = 0; i < samples.length - 1; i++) {
      for (let c = 0; c < columns - 1; c++) {
        const a = i * columns + c;
        const b = a + 1;
        const d = (i + 1) * columns + c;
        const e = d + 1;
        indices[t++] = a;
        indices[t++] = d;
        indices[t++] = b;
        indices[t++] = b;
        indices[t++] = d;
        indices[t++] = e;
      }
    }

    return { vertices, indices, vertexSurfaces, vertexShade };
  }

  /** Brightness multiplier for a lateral offset, darkening away from the road. */
  private shadeForOffset(absOffset: number, width: number): number {
    if (absOffset <= width + 0.01) return 1;
    if (absOffset <= width + VERGE_WIDTH + 0.01) return 0.84;
    if (absOffset <= width + VERGE_WIDTH + BANK_WIDTH + 0.01) return 0.66;
    return 0.5;
  }

  private surfaceForOffset(absOffset: number, width: number, road: SurfaceId): SurfaceId {
    if (absOffset <= width + 0.01) return road;
    if (absOffset <= width + VERGE_WIDTH + 0.01) return this.def.verge;
    return this.def.bank;
  }

  private buildCheckpoints(count: number): Checkpoint[] {
    const out: Checkpoint[] = [];
    for (let i = 1; i <= count; i++) {
      const distance = (this.length * i) / (count + 1);
      const s = this.spline.at(distance);
      out.push({ distance, position: s.position, width: s.width, right: s.right });
    }
    return out;
  }

  /** Total half-width of the corridor at a sample, including verge and bank. */
  private halfCorridor(width: number): number {
    return width + VERGE_WIDTH + BANK_WIDTH + WALL_WIDTH;
  }

  /**
   * Places where the stage runs into itself.
   *
   * A corridor is ~27 m wide, so a centreline that doubles back within that
   * distance produces two overlapping ribbons — and the car ends up buried in
   * the embankment of a section it has not reached yet. This is invisible in
   * the control points and obvious in the geometry, so it gets checked rather
   * than eyeballed. The same check is what makes generated stages safe in P7.
   *
   * Sections separated vertically by more than `clearance` are treated as a
   * legitimate over/under rather than a collision.
   */
  selfIntersections(clearance = 5): { a: number; b: number; gap: number }[] {
    const samples = this.spline.samples;
    const hits: { a: number; b: number; gap: number }[] = [];
    // Ignore neighbours: consecutive samples are meant to be close.
    const minSeparation = 45;

    for (let i = 0; i < samples.length; i++) {
      const a = samples[i]!;
      const reach = this.halfCorridor(a.width);
      for (let j = i + 1; j < samples.length; j++) {
        const b = samples[j]!;
        if (b.distance - a.distance < minSeparation) continue;
        if (Math.abs(a.position.y - b.position.y) > clearance) continue;

        const dx = a.position.x - b.position.x;
        const dz = a.position.z - b.position.z;
        const flat = Math.hypot(dx, dz);
        const needed = reach + this.halfCorridor(b.width);
        if (flat < needed) {
          hits.push({ a: a.distance, b: b.distance, gap: needed - flat });
        }
      }
    }

    // Collapse runs of adjacent samples into one report per crossing.
    const merged: { a: number; b: number; gap: number }[] = [];
    for (const hit of hits) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(hit.a - last.a) < 30 && Math.abs(hit.b - last.b) < 30) {
        if (hit.gap > last.gap) merged[merged.length - 1] = hit;
      } else {
        merged.push(hit);
      }
    }
    return merged;
  }

  /**
   * Surface under a world point, resolved analytically from its distance to the
   * centreline rather than from the geometry. Cheap enough to run per wheel per
   * step, and it stays correct however the mesh is later retessellated.
   */
  surfaceAt(point: Vec3, hint?: number): { surface: SurfaceId; index: number } {
    const loc = this.spline.locate(point, hint);
    return {
      surface: this.surfaceForOffset(Math.abs(loc.lateral), loc.sample.width, loc.sample.surface),
      index: loc.index,
    };
  }

  /** How far along the stage a world point is, and whether it is on the road. */
  progressAt(point: Vec3, hint?: number): {
    distance: number;
    lateral: number;
    onRoad: boolean;
    index: number;
  } {
    const loc = this.spline.locate(point, hint);
    return {
      distance: loc.distance,
      lateral: loc.lateral,
      onRoad: Math.abs(loc.lateral) <= loc.sample.width,
      index: loc.index,
    };
  }
}
