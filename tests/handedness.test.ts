/**
 * Which side of the car is which.
 *
 * `CLAUDE.md` records that handedness here has been settled wrong three times
 * by reasoning about it, so this settles it by driving: steer right, see which
 * way the car actually goes in its own frame, and require every part named L or
 * R to be on the matching side of that.
 *
 * The parts are laid out in four separate tables — the tuning's wheel mounts,
 * the damage components, the detachable parts, and the meshes — and a mirror
 * applied to three of them is worse than a mirror applied to none, because then
 * the damage panel and the car disagree about the same corner. One measurement,
 * checked against all of them.
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world.js';
import { rotateInverse } from '../src/sim/math.js';
import { COMPONENT_BY_ID } from '../src/sim/damage.js';
import { PART_BY_ID } from '../src/sim/debris.js';
import { CAR } from '../src/data/tuning.js';

/** Local x the car moves toward when the player steers right. */
async function rightHandSide(): Promise<number> {
  const world = await createWorld({ baseSurface: 'tarmac' });
  for (let i = 0; i < 120; i++) world.step({ throttle: 0.6, brake: 0, steer: 0, handbrake: 0 });
  const from = world.state().position;
  const facing = world.cars[0]!.vehicle.body.rotation();
  for (let i = 0; i < 240; i++) world.step({ throttle: 0.5, brake: 0, steer: 1, handbrake: 0 });
  const to = world.state().position;
  const local = rotateInverse(facing as never, { x: to.x - from.x, y: 0, z: to.z - from.z });
  return Math.sign(local.x);
}

describe('left and right', () => {
  it('agrees with the direction the car goes when you steer right', async () => {
    const right = await rightHandSide();
    // Nose along +Z, up along +Y, right-handed: the right-hand side is -X. If
    // this ever changes, everything below changes with it and the whole point
    // of measuring is that the tables follow the car rather than the other way.
    expect(right).toBe(-1);

    const at = (id: string) => COMPONENT_BY_ID.get(id as never)!.at.x;
    for (const [left, rightId] of [
      ['panelLeft', 'panelRight'],
      ['wingFL', 'wingFR'],
      ['quarterRL', 'quarterRR'],
      ['doorL', 'doorR'],
      ['mirrorL', 'mirrorR'],
      ['suspensionFL', 'suspensionFR'],
      ['hubRL', 'hubRR'],
      ['tyreFL', 'tyreFR'],
      ['brakeRL', 'brakeRR'],
    ] as const) {
      expect(Math.sign(at(rightId)), `${rightId} is on the wrong side`).toBe(right);
      expect(Math.sign(at(left)), `${left} is on the wrong side`).toBe(-right);
    }

    const part = (id: string) => PART_BY_ID.get(id as never)!.at.x;
    for (const [left, rightId] of [
      ['wingFL', 'wingFR'],
      ['quarterRL', 'quarterRR'],
      ['doorLeft', 'doorRight'],
      ['mirrorL', 'mirrorR'],
      ['wheelFL', 'wheelFR'],
      ['wheelRL', 'wheelRR'],
    ] as const) {
      expect(Math.sign(part(rightId)), `part ${rightId} is on the wrong side`).toBe(right);
      expect(Math.sign(part(left)), `part ${left} is on the wrong side`).toBe(-right);
    }

    // The wheels are indexed FL, FR, RL, RR everywhere above the simulation.
    const [fl, fr, rl, rr] = CAR.wheelPositions;
    expect(Math.sign(fr!.x), 'wheel 1 should be the front right').toBe(right);
    expect(Math.sign(fl!.x), 'wheel 0 should be the front left').toBe(-right);
    expect(Math.sign(rr!.x), 'wheel 3 should be the rear right').toBe(right);
    expect(Math.sign(rl!.x), 'wheel 2 should be the rear left').toBe(-right);
  });

  it('damages the side it was actually hit on', async () => {
    const right = await rightHandSide();
    const world = await createWorld({ baseSurface: 'tarmac', damage: true });
    const damage = world.cars[0]!.damage!;
    // A hit squarely on the car's right flank.
    damage.applyImpact({ x: right * 0.9, y: 0, z: 0 }, 20_000);
    expect(damage.get('doorR')).toBeLessThan(0.9);
    expect(damage.get('doorL')).toBe(1);
  });
});
