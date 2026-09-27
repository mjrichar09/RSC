/**
 * The co-driver's notes: what to say about the road ahead, and when.
 *
 * The HUD has shown the next two corners since the corners existed, and
 * reading them means taking your eyes off the car at exactly the moment the
 * car needs them. A rally co-driver exists to solve that, so this turns the
 * stage's corners into the calls a co-driver makes — "left four", "hairpin
 * right", "right three long into left two, don't cut", "one fifty" — and
 * decides when each is due. Speaking them is `audio/codriver.ts`; this file is
 * pure so the wording and the timing can be tested without a browser.
 *
 * Notes follow the real convention the corner severity already uses: 1 is a
 * hairpin, 6 is nearly flat.
 */

import type { Corner } from '../sim/corners.js';
import type { WetPatch } from '../sim/stage.js';

export interface PaceCall {
  /** Metres along the stage where the call is about: the first corner's turn-in. */
  at: number;
  text: string;
}

/** Corners closer together than this, exit to entry, are called as one. */
const INTO = 45;
/** A gap this long to the next corner is worth a distance call. */
const DISTANCE_CALL = 100;

const WORD = ['', 'one', 'two', 'three', 'four', 'five', 'six'] as const;

/** One corner, as said aloud. */
function say(corner: Corner, cut: boolean, water: boolean): string {
  const side = corner.direction;
  let text = corner.severity <= 1 ? `hairpin ${side}` : `${side} ${WORD[corner.severity] ?? 'six'}`;
  // A long corner: more than a right angle at anything above a hairpin.
  if (corner.severity > 1 && corner.turnDegrees > 100) text += ' long';
  if (water) text += ', water';
  if (cut) text += ", don't cut";
  return text;
}

/** A distance to the next note, rounded the way a co-driver rounds it. */
export function sayDistance(metres: number): string | null {
  if (metres < DISTANCE_CALL) return null;
  const rounded = Math.min(Math.round(metres / 50) * 50, 500);
  const hundreds = Math.floor(rounded / 100);
  const fifty = rounded % 100 === 50;
  const lead = WORD[hundreds] ?? 'five';
  if (hundreds === 0) return 'fifty';
  return fifty ? `${lead} fifty` : `${lead} hundred`;
}

/**
 * Every call for a stage, in order.
 *
 * `spills` and `water` are the stage's own patches: a spill on the inside of a
 * corner is "don't cut", which is precisely the advice, and water in a corner
 * is worth a word before you are in it.
 */
export function buildPacenotes(
  corners: readonly Corner[],
  hazards: { water?: readonly WetPatch[]; spills?: readonly WetPatch[] } = {},
): PaceCall[] {
  const overlaps = (patches: readonly WetPatch[] | undefined, c: Corner) =>
    (patches ?? []).some((p) => p.to >= c.entry - 10 && p.from <= c.exit + 10);
  const calls: PaceCall[] = [];
  let i = 0;
  while (i < corners.length) {
    const first = corners[i]!;
    let text = say(first, overlaps(hazards.spills, first), overlaps(hazards.water, first));
    let last = first;
    // Chain what follows closely: "left four into right two".
    while (i + 1 < corners.length && corners[i + 1]!.entry - last.exit < INTO) {
      i++;
      last = corners[i]!;
      text += ` into ${say(last, overlaps(hazards.spills, last), overlaps(hazards.water, last))}`;
    }
    const next = corners[i + 1];
    const gap = next ? sayDistance(next.entry - last.exit) : null;
    if (gap) text += `, ${gap}`;
    calls.push({ at: first.entry, text });
    i++;
  }
  return calls;
}

/**
 * Which call is due now, if any.
 *
 * A call is made when the car is `lead` seconds from the turn-in at its
 * current speed, and never closer than 35 m — a note has to finish before the
 * braking starts, and at walking pace a four-second lead would be a call made
 * on top of the corner. `next` is the index of the first call not yet made.
 */
export function dueCall(
  calls: readonly PaceCall[],
  next: number,
  furthest: number,
  speed: number,
  lead = 4,
): number | null {
  const call = calls[next];
  if (!call) return null;
  const reach = Math.max(Math.abs(speed) * lead, 35);
  return call.at - furthest <= reach ? next : null;
}
