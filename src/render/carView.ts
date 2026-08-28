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
import type { ComponentId, DamageModel } from '../sim/damage.js';
import type { DebrisModel, PartId } from '../sim/debris.js';
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
  /**
   * Body colour. Rival cars in a network race are told apart by paint, which
   * is the only cue that survives all four of them being sideways in a cloud
   * of gravel at once.
   */
  body?: number;
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

/**
 * Deterministic value noise from a position, 0..1.
 *
 * Keyed off the vertex rather than drawn from a stream, so the same car
 * crumples identically on every machine rendering it — which matters the moment
 * two people are looking at the same car in a network race.
 */
function hash3(x: number, y: number, z: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/** A crazed windscreen: milky, not shattered — this car still has to be driven. */
const WINDSCREEN_CRAZED = new THREE.Color(0xd8dee3);

/** Disc colours: cool cast iron, heat-tinted bronze, cherry red, and white heat. */
const DISC_COLD = new THREE.Color(0x8d949c);
const DISC_TINT = new THREE.Color(0x6b4a34);
const DISC_GLOW = new THREE.Color(0xff3b12);
const DISC_WHITE = new THREE.Color(0xffd9a0);

export class CarView {
  readonly group = new THREE.Group();

  private readonly chassis = new THREE.Group();
  private readonly wheels: THREE.Group[] = [];
  private readonly discs: THREE.Mesh[] = [];

  private readonly ghost: boolean;

  /**
   * Undeformed vertex positions of everything that can crumple.
   *
   * Deformation is applied from these each time rather than accumulated onto
   * the live geometry: a car that folded a little further on every frame would
   * fold itself flat in about ten seconds.
   */
  private readonly restGeometry = new Map<THREE.Mesh, Float32Array>();
  /** Dent set the current geometry was built from. */
  private dentVersion = -1;
  /** Undamaged pose of each deformable part, to deform away from. */
  private readonly restPose = new Map<THREE.Mesh, { position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }>();
  private nose!: THREE.Mesh;
  /** Headlight beams, and the glowing lamp faces that go with them. */
  private readonly headlights: THREE.SpotLight[] = [];
  private readonly lamps: THREE.Mesh[] = [];
  /** How much headlights matter here: 0 in daylight, 1 at night. */
  private headlightWeight = 0;
  private cabin!: THREE.Mesh;
  private body!: THREE.Mesh;
  private screen!: THREE.Mesh;
  /** The panels that can come off, and where they sit while they are still on. */
  private readonly parts = new Map<PartId, THREE.Mesh>();
  private readonly partRest = new Map<PartId, THREE.Vector3>();
  /** Which component's health deforms each panel. */
  private readonly partComponent = new Map<PartId, ComponentId>();

  constructor(parent: THREE.Object3D, options: CarViewOptions = {}) {
    const h = CAR.halfExtents;
    const isGhost = options.ghost === true;
    const bodyColor = options.body ?? PALETTE.carBody;
    this.ghost = isGhost;

    // Segmented, not because the shape needs it but because a box with eight
    // corners cannot be dented: crumple is vertices moving, and a face with no
    // vertices in the middle of it can only ever be scaled.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 2, h.y * 1.3, h.z * 2, 5, 3, 7),
      flat(bodyColor, 0.6, isGhost),
    );
    body.position.y = -0.05;
    body.castShadow = !isGhost;
    this.chassis.add(body);

    // Cabin, set back and narrowed — this is what makes the direction of travel
    // readable at a glance from a fixed isometric angle.
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.62, h.y * 1.0, h.z * 0.92, 4, 3, 4),
      flat(PALETTE.carCabin, 0.4, isGhost),
    );
    cabin.position.set(0, h.y * 1.05, -0.16);
    cabin.castShadow = !isGhost;
    this.chassis.add(cabin);

    // Nose wedge in the bright accent colour: an unmistakable "this end is the
    // front" cue, which matters enormously when the car is sideways under a
    // fixed camera and you have to read its heading instantly.
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.5, h.y * 0.42, h.z * 0.34, 5, 2, 2),
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

    // Bolt-on panels, each its own mesh.
    //
    // Two reasons, and both are gameplay rather than decoration: a panel has to
    // be able to *leave*, and a panel that deforms on its own shows you where
    // the car was hit. One body mesh can only say "damaged"; twelve say "the
    // front left is folded in and the mirror is gone", which is a thing you can
    // look at and price.
    const panelMat = () => flat(bodyColor, 0.55, isGhost);
    const trimMat = () => flat(PALETTE.carCabin, 0.55, isGhost);

    const box = (x: number, y: number, z: number) =>
      // Enough segments to fold, few enough that twelve panels cost nothing.
      new THREE.BoxGeometry(x, y, z, 3, 2, 3);
    /** id, geometry, position, material, and the component that deforms it. */
    const panels: [PartId, THREE.BoxGeometry, [number, number, number], THREE.Material, ComponentId][] = [
      ['bonnet', box(h.x * 1.5, h.y * 0.12, h.z * 0.6), [0, h.y * 0.62, h.z * 0.42], panelMat(), 'bonnet'],
      ['boot', box(h.x * 1.45, h.y * 0.12, h.z * 0.42), [0, h.y * 0.6, -h.z * 0.62], panelMat(), 'boot'],
      ['bumperFront', box(h.x * 1.72, h.y * 0.24, h.z * 0.12), [0, -h.y * 0.28, h.z * 0.99], trimMat(), 'panelFront'],
      ['bumperRear', box(h.x * 1.72, h.y * 0.24, h.z * 0.12), [0, -h.y * 0.28, -h.z * 0.99], trimMat(), 'panelRear'],
      ['wingFL', box(h.x * 0.16, h.y * 0.5, h.z * 0.42), [-h.x * 0.98, h.y * 0.15, h.z * 0.6], panelMat(), 'wingFL'],
      ['wingFR', box(h.x * 0.16, h.y * 0.5, h.z * 0.42), [h.x * 0.98, h.y * 0.15, h.z * 0.6], panelMat(), 'wingFR'],
      ['doorLeft', box(h.x * 0.12, h.y * 0.62, h.z * 0.5), [-h.x * 1.02, h.y * 0.2, -0.08], panelMat(), 'doorL'],
      ['doorRight', box(h.x * 0.12, h.y * 0.62, h.z * 0.5), [h.x * 1.02, h.y * 0.2, -0.08], panelMat(), 'doorR'],
      ['quarterRL', box(h.x * 0.16, h.y * 0.5, h.z * 0.42), [-h.x * 0.98, h.y * 0.15, -h.z * 0.62], panelMat(), 'quarterRL'],
      ['quarterRR', box(h.x * 0.16, h.y * 0.5, h.z * 0.42), [h.x * 0.98, h.y * 0.15, -h.z * 0.62], panelMat(), 'quarterRR'],
      ['mirrorL', box(0.1, 0.1, 0.16), [-h.x * 1.12, h.y * 0.62, h.z * 0.3], trimMat(), 'mirrorL'],
      ['mirrorR', box(0.1, 0.1, 0.16), [h.x * 1.12, h.y * 0.62, h.z * 0.3], trimMat(), 'mirrorR'],
      ['exhaust', box(0.1, 0.1, h.z * 0.3), [h.x * 0.45, -h.y * 0.62, -h.z * 1.02], trimMat(), 'exhaust'],
      ['wing', box(h.x * 1.95, h.y * 0.16, h.z * 0.2), [0, h.y * 1.55, -h.z * 0.92], trimMat(), 'panelRear'],
    ];

    for (const [id, geometry, position, material, component] of panels) {
      // The rear wing was built above so the nose/cabin block could reference
      // it; everything else is created here.
      const mesh = id === 'wing' ? wing : new THREE.Mesh(geometry, material);
      if (id !== 'wing') {
        mesh.position.set(position[0], position[1], position[2]);
        this.chassis.add(mesh);
      }
      mesh.castShadow = !isGhost;
      this.parts.set(id, mesh);
      this.partRest.set(id, mesh.position.clone());
      this.partComponent.set(id, component);
      if (!isGhost) this.keepRestGeometry(mesh);
      this.restPose.set(mesh, {
        position: mesh.position.clone(),
        scale: mesh.scale.clone(),
        color: (mesh.material as THREE.MeshStandardMaterial).color.clone(),
      });
    }

    // The windscreen is not detachable, but it does crack and darken, and it is
    // the one panel whose damage is read from inside the silhouette.
    const screen = new THREE.Mesh(
      box(h.x * 1.4, h.y * 0.5, h.z * 0.06),
      flat(0x9fb6c4, 0.2, isGhost),
    );
    screen.position.set(0, h.y * 1.0, h.z * 0.36);
    screen.castShadow = false;
    this.chassis.add(screen);
    this.screen = screen;
    this.restPose.set(screen, {
      position: screen.position.clone(),
      scale: screen.scale.clone(),
      color: (screen.material as THREE.MeshStandardMaterial).color.clone(),
    });

    this.group.add(this.chassis);

    const tireGeo = new THREE.CylinderGeometry(CAR.wheelRadius, CAR.wheelRadius, 0.26, 12);
    tireGeo.rotateZ(Math.PI / 2); // cylinder axis along local X, i.e. the axle
    const tireMat = flat(PALETTE.tire, 0.9, isGhost);
    const hubGeo = new THREE.BoxGeometry(0.28, CAR.wheelRadius * 0.9, CAR.wheelRadius * 0.9);
    const hubMat = flat(0xb9c0c9, 0.4, isGhost);
    // The disc is a ring on the *outboard* face, which is how you see one on a
    // real car: through the wheel, around the hub. A cylinder tucked inside the
    // tyre was invisible from an isometric camera — the tyre is in front of it.
    // MeshBasic because a hot disc emits its own light, and has to read at
    // night, which is when it matters most.
    const discGeo = new THREE.RingGeometry(CAR.wheelRadius * 0.42, CAR.wheelRadius * 0.76, 16);
    discGeo.rotateY(Math.PI / 2);

    for (let i = 0; i < 4; i++) {
      const wheel = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.castShadow = !isGhost;
      wheel.add(tire);
      // The hub spins with the wheel and makes rotation (and lockup) visible.
      wheel.add(new THREE.Mesh(hubGeo, hubMat));
      // Each disc owns its material: four corners reach four temperatures, and
      // the front pair does most of the work.
      const disc = new THREE.Mesh(
        discGeo,
        new THREE.MeshBasicMaterial({ color: DISC_COLD, side: THREE.DoubleSide }),
      );
      disc.position.x = i % 2 === 0 ? -0.135 : 0.135;
      wheel.add(disc);
      this.discs.push(disc);
      this.wheels.push(wheel);
      this.group.add(wheel);

    }

    parent.add(this.group);

    if (!isGhost) this.buildHeadlights(h);

    this.body = body;
    this.cabin = cabin;
    this.nose = nose;
    for (const mesh of [body, cabin, nose, wing]) {
      if (!isGhost) this.keepRestGeometry(mesh);
      this.restPose.set(mesh, {
        position: mesh.position.clone(),
        scale: mesh.scale.clone(),
        color: (mesh.material as THREE.MeshStandardMaterial).color.clone(),
      });
    }
  }

  /**
   * Remember a mesh's undamaged vertices, and give it geometry of its own.
   *
   * The panels are built from a shared `box()` helper, and two panels sharing
   * one BufferGeometry would crumple as one — a dent in the left door would
   * appear in the right one too.
   */
  private keepRestGeometry(mesh: THREE.Mesh): void {
    if (this.restGeometry.has(mesh)) return;
    mesh.geometry = mesh.geometry.clone();
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.restGeometry.set(mesh, Float32Array.from(position.array as Float32Array));
  }

  /**
   * Headlights.
   *
   * Two spotlights down the nose, plus the lamp faces that show they are lit.
   * Their intensity and reach come from the `lights` component, which until now
   * was a repair line with nothing behind it — 260 to fix something that had
   * never once mattered. On a night variant it decides whether you can see the
   * next corner.
   */
  private buildHeadlights(h: { x: number; y: number; z: number }): void {
    const lampGeo = new THREE.BoxGeometry(0.3, 0.16, 0.1);

    for (const side of [-1, 1]) {
      // Decay 0: this is an arcade light meant to reach 90 m of road, not a
      // physically-falling-off lamp. With realistic decay the beam dies a few
      // metres from the bumper and lights nothing you need to see.
      const beam = new THREE.SpotLight(0xfff0d0, 0, 95, 0.55, 0.45, 0);
      beam.position.set(side * h.x * 0.62, h.y * 0.35, h.z * 0.95);
      // The target has to be parented to the car too, or the beam stays
      // pointing at wherever the car happened to be when the scene was built.
      beam.target.position.set(side * h.x * 0.62, -h.y * 0.6, h.z * 0.95 + 18);
      this.chassis.add(beam);
      this.chassis.add(beam.target);
      this.headlights.push(beam);

      const lamp = new THREE.Mesh(
        lampGeo,
        new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 0 }),
      );
      lamp.position.set(side * h.x * 0.55, h.y * 0.35, h.z * 0.99);
      this.chassis.add(lamp);
      this.lamps.push(lamp);
    }
  }

  /** Tell the car how much the headlights matter here. */
  setHeadlightWeight(weight: number): void {
    this.headlightWeight = weight;
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
  /**
   * Fold the metal in where the car was actually hit.
   *
   * The damage model records dents — a point in the car's own frame and a
   * depth — and this pushes every vertex within reach of one toward it, with a
   * hashed wobble so the fold is uneven. That unevenness is the whole effect:
   * a panel displaced smoothly reads as a dented balloon, and the same panel
   * displaced by a couple of centimetres of noise reads as sheet metal that has
   * been folded and cannot be unfolded.
   *
   * Rebuilt only when the dents change. They change a handful of times in a
   * race and never between them, and reshaping fifteen meshes is not something
   * to do sixty times a second for no reason.
   */
  private applyCrumple(damage: DamageModel): void {
    if (damage.dentVersion === this.dentVersion) return;
    this.dentVersion = damage.dentVersion;

    for (const [mesh, rest] of this.restGeometry) {
      const attribute = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const array = attribute.array as Float32Array;
      array.set(rest);

      if (damage.dents.length > 0) {
        for (let i = 0; i < array.length; i += 3) {
          // The vertex in the car's frame, which is the frame the dents are in.
          const x = rest[i]! + mesh.position.x;
          const y = rest[i + 1]! + mesh.position.y;
          const z = rest[i + 2]! + mesh.position.z;

          let dx = 0;
          let dy = 0;
          let dz = 0;
          for (const dent of damage.dents) {
            const ox = dent.at.x - x;
            const oy = dent.at.y - y;
            const oz = dent.at.z - z;
            const distance = Math.hypot(ox, oy, oz);
            if (distance > dent.reach) continue;

            // Squared falloff: sharp at the point of contact, gone by the edge.
            const fall = (1 - distance / dent.reach) ** 2;
            const push = fall * dent.depth * 0.85;
            const scale = distance > 1e-4 ? push / distance : 0;
            dx += ox * scale;
            dy += oy * scale;
            dz += oz * scale;

            // Torn rather than pressed: a few centimetres of deterministic
            // noise, keyed off the vertex position so the same car crumples
            // the same way on every machine showing it.
            const wobble = fall * dent.depth * 0.09;
            dx += (hash3(x, y, z) - 0.5) * wobble;
            dy += (hash3(y, z, x) - 0.5) * wobble;
            dz += (hash3(z, x, y) - 0.5) * wobble;
          }

          array[i] = rest[i]! + dx;
          array[i + 1] = rest[i + 1]! + dy;
          array[i + 2] = rest[i + 2]! + dz;
        }
      }

      attribute.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }
  }

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
      mesh.scale[axis] = rest.scale[axis] * (1 - hurt * 0.52);
      mesh.position.copy(rest.position);
      // Crumple inward, toward the middle of the car.
      mesh.position[axis] = rest.position[axis] - shift * hurt;

      // Damaged bodywork goes dull and dark rather than staying showroom.
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.color.copy(rest.color).multiplyScalar(1 - hurt * (1 - darkestAllowed));
      material.roughness = 0.6 + hurt * 0.35;
    };

    crush(this.nose, damage.get('panelFront'), 'z', 0.55, 0.8);
    crush(this.cabin, damage.get('panelRoof'), 'y', 0.22);
    crush(
      this.body,
      Math.min(damage.get('panelLeft'), damage.get('panelRight')),
      'x',
      0,
    );

    // Every bolt-on panel folds along the axis it faces, toward the middle of
    // the car, and takes a twist with it. The twist is what turns a uniform
    // squash into something that reads as crumpled: a dented wing sits skewed,
    // not merely smaller.
    for (const [id, mesh] of this.parts) {
      const component = this.partComponent.get(id);
      if (!component) continue;
      const rest = this.partRest.get(id)!;
      const health = damage.get(component);
      const hurt = 1 - health;

      // Panels on the flanks fold inward across the car; ends fold along it.
      const lateral = Math.abs(rest.x) > 0.5;
      crush(mesh, health, lateral ? 'x' : 'z', lateral ? Math.sign(rest.x) * 0.16 : Math.sign(rest.z) * 0.3);
      if (hurt > 0.02) {
        // Signed from the panel's own position so the two sides fold opposite
        // ways rather than all leaning together.
        const twist = hurt * 0.68;
        mesh.rotation.set(
          lateral ? 0 : twist * Math.sign(rest.z || 1),
          twist * 0.6 * Math.sign(rest.x || 1),
          lateral ? twist * Math.sign(rest.x || 1) : twist * 0.4,
        );
      } else {
        mesh.rotation.set(0, 0, 0);
      }
    }

    // The windscreen goes milky and dark as it crazes, rather than deforming.
    const screenRest = this.restPose.get(this.screen);
    if (screenRest) {
      const cracked = 1 - damage.get('windscreen');
      const material = this.screen.material as THREE.MeshStandardMaterial;
      material.color.copy(screenRest.color).lerp(WINDSCREEN_CRAZED, cracked);
      material.roughness = 0.2 + cracked * 0.7;
    }

    // Headlights: below half health one side dies outright, so the beam goes
    // lopsided before it goes dark. That is a far more useful warning than a
    // dimmer being turned down evenly.
    const lightsHealth = damage.get('lights');
    for (let i = 0; i < this.headlights.length; i++) {
      const sideAlive = i === 0 || lightsHealth > 0.5;
      const strength = sideAlive ? lightsHealth : 0;
      const beam = this.headlights[i]!;
      beam.intensity = strength * this.headlightWeight * 30;
      beam.distance = 40 + strength * 65;
      beam.angle = 0.4 + strength * 0.18;
      const lamp = this.lamps[i]!.material as THREE.MeshBasicMaterial;
      lamp.opacity = strength * this.headlightWeight;
    }

    for (let i = 0; i < 4; i++) {
      const key = ['FL', 'FR', 'RL', 'RR'][i]!;
      const view = this.wheels[i]!;
      // A detached wheel is simply gone; a flat one squats on its rim.
      view.visible = damage.get(`hub${key}` as never) > 0;
      const tyre = damage.get(`tyre${key}` as never);
      view.scale.set(1, tyre <= 0 ? 0.55 : 1, 1);

      // Cold grey → oxidised bronze → red → orange-white, in two stages, the
      // same two the thermal model reports: discolouration first, then light.
      const disc = this.discs[i];
      if (disc) {
        const mat = disc.material as THREE.MeshBasicMaterial;
        mat.color.copy(DISC_COLD).lerp(DISC_TINT, damage.brakeTint(i));
        const glow = damage.brakeGlow(i);
        if (glow > 0) mat.color.lerp(DISC_GLOW, glow).lerp(DISC_WHITE, glow * glow);
      }
    }
  }

  /**
   * Show what the debris model says: a gone part is gone, and a dragging one
   * hangs at one corner and scrapes. The dragging pose is the telegraph — it is
   * the only warning the player gets before the part finally lets go.
   */
  private applyDebris(debris: DebrisModel): void {
    for (const [id, mesh] of this.parts) {
      const state = debris.stateOf(id);
      mesh.visible = state !== 'gone';
      const rest = this.partRest.get(id)!;
      // These poses are applied *after* the damage deformation and deliberately
      // override it: a part that is hanging off is no longer sitting where its
      // dents left it.
      if (state === 'dragging') {
        mesh.position.set(rest.x - 0.12, rest.y - 0.2, rest.z);
        mesh.rotation.set(0, 0, 0.5);
      } else if (debris.isLoose(id)) {
        // Sitting proud and skewed: the tell that this one is about to go.
        mesh.position.set(rest.x, rest.y + 0.07, rest.z);
        mesh.rotation.set(-0.18, 0, 0.06);
      }
    }
  }

  /** Where a dragging part touches the road, in world space, for sparks. */
  dragPoint(id: PartId): THREE.Vector3 | null {
    const mesh = this.parts.get(id);
    if (!mesh || !mesh.visible) return null;
    return mesh.getWorldPosition(new THREE.Vector3());
  }

  set visible(value: boolean) {
    this.group.visible = value;
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
    debris: DebrisModel | null = null,
  ): void {
    if (this.ghost) return;
    if (damage) {
      this.applyDamage(damage);
      this.applyCrumple(damage);
    }
    if (debris) this.applyDebris(debris);
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

    }
  }
}
