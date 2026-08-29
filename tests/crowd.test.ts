/**
 * The crowd at the corners.
 *
 * People standing perfectly still while a rally car arrives sideways is the
 * least believable thing left on a stage — real spectators are famous for
 * exactly the opposite, standing in the road until the last moment and then
 * not quite standing in it.
 *
 * They are scenery, and none of this touches the simulation: a car cannot hit
 * them and never will. What is tested is that they move when one comes, that
 * they go back afterwards, and that they cost nothing while it is elsewhere.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { STAGES } from '../src/data/stages/index.js';
import { Stage } from '../src/sim/stage.js';
import { buildCrowd } from '../src/render/stageMesh.js';

const stage = new Stage(STAGES[0]!);

/** Where the instanced body for person `i` currently is. */
function bodyAt(crowd: ReturnType<typeof buildCrowd>, i: number): THREE.Vector3 {
  const mesh = crowd.group.children[0] as THREE.InstancedMesh;
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(i, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

describe('spectators', () => {
  it('stand at the corners rather than everywhere', () => {
    const crowd = buildCrowd(stage);
    const mesh = crowd.group.children[0] as THREE.InstancedMesh;
    expect(mesh.count).toBeGreaterThan(10);
    // Nobody is standing on the road itself.
    for (let i = 0; i < mesh.count; i++) {
      const here = stage.progressAt(bodyAt(crowd, i));
      expect(here.onRoad).toBe(false);
    }
  });

  it('gets out of the way, and comes back', () => {
    const crowd = buildCrowd(stage);
    const start = bodyAt(crowd, 0);

    // A car arrives where they are standing.
    const car = { x: start.x, y: start.y, z: start.z };
    for (let i = 0; i < 60; i++) crowd.update(1 / 60, car);
    const scattered = bodyAt(crowd, 0);
    const ran = Math.hypot(scattered.x - start.x, scattered.z - start.z);
    expect(ran).toBeGreaterThan(1.5);

    // Away from the road, not across it: a spectator who dodges into the path
    // of the car is a spectator who has made things worse.
    expect(Math.abs(stage.progressAt(scattered).lateral)).toBeGreaterThan(
      Math.abs(stage.progressAt(start).lateral),
    );

    // And once it has gone they wander back to where they were watching from.
    const gone = { x: start.x + 300, y: start.y, z: start.z + 300 };
    for (let i = 0; i < 60 * 12; i++) crowd.update(1 / 60, gone);
    const home = bodyAt(crowd, 0);
    expect(Math.hypot(home.x - start.x, home.z - start.z)).toBeLessThan(0.2);
  });

  it('does not twitch at a car that is nowhere near', () => {
    const crowd = buildCrowd(stage);
    const before = bodyAt(crowd, 0);
    const far = { x: before.x + 500, y: before.y, z: before.z + 500 };
    for (let i = 0; i < 60; i++) crowd.update(1 / 60, far);
    const after = bodyAt(crowd, 0);
    expect(after.x).toBe(before.x);
    expect(after.z).toBe(before.z);
  });
});
