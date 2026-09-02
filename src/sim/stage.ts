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
import { shapeCamber, terrainRise } from './terrain.js';
import {
  BANK_HEIGHT,
  BANK_WIDTH,
  CROWN,
  VERGE_DROP,
  VERGE_WIDTH,
  WALL_HEIGHT,
  WALL_WIDTH,
} from './corridor.js';
import { type SceneryItem, scatterScenery } from './scenery.js';
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

export type PropKind =
  | 'tree'
  /** A young tree. Goes over when you hit it, and costs you very little. */
  | 'sapling'
  | 'rock'
  | 'bale'
  | 'pole'
  /** A wall of a house. The most solid thing in the game. */
  | 'building'
  | 'gatePost'
  | 'signPost'
  | 'pier';

/** A corner warning board standing on the verge. */
export interface CornerSign {
  /** Where it stands, in metres along the stage. */
  distance: number;
  position: Vec3;
  /** Facing, radians about Y — turned to face the camera, not the road. */
  yaw: number;
  corner: Corner;
}

/**
 * A place where the stage passes over itself.
 *
 * Grand Traverse does it twice — the snow section runs 46 m above the start
 * line and 19 m above the gravel section at 254 m — and until now nothing said
 * so. The upper corridor is a ribbon in space with a wall down each side and
 * open air beneath it, and the ground far below dips away under it, so from the
 * lower road it reads as a road hanging in the sky with nothing holding it up.
 * That is what "it needs a bridge so that it makes sense where the road crosses
 * over" is describing: the geometry was already an overpass, it just had no
 * structure.
 *
 * Found rather than authored, for the same reason the corners are: a control
 * point moves and a hand-placed bridge is in the wrong place, silently.
 */
export interface Crossing {
  /** Distance along the stage of the road passing over, metres. */
  over: number;
  /** Distance along the stage of the road passing under, metres. */
  under: number;
  /** How far the upper road is above the lower one, metres. */
  headroom: number;
  /** The carried span on the upper road, as distances along the stage. */
  span: [number, number];
}

export interface StageProp {
  kind: PropKind;
  position: Vec3;
  /** Collider half-extents, metres. */
  radius: number;
  height: number;
  /** Rotation about Y, radians. Visual only. */
  yaw: number;
  /**
   * Mass in kilograms, when this prop can be knocked over.
   *
   * A sapling is a dynamic body: hitting one topples it and costs the car
   * almost nothing, which is the whole difference between it and the tree
   * beside it. Everything else is fixed, and hitting a fixed thing at speed is
   * as expensive as the impact model says it is — no special case anywhere.
   */
  mass?: number;
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

const PROP_SHAPE: Record<PropKind, { radius: number; height: number; mass?: number }> = {
  // A mature trunk. Immovable, and hitting one is the most expensive mistake
  // available at the side of a forest stage.
  tree: { radius: 0.52, height: 7.5 },
  // Sixty kilos of young wood. It goes over, and it barely marks the car.
  sapling: { radius: 0.16, height: 3.0, mass: 60 },
  rock: { radius: 0.85, height: 1.3 },
  bale: { radius: 0.75, height: 1.5 },
  pole: { radius: 0.16, height: 2.2 },
  // The corner of a house. Nothing in the game hits harder.
  building: { radius: 3.2, height: 9 },
  // The scaffolding either side of a start, checkpoint or finish gate. Drawn by
  // the gate builder rather than with the hazards, so the renderer skips it.
  gatePost: { radius: 0.28, height: 3.4 },
  // The post under a corner board. Drawn by the sign builder, like a gate post,
  // so the renderer skips it here.
  //
  // It had no collider at all: the boards were built as pure decoration, and a
  // steel post standing two metres off the road that a car passes through is
  // the same bug as the trees were.
  //
  // Given a mass, so it goes over. Static was the first attempt and it is worse
  // than it sounds: a post that stops dead and stays perfectly upright after
  // being hit at ninety reads as scenery with a collider bolted on, which is
  // the same complaint one layer further in. Forty-five kilos of board and
  // pole — it barely marks the car, and it is lying in the verge afterwards.
  signPost: { radius: 0.09, height: 2.0, mass: 45 },
  // A bridge pier. Height is per-instance — it is however far it is from the
  // ground to the deck — so this one is only the footprint.
  pier: { radius: 1.5, height: 1 },
};

export { CORRIDOR } from './corridor.js';

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
  /** Half-width of the gate: the posts stand at ±this across it. */
  width: number;
  /** Unit vector across the gate, pointing to the driver's left. */
  left: Vec3;
  /**
   * Unit vector through the gate, pointing down the stage.
   *
   * With `position` and `left` this is the gate as a plane, which is what the
   * race rules test against. Testing instead against arc length and the
   * spline's own lateral looked equivalent and was not: that lateral comes from
   * the nearest *sample*, and through a tight corner the nearest sample is
   * across the apex from the car — it reported a car in the middle of the road
   * as twelve metres off it, and marked gates missed that were driven straight
   * through. A gate is three vectors, and it should be measured as three
   * vectors.
   */
  forward: Vec3;
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
   * The wood, the quarry floor or the street the road runs through.
   *
   * Built here rather than in the renderer so the trees you can see are the
   * trees you can hit — see `scenery.ts` for why that was ever otherwise.
   */
  readonly scenery: SceneryItem[];
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
  /** Places the stage passes over itself, and the bridges that carry it. */
  readonly crossings: Crossing[];
  readonly start: { position: Vec3; heading: number };
  readonly length: number;

  constructor(def: StageDef) {
    this.def = def;
    // The authored centreline says where the road goes; the terrain says what
    // it is. Applied here, before the spline, so the collider, the AI, the
    // camera and the props all agree about where the ground is — terrain that
    // existed only in the renderer would be a picture of a hill.
    const roughLength = def.controlPoints.reduce((total, point, i) => {
      if (i === 0) return 0;
      const previous = def.controlPoints[i - 1]!.pos;
      return total + Math.hypot(point.pos.x - previous.x, point.pos.z - previous.z);
    }, 0);
    this.spline = new Spline(
      shapeCamber(def.controlPoints, def.id),
      2,
      terrainRise(def.id, roughLength),
    );
    this.length = this.spline.length;
    this.geometry = this.buildGeometry();
    this.checkpoints = this.buildCheckpoints(def.checkpoints ?? 3);
    this.cameraZones = this.buildCameraZones();
    this.corners = findCorners(this.spline, this.length);
    // Before the props, which take a collider for each of these boards and a
    // pier for each end of every bridge.
    this.signs = this.buildSigns();
    this.crossings = this.findCrossings();
    this.props = this.buildProps();
    this.scenery = scatterScenery(def.id, def.biome, this.spline);

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
      // A crown down the middle, as every real road has: water has to run off
      // it. Small — about one and a half percent — but it is the difference
      // between a road that is a flat ribbon and one that has a line down it,
      // and it is why running wide costs you a little more than the width.
      { offset: 0, height: CROWN },
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

  /**
   * Checkpoints, spaced evenly along the stage.
   *
   * Evenly, and nowhere cleverer. Moving each gate onto the straightest road
   * within forty metres was tried — a gate mid-corner is one the racing line
   * goes round the outside of — and it works, but a gate that moves takes the
   * hazard layout with it: props are kept clear of every gate, so shifting one
   * reshuffles every tree and rock downstream of it. On Grand Traverse that put
   * something new in the AI's path and cost its reference lap fifteen seconds
   * against medals calibrated on the old one. Not a trade worth making for a
   * problem the gate rule does not have.
   */
  private buildCheckpoints(count: number): Checkpoint[] {
    const out: Checkpoint[] = [];
    for (let i = 1; i <= count; i++) {
      const distance = (this.length * i) / (count + 1);
      const s = this.spline.at(distance);
      out.push({ distance, position: s.position, width: s.width, left: s.left, forward: s.forward });
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
    // How far the road may turn inside one camera zone.
    //
    // The margin here is thinner than it looks: half this turn, plus up to an
    // eighth-turn of snapping error, plus the isometric offset, all stack
    // against the 90° at which the car starts driving out of the screen rather
    // than into it. At a quarter turn it passed by a hair, and the moment the
    // stages gained elevation — which moves every arc length slightly — one
    // zone on one stage crossed over and mirrored the steering. Less turn per
    // zone, more zones, and headroom that a change to the road cannot spend.
    const ZONE_TURN = Math.PI * 0.2;
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

    // Then check what was built, metre by metre, and split anything that fails.
    //
    // The rule above bounds how far the road turns inside a zone, and that is
    // not the same as bounding how far the road ends up from the camera it was
    // given: the yaw is snapped to an eighth of a turn and carries the
    // isometric offset, and those stack. It passed by a hair for a long time,
    // and the moment the stages gained elevation — which moves every arc
    // length slightly — one zone crossed over and mirrored the steering on a
    // corner. This makes the property the tests check into the property the
    // code enforces, rather than something the numbers happen to satisfy.
    const MARGIN = -0.12;
    const split: CameraZone[] = [];
    for (const [i, zone] of zones.entries()) {
      split.push(zone);
      const until = zones[i + 1]?.from ?? this.length;
      let yaw = zone.yaw!;
      for (let d = zone.from + 5; d < until; d += 5) {
        if (Math.cos(bearingAt(d) - yaw) < MARGIN) continue;
        // Past the margin: start a fresh zone here, aimed at the road ahead.
        const rest = Math.min(until, d + 60);
        const behind = bearingAt((d + rest) / 2) + Math.PI + ISO_OFFSET * side;
        yaw = Math.round(behind / EIGHTH) * EIGHTH;
        side = -side;
        split.push({ from: d, yaw, zoom: zoomAt(d) });
      }
    }
    return split;
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
    const props: StageProp[] = [...this.gatePosts(), ...this.signPosts(), ...this.piers()];
    const profile = this.def.hazards;
    if (!profile || profile.kinds.length === 0) return props;

    const random = seededRandom(hashString(this.def.id));
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

      // Trees vary. A wood of identical cones reads as wallpaper, and more to
      // the point a stand of trees where every one costs the same is a wall
      // with a texture on it rather than something to read and judge.
      const size = kind === 'tree' ? 0.8 + random() * 0.6 : 1;

      props.push({
        kind,
        // A building stands on the ground the road sits on, not down in the
        // verge's drop — half of one sunk into the bank reads as a bunker.
        position: v3(base.x, base.y - (kind === 'building' ? 0 : VERGE_DROP), base.z),
        radius: shape.radius * size,
        height: shape.height * size,
        yaw: random() * Math.PI * 2,
        ...(shape.mass ? { mass: shape.mass } : {}),
      });
    }
    return props;
  }

  /**
   * The posts either side of every gate, as things you can hit.
   *
   * A gate you can drive through the middle of is a line on the ground with
   * decoration around it; a gate with solid posts is a target you have to aim
   * at, and clipping one on the way past a checkpoint is a mistake with a
   * price. They stand at the road edge, where they were already drawn.
   */
  private gatePosts(): StageProp[] {
    const shape = PROP_SHAPE.gatePost;
    const posts: StageProp[] = [];
    const at = (sample: SplineSample) => {
      for (const side of [-1, 1]) {
        posts.push({
          kind: 'gatePost',
          position: v3(
            sample.position.x + sample.left.x * sample.width * side,
            sample.position.y,
            sample.position.z + sample.left.z * sample.width * side,
          ),
          radius: shape.radius,
          height: shape.height,
          yaw: 0,
        });
      }
    };

    at(this.spline.samples[0]!);
    for (const checkpoint of this.checkpoints) at(this.spline.at(checkpoint.distance));
    at(this.spline.samples[this.spline.samples.length - 1]!);
    return posts;
  }

  /**
   * The post under each corner board, as a thing you can hit.
   *
   * The boards themselves are drawn at 2.6 m, over the car; only the post is
   * in the way, and only just — a corner board on the verge is something you
   * brush past when you have run wide, not an obstacle you aim between.
   */
  private signPosts(): StageProp[] {
    const shape = PROP_SHAPE.signPost;
    return this.signs.map((sign) => ({
      kind: 'signPost' as const,
      position: v3(sign.position.x, sign.position.y, sign.position.z),
      radius: shape.radius,
      height: shape.height,
      yaw: sign.yaw,
      ...(shape.mass ? { mass: shape.mass } : {}),
    }));
  }

  /**
   * Where the stage passes over itself, and how much of the upper road a bridge
   * has to carry.
   *
   * The opposite question to `selfIntersections`, from the same pair scan: that
   * one wants overlapping road at the *same* height, which is a broken stage.
   * This one wants overlapping road at very different heights, which is a
   * legitimate overpass and the thing that needs building.
   *
   * `headroom` has a floor as well as no ceiling. Below about eight metres the
   * two corridors are inside each other — the lower one's bank stands 2.4 m and
   * its wall 8.5 — and that is a stage fault to be reported, not a bridge to be
   * drawn under.
   */
  private findCrossings(minHeadroom = 8): Crossing[] {
    const samples = this.spline.samples;
    const found: Crossing[] = [];

    for (let i = 0; i < samples.length; i++) {
      const a = samples[i]!;
      for (let j = i + 1; j < samples.length; j++) {
        const b = samples[j]!;
        if (b.distance - a.distance < 45) continue;
        const rise = b.position.y - a.position.y;
        if (Math.abs(rise) < minHeadroom) continue;

        const flat = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
        // The upper road only needs carrying where it is actually over the
        // lower one's corridor, not merely near it.
        const lower = rise > 0 ? a : b;
        if (flat > this.halfCorridor(lower.width)) continue;

        const upper = rise > 0 ? b : a;
        // One bridge per crossing, not one per sample: the pair scan reports
        // every sample of the upper road that is over every sample of the
        // lower, which for a shallow crossing is dozens of hits describing the
        // same structure. They are merged by extending the span.
        const existing = found.find((c) => Math.abs(c.over - upper.distance) < 90);
        if (existing) {
          existing.span[0] = Math.min(existing.span[0], upper.distance);
          existing.span[1] = Math.max(existing.span[1], upper.distance);
          continue;
        }
        found.push({
          over: upper.distance,
          under: lower.distance,
          headroom: Math.abs(rise),
          span: [upper.distance, upper.distance],
        });
      }
    }

    // Widen every span to clear the corridor it crosses, plus an abutment at
    // each end. A deck that stops at the edge of the road below it is a slab
    // with its ends in mid-air; a bridge reaches the ground on both sides.
    for (const crossing of found) {
      const reach = this.halfCorridor(this.spline.at(crossing.under).width) + 12;
      crossing.span[0] = Math.max(crossing.span[0] - reach, 0);
      crossing.span[1] = Math.min(crossing.span[1] + reach, this.length);
      // Centre the recorded point on what is actually carried.
      crossing.over = (crossing.span[0] + crossing.span[1]) / 2;
    }
    return found;
  }

  /**
   * The columns holding each bridge up.
   *
   * One at each end of the span, clear of the road passing underneath — they
   * stand outside that corridor's wall, so a car on the lower road cannot
   * reach them. They get colliders anyway: there are four of them in the whole
   * game, the bill is nothing, and a two-metre concrete column that a car
   * passes through is the bug this whole round of work is about.
   */
  private piers(): StageProp[] {
    const shape = PROP_SHAPE.pier;
    const props: StageProp[] = [];
    for (const crossing of this.crossings) {
      const groundBelow = this.spline.at(crossing.under).position.y;
      for (const at of crossing.span) {
        const sample = this.spline.at(at);
        // Two columns across the deck, under its edges, so the span reads as
        // carried rather than balanced on a post.
        for (const side of [-1, 1]) {
          const offset = sample.width * 0.75;
          const foot = groundBelow - 4;
          const height = sample.position.y - 1.4 - foot;
          if (height < 3) continue;
          props.push({
            kind: 'pier',
            position: v3(
              sample.position.x + sample.left.x * offset * side,
              foot,
              sample.position.z + sample.left.z * offset * side,
            ),
            radius: shape.radius,
            height,
            yaw: Math.atan2(sample.forward.x, sample.forward.z),
          });
        }
      }
    }
    return props;
  }

  /** Total half-width of the corridor at a sample, including verge and bank. */
  private halfCorridor(width: number): number {
    return width + VERGE_WIDTH + BANK_WIDTH + WALL_WIDTH;
  }

  /**
   * How close the stage comes to itself in plan, ignoring height.
   *
   * `selfIntersections` skips a pair whose road heights differ by more than a
   * few metres, because one passing over another is legitimate. This asks the
   * looser question: how close do two pieces of road get while still being at
   * heights where their embankments, walls and ground skirts are in each
   * other? Reported rather than rejected — every healthy stage in the game
   * sits between 30 and 45 m, so the number is a smell test.
   */

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
  closestApproach(headroom = 14): { gap: number; a: number; b: number } {
    const samples = this.spline.samples;
    let best = { gap: Infinity, a: 0, b: 0 };
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        if (samples[j]!.distance - samples[i]!.distance < 45) continue;
        // A road far enough above another is an overpass and reads as one. The
        // bank stands 2.4 m and the ground skirt hangs 4 m below the road, so
        // below about fourteen metres the two corridors are in each other.
        if (Math.abs(samples[i]!.position.y - samples[j]!.position.y) > headroom) continue;
        const gap = Math.hypot(
          samples[i]!.position.x - samples[j]!.position.x,
          samples[i]!.position.z - samples[j]!.position.z,
        );
        if (gap < best.gap) best = { gap, a: samples[i]!.distance, b: samples[j]!.distance };
      }
    }
    return best;
  }

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
