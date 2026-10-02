/**
 * The ground under a stage.
 *
 * A centreline of control points describes where a road goes; it says almost
 * nothing about what the road *is*. Authored by hand, every stage came out flat
 * in both directions at once — level from one side to the other, and level from
 * the start line to the finish except where somebody had typed a crest in. A
 * flat road takes the same line at the same speed everywhere on it, which is
 * the difference between driving a stage and following one.
 *
 * So the elevation and the camber are shaped here, procedurally and
 * deterministically, from the stage's own id:
 *
 * - **Along the road**, two long sine waves at different wavelengths. Long
 *   enough to roll rather than to launch — a crest is an authored decision and
 *   this must not accidentally make more of them — but short enough that the
 *   car is rarely level. Compressions load the suspension into corners and
 *   crests unload it out of them, and neither is a thing you can see on a map.
 * - **Across the road**, camber derived from the corner itself, plus a seeded
 *   modulation that turns some corners off-camber. Both matter and the second
 *   matters more: a road that is always banked into the turn is a road that
 *   flatters you, and the corner that quietly falls away from you is the one
 *   rally drivers talk about.
 *
 * Authored values always win. A control point with its own `y` keeps it (the
 * undulation is added on top of it, so a designed crest is still a crest), and
 * a control point with its own `banking` is left alone entirely.
 *
 * This runs in `sim/`, before the spline is built, so the physics mesh, the AI,
 * the camera and the props all see the same ground. Terrain that existed only
 * in the renderer would be a picture of a hill.
 */

import type { ControlPoint, Spline } from './spline.js';

/**
 * How far around a point to look for a lower piece of road.
 *
 * Wide enough to cover the gap between two stacked corridors, narrow enough
 * that a stage which merely climbs is not dragged down to its own valley.
 */
const UNDER_RADIUS = 70;

/** How far the ground sits below the road it follows, metres. */
const BELOW_ROAD = 4;

/**
 * The height of the open ground at a point, in world space.
 *
 * In `sim/` and shared, because two things have to agree about it and used not
 * to. The renderer built its terrain mesh from one rule and the scenery scatter
 * placed every tree in the `far` band at the height of the nearest *road*
 * sample — so past the thirty metres where the ground starts following its own
 * noise, the ground fell away by up to a dozen metres and the trees standing on
 * it did not. Worse where a stage crosses over itself: the ground takes the
 * lowest road nearby and the scatter took the nearest one, so every tree
 * scattered off the upper leg of Grand Traverse hung in the air above the lower
 * one, which is exactly what it looked like.
 *
 * One function, called by both. It is not cheap — it sweeps the sample list —
 * but it runs once per stage load for a few thousand points, not per frame.
 */
export function groundHeight(
  spline: Spline,
  x: number,
  z: number,
  craters: readonly Crater[] = [],
): number {
  // Two octaves of cheap trig noise: enough to read as landscape, and
  // deterministic, so the same stage always looks the same.
  const h =
    Math.sin(x * 0.011) * Math.cos(z * 0.013) * 9 +
    Math.sin(x * 0.037 + 1.7) * Math.cos(z * 0.029 - 0.9) * 3.5;

  // Follow the road's local height rather than a single global minimum, so the
  // ground sits just below the corridor everywhere instead of dropping into a
  // canyon wherever the stage climbs.
  //
  // The *lowest* road nearby, not the nearest one. Where a stage passes over
  // itself the nearest sample flips from one leg to the other across a knife
  // edge, and the ground took a twelve-metre step inside a single cell — a
  // cliff in the middle of the landscape, and where the strange shadows around
  // a doubled-back stage were coming from. Taking the minimum puts the ground
  // under everything, which is what ground does.
  const nearest = spline.locate({ x, y: 0, z });
  let roadHeight = nearest.sample.position.y;
  for (const sample of spline.samples) {
    const dx = sample.position.x - x;
    const dz = sample.position.z - z;
    if (dx * dx + dz * dz > UNDER_RADIUS * UNDER_RADIUS) continue;
    if (sample.position.y < roadHeight) roadHeight = sample.position.y;
  }

  // The noise fades in with distance from the road: the ground has to meet the
  // corridor flush where it touches it and is free to be landscape further out.
  const clearance = Math.min(Math.max((Math.abs(nearest.lateral) - 30) / 110, 0), 1);
  return roadHeight - BELOW_ROAD + h * clearance - craterDip(craters, x, z);
}

/**
 * A crater in the open ground, out of reach of the road.
 *
 * Placed here, seeded, rather than in the renderer, for the reason everything
 * the size of a building is: the scenery scatter has to know to keep its
 * boulders out of them, and the ground mesh has to make room for them.
 */
export interface Crater {
  x: number;
  z: number;
  /** Rim radius, metres. The ejecta apron reaches half as far again. */
  radius: number;
  /** Floor below the surrounding ground, metres. */
  depth: number;
  /** Rim above it, metres. */
  rim: number;
}

/** How far past the rim the ejecta apron runs, as a multiple of the radius. */
export const CRATER_APRON = 1.5;

/**
 * Height of a crater's surface above the open ground under it, at `r` metres
 * from its centre: a bowl, a raised rim, and an apron falling away to nothing.
 */
export function craterProfile(c: Crater, r: number): number {
  const u = r / c.radius;
  if (u >= CRATER_APRON) return 0;
  if (u <= 1) return -c.depth + (c.depth + c.rim) * u ** 2.6;
  const t = (u - 1) / (CRATER_APRON - 1);
  return c.rim * (1 - t) * (1 - t);
}

/**
 * How far the open ground is dropped under the craters near a point.
 *
 * The crater itself is its own fine mesh (the ground grid is twenty metres to
 * a cell, coarser than most craters), so the ground under it only has to get
 * out of the way: deeper than the bowl inside the rim, easing back to nothing
 * at the apron's edge, where the crater mesh meets it flush.
 */
export function craterDip(craters: readonly Crater[], x: number, z: number): number {
  let dip = 0;
  for (const c of craters) {
    const r = Math.hypot(x - c.x, z - c.z);
    if (r >= c.radius * CRATER_APRON) continue;
    const t = Math.min(Math.max((c.radius * CRATER_APRON - r) / (c.radius * 0.4), 0), 1);
    dip = Math.max(dip, (c.depth + 3) * t * t * (3 - 2 * t));
  }
  return dip;
}

/**
 * Scatter craters around a stage, seeded from its id.
 *
 * Every one keeps its apron `reach` metres clear of the centreline — past the
 * corridor's wall, so no crater ever changes the ground the corridor meets;
 * clear of `avoid` (a launch pad, say); and clear of each other.
 */
export function placeCraters(
  spline: Spline,
  seed: string,
  count: number,
  radius: readonly [number, number],
  reach: number,
  avoid: readonly { x: number; z: number; clear: number }[] = [],
): Crater[] {
  let state = hash(`${seed}:craters`) * 4294967296;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const length = spline.length;
  const craters: Crater[] = [];
  for (let attempt = 0; attempt < count * 40 && craters.length < count; attempt++) {
    // Mostly small, a few large: the way craters come.
    const r = radius[0] + (radius[1] - radius[0]) * random() ** 2.2;
    const apron = r * CRATER_APRON;
    // Along the road and out to the side, weighted toward it: scattered over
    // the stage's whole bounding box, nearly all of them were somewhere the
    // camera never looks.
    const sample = spline.at(random() * length);
    const side = random() < 0.5 ? -1 : 1;
    const out = sample.width + apron + reach + random() ** 1.6 * 160;
    const x = sample.position.x + sample.left.x * out * side;
    const z = sample.position.z + sample.left.z * out * side;
    if (Math.abs(spline.locate({ x, y: 0, z }).lateral) < apron + reach) continue;
    if (avoid.some((a) => Math.hypot(x - a.x, z - a.z) < apron + a.clear)) continue;
    if (craters.some((c) => Math.hypot(x - c.x, z - c.z) < (c.radius + r) * CRATER_APRON)) continue;
    // Only on level ground. The open ground follows the lowest road nearby, so
    // beside a climb it steps — and a crater laid over a step came out as a
    // torn sheet standing on its edge beside Red Planet's mesa.
    let low = Infinity;
    let high = -Infinity;
    for (let k = 0; k <= 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const reachOut = k === 8 ? 0 : apron;
      const y = groundHeight(spline, x + Math.cos(a) * reachOut, z + Math.sin(a) * reachOut);
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
    if (high - low > r * 0.25) continue;
    craters.push({ x, z, radius: r, depth: r * 0.32, rim: r * 0.12 });
  }
  return craters;
}

export interface TerrainOptions {
  /** Metres of rise and fall added along the road. */
  amplitude?: number;
  /** Maximum camber, radians. */
  camber?: number;
  /**
   * How banked the road is at a distance along it, −1 to 1.
   *
   * 1 is fully banked into the corner, 0 flat, −1 fully off-camber. Defaults to
   * a slow seeded wave, mostly positive: a road that is always banked into the
   * turn is a road that flatters you, and the corner that quietly falls away is
   * the one rally drivers talk about. Overridable so a test can ask for one or
   * the other rather than hunting for a seed that produces it.
   */
  mood?: (distance: number) => number;
}

/** Metres over which the stage settles back to its authored height at each end. */
const TAPER = 45;

/**
 * Wavelengths, metres.
 *
 * The long one is the shape of the valley; the short one is the road following
 * the ground over it. Deliberately not harmonically related, so the two never
 * line up into a regular pattern the eye can predict.
 */
/**
 * Wavelengths, metres, and how much rise each is allowed.
 *
 * Long enough that the gradient stays under about a tenth: measured, a 2.2 m
 * amplitude at 96 m gave 33% slopes — a one-in-three hill — and put a quarter
 * of one stage's AI lap off the road. The pair are deliberately not harmonically
 * related, so the road never settles into a rhythm the eye can predict.
 */
const LONG = 150;
const SHORT = 75;

const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
};

/**
 * Give a stage its camber.
 *
 * Returns new control points; the input is not modified, because stage
 * definitions are module-level constants shared by every world that loads them
 * and a stage that grew a hill each time it was built would be a fine way to
 * spend an afternoon.
 */
/**
 * The height added at a distance along a stage. Handed to the spline so the
 * wave is applied at sample resolution rather than at the control points.
 */
export function terrainRise(
  seed: string,
  totalLength: number,
  options: TerrainOptions = {},
): (distance: number) => number {
  const amplitude = options.amplitude ?? 1.1;
  const phase = hash(seed) * Math.PI * 2;
  const phase2 = hash(`${seed}:2`) * Math.PI * 2;
  return (d: number) => {
    const wave =
      Math.sin((d / LONG) * Math.PI * 2 + phase) * 0.7 +
      Math.sin((d / SHORT) * Math.PI * 2 + phase2) * 0.3;
    // Level at both ends: the grid has to be flat, and a finish run-off that
    // tips downhill is a car rolling off the end of the world.
    // Smoothstepped rather than linear, or the taper itself becomes a slope
    // with a kink at each end of it.
    const t = Math.max(Math.min(1, d / TAPER, (totalLength - d) / TAPER), 0);
    return wave * amplitude * t * t * (3 - 2 * t);
  };
}

export function shapeCamber(
  points: readonly ControlPoint[],
  seed: string,
  options: TerrainOptions = {},
): ControlPoint[] {
  const maxCamber = options.camber ?? 0.055;
  const phaseC = hash(`${seed}:camber`) * Math.PI * 2;

  // Distance along the polyline. Close enough for this: the control points are
  // the coarse shape and the spline only smooths between them.
  const distances: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!.pos;
    const b = points[i]!.pos;
    distances.push(distances[i - 1]! + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const total = distances[distances.length - 1]!;

  return points.map((point, i) => {
    if (point.banking !== undefined) return point;
    const previous = points[Math.max(i - 1, 0)]!.pos;
    const next = points[Math.min(i + 1, points.length - 1)]!.pos;
    const inX = point.pos.x - previous.x;
    const inZ = point.pos.z - previous.z;
    const outX = next.x - point.pos.x;
    const outZ = next.z - point.pos.z;
    const inLen = Math.hypot(inX, inZ) || 1;
    const outLen = Math.hypot(outX, outZ) || 1;
    // Positive when the road turns right, which is also the sign that raises
    // the left-hand — outside — edge. Verified by measurement rather than by
    // reasoning: see `tests/terrain.test.ts`, and see CLAUDE.md for why nothing
    // about handedness in this project is settled any other way.
    const turn = (inX / inLen) * (outZ / outLen) - (inZ / inLen) * (outX / outLen);

    const d = distances[i]!;
    const mood = options.mood
      ? options.mood(d)
      : // −0.56 to 1, changing slowly enough that a corner has one character
        // rather than three.
        0.22 + 0.78 * Math.sin((d / 210) * Math.PI * 2 + phaseC);
    const banking = Math.max(-1, Math.min(1, turn * 2.2)) * maxCamber * mood;
    const ends = Math.max(Math.min(1, d / TAPER, (total - d) / TAPER), 0);
    return { ...point, banking: banking * ends };
  });
}
