/**
 * Loose parts, drawn.
 *
 * The simulation owns a small, capped set of debris bodies; this is a matching
 * pool of boxes that follows them. Pooled rather than created on detachment
 * because parts come off in the middle of a stage, and allocating geometry at
 * that moment is exactly when a frame can least afford it.
 */

import * as THREE from 'three';
import type { LooseBody } from '../sim/world.js';
import { PALETTE } from './scene.js';

/** Matches `DEBRIS_BUDGET` in the simulation. */
const POOL = 12;

export class DebrisView {
  readonly group = new THREE.Group();
  private readonly boxes: THREE.Mesh[] = [];

  constructor(parent: THREE.Object3D) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: PALETTE.carBody, roughness: 0.7, metalness: 0 }),
      );
      mesh.castShadow = true;
      mesh.visible = false;
      this.boxes.push(mesh);
      this.group.add(mesh);
    }
    parent.add(this.group);
  }

  /** Pose the pool from the simulation's loose bodies. */
  update(loose: readonly LooseBody[]): void {
    for (let i = 0; i < this.boxes.length; i++) {
      const mesh = this.boxes[i]!;
      const entry = loose[i];
      if (!entry) {
        mesh.visible = false;
        continue;
      }
      const p = entry.body.translation();
      const r = entry.body.rotation();
      const half = entry.half;
      mesh.visible = true;
      mesh.position.set(p.x, p.y, p.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
      mesh.scale.set(half.x * 2, half.y * 2, half.z * 2);
    }
  }

  clear(): void {
    for (const mesh of this.boxes) mesh.visible = false;
  }
}
