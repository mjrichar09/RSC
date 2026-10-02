/**
 * Red Planet: a stage on Mars.
 *
 * The difference is gravity, in the air. At 3.71 m/s² — 0.38 of Earth's — a
 * car off a crest flies two and a half times as long. On the ground it is
 * given its Earth weight (`groundGravity`): with only Mars's, a tyre's grip is
 * a third of what it was, and the car spun its wheels down every straight and
 * cornered as if on ice; given the grip back without the weight, it went round
 * the first hairpin on two wheels.
 *
 * The stage is a story in that air. An S and a boulder chicane on the plain,
 * a switchback climb up a mesa, three moon-hops across the top — two-metre
 * bumps that are jumps here — and then the mesa's edge, a kicker, and a crater
 * the road dives into under the car. The swarm is on the crater floor, a
 * rockfall on the way out, and craters in the plain on every side.
 *
 * ## The jump
 *
 * Measured, after calculating it went wrong three times. Off the 14° lip the
 * car arrives flat out at 150 km/h — that is what the run-up allows, and the
 * AI takes it flat too — and flies about 216 m over six seconds. The road
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
 * player who is not flat out: 104 km/h at the lip flies 52 m, 121 flies 88 m,
 * 139 flies 154 m, and flat out (150) flies 216 m in 5.7 s — every one a soft
 * landing, and no rebound, because the car has its Earth weight the moment a
 * wheel is down. Nothing is scattered on the road from the
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
      // On an arc, never more than a quarter of its radius at a time: a 22 m
      // step round a 30 m hairpin is 43° per control point, and the spline cut
      // the corner so badly that the AI went off the side of the mesa there.
      const here = 'arc' in leg ? Math.min(step(d), leg.radius * 0.25) : step(d);
      let ds = Math.min(here, end - d);
      if (end - d - ds < here * 0.5) ds = end - d;
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
  // 0: the start, with the launch pad off to the left.
  { straight: 160, width: 8.0, surface: 'dirt' },
  // 1-3: an S off the line, and into the boulder field.
  { arc: 60 * DEG, radius: 90, width: 7.4, surface: 'dirt' },
  { straight: 70, width: 7.2, surface: 'gravel' },
  { arc: -95 * DEG, radius: 55, width: 7.0, surface: 'gravel' },
  // 4: the boulder chicane — rocks left and right on the road.
  { straight: 140, width: 7.6, surface: 'dirt' },
  { arc: 40 * DEG, radius: 150, width: 7.4, surface: 'dirt' },
  // 6-10: up the face of the mesa, two hairpins in it.
  { straight: 160, width: 7.0, surface: 'dirt' },
  { arc: 170 * DEG, radius: 45, width: 7.6, surface: 'gravel' },
  { straight: 140, width: 7.0, surface: 'dirt' },
  { arc: -170 * DEG, radius: 45, width: 7.6, surface: 'gravel' },
  { straight: 120, width: 7.2, surface: 'dirt' },
  // 11-13: across the top, with three moon-hops on the straight.
  { arc: 70 * DEG, radius: 200, width: 7.6, surface: 'dirt' },
  { straight: 200, width: 7.8, surface: 'dirt' },
  // Deliberately gentle enough to be the speed the run-up starts from: the
  // landing is fitted to the flight it produces.
  { arc: -60 * DEG, radius: 120, width: 7.6, surface: 'dirt' },
  // 14: the run-up to the mesa's edge, the lip, the flight and the landing.
  { straight: 1040, width: 8.5, surface: 'dirt' },
  // 15: the crater floor, and the swarm. A sweeper, not a corner: the car
  // arrives at speed straight off the landing.
  { arc: -70 * DEG, radius: 280, width: 7.8, surface: 'gravel' },
  { straight: 140, width: 7.6, surface: 'dirt' },
  { arc: 80 * DEG, radius: 110, width: 7.6, surface: 'dirt' },
  // 18: the rockfall, on one side or the other — the side is rolled per run.
  { straight: 200, width: 7.6, surface: 'gravel' },
  { arc: -50 * DEG, radius: 130, width: 7.6, surface: 'dirt' },
  // Long and level to the line, and past it.
  { straight: 220, width: 8.0, surface: 'dirt' },
];

const legLength = (leg: Leg) => ('straight' in leg ? leg.straight : Math.abs(leg.arc) * leg.radius);
/** Where a leg starts, metres along the walk. */
const legStart = (index: number) => LEGS.slice(0, index).reduce((sum, leg) => sum + legLength(leg), 0);

/** The chicane, the climb, the hops, the jump and the rockfall, by leg. */
const CHICANE = legStart(4);
const CLIMB_FROM = legStart(6);
const CLIMB_TO = legStart(11);
const HOPS = legStart(12);
const JUMP_LEG = 14;
const ROCKFALL = legStart(18);
/** How far down the jump straight the lip is: the run-up. */
const RUN_UP = 420;
/** Where the lip is, metres along the walk. */
export const LIP = legStart(JUMP_LEG) + RUN_UP;
/** Height of the mesa the climb reaches and the jump leaves from, metres. */
const MESA = 40;

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
 * The flight off the lip, measured: the AI's car flat out at 150 km/h, its
 * centre's height above the lip against distance past it, sampled every ten
 * metres and fitted with a cubic (worst residual 0.17 m), iterated until the
 * touchdown stopped moving. Re-measure and refit
 * whenever the kicker, the run-up or the car changes: the road under the
 * flight is only right for the flight it was fitted to.
 *
 * Measured rather than calculated because the calculation was wrong twice:
 * a parabola from the lip's drawn angle and the speed put the touchdown 80 m
 * from where the car came down. The cubic term is the drag.
 */
const flight = (x: number) => 0.9065 + 0.195794 * x - 0.00101104 * x * x - 7.5140e-07 * x * x * x;
const flightSlope = (x: number) => 0.195794 - 2 * 0.00101104 * x - 3 * 7.5140e-07 * x * x;
/** Clearance under the intended flight at its widest, metres. */
const CLEARANCE = 6;
/** Height of the kicker above the mesa, metres. */
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

/**
 * How much of the climb is done by `d`: distance along the climb's straights,
 * with a hairpin counting a tenth of its length. Fed through `smooth`, so the
 * grade eases in and out at the ends.
 */
function climbed(d: number): number {
  let total = 0;
  let at = CLIMB_FROM;
  for (let i = 6; i < 11; i++) {
    const length = legLength(LEGS[i]!);
    const weight = 'arc' in LEGS[i]! ? 0.1 : 1;
    total += Math.min(Math.max(d - at, 0), length) * weight;
    at += length;
  }
  return total;
}

/** Road height at a distance along the walk. */
function height(d: number): number {
  // Flat off the line and through the boulders.
  if (d < CLIMB_FROM) return 0;
  // Up the mesa on the straights, with the hairpins nearly level between
  // them — the way Coldwater's stack is built. Climbing through them, the
  // second hairpin sat on 10% of grade with the drop on the outside, and the
  // AI went off the side of the mesa there every run.
  if (d < CLIMB_TO) return MESA * smooth(climbed(d) / climbed(CLIMB_TO));
  if (d < LIP - 40) {
    // Three moon-hops across the top. A crest launches a car wherever
    // v² / R > g, and at Mars gravity a bump under two metres is a jump.
    let hop = 0;
    for (let k = 0; k < 3; k++) hop += 1.8 * Math.exp(-(((d - (HOPS + 45 + 50 * k)) / 9) ** 2));
    return MESA + hop;
  }
  // The kicker: a parabola, 0.25 (14°) at the lip.
  if (d < LIP) {
    const t = (d - (LIP - 40)) / 40;
    return MESA + KICKER * t * t;
  }
  const top = MESA + KICKER;
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
  // Earth weight while a wheel is down: on the ground this is the car you
  // know, and only the air is Mars. See `StageDef.groundGravity`.
  groundGravity: 9.81,
  // Impact craters in the plain on every side, out of reach of the road.
  craters: { count: 80, radius: [12, 70] },
  // The heights here are exact, and the jump is fitted to them.
  terrainAmplitude: 0,
  fauna: 'rover',
  // No rovers anywhere on the mesa, from the foot of the climb to 150 m past
  // the landing: struck in a hairpin one knocked the car off the side, struck
  // between the hops one cost the jump, and one under the flight was hit by
  // every car that came down short. They live on the plain and the crater floor.
  faunaClear: [[CLIMB_FROM - 20, LIP + LANDING + HOLD + RUNOUT + 150]],
  hazards: { kinds: ['rock'], spacing: 22 },
  // Level with the grid and just past the reach of a car that leaves the road
  // there (38.7 m, which `Stage` checks), so that the start camera, pulled
  // back, has it at the side of the frame from the line. Seventy metres up the
  // road it was above the top of the frame until it had already gone.
  launch: { at: 20, side: -1, offset: 40 },
  entryFee: 1500,
  payouts: { author: 28000, gold: 17500, silver: 9800, bronze: 5400, finish: 3100 },
  requiresMedals: 12,
  checkpoints: 4,
  // Calibrated against a measured AI lap of 148.7 s, at the ratios every other
  // stage uses: author is the lap x1.026, gold author x1.10, silver x1.38,
  // bronze x1.81. Re-measure if the jump, the gravity or the car changes.
  medals: { author: 153, gold: 168, silver: 211, bronze: 277 },
  flocks: [{ kind: 'alien', at: LIP + LANDING + HOLD + RUNOUT + 170, count: 14, spread: 120 }],
  /*
   * The boulder chicane: rocks on the road, left, right, left, each well clear
   * of the centreline so there is always a line through — the question is
   * whether you are on it at speed out of the S before it.
   */
  obstacles: [
    { kind: 'rock', distance: CHICANE + 30, across: -0.6, size: 1.3 },
    { kind: 'rock', distance: CHICANE + 62, across: 0.6, size: 1.2 },
    { kind: 'rock', distance: CHICANE + 96, across: -0.58, size: 1.4 },
  ],
  // A rockfall across one side of the crater's exit road, rolled per run.
  slide: { from: ROCKFALL + 50, length: 80, reach: 0.75, count: 16 },
  warnings: [
    { at: CHICANE - 40, kind: 'chicane' },
    { at: ROCKFALL - 30, kind: 'slide' },
  ],
  variants: [
    // Instead of rain and snow, the one weather Mars has.
    {
      id: 'dust-storm',
      conditions: { timeOfDay: 'day', weather: 'dust' },
      // Measured: `npm run stages` puts it at 1.16 — the dust film costs a
      // little grip, and most of it is visibility.
      timeScale: 1.16,
      rewardScale: 1.6,
      requiresMedals: 14,
    },
  ],
  cameraZones: [
    // Wide at the start, so the rocket is in the picture.
    { from: 0, yaw: 0, zoom: 28 },
    { from: 200, yaw: 0, zoom: 15 },
    // Pulled back up the mesa, so the leg above is in frame with this one.
    { from: CLIMB_FROM, yaw: 0, zoom: 19 },
    { from: CLIMB_TO, yaw: 0, zoom: 17 },
    // Pulled right back for the jump: the flight is over two hundred metres
    // and the point is to see it.
    { from: LIP - 160, yaw: 0, zoom: 24 },
    { from: LIP + LANDING + HOLD + RUNOUT + 40, yaw: 0, zoom: 16 },
  ],
  controlPoints: walk(LEGS, height, step),
};
