/**
 * Sparkle Speedway: a toy track on a playroom floor, with a loop-the-loop.
 *
 * The whole stage is plastic track pieces in glitter colours — the surface is
 * tarmac to a tyre, and the look is the renderer's (`biome: 'toy'`). There is
 * one set of conditions, clear daylight, and no variants: a playroom does not
 * get night stages or snow.
 *
 * The floor is flat (`terrainAmplitude: 0`) because the loop needs it: its
 * exit has to land on the road to the centimetre, and the seeded wave every
 * other stage gets would put the exit lane above or below it.
 *
 * ## The loop
 *
 * Built by `sim/loop.ts`, off the road where it leaves. The road keeps going
 * underneath: a straight approach through the booster, then a sideways jog of
 * `SHIFT` metres along the ground under the loop, timed so that it arrives in
 * the exit lane exactly where the loop puts the car down. The `Stage` checks
 * all of that on construction and refuses a loop that does not meet its road.
 *
 * Banked turns either side, because a toy track has them and nothing else in
 * the game does.
 */

import type { StageDef } from '../../sim/stage.js';
import type { ControlPoint } from '../../sim/spline.js';
import type { SurfaceId } from '../../sim/surfaces.js';
import { LOOP_RUN_IN, loopAdvance } from '../../sim/loop.js';

/** Path length of the loop from leaving the road to rejoining it, metres. */
const LOOP_LENGTH = 130;
/** How far the loop's exit lands from its entry, metres along the road. */
const ADVANCE = loopAdvance(LOOP_LENGTH);
/**
 * How far across the exit lane is from the entry, metres; negative is right.
 * The two lanes pass beside each other in side view where they cross low down,
 * so this is a deck and a rail each side plus room between them.
 */
const SHIFT = -8.6;
/** Half-width of the track on and around the loop, metres. */
const LOOP_WIDTH = 3.6;
/** The booster: its length, and the speed it sets for the loop, m/s. */
const BOOST = { length: 60, speed: 30 };
/** Straight track before the booster, metres: what `Stage` asks for, and a little. */
const APPROACH = 60;

type Leg =
  | { straight: number; width: number }
  | { arc: number; radius: number; width: number; bank?: number }
  | { jog: number; shift: number; width: number };

const SURFACE: SurfaceId = 'tarmac';
const DEG = Math.PI / 180;

const smooth = (t: number) => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

const legLength = (leg: Leg) =>
  'straight' in leg ? leg.straight : 'arc' in leg ? Math.abs(leg.arc) * leg.radius : leg.jog;

/**
 * Lay control points along straights, arcs and jogs, as Red Planet and
 * Coldwater Pass do: every leg starts pointing where the last one ended.
 *
 * A jog is the one new thing — a sideways move at an unchanged heading,
 * eased in and out — and it exists for the road under the loop. Banking on an
 * arc is eased in over its first and last fifteen metres, so a banked turn
 * rolls into its camber rather than stepping onto it.
 */
function walk(legs: Leg[]): ControlPoint[] {
  const points: ControlPoint[] = [];
  let x = 0;
  let z = 0;
  let heading = 0; // radians; 0 is +Z, positive turns toward +X, which is left
  const emit = (width: number, banking: number, px = x, pz = z) =>
    points.push({ pos: { x: px, y: 0, z: pz }, width, surface: SURFACE, banking });

  emit(legs[0]!.width, 0);
  for (const leg of legs) {
    const length = legLength(leg);
    if ('jog' in leg) {
      // Fine steps: the spline has to follow this to the centimetre, because
      // the loop's exit is checked against it.
      const n = Math.round(length / 2);
      const leftX = Math.cos(heading);
      const leftZ = -Math.sin(heading);
      const fromX = x;
      const fromZ = z;
      for (let i = 1; i <= n; i++) {
        const along = (i / n) * length;
        const across = leg.shift * smooth(i / n);
        emit(leg.width, 0, fromX + Math.sin(heading) * along + leftX * across, fromZ + Math.cos(heading) * along + leftZ * across);
      }
      x = fromX + Math.sin(heading) * length + leftX * leg.shift;
      z = fromZ + Math.cos(heading) * length + leftZ * leg.shift;
      continue;
    }
    // Straights at 4 m into and out of the loop, so the spline is straight
    // to within a centimetre right up to the run-in; coarser elsewhere.
    const step = 'straight' in leg ? 4 : Math.min(12, leg.radius * 0.25);
    let d = 0;
    while (d < length - 1e-6) {
      let ds = Math.min(step, length - d);
      if (length - d - ds < step * 0.5) ds = length - d;
      let banking = 0;
      if ('straight' in leg) {
        x += Math.sin(heading) * ds;
        z += Math.cos(heading) * ds;
      } else {
        const turn = (ds / leg.radius) * Math.sign(leg.arc);
        heading += turn / 2;
        x += Math.sin(heading) * ds;
        z += Math.cos(heading) * ds;
        heading += turn / 2;
        const edge = Math.min(d + ds, length - d - ds);
        banking = (leg.bank ?? 0) * Math.sign(leg.arc) * smooth(edge / 15);
      }
      d += ds;
      emit(leg.width, banking);
    }
  }
  return points;
}

const LEGS: Leg[] = [
  // 0: off the line, and a sweeping left.
  { straight: 110, width: 4.2 },
  { arc: 70 * DEG, radius: 85, width: 4.2 },
  { straight: 90, width: 4.0 },
  // 3: a hard right, banked.
  { arc: -120 * DEG, radius: 48, width: 4.4, bank: 0.2 },
  { straight: 110, width: 4.0 },
  // 5: the big banked hairpin, the way a toy track turns round.
  { arc: 170 * DEG, radius: 38, width: 4.6, bank: 0.28 },
  { straight: 130, width: 4.0 },
  // 7: into the loop's line.
  { arc: -60 * DEG, radius: 70, width: 4.0 },
  // 8: the approach, the booster and the run-in, all on one heading.
  { straight: 40, width: 4.0 },
  { straight: APPROACH + BOOST.length + LOOP_RUN_IN, width: LOOP_WIDTH },
  // 10: the road under the loop, over to the exit lane.
  { jog: ADVANCE, shift: SHIFT, width: LOOP_WIDTH },
  // 11: away from the loop, straight — a car still settling from the
  // landing should not be turning.
  { straight: 160 + LOOP_RUN_IN, width: LOOP_WIDTH },
  { straight: 40, width: 4.0 },
  // 13: a banked left, a right, and the run to the line.
  { arc: 130 * DEG, radius: 55, width: 4.4, bank: 0.22 },
  { straight: 100, width: 4.0 },
  { arc: -55 * DEG, radius: 95, width: 4.2 },
  { straight: 150, width: 4.2 },
];

/** Where a leg starts, metres along the walk. */
const legStart = (index: number) => LEGS.slice(0, index).reduce((sum, leg) => sum + legLength(leg), 0);

/** Where the car leaves the road into the loop. */
export const LOOP_AT = legStart(10);

export const sparkleSpeedway: StageDef = {
  id: 'sparkle-speedway',
  name: 'Sparkle Speedway',
  biome: 'toy',
  verge: 'tarmac',
  bank: 'tarmac',
  terrainAmplitude: 0,
  spills: false,
  // Nothing lives on a playroom floor that should be in the road.
  faunaClear: [[0, 1e6]],
  entryFee: 450,
  requiresMedals: 6,
  payouts: { author: 8400, gold: 5200, silver: 2900, bronze: 1650, finish: 950 },
  checkpoints: 3,
  // Calibrated against a measured AI lap of 78.8 s, at the ratios every other
  // stage uses: author is the lap x1.026, gold author x1.10, silver x1.38,
  // bronze x1.81. Re-measure if the loop, the booster or the car changes.
  medals: { author: 81, gold: 89, silver: 112, bronze: 147 },
  loop: {
    at: LOOP_AT,
    length: LOOP_LENGTH,
    shift: SHIFT,
    width: LOOP_WIDTH,
    surface: SURFACE,
    boost: BOOST,
  },
  cameraZones: [
    { from: 0, zoom: 14 },
    // Pulled right back for the loop: it stands taller than the frame.
    { from: LOOP_AT - BOOST.length - 40, zoom: 24 },
    { from: LOOP_AT + ADVANCE + 60, zoom: 14 },
  ],
  controlPoints: walk(LEGS),
};
