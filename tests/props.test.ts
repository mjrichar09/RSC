/**
 * What is at the side of the road, and what hitting it costs.
 *
 * The point is the *difference* between them: a stand of trees where every
 * trunk costs the same is a wall with a texture on it. A sapling has to be
 * worth clipping and a mature trunk worth avoiding, and the reason they differ
 * is that one of them weighs sixty kilos — not a special case anywhere in the
 * damage model.
 *
 * Measured by putting one prop in the middle of the road and driving straight
 * at it, the same way `npm run crash` measures a wall. Steering into the hazard
 * band instead measured the embankment: both trees came out at 6.8 kN·s because
 * that is what the bank costs, and the prop was lost in it.
 */

import { describe, expect, it } from 'vitest';
import { Stage, type PropKind } from '../src/sim/stage.js';
import { createWorld } from '../src/sim/world.js';
import { stageById } from '../src/data/stages/index.js';

const SHAPE: Record<string, { radius: number; height: number; mass?: number }> = {
  tree: { radius: 0.52, height: 7.5 },
  sapling: { radius: 0.16, height: 3.0, mass: 60 },
  building: { radius: 3.2, height: 9 },
  signPost: { radius: 0.09, height: 2.0, mass: 45 },
};

/** Drive into one prop standing on the road, 60 m from the line. */
async function driveInto(kind: PropKind) {
  const stage = new Stage(stageById('pine-loop'));
  const at = stage.spline.at(60);
  const shape = SHAPE[kind]!;
  stage.props.length = 0;
  stage.props.push({
    kind,
    position: { x: at.position.x, y: at.position.y, z: at.position.z },
    radius: shape.radius,
    height: shape.height,
    yaw: 0,
    ...(shape.mass ? { mass: shape.mass } : {}),
  });

  const world = await createWorld({ stage, damage: true });
  const damage = world.cars[0]!.damage!;
  for (let i = 0; i < 120 * 10; i++) world.step({ throttle: 1, brake: 0, steer: 0, handbrake: 0 });
  return { world, damage, moved: world.movableProps.map((p) => p.body.translation()) };
}

describe('what you hit at the roadside', () => {
  it('makes a sapling cheap and a mature trunk expensive', async () => {
    const small = await driveInto('sapling');
    const big = await driveInto('tree');
    expect(big.damage.peakImpulse).toBeGreaterThan(small.damage.peakImpulse * 3);
    // Worth clipping rather than worth avoiding.
    expect(small.damage.condition).toBeGreaterThan(0.98);
    // And the trunk is a genuine accident.
    expect(big.damage.condition).toBeLessThan(0.96);
  }, 40_000);

  it('knocks a sapling over and leaves a trunk standing', async () => {
    const small = await driveInto('sapling');
    expect(small.world.movableProps.length).toBe(1);
    const start = small.world.movableProps[0]!.prop.position;
    const now = small.moved[0]!;
    expect(Math.hypot(now.x - start.x, now.z - start.z)).toBeGreaterThan(0.5);

    const big = await driveInto('tree');
    expect(big.world.movableProps.length).toBe(0);
  }, 40_000);

  it('knocks a corner board over and barely marks the car', async () => {
    // A corner board is the cheapest thing on a stage that is still a thing:
    // it exists so the edge of the road is somewhere real, not so that running
    // wide ends a run. Before it had a collider at all the car drove through
    // it, which taught the player the verge was empty.
    const sign = await driveInto('signPost');
    expect(sign.world.movableProps.length).toBe(1);
    const start = sign.world.movableProps[0]!.prop.position;
    const now = sign.moved[0]!;
    expect(Math.hypot(now.x - start.x, now.z - start.z), 'the board should go over').toBeGreaterThan(
      0.5,
    );
    // Cheaper than a sapling: it is a pole and a sheet, not sixty kilos of wood.
    const small = await driveInto('sapling');
    expect(sign.damage.peakImpulse).toBeLessThan(small.damage.peakImpulse);
    expect(sign.damage.condition).toBeGreaterThan(0.99);
  }, 60_000);

  it('makes a building a major accident', async () => {
    // Not harder than a trunk, and it should not be: both are immovable, so
    // what the car gets back is its own momentum either way — 25 kN·s, about
    // what a 70 km/h wall costs. What makes a town stage frightening is that
    // there are walls down both sides of it and nowhere to put a mistake, not
    // that one wall hits harder than one tree.
    const wall = await driveInto('building');
    expect(wall.damage.peakImpulse).toBeGreaterThan(20_000);
    expect(wall.damage.condition).toBeLessThan(0.95);
    expect([...wall.damage.warnings()].length).toBeGreaterThan(0);
  }, 40_000);
});
