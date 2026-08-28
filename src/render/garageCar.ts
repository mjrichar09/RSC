/**
 * The car, in the garage, in the condition it is actually in.
 *
 * The damage panel names what is broken and the repair list prices it; this is
 * the thing those numbers are about. Paying to straighten a wing changes the
 * wing you are looking at, in the same frame — which is the difference between
 * a bill and a decision.
 *
 * Its own renderer and its own scene, deliberately: the race view is an
 * orthographic camera locked to a stage, and borrowing it would mean unwinding
 * and restoring half of that every time the garage opens. A second context
 * costs a few megabytes and is only alive while the garage is.
 */

import * as THREE from 'three';
import { CAR } from '../data/tuning.js';
import type { DamageModel } from '../sim/damage.js';
import type { DebrisModel } from '../sim/debris.js';
import type { VehicleState } from '../sim/vehicle.js';
import { CarView } from './carView.js';
import type { Livery } from '../data/liveries.js';
import { PALETTE } from './scene.js';

/** A parked car: wheels down, nothing turning, nothing sliding. */
function parkedState(): VehicleState {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 0 },
    speed: 0,
    rpm: 0,
    gear: 1,
    driftAngle: 0,
    yawRate: 0,
    airborne: false,
    shifting: false,
    engineLoad: 0,
    wheels: CAR.wheelPositions.map((p) => ({
      contact: { x: p.x, y: p.y - CAR.suspensionRestLength, z: p.z },
      grounded: true,
      // Sitting on its springs rather than at full droop.
      compression: 0.55,
      load: (CAR.mass * 9.81) / 4,
      steer: 0,
      spin: 0,
      rotation: 0,
      slipAngle: 0,
      slipRatio: 0,
      saturation: 0,
      surface: { id: 'tarmac' } as VehicleState['wheels'][number]['surface'],
    })),
  };
}

/** Radians per second the car turns on its own when nobody is dragging it. */
const IDLE_SPIN = 0.35;

export class GarageCar {
  readonly root: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly car: CarView;
  private readonly pivot = new THREE.Group();
  private readonly state = parkedState();

  private damage: DamageModel | null = null;
  private debris: DebrisModel | null = null;
  private yaw = Math.PI * 0.75;
  private pitch = 0.35;
  private dragging = false;
  private lastPointer: { x: number; y: number } | null = null;
  private active = false;
  private lastFrame = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'garage-car';

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.root.appendChild(this.renderer.domElement);

    // A perspective camera here, unlike the game's: this is an object being
    // inspected on a turntable rather than a car being driven, and a little
    // perspective is what makes it read as a solid thing.
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);

    this.scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x2a2118, 1.1));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.set(-4, 6, 3.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const extent = 4;
    key.shadow.camera.left = -extent;
    key.shadow.camera.right = extent;
    key.shadow.camera.top = extent;
    key.shadow.camera.bottom = -extent;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 20;
    // three.js will not pick up a changed shadow frustum on its own.
    key.shadow.camera.updateProjectionMatrix();
    this.scene.add(key);
    this.scene.add(new THREE.DirectionalLight(0x8fb2ff, 0.5).translateX(5).translateY(3));

    // A floor to catch the shadow, so the car is standing on something.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(4.2, 48),
      new THREE.MeshStandardMaterial({ color: PALETTE.carCabin, roughness: 1, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -CAR.wheelRadius - CAR.suspensionRestLength * 0.45;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.scene.add(this.pivot);
    this.car = new CarView(this.pivot);

    this.bindDragging();
  }

  /** Repaint the car on the turntable, live, as the player picks. */
  setLivery(livery: Livery, raceNumber: number): void {
    this.car.setLivery(livery, raceNumber);
  }

  /** Show this condition. Called again after every repair, so it stays true. */
  setCondition(damage: DamageModel, debris: DebrisModel | null = null): void {
    this.damage = damage;
    this.debris = debris;
  }

  /** Start or stop the turntable. Nothing renders while the garage is closed. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (!active) return;
    this.lastFrame = performance.now();
    const frame = () => {
      if (!this.active) return;
      const now = performance.now();
      const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
      this.lastFrame = now;
      this.draw(dt);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private draw(dt: number): void {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (width < 4 || height < 4) return;

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();

    if (!this.dragging) this.yaw += IDLE_SPIN * dt;
    this.pivot.rotation.y = this.yaw;

    const distance = 6.4;
    this.camera.position.set(
      0,
      Math.sin(this.pitch) * distance,
      Math.cos(this.pitch) * distance,
    );
    this.camera.lookAt(0, -0.1, 0);

    this.car.update(
      { position: this.state.position, rotation: this.state.rotation },
      this.state,
      this.damage,
      this.debris,
    );
    this.renderer.render(this.scene, this.camera);
  }

  /** Drag to turn it, the way you would walk round a car. */
  private bindDragging(): void {
    const element = this.renderer.domElement;
    element.style.touchAction = 'none';
    element.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      element.setPointerCapture(event.pointerId);
    });
    element.addEventListener('pointermove', (event) => {
      if (!this.dragging || !this.lastPointer) return;
      this.yaw -= (event.clientX - this.lastPointer.x) * 0.01;
      this.pitch = Math.min(
        Math.max(this.pitch + (event.clientY - this.lastPointer.y) * 0.006, -0.15),
        1.2,
      );
      this.lastPointer = { x: event.clientX, y: event.clientY };
    });
    const release = (event: PointerEvent) => {
      this.dragging = false;
      this.lastPointer = null;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
  }
}
