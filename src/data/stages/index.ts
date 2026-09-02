/**
 * Stage definitions.
 *
 * Stages are data, not scenes: a centreline of control points with a width and
 * a surface at each, plus medal times and camera zones. Everything visible —
 * road, verges, embankments, checkpoints — is generated from that, which is why
 * a stage costs a few dozen lines rather than an afternoon in an editor.
 */

import type { StageDef, VariantSpec } from '../../sim/stage.js';
import type { ControlPoint } from '../../sim/spline.js';
import type { SurfaceId } from '../../sim/surfaces.js';

/**
 * Variant helper. `timeScale` and `rewardScale` are calibrated by measurement:
 * `npm run stages` drives every variant with the AI, which feels the grip loss
 * directly, and the visibility allowance is added on top.
 */
const variant = (
  id: string,
  timeOfDay: VariantSpec['conditions']['timeOfDay'],
  weather: VariantSpec['conditions']['weather'],
  timeScale: number,
  rewardScale: number,
  requiresMedals: number,
): VariantSpec => ({
  id,
  conditions: { timeOfDay, weather },
  timeScale,
  rewardScale,
  requiresMedals,
});

/** Terse control-point helper: [x, z, y, width, surface]. */
const cp = (
  x: number,
  z: number,
  y: number,
  width: number,
  surface: SurfaceId,
  banking?: number,
): ControlPoint => ({ pos: { x, y, z }, width, surface, ...(banking ? { banking } : {}) });

/**
 * The always-free stage. Wide, flowing gravel with no hard braking zones — the
 * one you can always afford to enter, and the one that has to teach the car.
 */
const pineLoop: StageDef = {
  id: 'pine-loop',
  name: 'Pine Loop',
  biome: 'forest',
  verge: 'grass',
  bank: 'dirt',
  hazards: { kinds: ['tree', 'sapling', 'rock'], spacing: 15 },
  entryFee: 0,
  // The free stage. Modest money, but it is always available and always pays,
  // so no amount of bad luck can strand a player without a way back.
  payouts: { author: 2600, gold: 1600, silver: 900, bronze: 500, finish: 300 },
  checkpoints: 3,
  medals: { author: 36, gold: 41, silver: 52, bronze: 68 },
  controlPoints: [
    cp(0, 0, 0, 6.0, 'gravel'),
    // A crest on the opening straight. Sized so it only launches the car above
    // roughly 90 km/h: reward for committing, nothing for arriving carefully.
    cp(0, 22, 0, 6.0, 'gravel'),
    cp(0, 40, 2.6, 5.8, 'gravel'),
    cp(0, 58, 0, 6.0, 'gravel'),
    cp(0, 90, 0, 6.0, 'gravel'),
    cp(6, 130, 1.5, 5.6, 'gravel'),
    cp(40, 175, 3.0, 5.4, 'gravel'),
    cp(95, 190, 3.0, 5.6, 'gravel'),
    cp(145, 165, 1.5, 5.4, 'gravel'),
    cp(170, 115, 0, 5.2, 'gravel'),
    cp(165, 55, 0, 5.6, 'dirt'),
    cp(130, 10, 0, 6.0, 'dirt'),
    cp(75, -10, 0, 6.4, 'gravel'),
    // Second crest, taken blind on the way back down the valley.
    cp(58, -16, 0, 6.2, 'gravel'),
    cp(41, -22, 2.4, 6.0, 'gravel'),
    cp(24, -28, 0, 6.0, 'gravel'),
    cp(-6, -32, 0, 6.0, 'gravel'),
    cp(-30, -25, 0, 5.8, 'gravel'),
    cp(-55, 15, 0, 5.6, 'gravel'),
    cp(-40, 60, 0, 6.0, 'gravel'),
  ],
  variants: [
    variant('dusk', 'dusk', 'clear', 1.05, 1.35, 2),
    variant('night-rain', 'night', 'rain', 1.41, 2.1, 5),
  ],
  cameraZones: [
    { from: 0, yaw: Math.PI * 0.25, zoom: 13 },
    // Tightens through the fast right-hander so the exit stays in frame.
    { from: 200, yaw: Math.PI * 0.05, zoom: 15 },
    { from: 420, yaw: -Math.PI * 0.2, zoom: 14 },
    { from: 640, yaw: Math.PI * 0.35, zoom: 13 },
  ],
};

/**
 * Faster and narrower, with a tarmac spine and loose entries. Rewards commitment
 * and punishes carrying too much speed into the switchbacks.
 */
const quarryRun: StageDef = {
  id: 'quarry-run',
  name: 'Quarry Run',
  biome: 'quarry',
  verge: 'dirt',
  bank: 'dirt',
  hazards: { kinds: ['rock', 'bale', 'pole'], spacing: 12 },
  entryFee: 250,
  requiresMedals: 1,
  payouts: { author: 5200, gold: 3200, silver: 1800, bronze: 1000, finish: 600 },
  checkpoints: 4,
  medals: { author: 34, gold: 39, silver: 46, bronze: 55 },
  controlPoints: [
    cp(0, 0, 0, 5.4, 'tarmac'),
    cp(2, 26, 0, 5.4, 'tarmac'),
    // Crest over the quarry lip, straight onto the braking zone.
    cp(3, 44, 2.5, 5.2, 'tarmac'),
    cp(4, 62, 0, 5.4, 'tarmac'),
    cp(6, 86, 0, 5.4, 'tarmac'),
    cp(34, 112, -2, 5.0, 'tarmac'),
    cp(85, 130, -4, 4.6, 'gravel'),
    cp(130, 100, -4, 4.4, 'gravel', 0.12),
    cp(140, 45, -2, 4.4, 'gravel'),
    cp(110, 0, 0, 4.6, 'dirt'),
    cp(55, -25, 2, 4.8, 'dirt'),
    cp(0, -40, 4, 5.0, 'gravel'),
    cp(-55, -30, 4, 4.8, 'gravel'),
    cp(-95, 10, 2, 4.6, 'gravel'),
    cp(-100, 65, 0, 4.8, 'tarmac'),
    cp(-70, 110, 0, 5.2, 'tarmac'),
    cp(-30, 140, 0, 5.4, 'tarmac'),
    cp(20, 165, 0, 5.4, 'tarmac'),
    cp(75, 175, 0, 5.6, 'tarmac'),
  ],
  variants: [
    variant('rain', 'day', 'rain', 1.19, 1.4, 3),
    variant('night', 'night', 'clear', 1.1, 1.8, 6),
  ],
  cameraZones: [
    { from: 0, yaw: Math.PI * 0.25, zoom: 12 },
    { from: 260, yaw: -Math.PI * 0.1, zoom: 13 },
    { from: 520, yaw: Math.PI * 0.5, zoom: 12 },
    { from: 760, yaw: Math.PI * 0.15, zoom: 12 },
  ],
};

/**
 * Snow and ice. Wide enough to be survivable, slippery enough that the car is
 * never really settled — this is where the tire model earns its keep.
 */
const northPass: StageDef = {
  id: 'north-pass',
  name: 'North Pass',
  biome: 'winter',
  verge: 'snow',
  bank: 'snow',
  hazards: { kinds: ['pole', 'tree', 'sapling', 'rock'], spacing: 17 },
  entryFee: 500,
  requiresMedals: 2,
  payouts: { author: 8600, gold: 5400, silver: 3000, bronze: 1700, finish: 1000 },
  checkpoints: 4,
  // Re-derived after the locked-wheel grip floor: the AI's best lap here went
  // from 56.84s to 65.12s, because snow is where crude braking costs most and
  // locking now gives up 45% of peak grip rather than 26%. Same ratios to the
  // measured lap as before, moved with it.
  // Recalibrated after the gearbox fix. These were set against a car whose box
  // upshifted on wheelspin, which on snow left it in the wrong gear for most of
  // the stage: the AI's best lap here went from 62.3s to 47.0s once the shift
  // logic started reading the road. Medal times come from a measured AI lap, so
  // they move with it — at the same ratios this stage already had, so it is
  // exactly as hard relative to the car as it was.
  medals: { author: 39, gold: 46, silver: 57, bronze: 73 },
  controlPoints: [
    cp(0, 0, 0, 6.4, 'snow'),
    cp(-8, 65, 2, 6.4, 'snow'),
    cp(-45, 115, 5, 6.0, 'snow'),
    cp(-100, 140, 8, 5.8, 'ice'),
    cp(-160, 130, 10, 5.6, 'ice'),
    cp(-200, 85, 10, 5.8, 'snow'),
    cp(-205, 25, 8, 6.0, 'snow'),
    cp(-175, -30, 5, 6.2, 'snow'),
    cp(-115, -55, 3, 6.0, 'ice'),
    cp(-45, -60, 1, 5.8, 'ice'),
    cp(15, -55, 0, 6.0, 'snow'),
    cp(60, -20, 0, 6.2, 'snow'),
    cp(80, 35, 0, 6.4, 'snow'),
    cp(70, 95, 0, 6.4, 'snow'),
  ],
  variants: [
    variant('fog', 'day', 'fog', 1.09, 1.6, 4),
    variant('night-snow', 'night', 'snowfall', 1.57, 2.3, 7),
  ],
  cameraZones: [
    { from: 0, yaw: -Math.PI * 0.25, zoom: 14 },
    { from: 300, yaw: Math.PI * 0.15, zoom: 16 },
    { from: 600, yaw: -Math.PI * 0.45, zoom: 14 },
  ],
};

/**
 * A forest stage built around one obstacle: a stream running across the road.
 *
 * The ford is the whole point and everything before it is the setup. The road
 * narrows through the trees on the approach, so a driver arrives committed,
 * and the crossing itself is a surface that takes half the grip and most of the
 * speed — water does not spin a car so much as stop one. Wide, forgiving
 * run-off on the far side, because a hazard you cannot survive is a hazard
 * nobody takes twice.
 */
const millstream: StageDef = {
  id: 'millstream',
  name: 'Millstream',
  biome: 'forest',
  verge: 'grass',
  bank: 'dirt',
  hazards: { kinds: ['tree', 'sapling', 'rock'], spacing: 14 },
  entryFee: 300,
  requiresMedals: 5,
  payouts: { author: 6400, gold: 3900, silver: 2200, bronze: 1250, finish: 720 },
  checkpoints: 3,
  medals: { author: 32, gold: 35, silver: 44, bronze: 57 },
  controlPoints: [
    // A wide, fast opening: the width is the promise the rest of it breaks.
    cp(0, 0, 0, 7.6, 'gravel'),
    cp(2, 40, 0, 7.4, 'gravel'),
    cp(10, 82, 1.6, 6.8, 'gravel'),
    cp(34, 118, 2.4, 6.0, 'gravel'),
    // Squeezing down through the trees toward the water.
    cp(74, 138, 1.8, 5.0, 'dirt'),
    cp(118, 140, 0.6, 4.4, 'dirt'),
    cp(156, 128, 0, 4.2, 'dirt'),
    // The ford. Two points of it, so the crossing is a few car lengths rather
    // than a line you are past before the car has settled.
    cp(186, 112, -0.9, 5.2, 'water'),
    cp(206, 96, -1.1, 5.6, 'water'),
    // Out the far side, wide, with room to gather it up again.
    cp(232, 74, 0.4, 7.2, 'dirt'),
    cp(258, 40, 1.2, 7.6, 'gravel'),
    cp(268, -4, 1.6, 7.0, 'gravel'),
    cp(252, -48, 1.2, 5.8, 'gravel'),
    cp(212, -76, 0.6, 5.2, 'gravel'),
    cp(164, -86, 0, 5.6, 'gravel'),
    cp(112, -78, 0, 6.4, 'gravel'),
    cp(66, -52, 0, 7.0, 'gravel'),
    cp(38, -14, 0, 7.4, 'gravel'),
  ],
  variants: [
    variant('dusk', 'dusk', 'clear', 1.06, 1.4, 6),
    variant('rain', 'day', 'rain', 1.22, 1.75, 8),
  ],
  cameraZones: [
    { from: 0, yaw: Math.PI * 0.25, zoom: 14 },
    { from: 240, yaw: -Math.PI * 0.1, zoom: 13 },
    { from: 520, yaw: Math.PI * 0.4, zoom: 14 },
    { from: 800, yaw: Math.PI * 0.1, zoom: 14 },
  ],
};

/**
 * Tarmac through a town, in the Monte Carlo manner.
 *
 * Narrow, walled, and unforgiving: the width swings between a street you can
 * use and a gap between two buildings, and the corners are junctions rather
 * than bends. There is nothing loose to lean on here — this is the one stage
 * where the tyre model is being asked for grip rather than for slip, and where
 * running wide costs a wall instead of a verge.
 */
const vieuxVillage: StageDef = {
  id: 'vieux-village',
  name: 'Vieux Village',
  biome: 'town',
  // Pavement, then a lighter kerbstone bank. Both tarmac made the whole
  // corridor one flat grey with no edge to the road at all.
  verge: 'tarmac',
  bank: 'gravel',
  // Buildings twice over, so most of what lines this street is a wall. That
  // is the character of a town stage: there is no run-off, and getting a
  // corner wrong costs the most expensive impact in the game.
  hazards: { kinds: ['building', 'building', 'bale', 'pole'], spacing: 11 },
  entryFee: 420,
  requiresMedals: 7,
  payouts: { author: 7600, gold: 4600, silver: 2600, bronze: 1450, finish: 850 },
  checkpoints: 3,
  medals: { author: 28, gold: 31, silver: 39, bronze: 51 },
  controlPoints: [
    // Out of the square, which is the widest the stage ever gets.
    cp(0, 0, 0, 8.2, 'tarmac'),
    cp(0, 34, 0, 7.0, 'tarmac'),
    cp(-4, 66, 1.2, 5.2, 'tarmac'),
    // Between the houses: two car widths and a wall either side.
    cp(-18, 96, 2.4, 4.0, 'tarmac'),
    cp(-44, 118, 3.4, 3.8, 'tarmac'),
    cp(-78, 126, 4.0, 4.4, 'tarmac'),
    // The hairpin at the top of the village.
    cp(-114, 114, 4.6, 5.2, 'tarmac'),
    cp(-136, 84, 4.8, 4.8, 'tarmac'),
    cp(-134, 46, 4.4, 4.2, 'tarmac'),
    // Down the far side, away from the square rather than back through it: a
    // street that passes within a corridor's width of the start line is a
    // stage that buries the car in an embankment belonging to a section it has
    // not reached yet.
    cp(-118, 6, 3.6, 4.6, 'tarmac'),
    cp(-96, -34, 2.6, 5.6, 'tarmac'),
    cp(-62, -66, 1.6, 6.8, 'tarmac'),
    // The market street: the second-widest thing here, and the only real
    // overtaking place if anyone else is on the stage.
    cp(-18, -84, 0.8, 7.4, 'tarmac'),
    cp(28, -88, 0.4, 6.4, 'tarmac'),
    // A cobbled cut-through between two houses, tight and off-camber.
    cp(72, -80, 0.2, 5.6, 'tarmac'),
    cp(110, -66, 0, 5.2, 'tarmac'),
    cp(138, -40, 0, 5.0, 'tarmac'),
    cp(148, -4, 0, 5.4, 'tarmac'),
    cp(142, 32, 0, 6.2, 'tarmac'),
    cp(120, 62, 0, 7.0, 'tarmac'),
  ],
  variants: [
    variant('night', 'night', 'clear', 1.16, 1.9, 8),
    variant('night-rain', 'night', 'rain', 1.44, 2.4, 10),
  ],
  cameraZones: [
    { from: 0, yaw: Math.PI * 0.2, zoom: 11 },
    { from: 200, yaw: -Math.PI * 0.3, zoom: 12 },
    { from: 420, yaw: Math.PI * 0.45, zoom: 11 },
    { from: 640, yaw: -Math.PI * 0.15, zoom: 12 },
  ],
};

/**
 * Twice the length of anything else here, and three different roads.
 *
 * It starts on tarmac in the valley, climbs onto loose gravel through the
 * middle third, and finishes on snow over the top. The point is endurance of
 * *attention*: the car that works on the first third is the wrong car for the
 * last, the brakes have a long way to get hot, and nobody has a ghost for a
 * road they have only seen once.
 */
const grandTraverse: StageDef = {
  id: 'grand-traverse',
  name: 'Grand Traverse',
  biome: 'alpine',
  verge: 'grass',
  bank: 'dirt',
  hazards: { kinds: ['rock', 'tree', 'sapling', 'pole'], spacing: 18 },
  entryFee: 700,
  requiresMedals: 9,
  payouts: { author: 14200, gold: 8800, silver: 4900, bronze: 2750, finish: 1600 },
  checkpoints: 6,
  medals: { author: 77, gold: 84, silver: 106, bronze: 139 },
  controlPoints: [
    // Valley tarmac: fast, wide, and the only place on the stage to breathe.
    cp(0, 0, 0, 7.8, 'tarmac'),
    cp(6, 54, 0, 7.8, 'tarmac'),
    cp(26, 106, 2, 7.2, 'tarmac'),
    cp(66, 146, 5, 6.4, 'tarmac'),
    cp(120, 168, 9, 6.0, 'tarmac'),
    // The surface changes here, in the middle of a straight, and that placement
    // is deliberate: with the change on the entry to the following corner the
    // AI arrived at 120 km/h on tarmac grip, found gravel under it mid-corner
    // and beached itself on the embankment on every committed lap. Sixty metres
    // of straight gravel before the corner is the whole fix.
    cp(180, 170, 13, 6.0, 'gravel'),
    cp(236, 152, 17, 6.2, 'gravel'),
    // Wider than the tarmac, not narrower: a loose surface at this altitude is
    // a road nobody has fenced, and the AI needs the room the corners take away.
    cp(284, 116, 21, 6.6, 'gravel'),
    cp(316, 66, 25, 6.4, 'gravel'),
    cp(330, 8, 29, 6.2, 'gravel'),
    cp(320, -52, 33, 6.4, 'gravel'),
    cp(284, -104, 36, 6.8, 'gravel'),
    cp(228, -138, 39, 7.0, 'gravel'),
    cp(162, -148, 41, 6.6, 'gravel'),
    cp(98, -134, 43, 6.0, 'gravel'),
    cp(46, -98, 45, 5.8, 'gravel'),
    cp(16, -50, 46, 6.2, 'gravel'),
    // Over the top: snow, and the widest road on the stage because none of it
    // is any use to you. The change is on the straight for the same reason the
    // gravel's is — the corner at the top of the climb is eighty metres later,
    // which is enough warning to have slowed down for it.
    //
    // Routed west, into empty ground, and that is not a style choice. The snow
    // loop used to be concentric with the gravel loop at almost the same radius
    // and twelve metres higher: `npm run stages` reports the closest a stage
    // comes to itself, and this one came within **one metre** of its own road at
    // 464 m against 1451 m. One corridor's embankment and wall then hang in the
    // air directly over the other, which is what the strange shadows and
    // occlusion around this stage were.
    cp(10, -22, 46.5, 7.0, 'snow'),
    cp(4, 4, 47, 7.4, 'snow'),
    cp(-24, 46, 48, 7.8, 'snow'),
    cp(-64, 82, 48, 7.2, 'snow'),
    cp(-96, 128, 47, 6.6, 'snow'),
    cp(-104, 182, 46, 6.2, 'snow'),
    cp(-80, 230, 44, 6.6, 'snow'),
    cp(-30, 258, 42, 7.0, 'snow'),
    cp(28, 258, 39, 7.4, 'snow'),
    // The long descent off the back, and the only place the stage is fast
    // twice: a straight after twenty corners is a straight you will use.
    cp(88, 242, 36, 7.0, 'snow'),
    cp(132, 206, 32, 6.4, 'snow'),
    cp(152, 156, 28, 6.0, 'snow'),
    cp(154, 100, 24, 6.4, 'snow'),
    cp(150, 44, 20, 7.0, 'snow'),
    cp(140, -8, 16, 7.4, 'snow'),
    cp(160, -58, 13, 7.0, 'snow'),
    // Straight run-off past the line, into the middle of the valley the gravel
    // loop encircles — the one piece of open ground left on the stage.
    cp(168, -108, 10, 7.4, 'snow'),
  ],
  variants: [
    variant('dusk', 'dusk', 'clear', 1.08, 1.5, 10),
    variant('night-snow', 'night', 'snowfall', 1.52, 2.5, 12),
  ],
  cameraZones: [
    { from: 0, yaw: Math.PI * 0.25, zoom: 14 },
    { from: 300, yaw: -Math.PI * 0.2, zoom: 15 },
    { from: 640, yaw: Math.PI * 0.55, zoom: 14 },
    { from: 1000, yaw: -Math.PI * 0.35, zoom: 15 },
    { from: 1400, yaw: Math.PI * 0.15, zoom: 14 },
  ],
};

/**
 * The jumps stage.
 *
 * Every other stage in the game is about a line through a corner. This one is
 * about a number on the way *in* to a lip: a motocross track's rhythm, where
 * the fast way round is not the committed one but the one that arrives at each
 * take-off at the speed its landing was built for. Too slow and the car cases
 * the face of the next rise and stops dead; too fast and it lands long, flat
 * and on its bump stops with the corner already there.
 *
 * Four kinds of jump, in the order a rider would want to meet them:
 *
 * - A **rhythm section** of four low crests on a fixed 22 m pitch. Taken at the
 *   right speed the car skims them; taken too fast it lands on the face of the
 *   next one and is thrown off line for the whole row.
 * - A **table-top** with a flat top and a landing ramp, which is the forgiving
 *   one: land anywhere down the ramp and it works.
 * - A **step-down**, where the road falls away past the lip. Nothing about the
 *   approach tells you that, which is why the corner board before it matters.
 * - The **big one**, launching onto a long descent. Downhill landings reward
 *   speed rather than punishing it, so this is the one place on the stage where
 *   the brave line is also the quick one — put somewhere the driver has just
 *   spent three jumps learning to be careful.
 *
 * Wide, and deliberately so. A jump taken crooked lands crooked, and a narrow
 * road turns every landing into a save; the width is what makes speed rather
 * than steering the thing being tested. It never comes within eighty metres of
 * itself and finishes on a long flat run-off, because a car still settling from
 * the last double is a car that needs road in front of it.
 */
const scrubbedFlats: StageDef = {
  id: 'scrubbed-flats',
  name: 'Scrubbed Flats',
  biome: 'moor',
  verge: 'dirt',
  bank: 'dirt',
  // Sparse, and no trees. The run-off beside a landing is where a car that got
  // it wrong is going, and lining it with trunks makes a mistimed jump a
  // retirement rather than a lost second.
  hazards: { kinds: ['bale', 'pole'], spacing: 26 },
  entryFee: 400,
  requiresMedals: 4,
  payouts: { author: 7400, gold: 4500, silver: 2500, bronze: 1400, finish: 820 },
  checkpoints: 4,
  // From a measured AI lap, not from taste: `npm run stages --stage=scrubbed-flats`
  // drives it in 45.6 s clean, 0% off road and no rescues, and these are that
  // time at the ratios every other stage in the game uses (0.89 / 0.97 / 1.22 /
  // 1.60). Re-measure and re-derive them if a jump moves — the whole stage is
  // speed against geometry, so a lip half a metre lower is a different lap.
  medals: { author: 41, gold: 44, silver: 56, bronze: 73 },
  controlPoints: [
    // Start apron, then a flat run-up: the rhythm section has to be entered at
    // a speed the driver chose rather than at whatever the start produced.
    cp(0, 0, 0, 8.0, 'dirt'),
    cp(0, 30, 0, 7.6, 'dirt'),
    cp(0, 58, 0, 7.4, 'dirt'),
    // The rhythm section. Four crests on a 22 m pitch — close enough that the
    // landing off one is the run-up to the next, so it is one decision made
    // early rather than four made late.
    cp(0, 80, 1.9, 7.0, 'dirt'),
    cp(0, 102, 0, 7.0, 'dirt'),
    cp(0, 124, 1.9, 7.0, 'dirt'),
    cp(0, 146, 0, 7.0, 'dirt'),
    cp(0, 168, 1.9, 7.0, 'dirt'),
    cp(0, 190, 0, 7.2, 'dirt'),
    // Opening out, and climbing, into the top of the loop.
    cp(4, 220, 0, 7.6, 'dirt'),
    cp(14, 250, 0.8, 7.6, 'dirt'),
    cp(38, 276, 1.6, 7.2, 'dirt'),
    cp(74, 290, 2.0, 7.0, 'dirt'),
    // The table-top: a lip, a flat top long enough to be in the air over, and a
    // ramp down the far side to land on.
    cp(110, 292, 3.6, 6.8, 'dirt'),
    cp(134, 292, 3.8, 6.8, 'dirt'),
    cp(162, 288, 0.4, 7.4, 'dirt'),
    cp(196, 280, 0, 7.4, 'dirt'),
    // South down the east side, still fast.
    cp(228, 262, 0, 7.0, 'dirt'),
    cp(248, 234, 0, 6.6, 'dirt'),
    cp(256, 204, 0.6, 6.8, 'dirt'),
    // The step-down. The lip is the last thing visible from the approach and
    // the road is two and a half metres lower on the other side of it.
    cp(258, 178, 2.4, 6.8, 'dirt'),
    cp(258, 152, -1.6, 7.2, 'dirt'),
    cp(256, 126, -2.4, 7.2, 'dirt'),
    // A genuine corner, to take the speed back off. Without one the whole stage
    // is a straight line with bumps in it, and the fast lap is full throttle.
    cp(246, 98, -2.4, 5.6, 'dirt'),
    cp(228, 74, -2.0, 5.2, 'dirt'),
    cp(202, 58, -1.4, 5.6, 'dirt'),
    // The big one, onto a long descent: land far down a falling road and the
    // speed is kept, so this is the one jump where committing is also quick.
    cp(172, 48, 1.0, 6.8, 'dirt'),
    cp(140, 42, -2.6, 7.6, 'dirt'),
    cp(108, 38, -4.0, 7.6, 'dirt'),
    // A last double onto the run to the line. Sharpened after measuring it:
    // authored at 1.4 m of rise these two crests only launched the car above
    // 130 km/h, which nothing reaches down here, so the stage's last jump was
    // a bump. Deepening the dips either side rather than raising the lips
    // keeps the run-in flat and the landing low.
    cp(80, 26, -1.8, 7.2, 'dirt'),
    cp(56, 8, -5.4, 7.2, 'dirt'),
    cp(38, -16, -3.0, 7.4, 'dirt'),
    // Flat, long, and pointed away from everything: a car still settling from
    // the last landing needs road in front of it, and the finish is not the
    // place to discover the corridor has run out.
    cp(26, -44, -4.4, 7.6, 'dirt'),
    cp(20, -74, -4.4, 8.0, 'dirt'),
  ],
  variants: [
    variant('dusk', 'dusk', 'clear', 1.07, 1.45, 6),
    variant('rain', 'day', 'rain', 1.26, 1.8, 9),
  ],
  cameraZones: [
    // The rhythm section is watched from the side: height off the ground is
    // what the driver needs to read there, and a camera down the road hides it.
    { from: 0, yaw: Math.PI * 0.5, zoom: 14 },
    { from: 230, yaw: Math.PI * 0.15, zoom: 15 },
    { from: 470, yaw: -Math.PI * 0.3, zoom: 14 },
    { from: 700, yaw: -Math.PI * 0.6, zoom: 15 },
    { from: 900, yaw: Math.PI * 0.75, zoom: 14 },
  ],
};

import { GENERATED_STAGES } from './generated.js';

/**
 * Hand-authored stages first, then generated ones.
 *
 * The three authored stages teach the car and anchor the economy; the generated
 * set is what makes the game bigger than an afternoon. They are the same kind of
 * data and go through exactly the same code — the only difference is that a
 * person picked the corners of the first three.
 */
/**
 * Generated stages open progressively, three medals apart, so the career has a
 * shape beyond a rising balance. The ramp is deliberately gentle and the free
 * stage never locks, so nobody is ever stuck with nothing to drive.
 */
const gated = GENERATED_STAGES.map((stage, i) => ({
  ...stage,
  // Must stay reachable: with N stages open a player can hold at most N
  // medals, so a requirement above a stage's own position in the unlock order
  // dead-ends the career with money in the bank and nothing to spend it on.
  // A step below one keeps slack, so nobody has to medal literally everything.
  requiresMedals: 3 + Math.floor(i * 0.8),
}));

export const STAGES: StageDef[] = [
  pineLoop,
  quarryRun,
  northPass,
  ...gated,
  millstream,
  vieuxVillage,
  scrubbedFlats,
  grandTraverse,
];

export const stageById = (id: string): StageDef => {
  const found = STAGES.find((s) => s.id === id);
  if (!found) throw new Error(`unknown stage: ${id}`);
  return found;
};
