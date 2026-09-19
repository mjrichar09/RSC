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
 *
 * ## The repair you can watch
 *
 * A paid repair used to land between two frames: press `fix`, and the panel is
 * straight before the button has finished depressing. The money and the bill
 * are still instant — they must be — but the *picture* now waits for somebody
 * to walk over and do it. `Mechanic` is the figure; `HeldDamage` is how the
 * wing stays bent until he gets there, by holding the pre-repair health for
 * exactly the components he has been sent to and letting each one through as
 * the spanner lands on it.
 *
 * Nothing outside this file sees any of that. `career.buildDamage()` is the
 * truth, the repair list prices off it, and this is a renderer lagging behind
 * it on purpose — the same shape as `foldEase.ts`, and for the same reason.
 */

import * as THREE from 'three';
import { CAR } from '../data/tuning.js';
import type { DamageModel } from '../sim/damage.js';
import type { DebrisModel } from '../sim/debris.js';
import type { VehicleState } from '../sim/vehicle.js';
import { CarView, type DamageLike } from './carView.js';
import { Mechanic } from './mechanic.js';
import type { ComponentId, Dent } from '../sim/damage.js';
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

/**
 * How fast the turntable swings to show the part being worked on, per second.
 *
 * A fraction of the remaining angle each second rather than a fixed rate, so a
 * part already roughly in view barely moves and one round the back comes round
 * briskly. Slow enough to read as the car being turned to show you something.
 */
const PRESENT_RATE = 3.2;

/**
 * The damage the car is *drawn* from while a repair is being carried out.
 *
 * It is the live model with a few components pinned to what they were before
 * the money was spent. `release` un-pins one, which is what makes a panel
 * straighten at the moment it is worked on rather than when the button was
 * pressed.
 *
 * Dents are held as a whole rather than per component, because they are not
 * per component: a dent is a position on the bodywork and `repairAll` clears
 * the list outright. Holding the old list until the last job is done is the
 * only way the folds do not all vanish on the first spanner.
 */
class HeldDamage implements DamageLike {
  source: DamageLike | null = null;
  private readonly held = new Map<ComponentId, number>();
  private heldDents: readonly Dent[] | null = null;
  private heldVersion = 0;
  /** Bumped whenever the shown dent list changes, for whichever reason. */
  private shownVersion = 0;

  /** Point at a new car. Nothing is held across that. */
  attach(source: DamageLike | null): void {
    this.source = source;
    this.held.clear();
    this.heldDents = null;
    this.shownVersion++;
  }

  /** Pin these components at whatever they read right now. */
  hold(ids: readonly ComponentId[]): void {
    if (!this.source) return;
    for (const id of ids) {
      if (!this.held.has(id)) this.held.set(id, this.source.get(id));
    }
    if (this.heldDents === null) {
      this.heldDents = this.source.dents.map((dent) => ({ ...dent, at: { ...dent.at } }));
      this.heldVersion = this.source.dentVersion;
    }
  }

  /** Let one component through. The folds follow once the last one has. */
  release(id: ComponentId): void {
    this.held.delete(id);
    if (this.held.size === 0 && this.heldDents !== null) {
      this.heldDents = null;
      this.shownVersion++;
    }
  }

  /** Everything through at once: the garage closed, or the car was replaced. */
  releaseAll(): void {
    if (this.held.size === 0 && this.heldDents === null) return;
    this.held.clear();
    this.heldDents = null;
    this.shownVersion++;
  }

  get(id: ComponentId): number {
    const pinned = this.held.get(id);
    return pinned !== undefined ? pinned : (this.source?.get(id) ?? 1);
  }

  brakeGlow(index: number): number {
    return this.source?.brakeGlow(index) ?? 0;
  }

  brakeTint(index: number): number {
    return this.source?.brakeTint(index) ?? 0;
  }

  get dents(): readonly Dent[] {
    return this.heldDents ?? this.source?.dents ?? [];
  }

  get dentVersion(): number {
    // Both terms, so the mesh is rebuilt when the held list is dropped *and*
    // when the live one changes underneath it. Either alone leaves a car
    // showing folds it no longer has until something else bumps the number.
    const live = this.heldDents === null ? (this.source?.dentVersion ?? 0) : this.heldVersion;
    return this.shownVersion + live;
  }
}

export class GarageCar {
  readonly root: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly car: CarView;
  private readonly pivot = new THREE.Group();
  private readonly state = parkedState();
  private readonly mechanic: Mechanic;
  /** What the car is drawn from: the live model, minus what is being fixed. */
  private readonly shown = new HeldDamage();

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
    // On the turntable rather than in the scene, so he stays at the wing he is
    // working on while the car turns instead of being left behind by it.
    this.mechanic = new Mechanic(this.pivot);

    this.bindDragging();
  }

  /** Repaint the car on the turntable, live, as the player picks. */
  setLivery(livery: Livery, raceNumber: number): void {
    this.car.setLivery(livery, raceNumber);
  }

  /**
   * Show this condition. Called again after every repair, so it stays true.
   *
   * Held components survive it: the garage re-renders on every action and hands
   * over a freshly built model each time, and a repair in progress must not be
   * cancelled by the panel beside it being redrawn.
   */
  setCondition(damage: DamageModel, debris: DebrisModel | null = null): void {
    this.damage = damage;
    this.debris = debris;
    this.shown.source = damage;
  }

  /**
   * Somebody has just paid to fix these. Send the mechanic to each one.
   *
   * Called *before* the garage re-renders with the repaired model, because the
   * pre-repair health has to be captured off the model currently being shown —
   * after the re-render it is gone and there is nothing left to hold.
   *
   * A component he does not get to — a full repair is trimmed to a handful of
   * stops — is released immediately, so nothing is ever left pinned to a value
   * the car no longer has.
   */
  repair(ids: readonly ComponentId[]): void {
    if (ids.length === 0) return;
    this.shown.hold(ids);
    this.mechanic.fix(ids, (id) => this.shown.release(id));
  }

  /**
   * Start or stop the turntable. Nothing renders while the garage is closed.
   *
   * `live` off leaves it awake but unpowered: no animation frames are asked
   * for, and the caller drives it with `advance` instead. That is what lets a
   * screenshot land on a chosen moment of the repair — the mechanic lives
   * entirely inside this loop, and `shoot` never calls it, which is the exact
   * shape of bug this codebase keeps rediscovering.
   */
  setActive(active: boolean, live = true): void {
    if (active === this.active) return;
    this.active = active;
    if (!active) {
      // Nothing animates while the garage is shut, so a repair half-finished
      // when it closed would be frozen mid-swing and still hiding a straight
      // panel the next time it opened.
      this.mechanic.reset();
      this.shown.releaseAll();
      return;
    }
    if (!live) return;
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

  /**
   * Run the turntable forward to a moment, then draw it once.
   *
   * For a harness. Advancing and *drawing* every step is what a real second of
   * this costs, and under the software WebGL `shoot` uses that is around a
   * second per frame — seeking two seconds of repair that way took longer than
   * the ninety-second timeout and reported nothing but the timeout. The
   * animation is arithmetic and costs nothing; only the picture is expensive,
   * and only the last one is wanted.
   */
  seek(seconds: number): void {
    const step = 1 / 60;
    for (let t = 0; t < seconds; t += step) this.step(step);
    this.draw(0);
  }

  /**
   * Everything that moves, and nothing that is drawn.
   *
   * Split out so a seek can run a hundred of these for the cost of one render.
   */
  private step(dt: number): void {
    this.mechanic.update(dt);

    // A player turning the car themselves is the one thing that must never be
    // fought: while a pointer is down it owns the yaw and nothing else touches
    // it.
    if (this.dragging) return;

    /*
     * Turn to show the work.
     *
     * The turntable idles round at a constant rate, which means a repair
     * started at the wrong moment happens out of sight behind the car. While
     * there is a job on, the yaw eases to whichever angle brings that part to
     * the front instead.
     */
    const at = this.mechanic.attention;
    if (at) {
      const wanted = -Math.atan2(at.x, at.z);
      const delta = Math.atan2(Math.sin(wanted - this.yaw), Math.cos(wanted - this.yaw));
      this.yaw += delta * Math.min(dt * PRESENT_RATE, 1);
    } else {
      this.yaw += IDLE_SPIN * dt;
    }
  }

  private draw(dt: number): void {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (width < 4 || height < 4) return;

    this.step(dt);

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();

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
      this.damage ? this.shown : null,
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
