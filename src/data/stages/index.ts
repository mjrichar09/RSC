/**
 * Stage definitions.
 *
 * Stages are data, not scenes: a centreline of control points with a width and
 * a surface at each, plus medal times and camera zones. Everything visible —
 * road, verges, embankments, checkpoints — is generated from that, which is why
 * a stage costs a few dozen lines rather than an afternoon in an editor.
 */

import type { StageDef } from '../../sim/stage.js';
import type { ControlPoint } from '../../sim/spline.js';
import type { SurfaceId } from '../../sim/surfaces.js';

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
  medals: { author: 45, gold: 53, silver: 66, bronze: 85 },
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
  cameraZones: [
    { from: 0, yaw: -Math.PI * 0.25, zoom: 14 },
    { from: 300, yaw: Math.PI * 0.15, zoom: 16 },
    { from: 600, yaw: -Math.PI * 0.45, zoom: 14 },
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

export const STAGES: StageDef[] = [pineLoop, quarryRun, northPass, ...gated];

export const stageById = (id: string): StageDef => {
  const found = STAGES.find((s) => s.id === id);
  if (!found) throw new Error(`unknown stage: ${id}`);
  return found;
};
