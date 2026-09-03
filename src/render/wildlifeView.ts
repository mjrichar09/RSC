/**
 * Deer at the roadside.
 *
 * The pose carries the whole gameplay message, so it is deliberately readable
 * from a fixed isometric camera at speed: head down and side-on while grazing,
 * head up and turned to face the road once alert. That change is the only
 * warning the player gets, so it has to be visible in a glance, at 130 km/h,
 * in the rain.
 */

import * as THREE from 'three';
import type { Animal } from '../sim/wildlife.js';
import type { Vec3 } from '../sim/math.js';

/** Enough for any stage this game builds; a kilometre carries about three. */
const POOL = 8;

const HIDE = 0x6b5136;
const HIDE_ALERT = 0x8f6a44;

export class WildlifeView {
  readonly group = new THREE.Group();
  private readonly deer: { root: THREE.Group; head: THREE.Group; body: THREE.Mesh }[] = [];

  constructor(parent: THREE.Object3D) {
    const bodyGeo = new THREE.BoxGeometry(0.5, 0.62, 1.35);
    const neckGeo = new THREE.BoxGeometry(0.26, 0.5, 0.26);
    const headGeo = new THREE.BoxGeometry(0.26, 0.24, 0.44);
    const legGeo = new THREE.BoxGeometry(0.12, 0.75, 0.12);

    for (let i = 0; i < POOL; i++) {
      const root = new THREE.Group();
      const material = new THREE.MeshStandardMaterial({ color: HIDE, roughness: 0.85, metalness: 0 });

      const body = new THREE.Mesh(bodyGeo, material);
      body.position.y = 1.05;
      body.castShadow = true;
      root.add(body);

      for (const [x, z] of [
        [-0.18, 0.5],
        [0.18, 0.5],
        [-0.18, -0.5],
        [0.18, -0.5],
      ] as const) {
        const leg = new THREE.Mesh(legGeo, material);
        leg.position.set(x, 0.38, z);
        root.add(leg);
      }

      // Neck and head live in their own group so the whole assembly can pivot
      // at the shoulders — grazing is the head down between the front legs.
      const head = new THREE.Group();
      const neck = new THREE.Mesh(neckGeo, material);
      neck.position.set(0, 0.24, 0);
      head.add(neck);
      const skull = new THREE.Mesh(headGeo, material);
      skull.position.set(0, 0.5, 0.12);
      head.add(skull);
      head.position.set(0, 1.2, 0.62);
      root.add(head);

      root.visible = false;
      this.deer.push({ root, head, body });
      this.group.add(root);
    }

    parent.add(this.group);
  }

  /**
   * Pose from a recorded crash frame.
   *
   * A deer is placed and stepped by the simulation, so by the time the
   * cinematic runs it has moved on or been marked gone — and the replay showed
   * a car swerving at nothing and crumpling for no reason. The reel keeps where
   * each animal stood; this puts them back.
   */
  updateFromReel(animals: readonly { position: Vec3; yaw: number; gone: boolean }[]): void {
    for (let i = 0; i < this.deer.length; i++) {
      const view = this.deer[i]!;
      const animal = animals[i];
      // By index, exactly as `update` does: each view belongs to one animal for
      // the life of the stage, so filtering the list would shuffle every deer
      // after the first one that had been hit.
      if (!animal || animal.gone) {
        view.root.visible = false;
        continue;
      }
      view.root.visible = true;
      view.root.position.set(animal.position.x, animal.position.y, animal.position.z);
      view.root.rotation.y = animal.yaw;
      // Head up. An animal in the second before a crash has seen the car; a
      // grazing deer in a crash replay would be the wrong picture even if the
      // reel recorded the pose, which it deliberately does not.
      view.head.rotation.x = -0.15;
      (view.body.material as THREE.MeshStandardMaterial).color.setHex(HIDE_ALERT);
    }
  }

  update(animals: readonly Animal[]): void {
    for (let i = 0; i < this.deer.length; i++) {
      const view = this.deer[i]!;
      const animal = animals[i];
      if (!animal || animal.state === 'gone') {
        view.root.visible = false;
        continue;
      }

      view.root.visible = true;
      view.root.position.set(animal.position.x, animal.position.y, animal.position.z);
      view.root.rotation.y = animal.yaw;

      // Head down to graze, up the moment it has seen you. The tint shifts with
      // it, because a silhouette alone is hard to read against a dark verge at
      // night — and night is exactly when this matters.
      const alert = animal.state !== 'grazing';
      view.head.rotation.x = alert ? -0.15 : 1.15;
      (view.body.material as THREE.MeshStandardMaterial).color.setHex(
        alert ? HIDE_ALERT : HIDE,
      );
    }
  }

  clear(): void {
    for (const view of this.deer) view.root.visible = false;
  }
}
