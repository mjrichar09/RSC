/**
 * Procedural stage generation.
 *
 * A stage is just a centreline of control points, so generating one is a walk:
 * pick a heading, step forward, turn by a bounded amount, repeat. Everything
 * else — road, verges, embankments, hazards, collider — is already derived from
 * that centreline, so nothing here has to know about geometry.
 *
 * What makes generated stages shippable is the validation, not the generation.
 * Every candidate must survive three checks: its corridor must not run into
 * itself, its corners must be drivable, and the AI driver must actually get
 * round it. A generator without those produces stages that look plausible and
 * are impossible.
 */

import type { ControlPoint } from './spline.js';
import { Stage, type HazardProfile, type StageDef } from './stage.js';
import type { SurfaceId } from './surfaces.js';

export interface BiomePreset {
  id: string;
  /** Road surfaces, chosen per segment. Repeat one to weight it. */
  surfaces: SurfaceId[];
  verge: SurfaceId;
  bank: SurfaceId;
  hazards: HazardProfile;
  /** Half-width range of the road, metres. */
  width: [number, number];
  /** Metres of elevation the stage may drift per segment. */
  relief: number;
}

export const BIOMES: BiomePreset[] = [
  {
    id: 'forest',
    surfaces: ['gravel', 'gravel', 'dirt'],
    verge: 'grass',
    bank: 'dirt',
    hazards: { kinds: ['tree', 'rock'], spacing: 15 },
    width: [5.2, 6.6],
    relief: 2.5,
  },
  {
    id: 'quarry',
    surfaces: ['tarmac', 'gravel', 'dirt'],
    verge: 'dirt',
    bank: 'dirt',
    hazards: { kinds: ['rock', 'bale', 'pole'], spacing: 12 },
    width: [4.4, 5.8],
    relief: 3.5,
  },
  {
    id: 'winter',
    surfaces: ['snow', 'snow', 'ice'],
    verge: 'snow',
    bank: 'snow',
    hazards: { kinds: ['pole', 'tree'], spacing: 17 },
    width: [5.8, 7.0],
    relief: 3,
  },
  {
    id: 'moor',
    surfaces: ['dirt', 'mud', 'gravel'],
    verge: 'grass',
    bank: 'grass',
    hazards: { kinds: ['rock', 'pole'], spacing: 19 },
    width: [5.0, 6.4],
    relief: 2,
  },
  {
    id: 'coast',
    surfaces: ['tarmac', 'tarmac', 'gravel'],
    verge: 'grass',
    bank: 'dirt',
    hazards: { kinds: ['pole', 'bale', 'rock'], spacing: 14 },
    width: [4.8, 6.2],
    relief: 4,
  },
];

export const biomeById = (id: string): BiomePreset =>
  BIOMES.find((b) => b.id === id) ?? BIOMES[0]!;

export interface GenerateOptions {
  seed: number;
  biome?: string;
  /** Target centreline length in metres. */
  length?: number;
  /** 0 = flowing and open, 1 = tight and technical. */
  technicality?: number;
  /** Roughly one crest per this many metres. Zero for a flat stage. */
  crestSpacing?: number;
}

/**
 * A crest is a short convex rise: half-length `CREST_HALF` metres, `CREST_RISE`
 * high.
 *
 * The car leaves the ground when the crest's radius of curvature is smaller
 * than v²/g, and for a parabolic crest that radius is L²/2h. These numbers give
 * about 65 m, so the car flies over at roughly 90 km/h and stays planted below
 * it — a crest that only rewards commitment, rather than one that launches
 * everybody equally.
 */
const CREST_HALF = 18;
const CREST_RISE = 2.5;

/**
 * Deterministic RNG — a seed must always produce the same stage.
 *
 * The seed is scrambled and the generator warmed up before use. Raw xorshift
 * mixes poorly from small seeds, and its first few outputs come out biased low
 * — which silently made every stage pick biome index 0.
 */
function rng(seed: number): () => number {
  let a = Math.imul(seed >>> 0 || 1, 0x9e3779b1) >>> 0;
  a ^= a >>> 16;
  a = Math.imul(a, 0x85ebca6b) >>> 0;
  a ^= a >>> 13;
  if (a === 0) a = 0x6d2b79f5;

  const next = () => {
    a ^= a << 13;
    a >>>= 0;
    a ^= a >> 17;
    a ^= a << 5;
    a >>>= 0;
    return a / 4294967296;
  };

  for (let i = 0; i < 8; i++) next();
  return next;
}

/**
 * The minimum separation two parts of the centreline need before their
 * corridors overlap. Generous, because near-misses still produce embankments
 * that merge into an unreadable mess.
 */
const CLEARANCE = 34;

/**
 * Walk a centreline.
 *
 * Turn angle is bounded by segment length so no corner is tighter than the
 * corridor is wide, and each candidate point is rejected if it lands too near
 * anything already placed — cheaper than generating a self-crossing stage and
 * discovering it later.
 */
function walk(random: () => number, biome: BiomePreset, targetLength: number, technicality: number): ControlPoint[] | null {
  const minSegment = 44 - technicality * 12;
  const maxSegment = 92 - technicality * 26;
  // Sharper turns allowed on a technical stage, but never tighter than the
  // corridor can physically accommodate.
  const maxTurn = (0.55 + technicality * 0.5) * Math.PI * 0.5;

  const points: { x: number; y: number; z: number }[] = [{ x: 0, y: 0, z: 0 }];
  let heading = 0;
  let elevation = 0;
  let travelled = 0;
  let attemptsSinceProgress = 0;

  while (travelled < targetLength) {
    if (attemptsSinceProgress > 40) return null;

    const segment = minSegment + random() * (maxSegment - minSegment);
    // Bias successive turns to alternate, which produces flowing sequences
    // instead of a stage that spirals in one direction and closes on itself.
    const turn = (random() - 0.5) * 2 * maxTurn * (0.4 + random() * 0.6);
    const nextHeading = heading + turn;

    const last = points[points.length - 1]!;
    const candidate = {
      x: last.x + Math.sin(nextHeading) * segment,
      z: last.z + Math.cos(nextHeading) * segment,
      y: elevation + (random() - 0.5) * 2 * biome.relief,
    };

    // Reject anything that crowds an earlier part of the stage.
    let crowded = false;
    for (let i = 0; i < points.length - 1; i++) {
      const p = points[i]!;
      if (Math.hypot(p.x - candidate.x, p.z - candidate.z) < CLEARANCE) {
        crowded = true;
        break;
      }
    }
    if (crowded) {
      attemptsSinceProgress++;
      continue;
    }

    points.push(candidate);
    heading = nextHeading;
    elevation = candidate.y;
    travelled += segment;
    attemptsSinceProgress = 0;
  }

  if (points.length < 6) return null;

  return points.map((pos, i) => {
    const t = i / (points.length - 1);
    // Widen slightly at the start and finish so the line is easy to take.
    const edge = Math.min(t, 1 - t) * 2;
    const width =
      biome.width[0] + (biome.width[1] - biome.width[0]) * (0.35 + random() * 0.4) + (1 - edge) * 0.5;
    return {
      pos,
      width,
      surface: biome.surfaces[Math.floor(random() * biome.surfaces.length)]!,
    };
  });
}

/**
 * Insert crests into a finished centreline.
 *
 * Each one replaces a slice of a straight-ish segment with a rise and a fall,
 * so the road still goes where it went — only now it goes over something. They
 * are only placed on segments long and straight enough to take one: a crest in
 * the middle of a corner is a launch into an embankment, not a jump.
 */
function addCrests(
  points: ControlPoint[],
  random: () => number,
  spacing: number,
): ControlPoint[] {
  const out: ControlPoint[] = [points[0]!];
  let sinceLast = Infinity;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const span = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
    sinceLast += span;

    // Needs room for the rise, the peak and the fall, plus approach and exit —
    // and enough clear road since the last one. Back-to-back crests make a
    // washboard the car is never off long enough to fly over, rather than a
    // sequence of jumps.
    const roomy = span > CREST_HALF * 4 && sinceLast > spacing * 0.8;
    if (roomy && random() < span / spacing) {
      sinceLast = 0;
      const t = 0.5;
      const at = (k: number) => ({
        x: a.pos.x + (b.pos.x - a.pos.x) * k,
        y: a.pos.y + (b.pos.y - a.pos.y) * k,
        z: a.pos.z + (b.pos.z - a.pos.z) * k,
      });
      const half = CREST_HALF / span;

      for (const [k, lift] of [
        [t - half, 0],
        [t, CREST_RISE],
        [t + half, 0],
      ] as const) {
        const pos = at(k);
        out.push({ ...b, pos: { ...pos, y: pos.y + lift } });
      }
    }
    out.push(b);
  }
  return out;
}

/** Camera zones spaced along the stage, following the direction of travel. */
function cameraZones(stage: Stage, random: () => number): StageDef['cameraZones'] {
  const zones: NonNullable<StageDef['cameraZones']> = [];
  const count = Math.max(3, Math.round(stage.length / 220));

  for (let i = 0; i < count; i++) {
    const at = (stage.length * i) / count;
    const sample = stage.spline.at(at);
    // Sit the camera off the direction of travel so the road runs across the
    // screen rather than straight at it, and snap to eighths so the world reads
    // as isometric rather than as a free-floating camera.
    const bearing = Math.atan2(sample.forward.x, sample.forward.z);
    const eighth = Math.PI / 4;
    const yaw = Math.round((bearing + eighth) / eighth) * eighth;
    zones.push({ from: at, yaw, zoom: 12.5 + random() * 3 });
  }
  return zones;
}

export interface GeneratedStage {
  def: StageDef;
  stage: Stage;
}

/**
 * Build one candidate. Returns null when it fails a structural check; the
 * caller decides whether to try another seed.
 *
 * Drivability is *not* checked here — that needs the physics and is done by
 * `validateStage` in `runStage.ts`, so this module stays pure and cheap.
 */
export function generateStage(options: GenerateOptions): GeneratedStage | null {
  const random = rng(options.seed);
  const biome = options.biome ? biomeById(options.biome) : BIOMES[Math.floor(random() * BIOMES.length)]!;
  const targetLength = options.length ?? 700 + random() * 500;
  const technicality = options.technicality ?? random();

  let controlPoints = walk(random, biome, targetLength, technicality);
  if (!controlPoints) return null;

  const crestSpacing = options.crestSpacing ?? 150 + random() * 130;
  if (crestSpacing > 0) controlPoints = addCrests(controlPoints, random, crestSpacing);

  const id = `gen-${biome.id}-${options.seed}`;
  const def: StageDef = {
    id,
    name: stageName(biome.id, random),
    biome: biome.id,
    controlPoints,
    verge: biome.verge,
    bank: biome.bank,
    hazards: biome.hazards,
    checkpoints: Math.max(2, Math.round(targetLength / 240)),
    // Placeholders: both are set from the AI's time once it has been driven.
    medals: { author: 1, gold: 1, silver: 1, bronze: 1 },
    entryFee: 0,
    payouts: { author: 0, gold: 0, silver: 0, bronze: 0, finish: 0 },
  };

  const stage = new Stage(def);
  if (stage.selfIntersections().length > 0) return null;

  def.cameraZones = cameraZones(stage, random);
  return { def, stage: new Stage(def) };
}

const FIRST = ['North', 'Black', 'High', 'Old', 'Long', 'Cold', 'Deep', 'Wind', 'Storm', 'Iron'];
const SECOND: Record<string, string[]> = {
  forest: ['Pine', 'Birch', 'Timber', 'Hollow', 'Thicket'],
  quarry: ['Quarry', 'Cutting', 'Shale', 'Slate', 'Pit'],
  winter: ['Frost', 'Drift', 'Glacier', 'Snow', 'Pass'],
  moor: ['Moor', 'Fell', 'Bog', 'Heath', 'Mire'],
  coast: ['Head', 'Cove', 'Point', 'Cliff', 'Bay'],
};
const THIRD = ['Run', 'Pass', 'Stage', 'Loop', 'Trail', 'Climb', 'Descent'];

function stageName(biome: string, random: () => number): string {
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!;
  const middle = pick(SECOND[biome] ?? SECOND.forest!);
  // Avoid "Deep Pass Pass": drop any suffix that repeats the middle word.
  const suffixes = THIRD.filter((t) => t !== middle);
  return `${pick(FIRST)} ${middle} ${pick(suffixes)}`;
}

/**
 * Set medal times and payouts from a measured lap.
 *
 * The AI is a consistent, honest driver rather than a fast one, so its time
 * anchors silver: gold and author are left for a human to earn, and bronze is
 * generous enough that finishing at all is worth something.
 */
export function calibrate(def: StageDef, aiTime: number, lengthMetres: number): StageDef {
  const medals = {
    author: Math.round(aiTime * 0.68),
    gold: Math.round(aiTime * 0.8),
    silver: Math.round(aiTime * 0.98),
    bronze: Math.round(aiTime * 1.3),
  };

  // Longer and slower stages pay more, since they cost more to attempt.
  const base = Math.round((lengthMetres / 100) * 42 + aiTime * 6);
  return {
    ...def,
    medals,
    entryFee: Math.round(base * 0.35),
    payouts: {
      finish: Math.round(base * 0.9),
      bronze: Math.round(base * 1.5),
      silver: Math.round(base * 2.6),
      gold: Math.round(base * 4.4),
      author: Math.round(base * 7),
    },
  };
}
