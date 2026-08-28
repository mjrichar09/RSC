/**
 * Corners, found in the road rather than authored.
 *
 * A stage is a centreline, so where its corners are and how tight they are is
 * already implied by its curvature — nobody should have to write pacenotes by
 * hand, and a note written by hand would go stale the moment a control point
 * moved. This walks the spline and reports what a co-driver would read out.
 *
 * Pure, and headless: the roadside signs, the HUD notes and the map all read
 * the same list, so a sign can never disagree with what the HUD says.
 */

import type { Spline } from './spline.js';

export type CornerDirection = 'left' | 'right';

export interface Corner {
  /** Where the road starts bending, metres along the stage. */
  entry: number;
  /** The tightest point. */
  apex: number;
  /** Where it straightens out again. */
  exit: number;
  direction: CornerDirection;
  /** Tightest radius through the corner, metres. */
  radius: number;
  /**
   * 1 to 6, the rally pacenote scale: 1 is a hairpin you brake to walking pace
   * for and 6 is a kink you take flat. Deliberately the same direction as a
   * real note — a driver who knows the convention already knows this one.
   */
  severity: number;
  /** Total heading change through the corner, degrees. Always positive. */
  turnDegrees: number;
  /** Metres of road until the next corner, or null if this is the last. */
  toNext: number | null;
}

/**
 * Radius thresholds for each severity, metres, tightest first.
 *
 * Calibrated against the stages this game actually has rather than against real
 * roads: a corridor here is about 11 m wide and its hairpins come in at 12–15 m
 * radius, so a scale built for a 6 m forest road would report every corner as a
 * hairpin and tell the player nothing.
 */
const SEVERITY_RADIUS = [14, 22, 34, 52, 80, 125];

/** Below this curvature the road is straight enough not to be worth a note. */
const STRAIGHT = 1 / 160;
/** A corner has to bend by at least this much to be one, degrees. */
const MIN_TURN = 12;
/** Two corners closer than this are linked, and the note says so. */
export const LINK_DISTANCE = 45;

/** Severity for a radius: 1 is a hairpin, 6 is flat. */
export function severityFor(radius: number): number {
  for (let i = 0; i < SEVERITY_RADIUS.length; i++) {
    if (radius < SEVERITY_RADIUS[i]!) return i + 1;
  }
  return 6;
}

/**
 * Every corner on a stage, in order.
 *
 * Built around **apexes**, not around runs of bending road. The obvious version
 * — start a corner when the curvature rises, end it when it falls — merges
 * everything that bends the same way into one note: it reported half of North
 * Pass as a single "Right 5" 416 m long, and the whole middle of Pine Loop as
 * one 348 m corner. A co-driver calls a sequence as a sequence.
 *
 * So: find the local peaks of curvature, keep the ones that stand out from the
 * road either side of them, and grow each one outward until the road relaxes to
 * a fraction of the apex or changes hands.
 */
export function findCorners(spline: Spline, length: number): Corner[] {
  const STEP = 2;
  const n = Math.max(Math.floor(length / STEP), 1);
  const k: number[] = [];
  for (let i = 0; i <= n; i++) k.push(spline.at(i * STEP).curvature);

  /** The corner ends where the bend has relaxed to this share of its apex. */
  const RELAX = 0.62;
  /** Only one note per this many metres of road. */
  const SEPARATION = 45;
  /** No note covers more than this either side of its apex. */
  const REACH = 70;

  // Every local maximum of curvature, tightest first. Taking them in order of
  // tightness and suppressing their neighbours is what stops a radius that
  // wanders inside a long curve from being called every twenty metres — and it
  // keeps the *tightest* point of a stretch rather than whichever came first.
  const peaks: number[] = [];
  for (let i = 1; i < n; i++) {
    const here = Math.abs(k[i]!);
    if (here < STRAIGHT) continue;
    if (here >= Math.abs(k[i - 1]!) && here > Math.abs(k[i + 1]!)) peaks.push(i);
  }
  peaks.sort((a, b) => Math.abs(k[b]!) - Math.abs(k[a]!));

  const chosen: number[] = [];
  for (const peak of peaks) {
    if (chosen.some((other) => Math.abs(other - peak) * STEP < SEPARATION)) continue;
    chosen.push(peak);
  }
  chosen.sort((a, b) => a - b);

  const corners: Corner[] = [];
  for (let c = 0; c < chosen.length; c++) {
    const i = chosen[c]!;
    const here = Math.abs(k[i]!);
    const sign = Math.sign(k[i]!);
    const floor = Math.max(STRAIGHT, here * RELAX);
    const limit = Math.round(REACH / STEP);

    let a = i;
    while (a > 0 && i - a < limit && Math.sign(k[a - 1]!) === sign && Math.abs(k[a - 1]!) >= floor) a--;
    let b = i;
    while (b < n && b - i < limit && Math.sign(k[b + 1]!) === sign && Math.abs(k[b + 1]!) >= floor) b++;

    // Never overlap the neighbouring notes: two corners that share road are two
    // descriptions of the same tarmac, and the second one always loses.
    const previous = corners[corners.length - 1];
    const entry = Math.max(a * STEP, previous ? previous.exit : 0);
    const next = chosen[c + 1];
    const exit = Math.min(b * STEP, next !== undefined ? next * STEP : length);
    if (exit <= entry) continue;

    let turn = 0;
    for (let j = Math.round(entry / STEP); j <= Math.round(exit / STEP); j++) turn += (k[j] ?? 0) * STEP;
    const degrees = (Math.abs(turn) * 180) / Math.PI;
    if (degrees < MIN_TURN) continue;

    corners.push({
      entry,
      apex: i * STEP,
      exit,
      direction: sign > 0 ? 'right' : 'left',
      radius: 1 / here,
      severity: severityFor(1 / here),
      turnDegrees: degrees,
      toNext: null,
    });
  }

  for (let i = 0; i < corners.length - 1; i++) {
    corners[i]!.toNext = Math.max(corners[i + 1]!.entry - corners[i]!.exit, 0);
  }
  return corners;
}

/** A corner the car has not reached yet, and how far away it is. */
export interface UpcomingCorner {
  corner: Corner;
  /** Metres from the car to the turn-in point. */
  distance: number;
}

/**
 * The next `count` corners from a point on the stage.
 *
 * A corner counts as upcoming until the car is past its apex — the note has to
 * stay on screen through the entry, which is when it is being used.
 */
export function cornersAhead(
  corners: readonly Corner[],
  distance: number,
  count = 2,
): UpcomingCorner[] {
  const out: UpcomingCorner[] = [];
  for (const corner of corners) {
    if (corner.apex < distance) continue;
    out.push({ corner, distance: corner.entry - distance });
    if (out.length >= count) break;
  }
  return out;
}

/** "Right 3", "Left 1 hairpin", "Right 5 into left 4" — a co-driver's line. */
export function describeCorner(corner: Corner): string {
  const name = corner.direction === 'left' ? 'Left' : 'Right';
  if (corner.severity === 1) return `${name} 1 hairpin`;
  return `${name} ${corner.severity}`;
}
