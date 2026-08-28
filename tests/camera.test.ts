/**
 * The camera must never mirror the controls.
 *
 * This is the test for the worst bug the game has had. The simulation was
 * always correct — steering right turned the car right in the world — but the
 * camera's yaw was authored by hand, by eye, and on most of every stage it sat
 * *in front* of the car. A car coming toward the viewer has its left and right
 * swapped on screen, so the steering read as inverted for 60–98% of every
 * stage, and not one headless test could see it, because nothing was wrong with
 * the physics.
 *
 * So the check is done where the problem actually lives: in screen space. The
 * car's own right-hand direction is projected through the real camera, and it
 * has to come out pointing right on screen.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { STAGES } from '../src/data/stages/index.js';
import { Stage } from '../src/sim/stage.js';
import { IsoCamera } from '../src/render/camera.js';
import { createWorld } from '../src/sim/world.js';

/**
 * Screen-space x of the car's right-hand direction, at `distance` along the
 * stage, through the camera that stage would actually be using there.
 */
function rightOnScreen(stage: Stage, distance: number): number {
  const sample = stage.spline.at(distance);
  const camera = new IsoCamera();
  camera.resize(1600, 900);
  camera.applyZones(stage.cameraZones, distance);
  camera.jumpTo(sample.position);
  camera.camera.updateMatrixWorld(true);

  const at = new THREE.Vector3(sample.position.x, sample.position.y, sample.position.z);
  // Which way the car actually goes when you steer right. The spline carries
  // its across-road vector as `left` — that is `cross(up, forward)`, and in a
  // right-handed Y-up world that points to the driver's left — so the right is
  // its negation.
  const right = new THREE.Vector3(-sample.left.x, -sample.left.y, -sample.left.z).normalize();

  const here = at.clone().project(camera.camera);
  const there = at.clone().add(right).project(camera.camera);
  return there.x - here.x;
}

describe('pressing right goes right', () => {
  /**
   * The end-to-end version, and the one that actually settles it: drive the
   * real car through the real camera, once straight and once turning, and
   * compare where it ends up on screen. Everything else in this file is a
   * cheaper proxy for this.
   *
   * Reasoning about the sign by hand got it wrong three times — the model
   * frame, the spline's vectors and the camera basis each have their own
   * handedness, and two wrongs cancelled — so this measures instead.
   */
  const lateralOnScreen = async (def: (typeof STAGES)[number], steer: number) => {
    const stage = new Stage(def);
    const camera = new IsoCamera();
    camera.resize(1600, 900);
    camera.applyZones(stage.cameraZones, 0);
    camera.jumpTo(stage.start.position);
    camera.camera.updateMatrixWorld(true);

    const drive = async (input: number) => {
      const world = await createWorld({ stage });
      for (let i = 0; i < 60; i++) world.step({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
      for (let i = 0; i < 150; i++) {
        world.step({ throttle: 0.6, brake: 0, steer: input, handbrake: 0 });
      }
      const p = world.state().position;
      return new THREE.Vector3(p.x, p.y, p.z).project(camera.camera);
    };

    const straight = await drive(0);
    const turned = await drive(steer);
    return turned.x - straight.x;
  };

  for (const def of STAGES.slice(0, 3)) {
    it(`moves the car right on screen on ${def.id}`, async () => {
      expect(await lateralOnScreen(def, 1)).toBeGreaterThan(0);
      expect(await lateralOnScreen(def, -1)).toBeLessThan(0);
    });
  }
});

describe('camera orientation', () => {
  for (const def of STAGES) {
    it(`never mirrors the steering on ${def.id}`, () => {
      const stage = new Stage(def);
      let worst = Infinity;
      let worstAt = 0;
      for (let d = 0; d < stage.length; d += 5) {
        const x = rightOnScreen(stage, d);
        if (x < worst) {
          worst = x;
          worstAt = d;
        }
      }
      // Positive means the car's right is the screen's right, everywhere.
      expect(worst, `mirrored at ${worstAt.toFixed(0)} m`).toBeGreaterThan(0);
    });
  }

  it('keeps the car driving into the screen, not out of it', () => {
    // The same property stated the other way round: the camera sits behind the
    // direction of travel, with margin. Perpendicular is the limit, and the
    // zone rule leaves about 14° of headroom before that.
    for (const def of STAGES) {
      const stage = new Stage(def);
      for (let d = 0; d < stage.length; d += 5) {
        const sample = stage.spline.at(d);
        const heading = Math.atan2(sample.forward.x, sample.forward.z);
        let yaw = stage.cameraZones[0]!.yaw!;
        for (const zone of stage.cameraZones) {
          if (d >= zone.from && zone.yaw !== undefined) yaw = zone.yaw;
        }
        expect(Math.cos(heading - yaw), `${def.id} at ${d.toFixed(0)} m`).toBeLessThan(0);
      }
    }
  });

  it('changes yaw at zone boundaries rather than continuously', () => {
    // The view is still fixed and still only pans; if this ever turns into a
    // chase camera that rotates with the car, that is a different game.
    const stage = new Stage(STAGES[0]!);
    expect(stage.cameraZones.length).toBeGreaterThan(1);
    expect(stage.cameraZones.length).toBeLessThan(stage.length / 40);
    expect(stage.cameraZones[0]!.from).toBe(0);
    for (let i = 1; i < stage.cameraZones.length; i++) {
      expect(stage.cameraZones[i]!.from).toBeGreaterThan(stage.cameraZones[i - 1]!.from);
    }
  });

  it('keeps the authored zoom for each part of the stage', () => {
    // Yaw is derived; zoom is a stage-authoring decision and must survive.
    const def = STAGES.find((s) => (s.cameraZones?.length ?? 0) > 0)!;
    const authored = def.cameraZones!.map((z) => z.zoom).filter((z) => z !== undefined);
    const derived = new Stage(def).cameraZones.map((z) => z.zoom);
    for (const zoom of derived) expect(authored).toContain(zoom);
  });
});
