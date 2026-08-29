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
  hazards: { kinds: ['tree', 'rock'], spacing: 15 },
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
  hazards: { kinds: ['pole', 'tree', 'rock'], spacing: 17 },
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
  hazards: { kinds: ['tree', 'rock'], spacing: 14 },
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
  hazards: { kinds: ['bale', 'pole'], spacing: 11 },
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
  hazards: { kinds: ['rock', 'tree', 'pole'], spacing: 18 },
  entryFee: 700,
  requiresMedals: 9,
  payouts: { author: 14200, gold: 8800, silver: 4900, bronze: 2750, finish: 1600 },
  checkpoints: 6,
  medals: { author: 80, gold: 87, silver: 110, bronze: 143 },
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
    cp(10, -22, 46.5, 7.0, 'snow'),
    cp(4, 4, 47, 7.4, 'snow'),
    cp(14, 60, 48, 7.8, 'snow'),
    cp(52, 108, 48, 7.2, 'snow'),
    cp(104, 140, 47, 6.2, 'snow'),
    cp(168, 150, 46, 5.8, 'snow'),
    cp(232, 138, 44, 6.2, 'snow'),
    cp(288, 106, 42, 6.8, 'snow'),
    cp(324, 58, 40, 7.2, 'snow'),
    // The long descent off the back, and the only place the stage is fast
    // twice: a straight after twenty corners is a straight you will use.
    cp(372, 34, 38, 7.4, 'snow'),
    cp(396, -14, 36, 7.0, 'snow'),
    cp(400, -70, 33, 6.4, 'snow'),
    cp(390, -124, 29, 6.0, 'snow'),
    cp(366, -172, 25, 6.4, 'snow'),
    cp(324, -206, 21, 7.0, 'snow'),
    cp(268, -222, 18, 7.4, 'snow'),
    cp(208, -224, 15, 7.0, 'snow'),
    // Straight run-off past the line: a car that crosses it sideways has
    // somewhere to go, and a car that rolls back a few centimetres does not
    // fall out of the world.
    cp(148, -224, 13, 7.4, 'snow'),
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
  grandTraverse,
];

export const stageById = (id: string): StageDef => {
  const found = STAGES.find((s) => s.id === id);
  if (!found) throw new Error(`unknown stage: ${id}`);
  return found;
};
