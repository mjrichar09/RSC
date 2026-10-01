/**
 * Red Planet: a stage on Mars.
 *
 * The difference is gravity, and almost everything about the stage follows
 * from it. At 3.71 m/s² — 0.38 of Earth's — the car weighs a third of what it
 * did, and a tyre's grip is its load, so it corners at about sqrt(0.38) of the
 * speed and stops in more than twice the distance. The corners are wide
 * sweepers for that reason: a hairpin here would be a crawl.
 *
 * And a car leaves the ground wherever v² / R > g, which on Mars is almost
 * anywhere. One place is built to use that on purpose: a kicker at the end of
 * a long straight and a crater the road dives into under the car.
 *
 * ## The jump
 *
 * Measured, after calculating it went wrong three times. Off the 14° lip the
 * car arrives flat out at 143 km/h — that is what the run-up allows, and the
 * AI takes it flat too — and flies about 225 m over six seconds. The road
 * under it is built from that flight as recorded (`flight`, below), not from
 * a parabola: the car launches at its own angle rather than the lip's, and
 * bleeds speed to drag in the air, and a road drawn to the textbook arc had it
 * landing eighty metres early on a slope that was still curving away.
 *
 * Four things make it a landing rather than an impact, each found by the car
 * not surviving without it:
 *
 * - The heights here are exact (`terrainAmplitude: 0`). The seeded wave every
 *   other stage gets tilted the kicker enough to move the landing sixty metres
 *   the moment a corner upstream changed length.
 * - The clearance under the flight is a parabola (`gap`), so the road curves
 *   up into a car wherever it comes down. Closing at the flight's own angle
 *   matched the design landing and threw any slower car back into the air.
 * - The touchdown runs into a straight slope at the road's own angle, then a
 *   concave runout. A road that follows the flight curves away as fast as the
 *   car falls, nothing presses the car into it, and it bounced into a second
 *   190 m flight.
 * - The car's nose follows its path in the air (`airPitchAlign` in the
 *   tuning). It used to hold the lip's 14° nose-up for all seven seconds and
 *   land tail first on a road falling at 20°, for 41 000 N·s and a wheel off.
 *
 * Measured, with the throttle held back on the run-up to stand in for a
 * player who is not flat out: 106 km/h at the lip flies 58 m, 122 flies 102 m,
 * 143 flies 224 m with one 32 m rebound off the landing, and all three finish
 * with the front panel at 96%. Nothing is scattered on the road from the
 * run-up to 150 m past the runout (`faunaClear`): a rover the seed put under
 * the flight was hit by every car that came down short.

 * It has to be straight. A car in the air cannot follow a bend, so the whole
 * flight and the landing are one heading, and the run-up is straight too so
 * the AI arrives square to the lip.
 *
 * ## Authored as a driven path
 *
 * Walked, like Coldwater Pass: every leg starts pointing where the last one
 * ended, so there is no kink a car can stop dead against. Heights come from
 * one function of distance rather than per point, because the jump profile is
 * a curve and has to be sampled finely where it matters.
 */

import type { StageDef } from '../../sim/stage.js';
import type { ControlPoint } from '../../sim/spline.js';
import type { SurfaceId } from '../../sim/surfaces.js';

/** Mars surface gravity, m/s². */
export const MARS_GRAVITY = 3.71;

type Leg =
  | { straight: number; width: number; surface: SurfaceId }
  | { arc: number; radius: number; width: number; surface: SurfaceId };

/** Lay control points along a sequence of straights and arcs. */
function walk(legs: Leg[], height: (d: number) => number, step: (d: number) => number): ControlPoint[] {
  const points: ControlPoint[] = [];
  let x = 0;
  let z = 0;
  let heading = 0; // radians; 0 is +Z, positive turns toward +X
  let d = 0;
  const emit = (width: number, surface: SurfaceId) =>
    points.push({ pos: { x, y: height(d), z }, width, surface });

  emit(legs[0]!.width, legs[0]!.surface);
  for (const leg of legs) {
    const end = d + legLength(leg);
    while (d < end - 1e-6) {
      // Never a sliver at the end of a leg: a last step of 0.2 m put two
      // control points on top of each other and bunched the spline's samples.
      let ds = Math.min(step(d), end - d);
      if (end - d - ds < step(d) * 0.5) ds = end - d;
      if ('straight' in leg) {
        x += Math.sin(heading) * ds;
        z += Math.cos(heading) * ds;
      } else {
        // Along the chord of the arc, turning half the step's angle before and
        // half after, which keeps the walk on the circle.
        const turn = (ds / leg.radius) * Math.sign(leg.arc);
        heading += turn / 2;
        x += Math.sin(heading) * ds;
        z += Math.cos(heading) * ds;
        heading += turn / 2;
      }
      d += ds;
      emit(leg.width, leg.surface);
    }
  }
  return points;
}

const DEG = Math.PI / 180;

const LEGS: Leg[] = [
  // The start, with the launch pad off to the left.
  { straight: 160, width: 8.0, surface: 'dirt' },
  // Real corners, if slow ones: under 160 m of radius is what the co-driver
  // and the corner boards call. Drawn first as 260-320 m sweepers, the stage
  // had no corners at all, which is a stage the co-driver says nothing about.
  { arc: 50 * DEG, radius: 130, width: 7.6, surface: 'dirt' },
  { straight: 150, width: 7.4, surface: 'gravel' },
  { arc: -35 * DEG, radius: 120, width: 7.6, surface: 'dirt' },
  { straight: 60, width: 7.6, surface: 'dirt' },
  // Deliberately gentle: its exit speed is the lip speed, and the landing is
  // fitted to the flight that speed produces.
  { arc: -80 * DEG, radius: 260, width: 7.6, surface: 'dirt' },
  // The run-up, the lip, the flight and the landing: one straight.
  { straight: 960, width: 8.5, surface: 'dirt' },
  // The crater floor, and the swarm. A sweeper, not a corner: the car arrives
  // here at 120 km/h straight off the landing, and on Mars slowing for a
  // 140 m corner takes 180 m of braking the bounce off the landing does not
  // leave — drawn that way, the AI went into the wall.
  { arc: -70 * DEG, radius: 280, width: 7.8, surface: 'gravel' },
  { straight: 200, width: 7.6, surface: 'dirt' },
  { arc: 60 * DEG, radius: 120, width: 7.6, surface: 'dirt' },
  { straight: 140, width: 7.6, surface: 'dirt' },
  { arc: -40 * DEG, radius: 130, width: 7.6, surface: 'dirt' },
  // Long and level to the line, and past it.
  { straight: 240, width: 8.0, surface: 'dirt' },
];

const legLength = (leg: Leg) => ('straight' in leg ? leg.straight : Math.abs(leg.arc) * leg.radius);
/** The straight the jump is on. */
const JUMP_LEG = 6;
/** How far down the jump straight the lip is: the run-up. */
const RUN_UP = 420;
/** Where the lip is, metres along the walk. */
export const LIP = LEGS.slice(0, JUMP_LEG).reduce((sum, leg) => sum + legLength(leg), 0) + RUN_UP;
/** How far from the lip the intended flight touches down. */
const LANDING = 240;
/**
 * A straight landing slope past the touchdown, for a car that arrives a little
 * faster or carries a little more.
 *
 * Straight, not the flight's own curve. A road that follows a falling car's
 * path curves away exactly as fast as the car falls, so nothing presses the
 * car into it: the first landing on that version touched, rebounded off its
 * springs, and flew another 190 m to a landing at 26 m/s. A straight slope is
 * what a ski jump lands on, for the same reason.
 */
const HOLD = 50;
/**
 * How far below the fitted flight the landing slope is laid, metres. The fit is
 * not perfect, and a car meeting the road early lands on the curved part —
 * which throws it again. A little below, it meets the straight just past the
 * touchdown instead, about 2.5 m/s across the slope.
 */
const MARGIN = 0.8;
/** Runout from the landing slope to level ground. */
const RUNOUT = 200;
/** Height of the car's centre above the road at rest, metres. */
const RIDE = 1.0;

/**
 * The flight off the lip, measured: the AI's car flat out at 143 km/h, its
 * centre's height above the lip against distance past it, sampled every ten
 * metres and fitted with a cubic (worst residual 0.07 m), iterated until the
 * touchdown stopped moving. Re-measure and refit
 * whenever the kicker, the run-up or the car changes: the road under the
 * flight is only right for the flight it was fitted to.
 *
 * Measured rather than calculated because the calculation was wrong twice:
 * a parabola from the lip's drawn angle and the speed put the touchdown 80 m
 * from where the car came down. The cubic term is the drag.
 */
const flight = (x: number) => 1.2952 + 0.211272 * x - 0.00122308 * x * x - 5.5341e-07 * x * x * x;
const flightSlope = (x: number) => 0.211272 - 2 * 0.00122308 * x - 3 * 5.5341e-07 * x * x;
/** Clearance under the intended flight at its widest, metres. */
const CLEARANCE = 6;
/** Height of the plateau the run-up crosses, and of the kicker above it. */
const PLATEAU = 15;
const KICKER = 5;

const smooth = (t: number) => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

/**
 * How far the road sits below the flight, metres past the lip.
 *
 * A parabola, so the road under the flight curves *up* relative to it
 * everywhere: wherever a car comes down — early because it was slower, or at
 * the touchdown — the road presses into it rather than curving away from it.
 *
 * Two shapes were tried first and both threw the car back into the air. A
 * clearance that closes with zero slope at the touchdown matches the landing
 * angle perfectly but has to curve away faster than the flight just before it,
 * so a car three km/h slow came down there and bounced into a second 200 m
 * flight. This one leaves the design-speed car meeting the road a little
 * flatter than its path (about 3.6 m/s across the slope), which a landing
 * absorbs, and is right for every slower car too.
 */
const gap = (x: number) => (CLEARANCE * 4 * x * (LANDING - x)) / LANDING ** 2;

/** Road height at a distance along the walk. */
function height(d: number): number {
  // A long gentle climb onto the plateau the jump is launched from.
  if (d < LIP - 40) return PLATEAU * smooth((d - 300) / 700);
  // The kicker: a parabola, 0.25 (14°) at the lip.
  if (d < LIP) {
    const t = (d - (LIP - 40)) / 40;
    return PLATEAU + KICKER * t * t;
  }
  const top = PLATEAU + KICKER;
  const x = d - LIP;
  if (x <= LANDING) return top + flight(x) - RIDE - MARGIN - gap(x);
  // The landing slope, held straight from the touchdown at the *road's* own
  // slope there — which, with the parabolic clearance, is a little flatter
  // than the flight's. Continued at the flight's slope instead it was a 0.1
  // kink, and a car that had landed early and was rolling down to it at
  // 106 km/h was launched off it into a landing that retired it.
  const slope = flightSlope(LANDING) + (4 * CLEARANCE) / LANDING;
  const touchdown = top + flight(LANDING) - RIDE - MARGIN;
  if (x <= LANDING + HOLD) return touchdown + slope * (x - LANDING);
  // Eased level from there.
  const end = LANDING + HOLD;
  const r = Math.min(x - end, RUNOUT);
  const runout = touchdown + slope * HOLD + slope * r - (slope / (2 * RUNOUT)) * r * r;
  // And a slow rise out of the crater toward the finish.
  const floor = x - end - RUNOUT;
  return runout + (floor > 0 ? 4 * smooth((floor - 600) / 500) : 0);
}

/** Fine steps over the kicker and the flight; coarse ones elsewhere. */
const step = (d: number) => (d > LIP - 60 && d < LIP + LANDING + HOLD + RUNOUT ? 8 : 22);

export const redPlanet: StageDef = {
  id: 'red-planet',
  name: 'Red Planet',
  biome: 'mars',
  verge: 'gravel',
  bank: 'dirt',
  gravity: MARS_GRAVITY,
  // The heights here are exact, and the jump is fitted to them.
  terrainAmplitude: 0,
  fauna: 'rover',
  // Nothing on the run-up, under the flight, on the landing, or in the next
  // 150 m, where the car is still settling off the bounce at 120 km/h.
  faunaClear: [[LIP - 150, LIP + LANDING + HOLD + RUNOUT + 150]],
  hazards: { kinds: ['rock'], spacing: 22 },
  // Level with the grid and just past the reach of a car that leaves the road
  // there (38.7 m, which `Stage` checks), so that the start camera, pulled
  // back, has it at the side of the frame from the line. Seventy metres up the
  // road it was above the top of the frame until it had already gone.
  launch: { at: 20, side: -1, offset: 40 },
  entryFee: 1500,
  payouts: { author: 28000, gold: 17500, silver: 9800, bronze: 5400, finish: 3100 },
  requiresMedals: 12,
  checkpoints: 3,
  // Calibrated against a measured AI lap of 144.6 s, at the ratios every other
  // stage uses: author is the lap x1.026, gold author x1.10, silver x1.38,
  // bronze x1.81. Re-measure if the jump, the gravity or the car changes.
  medals: { author: 148, gold: 163, silver: 204, bronze: 268 },
  flocks: [{ kind: 'alien', at: LIP + LANDING + HOLD + RUNOUT + 170, count: 14, spread: 120 }],
  warnings: [],
  variants: [
    // Instead of rain and snow, the one weather Mars has.
    {
      id: 'dust-storm',
      conditions: { timeOfDay: 'day', weather: 'dust' },
      // Measured: `npm run stages` puts it at 1.11 — the dust film costs
      // little grip on loose ground, and most of it is visibility.
      timeScale: 1.11,
      rewardScale: 1.6,
      requiresMedals: 14,
    },
  ],
  cameraZones: [
    // Wide at the start, so the rocket is in the picture.
    { from: 0, yaw: 0, zoom: 28 },
    { from: 220, yaw: 0, zoom: 16 },
    // Pulled right back for the jump: the flight is over two hundred metres
    // and the point is to see it.
    { from: LIP - 160, yaw: 0, zoom: 24 },
    { from: LIP + LANDING + HOLD + RUNOUT + 40, yaw: 0, zoom: 16 },
  ],
  controlPoints: walk(LEGS, height, step),
};
