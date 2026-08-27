/**
 * The P0 proving ground.
 *
 * A tarmac plane with four surface patches arranged around the spawn, so every
 * grip regime is a few seconds' drive away. Shared by the sim (which resolves
 * grip from it) and the renderer (which colours the ground from it) so the two
 * can never disagree about what you are driving on.
 *
 * P2 replaces this with real stage geometry; the surface lookup contract stays
 * the same.
 */

import type { GroundPatch } from '../sim/world.js';

export const TEST_PATCHES: GroundPatch[] = [
  { x: 0, z: 120, halfX: 70, halfZ: 60, surface: 'gravel' },
  { x: 130, z: 0, halfX: 60, halfZ: 70, surface: 'snow' },
  { x: -130, z: 0, halfX: 60, halfZ: 70, surface: 'grass' },
  { x: 0, z: -120, halfX: 70, halfZ: 60, surface: 'ice' },
  { x: 0, z: 0, halfX: 34, halfZ: 34, surface: 'tarmac' },
];
