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

import { CLEAR_DAY, type Conditions, describeConditions } from './conditions.js';
import { type Vec3, add, scale, v3 } from './math.js';
import { type ControlPoint, Spline, type SplineSample } from './spline.js';
import { type Corner, findCorners } from './corners.js';
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

export type PropKind = 'tree' | 'rock' | 'bale' | 'pole';

/** A corner warning board standing on the verge. */
export interface CornerSign {
  /** Where it stands, in metres along the stage. */
  distance: number;
  position: Vec3;
  /** Facing, radians about Y — turned to face the camera, not the road. */
  yaw: number;
  corner: Corner;
}

export interface StageProp {
  kind: PropKind;
  position: Vec3;
  /** Collider half-extents, metres. */
  radius: number;
  height: number;
  /** Rotation about Y, radians. Visual only. */
  yaw: number;
}

/** What lines the verge in each biome, and how densely. */
export interface HazardProfile {
  kinds: PropKind[];
  /** Average metres between hazards. Smaller is more claustrophobic. */
  spacing: number;
}

/**
 * A stage under particular conditions.
 *
 * Conditions are variants rather than a per-race roll, so a record always
 * belongs to the conditions it was set in. A gold time from clear daylight
 * would be meaningless — and quietly unreachable — in fog, and a ghost from a
 * dry line is the wrong car to chase on a wet one.
 */
export interface StageVariant {
  /** Unique within the stage. Combined with the stage id to key records. */
  id: string;
  /** Human label, e.g. "Night · Rain". */
  name: string;
  conditions: Conditions;
  medals: MedalTimes;
  payouts: { author: number; gold: number; silver: number; bronze: number; finish: number };
  entryFee: number;
  requiresMedals: number;
}

/**
 * How a variant differs from its stage's baseline.
 *
 * `timeScale` is calibrated by driving the variant with the AI (`npm run
 * stages`), which feels the grip loss directly, and then adding an allowance
 * for visibility, which the AI does not feel at all — see
 * `visibilityPenalty`.
 */
export interface VariantSpec {
  id: string;
  conditions: Conditions;
  /** Multiplier on the base medal times. */
  timeScale: number;
  /** Multiplier on entry fee and payouts. Harder conditions pay more. */
  rewardScale: number;
  requiresMedals: number;
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
  /** What each medal pays on a finish. */
  payouts: { author: number; gold: number; silver: number; bronze: number; finish: number };
  /**
   * Medals that must already be held elsewhere before this stage opens.
   *
   * Nine stages available at once gives a new player no direction, and a
   * career with no shape beyond a rising balance. Zero, or absent, means
   * always open — the free stage never locks.
   */
  requiresMedals?: number;
  cameraZones?: CameraZone[];
  /** Roadside hazards. Omit for a bare corridor. */
  hazards?: HazardProfile;
  /**
   * Extra conditions this stage can be raced in, beyond clear daylight.
   * The baseline variant is always present and is generated, not authored.
   */
  variants?: VariantSpec[];
  /** Number of intermediate checkpoints. They are spaced evenly along the stage. */
  checkpoints?: number;
}

/**
 * Deterministic RNG, so a stage's hazards are identical on every load and in
 * every headless run. Nothing about a stage may depend on Math.random.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a stage id into a seed, so hazard layout is stable but stage-specific. */
function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const PROP_SHAPE: Record<PropKind, { radius: number; height: number }> = {
  tree: { radius: 0.42, height: 5.5 },
  rock: { radius: 0.85, height: 1.3 },
  bale: { radius: 0.75, height: 1.5 },
  pole: { radius: 0.16, height: 2.2 },
};

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
  /** Unit vector across the gate, pointing to the driver's left. */
  left: Vec3;
}

/** Key under which a variant's record and ghost are stored. */
export const variantKey = (stageId: string, variantId: string): string =>
  `${stageId}:${variantId}`;

/** The always-present clear-daylight variant, built from the stage's own numbers. */
const baselineVariant = (def: StageDef): StageVariant => ({
  id: 'day-clear',
  name: describeConditions(CLEAR_DAY),
  conditions: CLEAR_DAY,
  medals: def.medals,
  payouts: def.payouts,
  entryFee: def.entryFee,
  requiresMedals: def.requiresMedals ?? 0,
});

/**
 * Every way this stage can be raced: clear daylight first, then its variants.
 *
 * Variants scale off the baseline rather than repeating it, so a stage's
 * numbers are stated once and a harder version of it stays in proportion.
 */
export function stageVariants(def: StageDef): StageVariant[] {
  const base = baselineVariant(def);
  const extras = (def.variants ?? []).map((spec): StageVariant => ({
    id: spec.id,
    name: describeConditions(spec.conditions),
    conditions: spec.conditions,
    medals: {
      author: Math.round(def.medals.author * spec.timeScale),
      gold: Math.round(def.medals.gold * spec.timeScale),
      silver: Math.round(def.medals.silver * spec.timeScale),
      bronze: Math.round(def.medals.bronze * spec.timeScale),
    },
    payouts: {
      author: Math.round(def.payouts.author * spec.rewardScale),
      gold: Math.round(def.payouts.gold * spec.rewardScale),
      silver: Math.round(def.payouts.silver * spec.rewardScale),
      bronze: Math.round(def.payouts.bronze * spec.rewardScale),
      finish: Math.round(def.payouts.finish * spec.rewardScale),
    },
    entryFee: Math.round(def.entryFee * spec.rewardScale),
    requiresMedals: spec.requiresMedals,
  }));
  return [base, ...extras];
}

/** Look up one variant, falling back to clear daylight. */
export function findVariant(def: StageDef, variantId: string | undefined): StageVariant {
  const all = stageVariants(def);
  return all.find((v) => v.id === variantId) ?? all[0]!;
}

export class Stage {
  readonly def: StageDef;
  readonly spline: Spline;
  readonly geometry: StageGeometry;
  readonly checkpoints: Checkpoint[];
  readonly props: StageProp[];
  /**
   * Camera zones, derived from the road rather than authored.
   *
   * The authored zones in `def.cameraZones` supply zoom only; the yaw is
   * computed here. See `buildCameraZones` for why.
   */
  readonly cameraZones: CameraZone[];
  /** Corners found in the road, shared by the signs, the HUD and the map. */
  readonly corners: Corner[];
  /** Warning boards on the verge, one per corner. */
  readonly signs: CornerSign[];
  readonly start: { position: Vec3; heading: number };
  readonly length: number;

  constructor(def: StageDef) {
    this.def = def;
    this.spline = new Spline(def.controlPoints);
    this.length = this.spline.length;
    this.geometry = this.buildGeometry();
    this.checkpoints = this.buildCheckpoints(def.checkpoints ?? 3);
    this.props = this.buildProps();
    this.cameraZones = this.buildCameraZones();
    this.corners = findCorners(this.spline, this.length);
    this.signs = this.buildSigns();

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
        const point = add(add(s.position, scale(s.left, p.offset)), scale(s.up, p.height));
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
      out.push({ distance, position: s.position, width: s.width, left: s.left });
    }
    return out;
  }

  /**
   * Place roadside hazards along the verge.
   *
   * Without them the damage model has almost nothing to act on: the
   * embankments are shallow ramps, so a car that runs wide simply climbs one
   * and slides back with a couple of thousand newton-seconds of contact — far
   * below the threshold for even paint damage. Real rally stages are lined with
   * trees, rocks and bales, and those are what make going off-line a decision
   * rather than a minor inconvenience.
   *
   * They sit just beyond the verge, so clipping one is the price of running
   * genuinely wide rather than of using the road's full width.
   */
  /**
   * Camera zones that always sit *behind* the direction of travel.
   *
   * This was authored by hand, and by eye, and it was wrong: measured across
   * the nine stages, between 60% and 98% of every one was driven toward the
   * camera. A car coming toward the viewer has its left and right mirrored on
   * screen, so the steering read as inverted for most of the game — the single
   * worst bug in it, and invisible to every headless test, because the
   * simulation was perfectly correct.
   *
   * So the yaw is derived instead. A zone runs until the road has turned more
   * than `ZONE_TURN` from the heading it started with, and its camera sits
   * behind that heading, offset for an isometric read and snapped to an eighth
   * of a circle so the world still reads as a fixed diorama rather than a chase
   * camera. The budget is what keeps the guarantee: at most 45° of road turn
   * inside a zone, 20° of stylistic offset and 11.25° of snapping is 76°, which
   * leaves 14° of margin before a car could face the camera again.
   *
   * The view is still fixed and still pans: the yaw changes only at zone
   * boundaries, and eases over `zoneHalfLife`.
   */
  private buildCameraZones(): CameraZone[] {
    const ZONE_TURN = Math.PI * 0.25;
    const ISO_OFFSET = Math.PI * 0.11;
    const EIGHTH = Math.PI / 4;
    const authored = this.def.cameraZones ?? [];

    /** Zoom the author asked for at this distance, or a sensible default. */
    const zoomAt = (distance: number): number => {
      let zoom = 13;
      for (const zone of authored) {
        if (distance >= zone.from && zone.zoom !== undefined) zoom = zone.zoom;
      }
      return zoom;
    };

    const bearingAt = (distance: number): number => {
      const sample = this.spline.at(distance);
      return Math.atan2(sample.forward.x, sample.forward.z);
    };

    const zones: CameraZone[] = [];
    let zoneStart = 0;
    let reference = bearingAt(0);
    // Alternate which side the camera sits on, so consecutive zones do not all
    // look the same and the stage keeps some visual variety.
    let side = 1;

    const push = (from: number, bearing: number) => {
      const behind = bearing + Math.PI + ISO_OFFSET * side;
      zones.push({
        from,
        yaw: Math.round(behind / EIGHTH) * EIGHTH,
        zoom: zoomAt(from),
      });
      side = -side;
    };

    for (let d = 5; d < this.length; d += 5) {
      const bearing = bearingAt(d);
      let turn = (bearing - reference) % (Math.PI * 2);
      if (turn > Math.PI) turn -= Math.PI * 2;
      if (turn < -Math.PI) turn += Math.PI * 2;
      if (Math.abs(turn) > ZONE_TURN) {
        // The zone's camera is aimed at the middle of what it covers, not at
        // its first metre, which halves the turn it has to tolerate.
        push(zoneStart, bearingAt((zoneStart + d) / 2));
        zoneStart = d;
        reference = bearing;
      }
    }
    push(zoneStart, bearingAt((zoneStart + this.length) / 2));

    // The first zone always starts at zero, whatever the walk above decided.
    zones[0]!.from = 0;
    return zones;
  }

  /**
   * A warning board before each corner, on the outside of the bend.
   *
   * Outside rather than inside because that is the side you are looking at on
   * the way in — a sign on the apex side is behind the car by the time it
   * matters. Set back far enough to be read at pace and pulled in when the
   * previous corner is close, so a board never appears before the corner it
   * belongs to has been left.
   */
  private buildSigns(): CornerSign[] {
    const WARNING = 55;
    const signs: CornerSign[] = [];

    for (let i = 0; i < this.corners.length; i++) {
      const corner = this.corners[i]!;
      const previous = this.corners[i - 1];
      const earliest = previous ? previous.exit + 8 : 6;
      const at = Math.max(Math.min(corner.entry - WARNING, corner.entry - 12), earliest);
      if (at >= corner.entry) continue;

      const sample = this.spline.at(at);
      // `left` is the road's left, so the outside of a left-hander is its
      // negation. Getting this backwards puts every board in the ditch on the
      // inside of the bend, where nobody looks.
      const outward = corner.direction === 'left' ? -1 : 1;
      const offset = sample.width + VERGE_WIDTH * 0.7;
      const base = add(sample.position, scale(sample.left, offset * outward));
      // Facing the *camera*, not the road. A board turned to face the
      // oncoming car is seen almost edge-on from an isometric view — it
      // renders as a bright sliver and reads as nothing at all. The camera's
      // yaw is fixed within a zone, so this is still a static orientation.
      let yaw = this.cameraZones[0]!.yaw ?? 0;
      for (const zone of this.cameraZones) {
        if (at >= zone.from && zone.yaw !== undefined) yaw = zone.yaw;
      }

      signs.push({
        distance: at,
        position: v3(base.x, base.y - VERGE_DROP, base.z),
        yaw,
        corner,
      });
    }
    return signs;
  }

  private buildProps(): StageProp[] {
    const profile = this.def.hazards;
    if (!profile || profile.kinds.length === 0) return [];

    const random = seededRandom(hashString(this.def.id));
    const props: StageProp[] = [];
    const gateClearance = 14;

    for (let d = 12; d < this.length - 12; d += profile.spacing * (0.6 + random() * 0.8)) {
      // Keep the start, finish and every checkpoint gate clear.
      const nearGate =
        d < gateClearance ||
        d > this.length - gateClearance ||
        this.checkpoints.some((c) => Math.abs(c.distance - d) < gateClearance);
      if (nearGate) continue;

      const sample = this.spline.at(d);
      const side = random() < 0.5 ? -1 : 1;
      const kind = profile.kinds[Math.floor(random() * profile.kinds.length)]!;
      const shape = PROP_SHAPE[kind];

      // Just past the verge, scattered into the lower part of the bank.
      const offset = sample.width + VERGE_WIDTH * 0.85 + random() * BANK_WIDTH * 0.75;
      const along = (random() - 0.5) * profile.spacing * 0.4;

      const base = add(
        add(sample.position, scale(sample.left, offset * side)),
        scale(sample.forward, along),
      );

      props.push({
        kind,
        position: v3(base.x, base.y - VERGE_DROP, base.z),
        radius: shape.radius,
        height: shape.height,
        yaw: random() * Math.PI * 2,
      });
    }
    return props;
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
