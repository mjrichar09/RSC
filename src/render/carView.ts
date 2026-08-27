/**
 * Visual representation of the car.
 *
 * Reads sim state, never writes it. Deliberately built from primitives: a
 * strong silhouette in flat-shaded blocks tells you everything you need about
 * body attitude, and it is the whole point of the "minimal now, models later"
 * approach — this file is the only thing that has to change later.
 */

import * as THREE from 'three';
import { CAR } from '../data/tuning.js';
import type { Quat, Vec3 } from '../sim/math.js';
import type { VehicleState } from '../sim/vehicle.js';
import { PALETTE } from './scene.js';

const flat = (color: number, roughness = 0.6) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05, flatShading: true });

export class CarView {
  readonly group = new THREE.Group();

  private readonly chassis = new THREE.Group();
  private readonly wheels: THREE.Group[] = [];
  /** Marks where each tire is actually touching, and how hard it is sliding. */
  private readonly contactDots: THREE.Mesh[] = [];

  constructor(parent: THREE.Object3D) {
    const h = CAR.halfExtents;

    const body = new THREE.Mesh(new THREE.BoxGeometry(h.x * 2, h.y * 1.3, h.z * 2), flat(PALETTE.carBody));
    body.position.y = -0.05;
    body.castShadow = true;
    this.chassis.add(body);

    // Cabin, set back and narrowed — this is what makes the direction of travel
    // readable at a glance from a fixed isometric angle.
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.62, h.y * 1.0, h.z * 0.92),
      flat(PALETTE.carCabin, 0.4),
    );
    cabin.position.set(0, h.y * 1.05, -0.16);
    cabin.castShadow = true;
    this.chassis.add(cabin);

    // Nose wedge in the bright accent colour: an unmistakable "this end is the
    // front" cue, which matters enormously when the car is sideways under a
    // fixed camera and you have to read its heading instantly.
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.5, h.y * 0.42, h.z * 0.34),
      flat(PALETTE.carAccent, 0.5),
    );
    nose.position.set(0, h.y * 0.42, h.z * 0.86);
    nose.castShadow = true;
    this.chassis.add(nose);

    // Rear wing, in the dark cabin colour rather than the nose accent — two
    // bright ends would make the car's heading ambiguous at a glance.
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.95, h.y * 0.16, h.z * 0.2),
      flat(PALETTE.carCabin, 0.5),
    );
    wing.position.set(0, h.y * 1.55, -h.z * 0.92);
    wing.castShadow = true;
    this.chassis.add(wing);

    this.group.add(this.chassis);

    const tireGeo = new THREE.CylinderGeometry(CAR.wheelRadius, CAR.wheelRadius, 0.26, 12);
    tireGeo.rotateZ(Math.PI / 2); // cylinder axis along local X, i.e. the axle
    const tireMat = flat(PALETTE.tire, 0.9);
    const hubGeo = new THREE.BoxGeometry(0.28, CAR.wheelRadius * 0.9, CAR.wheelRadius * 0.9);
    const hubMat = flat(0xb9c0c9, 0.4);

    for (let i = 0; i < 4; i++) {
      const wheel = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.castShadow = true;
      wheel.add(tire);
      // The hub spins with the wheel and makes rotation (and lockup) visible.
      wheel.add(new THREE.Mesh(hubGeo, hubMat));
      this.wheels.push(wheel);
      this.group.add(wheel);

      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(0.3, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }),
      );
      dot.rotation.x = -Math.PI / 2;
      this.contactDots.push(dot);
      parent.add(dot);
    }

    parent.add(this.group);
  }

  update(transform: { position: Vec3; rotation: Quat }, state: VehicleState): void {
    const { position, rotation } = transform;
    this.group.position.set(position.x, position.y, position.z);
    this.group.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

    for (let i = 0; i < 4; i++) {
      const w = state.wheels[i]!;
      const mount = CAR.wheelPositions[i]!;
      const view = this.wheels[i]!;

      // Suspension travel: an ungrounded wheel hangs at full droop.
      const drop = w.grounded ? (1 - w.compression) * CAR.suspensionRestLength : CAR.suspensionRestLength;
      view.position.set(mount.x, mount.y - drop + CAR.suspensionRestLength * 0.5, mount.z);
      view.rotation.set(w.rotation, w.steer, 0, 'YXZ');

      const dot = this.contactDots[i]!;
      const mat = dot.material as THREE.MeshBasicMaterial;
      if (w.grounded) {
        dot.position.set(w.contact.x, w.contact.y + 0.02, w.contact.z);
        // Fades in as the tire passes its grip peak — a free, always-on readout
        // of exactly which corner is letting go.
        mat.opacity = Math.min(Math.max(w.saturation - 0.85, 0) * 1.6, 0.7);
        mat.color.setHSL(0.14 - Math.min(w.saturation - 1, 1) * 0.14, 0.9, 0.6);
      } else {
        mat.opacity = 0;
      }
    }
  }
}
