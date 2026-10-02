/**
 * A rocket on a pad beside the start, which goes on the green.
 *
 * Scenery with a clock. Where the pad stands is the simulation's
 * (`Stage.launchPad`, which refuses anywhere a car could reach), so this only
 * draws it; and what it is doing is a pure function of one number — seconds
 * from the green, negative through the countdown — so a screenshot of
 * `red-planet@4` shows it four seconds up, exactly as the live game does at
 * that moment. Nothing here reads a wall clock except the flicker.
 *
 * The timeline:
 *   before -3 s   standing, venting
 *   -3 s to 0     ignition: the engines light and smoke boils off the pad
 *   0             liftoff, on the green
 *   after         climbing faster and faster, pitching over down-range,
 *                 and gone off the top of the frame within a few seconds
 */

import * as THREE from 'three';
import type { Vec3 } from '../sim/math.js';
import { ParticleField } from './fx.js';

/** Total height, base of the engine bell to the tip, metres. */
const HEIGHT = 30;
const RADIUS = 1.9;
/** When the engines light, seconds before the green. */
const IGNITION = -3;
/** After this the rocket is too high to matter and is not drawn. */
const GONE = 30;
/**
 * Height of the launch table the rocket stands on, metres. It stood on the pad
 * itself at first, and its engine bell and flame went through the pad's
 * surface, which flickered in and out as the flame did.
 */
const MOUNT = 3.5;

export interface RocketPose {
  /** Height of the base above the pad, metres. */
  altitude: number;
  /** Pitch-over, radians. */
  lean: number;
  /** Engine output, 0..1. */
  thrust: number;
}

/** Where the rocket is `t` seconds from the green. */
export function rocketFlight(t: number): RocketPose {
  if (t < IGNITION) return { altitude: 0, lean: 0, thrust: 0 };
  if (t < 0) return { altitude: 0, lean: 0, thrust: Math.min((t - IGNITION) / 1.2, 1) * 0.85 };
  // Slow off the pad and then quicker and quicker: a rocket's acceleration
  // grows as it burns its own mass away.
  return {
    altitude: 1.4 * t * t + 0.3 * t * t * t,
    lean: Math.min(0.012 * t * t, 0.6),
    thrust: 1,
  };
}

const WHITE = 0xeceae4;
const DARK = 0x26282c;
const STEEL = 0x6e7177;
const CONCRETE = 0x9a8e84;
const SMOKE = new THREE.Color(0xe8ddd0);
const FLAME = 0xffb04a;
const CORE = 0xfff1c4;

export class RocketView {
  readonly group = new THREE.Group();
  /** The vehicle itself, which leaves; the pad and the tower stay. */
  private readonly vehicle = new THREE.Group();
  private readonly flame: THREE.Mesh;
  private readonly core: THREE.Mesh;
  private readonly arm: THREE.Group;
  private readonly jets: THREE.Mesh[] = [];
  private readonly padGlow: THREE.Mesh;
  private readonly smoke: ParticleField;
  private flicker = 0;
  /** What it was last posed at, for the harness's status line. */
  pose: { t: number; altitude: number } = { t: 0, altitude: 0 };

  constructor(parent: THREE.Object3D) {
    const solid = (color: number, roughness = 0.6, metalness = 0) =>
      new THREE.MeshStandardMaterial({ color, roughness, metalness });
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, to: THREE.Object3D, at: Vec3) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(at.x, at.y, at.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      to.add(mesh);
      return mesh;
    };
    const white = solid(WHITE, 0.45);
    // A floor of its own colour: the side the camera sees is the shaded one,
    // and lit only by red ground a white rocket read as brown.
    white.emissive.setHex(0x4a4744);
    const dark = solid(DARK, 0.5);
    const steel = solid(STEEL, 0.5, 0.4);

    // The pad: a slab, and a flame trench across it. The trench stands a few
    // centimetres proud: with its top level with the slab's, the two faces
    // fought for the same pixels and the pad blinked under the rocket.
    add(new THREE.BoxGeometry(18, 1.2, 18), solid(CONCRETE, 0.9), this.group, { x: 0, y: -0.4, z: 0 });
    add(new THREE.BoxGeometry(18.2, 0.1, 3.2), dark, this.group, { x: 0, y: 0.25, z: 0 });
    // The launch table: a ring on four legs, open in the middle for the flame.
    const table = new THREE.Mesh(new THREE.TorusGeometry(RADIUS + 0.5, 0.3, 8, 24), steel);
    table.rotation.x = Math.PI / 2;
    table.position.y = MOUNT - 0.2;
    table.castShadow = true;
    this.group.add(table);
    for (const [x, z] of [
      [2.4, 2.4],
      [-2.4, 2.4],
      [2.4, -2.4],
      [-2.4, -2.4],
    ] as const) {
      add(new THREE.BoxGeometry(0.5, MOUNT, 0.5), steel, this.group, { x, y: MOUNT / 2, z });
    }

    // The vehicle, built from its base upward.
    const body = HEIGHT - 8;
    add(new THREE.CylinderGeometry(RADIUS * 0.75, RADIUS * 1.05, 2.2, 16), dark, this.vehicle, {
      x: 0,
      y: 1.1,
      z: 0,
    });
    add(new THREE.CylinderGeometry(RADIUS, RADIUS, body, 20), white, this.vehicle, { x: 0, y: 2.2 + body / 2, z: 0 });
    // Bands, for scale and for a spin you can see.
    for (const y of [5, 13.5]) {
      add(new THREE.CylinderGeometry(RADIUS * 1.01, RADIUS * 1.01, 0.9, 20), dark, this.vehicle, { x: 0, y, z: 0 });
    }
    add(new THREE.ConeGeometry(RADIUS, 5.8, 20), white, this.vehicle, { x: 0, y: 2.2 + body + 2.9, z: 0 });
    for (let i = 0; i < 4; i++) {
      const fin = add(new THREE.BoxGeometry(0.25, 4, 2.6), dark, this.vehicle, { x: 0, y: 4, z: 0 });
      fin.geometry.translate(0, 0, RADIUS + 1.1);
      fin.rotation.y = (i * Math.PI) / 2 + Math.PI / 4;
    }

    // The flame: two cones hanging from the bell, lit from inside.
    const glow = (color: number, opacity: number) =>
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
    // A unit cone, wide end at the bell and point one metre below it; scaled
    // to length by the thrust.
    const flameGeometry = new THREE.ConeGeometry(1.6, 1, 16, 1, true);
    flameGeometry.rotateX(Math.PI);
    flameGeometry.translate(0, -0.5, 0);
    this.flame = new THREE.Mesh(flameGeometry, glow(FLAME, 0.85));
    this.core = new THREE.Mesh(flameGeometry, glow(CORE, 0.95));
    this.core.scale.set(0.5, 1, 0.5);
    for (const f of [this.flame, this.core]) {
      f.position.y = 0;
      f.visible = false;
      this.vehicle.add(f);
    }
    this.group.add(this.vehicle);

    // What the trench throws out: two jets of flame along it, either way, and
    // the glow of the fire on the concrete. Both fade as the rocket climbs.
    const jetGeometry = new THREE.ConeGeometry(1.5, 1, 14, 1, true);
    jetGeometry.translate(0, -0.5, 0);
    for (const side of [1, -1]) {
      const jet = new THREE.Mesh(jetGeometry, glow(FLAME, 0.8));
      jet.rotation.z = (side * Math.PI) / 2;
      jet.position.set(0, 0.9, 0);
      jet.visible = false;
      this.group.add(jet);
      this.jets.push(jet);
    }
    this.padGlow = new THREE.Mesh(new THREE.CircleGeometry(7, 24), glow(FLAME, 0.5));
    this.padGlow.rotation.x = -Math.PI / 2;
    this.padGlow.position.y = 0.32;
    this.padGlow.visible = false;
    this.group.add(this.padGlow);

    // The tower, on the far side from the road. Up the road from it instead,
    // the camera — which looks along the road — saw the two in one column and
    // the lattice hid the rocket entirely.
    const tower = new THREE.Group();
    tower.position.set(-6.5, 0, 0);
    for (const [x, z] of [
      [-1.4, -1.4],
      [1.4, -1.4],
      [-1.4, 1.4],
      [1.4, 1.4],
    ] as const) {
      add(new THREE.BoxGeometry(0.35, HEIGHT + 4, 0.35), steel, tower, { x, y: (HEIGHT + 4) / 2, z });
    }
    for (let y = 3; y < HEIGHT + 4; y += 4) {
      add(new THREE.BoxGeometry(3.2, 0.25, 3.2), steel, tower, { x: 0, y, z: 0 });
    }
    this.arm = new THREE.Group();
    this.arm.position.set(1.4, HEIGHT - 6, 0);
    add(new THREE.BoxGeometry(3.4, 0.6, 0.9), steel, this.arm, { x: 1.7, y: 0, z: 0 });
    tower.add(this.arm);
    this.group.add(tower);

    // Its own smoke. A cloud that has to hang for seconds over a pad cannot
    // share a pool with gravel spray, which churns through one in half a second.
    this.smoke = new ParticleField(parent, 40, { haze: 2000 });
    this.smoke.fadeIn = 0.15;

    this.group.visible = false;
    parent.add(this.group);
  }

  /**
   * Stand it on a stage's pad, or take it away. `awayFromRoad` is the yaw that
   * points the group's -X away from the road, which is where the tower stands.
   */
  attach(pad: Vec3 | null, awayFromRoad = 0): void {
    this.group.visible = pad !== null;
    if (!pad) return;
    this.group.position.set(pad.x, pad.y, pad.z);
    this.group.rotation.y = awayFromRoad;
    this.vehicle.position.set(0, 0, 0);
    this.vehicle.rotation.set(0, 0, 0);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  setScale(pixelsPerMetre: number): void {
    this.smoke.setScale(pixelsPerMetre);
  }

  /** Pose it `t` seconds from the green, and advance its smoke by `dt`. */
  update(t: number, dt: number): void {
    this.smoke.update(dt);
    if (!this.group.visible) return;
    const pose = rocketFlight(t);
    this.pose = { t: +t.toFixed(2), altitude: +pose.altitude.toFixed(1) };
    this.vehicle.visible = t < GONE;
    // Pitches over down-range, along the road, so it climbs away up the
    // screen rather than toward the tower.
    this.vehicle.position.set(0, MOUNT + pose.altitude, Math.sin(pose.lean) * pose.altitude * 0.25);
    this.vehicle.rotation.x = pose.lean;
    // The arm swings clear as the engines light.
    const swing = Math.min(Math.max((t - IGNITION + 1) / 2, 0), 1);
    this.arm.rotation.y = swing * 1.6;

    this.flicker += dt * 37;
    const on = pose.thrust > 0.01 && t < GONE;
    this.flame.visible = on;
    this.core.visible = on;
    // How much of the fire is still on the pad: all of it at the start, none
    // once the rocket is twenty metres up.
    const onPad = on ? Math.max(1 - pose.altitude / 20, 0) * pose.thrust : 0;
    if (on) {
      const jitter = 1 + Math.sin(this.flicker) * 0.06 + Math.sin(this.flicker * 2.3) * 0.05;
      // Never longer than the drop to the trench, so it never goes through it.
      const length = Math.min((6 + 10 * pose.thrust) * jitter, MOUNT + pose.altitude - 0.35);
      this.flame.scale.set(1, length, 1);
      this.core.scale.set(0.5, length * 0.6, 0.5);
    }
    for (const [i, jet] of this.jets.entries()) {
      jet.visible = onPad > 0.02;
      const reach = (5 + 9 * onPad) * (1 + Math.sin(this.flicker * 1.3 + i * 2) * 0.08);
      jet.scale.set(0.6 + 0.4 * onPad, reach, 0.6 + 0.4 * onPad);
    }
    this.padGlow.visible = onPad > 0.02;
    (this.padGlow.material as THREE.MeshBasicMaterial).opacity = 0.55 * onPad;

    if (!on || dt <= 0) return;
    const world = new THREE.Vector3();
    this.vehicle.getWorldPosition(world);
    const haze = this.smoke.haze;
    if (!haze) return;
    // On the pad, smoke boils out sideways along the trench; once it is up, it
    // trails behind in a column.
    const low = pose.altitude < 25;
    // A great deal of it on the pad: a launch is mostly a cloud.
    const rate = (low ? 260 : 30) * pose.thrust;
    const count = Math.floor(rate * dt + Math.random());
    for (let n = 0; n < count; n++) {
      const out = (Math.random() - 0.5) * 2;
      const across = this.group.rotation.y;
      const spread = 9 + Math.random() * 9;
      const velocity = low
        ? {
            x: Math.cos(across) * out * spread + (Math.random() - 0.5) * 3,
            y: 1 + Math.random() * 3,
            z: -Math.sin(across) * out * spread + (Math.random() - 0.5) * 3,
          }
        : { x: (Math.random() - 0.5) * 3, y: -4 - Math.random() * 4, z: (Math.random() - 0.5) * 3 };
      const at = low
        ? { x: world.x + (Math.random() - 0.5) * 4, y: this.group.position.y + 1, z: world.z + (Math.random() - 0.5) * 4 }
        : { x: world.x, y: world.y - 4, z: world.z };
      haze.emit(at, velocity, SMOKE, low ? 4 + Math.random() * 5 : 3 + Math.random() * 3, 4.5 + Math.random() * 3.5, {
        drop: -0.02,
        peak: 0.6,
        grow: 2.6,
      });
    }
  }
}
