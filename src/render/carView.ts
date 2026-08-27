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
import type { DamageModel } from '../sim/damage.js';
import type { GhostSample } from '../sim/replay.js';
import type { VehicleState } from '../sim/vehicle.js';
import { PALETTE } from './scene.js';

export interface CarViewOptions {
  /**
   * Render as a ghost: translucent, unlit-ish, no shadow and no contact
   * markers. It has to be legible enough to chase and faint enough that it is
   * never mistaken for the car you are driving.
   */
  ghost?: boolean;
}

const flat = (color: number, roughness = 0.6, ghost = false) =>
  new THREE.MeshStandardMaterial({
    color: ghost ? 0x5fd0ff : color,
    roughness,
    metalness: 0.05,
    flatShading: true,
    ...(ghost
      ? { transparent: true, opacity: 0.34, depthWrite: false, emissive: 0x143a4a }
      : {}),
  });

export class CarView {
  readonly group = new THREE.Group();

  private readonly chassis = new THREE.Group();
  private readonly wheels: THREE.Group[] = [];
  /** Marks where each tire is actually touching, and how hard it is sliding. */
  private readonly contactDots: THREE.Mesh[] = [];

  private readonly ghost: boolean;

  /** Undamaged pose of each deformable part, to deform away from. */
  private readonly restPose = new Map<THREE.Mesh, { position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }>();
  private nose!: THREE.Mesh;
  private cabin!: THREE.Mesh;
  private body!: THREE.Mesh;
  private wing!: THREE.Mesh;

  constructor(parent: THREE.Object3D, options: CarViewOptions = {}) {
    const h = CAR.halfExtents;
    const isGhost = options.ghost === true;
    this.ghost = isGhost;

    const body = new THREE.Mesh(new THREE.BoxGeometry(h.x * 2, h.y * 1.3, h.z * 2), flat(PALETTE.carBody, 0.6, isGhost));
    body.position.y = -0.05;
    body.castShadow = !isGhost;
    this.chassis.add(body);

    // Cabin, set back and narrowed — this is what makes the direction of travel
    // readable at a glance from a fixed isometric angle.
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.62, h.y * 1.0, h.z * 0.92),
      flat(PALETTE.carCabin, 0.4, isGhost),
    );
    cabin.position.set(0, h.y * 1.05, -0.16);
    cabin.castShadow = !isGhost;
    this.chassis.add(cabin);

    // Nose wedge in the bright accent colour: an unmistakable "this end is the
    // front" cue, which matters enormously when the car is sideways under a
    // fixed camera and you have to read its heading instantly.
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.5, h.y * 0.42, h.z * 0.34),
      flat(PALETTE.carAccent, 0.5, isGhost),
    );
    nose.position.set(0, h.y * 0.42, h.z * 0.86);
    nose.castShadow = !isGhost;
    this.chassis.add(nose);

    // Rear wing, in the dark cabin colour rather than the nose accent — two
    // bright ends would make the car's heading ambiguous at a glance.
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.95, h.y * 0.16, h.z * 0.2),
      flat(PALETTE.carCabin, 0.5, isGhost),
    );
    wing.position.set(0, h.y * 1.55, -h.z * 0.92);
    wing.castShadow = !isGhost;
    this.chassis.add(wing);

    this.group.add(this.chassis);

    const tireGeo = new THREE.CylinderGeometry(CAR.wheelRadius, CAR.wheelRadius, 0.26, 12);
    tireGeo.rotateZ(Math.PI / 2); // cylinder axis along local X, i.e. the axle
    const tireMat = flat(PALETTE.tire, 0.9, isGhost);
    const hubGeo = new THREE.BoxGeometry(0.28, CAR.wheelRadius * 0.9, CAR.wheelRadius * 0.9);
    const hubMat = flat(0xb9c0c9, 0.4, isGhost);

    for (let i = 0; i < 4; i++) {
      const wheel = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.castShadow = !isGhost;
      wheel.add(tire);
      // The hub spins with the wheel and makes rotation (and lockup) visible.
      wheel.add(new THREE.Mesh(hubGeo, hubMat));
      this.wheels.push(wheel);
      this.group.add(wheel);

      if (isGhost) continue;
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(0.3, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }),
      );
      dot.rotation.x = -Math.PI / 2;
      this.contactDots.push(dot);
      parent.add(dot);
    }

    parent.add(this.group);

    this.body = body;
    this.cabin = cabin;
    this.nose = nose;
    this.wing = wing;
    for (const mesh of [body, cabin, nose, wing]) {
      this.restPose.set(mesh, {
        position: mesh.position.clone(),
        scale: mesh.scale.clone(),
        color: (mesh.material as THREE.MeshStandardMaterial).color.clone(),
      });
    }
  }

  /**
   * Deform and discolour the car to match its condition.
   *
   * The damage panel says what is broken; this makes it visible on the thing
   * you are actually looking at. A crumpled nose and a sunken corner are read
   * without taking your eyes off the road, which an abstract readout never is.
   *
   * Purely presentational — nothing here feeds back into the simulation.
   */
  private applyDamage(damage: DamageModel): void {
    const crush = (
      mesh: THREE.Mesh,
      health: number,
      axis: 'x' | 'y' | 'z',
      shift: number,
      /** How dark this part may get. The nose keeps its brightness because it
       *  is the cue for which end is the front, and losing that on a damaged
       *  car costs more than the realism gains. */
      darkestAllowed = 0.45,
    ) => {
      const rest = this.restPose.get(mesh);
      if (!rest) return;
      const hurt = 1 - health;

      mesh.scale.copy(rest.scale);
      mesh.scale[axis] = rest.scale[axis] * (1 - hurt * 0.42);
      mesh.position.copy(rest.position);
      // Crumple inward, toward the middle of the car.
      mesh.position[axis] = rest.position[axis] - shift * hurt;

      // Damaged bodywork goes dull and dark rather than staying showroom.
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.color.copy(rest.color).multiplyScalar(1 - hurt * (1 - darkestAllowed));
      material.roughness = 0.6 + hurt * 0.35;
    };

    crush(this.nose, damage.get('panelFront'), 'z', 0.55, 0.8);
    crush(this.wing, damage.get('panelRear'), 'z', -0.35);
    crush(this.cabin, damage.get('panelRoof'), 'y', 0.22);
    crush(
      this.body,
      Math.min(damage.get('panelLeft'), damage.get('panelRight')),
      'x',
      0,
    );

    for (let i = 0; i < 4; i++) {
      const key = ['FL', 'FR', 'RL', 'RR'][i]!;
      const view = this.wheels[i]!;
      // A detached wheel is simply gone; a flat one squats on its rim.
      view.visible = damage.get(`hub${key}` as never) > 0;
      const tyre = damage.get(`tyre${key}` as never);
      view.scale.set(1, tyre <= 0 ? 0.55 : 1, 1);
    }
  }

  set visible(value: boolean) {
    this.group.visible = value;
    for (const dot of this.contactDots) dot.visible = value;
  }

  /** Pose this view from a recorded ghost frame rather than from live sim state. */
  updateFromGhost(sample: GhostSample): void {
    this.group.position.set(sample.position.x, sample.position.y, sample.position.z);
    this.group.quaternion.set(
      sample.rotation.x,
      sample.rotation.y,
      sample.rotation.z,
      sample.rotation.w,
    );
    for (let i = 0; i < 4; i++) {
      const mount = CAR.wheelPositions[i]!;
      const view = this.wheels[i]!;
      // Ghosts do not record suspension travel; it is not visible at this
      // opacity and it would cost four more floats a frame.
      view.position.set(mount.x, mount.y + CAR.suspensionRestLength * 0.5, mount.z);
      view.rotation.set(sample.wheelRotation[i]!, i < 2 ? sample.steer : 0, 0, 'YXZ');
    }
  }

  update(
    transform: { position: Vec3; rotation: Quat },
    state: VehicleState,
    damage: DamageModel | null = null,
  ): void {
    if (this.ghost) return;
    if (damage) this.applyDamage(damage);
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
