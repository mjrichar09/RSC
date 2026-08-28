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

import type { ControlPoint } from './spline.js';

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
