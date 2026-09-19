/**
 * The mechanic: the person the repair bill is paying.
 *
 * The garage could fix a wing by swapping the number behind it, and for a long
 * time it did — you pressed `fix`, money left, and the panel was straight in
 * the same frame. That is a spreadsheet with a car on it. What makes a repair
 * read as a repair is somebody walking over to the *specific* thing that is
 * broken, working on it, and the metal changing when the spanner lands.
 *
 * So this is a small figure who lives on the turntable, knows where every
 * component sits on the car, and goes there. `COMPONENTS` already carries an
 * `at` for each one — it is the point the damage model measures impacts
 * against — and that is the same point a person would stand at. Nothing here
 * invents a second table of positions; a component that moves takes its
 * mechanic with it.
 *
 * ## It only looks like it is doing the work
 *
 * The repair has already happened by the time the walk starts: the money is
 * gone and `career` has written the profile. What is deferred is the *picture*,
 * and only in the garage — `GarageCar` holds the old health for a queued
 * component and lets it through the moment this reports the job done. That is
 * the same trick as `foldEase.ts` one step further on, and it obeys the same
 * rule: the panel, the bill and the save file all read the live model, because
 * the metal being seen to straighten over a second must not mean the player is
 * owed money for a second.
 *
 * ## Why it is boxes
 *
 * Every part of this is a box or a sphere, posed from one clock. A rigged mesh
 * would be a modelling pipeline, an animation format and a loader for a figure
 * that is forty pixels tall on a phone, and the game's own car is flat-shaded
 * boxes for the same reason. Chunky proportions — big head, short legs, a cap
 * — read at that size in a way a realistic figure does not.
 */

import * as THREE from 'three';
import { CAR } from '../data/tuning.js';
import { COMPONENT_BY_ID, type ComponentId } from '../sim/damage.js';

/** Ground level in the garage scene: the floor the car's wheels sit on. */
const FLOOR = -CAR.wheelRadius - CAR.suspensionRestLength * 0.45;

/** How tall the whole figure is, metres. Deliberately short beside the car. */
const HEIGHT = 1.5;

/** Everything below is authored at 1.5 m and scaled by this. */
const S = HEIGHT / 1.5;

/** Metres per second on foot. A brisk walk, not a jog: he is at work. */
const WALK_SPEED = 1.9;

/**
 * How long the spanner is on one component, seconds.
 *
 * Long enough to register as work and short enough that fixing the four
 * corners is not a minute of watching. Scaled down when a queue is long — see
 * `workTime`.
 */
const WORK_FOR = 1.5;

/** How long the thumbs-up at the end of a job lasts, seconds. */
const CHEER_FOR = 0.55;

/**
 * The most stops one "repair everything" makes.
 *
 * There are thirty-odd components and a full repair fixes all of them at once.
 * Walking to every one is a minute and a half of a garage nobody can use, so a
 * long queue becomes a montage: a handful get visited and the rest are let
 * through as the round begins. The number is where it stops reading as a round
 * of the car and starts reading as a wait.
 */
const MAX_STOPS = 6;

/** Where he stands when there is nothing to do: off the car's front-left. */
const HOME = new THREE.Vector3(1.45, 0, 1.75);

/**
 * How far his feet stay off the bodywork, metres.
 *
 * He used to walk to the part in a straight line, which is through the car for
 * anything on the far side of it — across the bonnet to reach a rear quarter,
 * and out through the roof. A car is the one thing in this scene that is
 * definitely solid, and walking through it undoes the whole point of sending
 * somebody to the part rather than swapping a number.
 *
 * Small on purpose. This is the footprint a *path* has to clear, not personal
 * space: every standing position is already outside it by construction, and a
 * larger one would send him on a wide lap of a car he is meant to be working
 * on.
 */
const BODY_CLEARANCE = 0.45;

/** The footprint he walks around, as half-extents on the floor. */
const KEEP_OUT = {
  x: CAR.halfExtents.x + BODY_CLEARANCE,
  z: CAR.halfExtents.z + BODY_CLEARANCE,
};

/** Its corners, counter-clockwise from the front-right of the car. */
const CORNERS = [
  { x: KEEP_OUT.x, z: KEEP_OUT.z },
  { x: -KEEP_OUT.x, z: KEEP_OUT.z },
  { x: -KEEP_OUT.x, z: -KEEP_OUT.z },
  { x: KEEP_OUT.x, z: -KEEP_OUT.z },
];

const TWO_PI = Math.PI * 2;

/** An angle in [0, 2pi). */
const turn = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/**
 * Where a point sits around the car, as an angle.
 *
 * Measured in the footprint's *own* units — x over its half-width, z over its
 * half-length — so the four corners land exactly a quarter turn apart however
 * long the car is. Measured in metres they would bunch up at the ends and the
 * routing would pick the wrong way round a car this much longer than it is
 * wide.
 */
const aroundCar = (p: { x: number; z: number }): number =>
  turn(Math.atan2(p.z / KEEP_OUT.z, p.x / KEEP_OUT.x));

const CORNER_ANGLES = CORNERS.map(aroundCar);

/**
 * Does the straight line from `a` to `b` cross the car's footprint?
 *
 * The usual slab clip against an axis-aligned box at the origin. Both ends are
 * always outside it — every standing position is pushed past one face and
 * `HOME` is off the front-right — so this only ever answers "is the car in the
 * way", never "is somebody standing in it".
 */
export function crossesBody(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
  const d = { x: b.x - a.x, z: b.z - a.z };
  let enter = 0;
  let leave = 1;
  for (const axis of ['x', 'z'] as const) {
    const half = KEEP_OUT[axis];
    if (Math.abs(d[axis]) < 1e-6) {
      // Parallel to this pair of faces: either the whole line is between them
      // or it can never be.
      if (Math.abs(a[axis]) > half) return false;
      continue;
    }
    const first = (-half - a[axis]) / d[axis];
    const second = (half - a[axis]) / d[axis];
    enter = Math.max(enter, Math.min(first, second));
    leave = Math.min(leave, Math.max(first, second));
    if (enter > leave) return false;
  }
  return true;
}

/**
 * The corners passed going from `a` round to `b`, in travel order.
 *
 * `way` is +1 for counter-clockwise and -1 for clockwise. A corner counts when
 * it lies inside the sweep, and sorting by how far into the sweep it is puts
 * them in the order they are walked.
 */
function cornersBetween(a: number, b: number, way: 1 | -1): { x: number; z: number }[] {
  const sweep = way > 0 ? turn(b - a) : turn(a - b);
  return CORNERS.map((corner, i) => ({
    corner,
    into: way > 0 ? turn(CORNER_ANGLES[i]! - a) : turn(a - CORNER_ANGLES[i]!),
  }))
    .filter((step) => step.into < sweep)
    .sort((one, two) => one.into - two.into)
    .map((step) => step.corner);
}

/**
 * A way of getting from `from` to `to` that does not go through the car.
 *
 * Straight when the car is not in the way, which is most short hops along one
 * flank. Otherwise round the outside, by whichever of the two ways round is
 * shorter — measured rather than guessed, because for a car four metres long
 * and under two wide the answer is not the one the angle suggests.
 */
export function routeAround(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
  if (!crossesBody(from, to)) return [to.clone()];

  const start = aroundCar(from);
  const end = aroundCar(to);
  const ways = [cornersBetween(start, end, 1), cornersBetween(start, end, -1)];
  const lengthOf = (corners: { x: number; z: number }[]): number => {
    let total = 0;
    let at: { x: number; z: number } = from;
    for (const corner of [...corners, to]) {
      total += Math.hypot(corner.x - at.x, corner.z - at.z);
      at = corner;
    }
    return total;
  };
  const best = lengthOf(ways[0]!) <= lengthOf(ways[1]!) ? ways[0]! : ways[1]!;
  return [...best.map((corner) => new THREE.Vector3(corner.x, 0, corner.z)), to.clone()];
}

/** Resting height of the hips above the feet. */
const HIP_HEIGHT = 0.58 * S;

/**
 * Where to stand to work on a part.
 *
 * The component's own point is on or under the bodywork — that is what it is
 * for — so standing on it puts a mechanic's head through a bonnet. He is
 * pushed outward along whichever of the car's axes the part is nearest the
 * edge of, which puts him at the wing for a wing and at the nose for the
 * radiator without a second table saying so.
 *
 * Exported because the check that he never walks through the car has to start
 * from the same places he does, and a second copy of this in a test would be
 * a test of the copy.
 */
export function standingSpot(at: { x: number; y: number; z: number }): THREE.Vector3 {
  const outX = Math.abs(at.x) / CAR.halfExtents.x;
  const outZ = Math.abs(at.z) / CAR.halfExtents.z;
  return outX >= outZ
    ? new THREE.Vector3(Math.sign(at.x || 1) * (CAR.halfExtents.x + 0.55), 0, at.z)
    : new THREE.Vector3(at.x, 0, Math.sign(at.z || 1) * (CAR.halfExtents.z + 0.6));
}

/** Where he waits between jobs. */
export const IDLE_SPOT = HOME;

/** A job: which component, and what to run when the spanner lands. */
interface Job {
  id: ComponentId;
  done: () => void;
}

type Phase = 'idle' | 'walking' | 'working' | 'cheering';

/** How many sparks can be in the air at once. */
const SPARKS = 20;

/**
 * A stubby limb, pivoting from one end.
 *
 * Three.js rotates about an object's origin and a box's origin is its middle,
 * so an arm built as a plain mesh swings from its elbow. The mesh is offset
 * inside a group and the group is what is rotated — which is the whole of what
 * a bone is here.
 */
function limb(
  parent: THREE.Object3D,
  at: THREE.Vector3,
  size: { x: number; y: number; z: number },
  material: THREE.Material,
): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.copy(at);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  mesh.position.y = -size.y / 2;
  mesh.castShadow = true;
  pivot.add(mesh);
  parent.add(pivot);
  return pivot;
}

export class Mechanic {
  readonly group = new THREE.Group();

  /** What he is doing, and how long he has been doing it. */
  private phase: Phase = 'idle';
  private phaseFor = 0;
  /** A free-running clock for anything that just cycles, seconds. */
  private clock = 0;

  private readonly queue: Job[] = [];
  private job: Job | null = null;
  /**
   * The rest of the walk, corner by corner, with the destination last.
   *
   * A list rather than a point because the car is in the way of most of these
   * journeys: see `routeAround`.
   */
  private path: THREE.Vector3[] = [];
  /** The leg he is on, on the floor. */
  private readonly target = new THREE.Vector3().copy(HOME);
  /** Which way he is facing, radians. Eased, so he turns rather than snapping. */
  private facing = Math.PI;

  private readonly body = new THREE.Group();
  private readonly hips = new THREE.Group();
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly head: THREE.Group;
  private readonly sparks: THREE.Points;
  private readonly sparkVel: THREE.Vector3[] = [];
  private readonly sparkLife: number[] = [];

  constructor(parent: THREE.Object3D) {
    const overalls = new THREE.MeshStandardMaterial({
      color: 0x2f6fb5,
      roughness: 0.85,
      flatShading: true,
    });
    const skin = new THREE.MeshStandardMaterial({
      color: 0xe0a578,
      roughness: 0.9,
      flatShading: true,
    });
    const cap = new THREE.MeshStandardMaterial({
      color: 0xe8552f,
      roughness: 0.8,
      flatShading: true,
    });
    const steel = new THREE.MeshStandardMaterial({
      color: 0xb9c0c9,
      roughness: 0.35,
      metalness: 0.5,
      flatShading: true,
    });

    this.group.position.set(HOME.x, FLOOR, HOME.z);
    this.group.add(this.body);
    this.body.add(this.hips);

    // Legs hang from the hips, which is the thing that bobs when he walks.
    this.hips.position.y = HIP_HEIGHT;
    const legSize = { x: 0.15 * S, y: 0.56 * S, z: 0.17 * S };
    this.legL = limb(this.hips, new THREE.Vector3(0.11 * S, 0, 0), legSize, overalls);
    this.legR = limb(this.hips, new THREE.Vector3(-0.11 * S, 0, 0), legSize, overalls);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44 * S, 0.5 * S, 0.3 * S), overalls);
    torso.position.y = 0.25 * S;
    torso.castShadow = true;
    this.hips.add(torso);

    const armSize = { x: 0.12 * S, y: 0.44 * S, z: 0.14 * S };
    this.armL = limb(this.hips, new THREE.Vector3(0.28 * S, 0.42 * S, 0), armSize, overalls);
    this.armR = limb(this.hips, new THREE.Vector3(-0.28 * S, 0.42 * S, 0), armSize, overalls);

    // The spanner, in the right hand, pointing the way the arm does.
    const spanner = new THREE.Mesh(new THREE.BoxGeometry(0.06 * S, 0.34 * S, 0.06 * S), steel);
    spanner.position.set(0, -0.52 * S, 0.06 * S);
    spanner.castShadow = true;
    this.armR.add(spanner);

    // Head and cap ride on their own group, so he can look about without the
    // shoulders following.
    this.head = new THREE.Group();
    this.head.position.y = 0.56 * S;
    this.hips.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.2 * S, 10, 8), skin);
    skull.castShadow = true;
    this.head.add(skull);
    const crown = new THREE.Mesh(
      new THREE.SphereGeometry(0.205 * S, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      cap,
    );
    crown.position.y = 0.04 * S;
    crown.castShadow = true;
    this.head.add(crown);
    const peak = new THREE.Mesh(new THREE.BoxGeometry(0.3 * S, 0.04 * S, 0.18 * S), cap);
    peak.position.set(0, 0.05 * S, 0.22 * S);
    this.head.add(peak);

    /*
     * Sparks off the spanner.
     *
     * `sizeAttenuation` works here and does not in the game: the garage camera
     * is a perspective one, so a point genuinely has a distance to be scaled
     * by. The race view is orthographic, where the usual `1.0 / -mvPosition.z`
     * trick divides by a fixed camera distance and yields sub-pixel points that
     * never appear — see `fx.ts`.
     *
     * A sibling of the figure rather than a child of the hand: these are
     * emitted at the component, in car space, and parenting them to a limb
     * would drag every spark in the air along with the next swing.
     */
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    this.sparks = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0xffd27a,
        size: 0.05,
        sizeAttenuation: true,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.sparks.frustumCulled = false;
    this.sparks.visible = false;
    for (let i = 0; i < SPARKS; i++) {
      this.sparkVel.push(new THREE.Vector3());
      this.sparkLife.push(0);
    }
    parent.add(this.sparks);
    parent.add(this.group);
  }

  /** True while there is anything left to do. */
  get busy(): boolean {
    return this.job !== null || this.queue.length > 0;
  }

  /**
   * Where the current job is, in car space, or null when there is none.
   *
   * `GarageCar` uses it to turn the turntable so the part being worked on
   * faces the player. A repair that happens round the back of the car is a
   * repair nobody saw.
   */
  get attention(): { x: number; y: number; z: number } | null {
    const at = this.job ? COMPONENT_BY_ID.get(this.job.id)?.at : undefined;
    return at ?? null;
  }

  /**
   * Queue a round of repairs.
   *
   * `done` fires per component, as the spanner lands on that one, which is what
   * lets each panel straighten at its own moment rather than all of them at the
   * end. A long list is trimmed to `MAX_STOPS` and everything dropped is
   * reported immediately — a full repair should look like a round of the car,
   * not like a queue being worked through.
   */
  fix(ids: readonly ComponentId[], done: (id: ComponentId) => void): void {
    const known = ids.filter((id) => COMPONENT_BY_ID.has(id));
    // Spread the stops around the car rather than taking the first few in
    // table order, which would be four corners of suspension and nothing else.
    const visiting = known.length <= MAX_STOPS ? known : spread(known, MAX_STOPS);
    const dropped = new Set(known);
    for (const id of visiting) dropped.delete(id);
    for (const id of dropped) done(id);
    for (const id of visiting) this.queue.push({ id, done: () => done(id) });
    if (!this.job) this.next();
  }

  /** Drop everything and stand still. The garage closed, or the car changed. */
  reset(): void {
    this.queue.length = 0;
    this.job = null;
    this.path = [];
    this.phase = 'idle';
    this.phaseFor = 0;
    this.facing = Math.PI;
    this.target.copy(HOME);
    this.group.position.set(HOME.x, FLOOR, HOME.z);
    for (let i = 0; i < this.sparkLife.length; i++) this.sparkLife[i] = 0;
  }

  /** Advance everything. Real seconds — this is a duration a person watches. */
  update(dt: number): void {
    this.clock += dt;
    this.phaseFor += dt;
    this.updateSparks(dt);

    switch (this.phase) {
      case 'walking':
        this.walk(dt);
        break;
      case 'working':
        this.work(dt);
        break;
      case 'cheering':
        this.cheer();
        break;
      default:
        this.idle();
    }

    // Turning is eased rather than set, or he pivots on the spot like a turret
    // every time a job at the other end of the car comes up.
    const here = this.group.position;
    const toward = Math.atan2(this.target.x - here.x, this.target.z - here.z);
    const wanted = this.phase === 'walking' ? toward : this.facing;
    this.facing += wrapAngle(wanted - this.facing) * Math.min(dt * 9, 1);
    this.group.rotation.y = this.facing;
  }

  /** Take the next job, or go home. */
  private next(): void {
    const job = this.queue.shift() ?? null;
    this.job = job;
    this.phase = 'walking';
    this.phaseFor = 0;
    if (!job) {
      this.setRoute(HOME);
      return;
    }
    this.setRoute(standingSpot(COMPONENT_BY_ID.get(job.id)!.at));
  }

  /** Work out how to get there without walking through the car, and set off. */
  private setRoute(to: THREE.Vector3): void {
    this.path = routeAround(this.group.position, to);
    this.target.copy(this.path[0]!);
  }

  private walk(dt: number): void {
    const here = this.group.position;
    let step = WALK_SPEED * dt;

    // Corners are consumed inside the one frame that reaches them. Stopping at
    // each for a frame would be a stutter at every corner of the car, and at a
    // low frame rate two corners can genuinely fall inside one step.
    while (step > 0 && this.path.length > 0) {
      const leg = this.path[0]!;
      const dx = leg.x - here.x;
      const dz = leg.z - here.z;
      const left = Math.hypot(dx, dz);
      if (left > step) {
        here.x += (dx / left) * step;
        here.z += (dz / left) * step;
        break;
      }
      here.set(leg.x, FLOOR, leg.z);
      step -= left;
      this.path.shift();
    }

    if (this.path.length === 0) {
      this.settle();
      if (this.job) {
        // Face the part itself, which is where the work is — not the car's
        // middle, which for a mirror is over his shoulder.
        const at = COMPONENT_BY_ID.get(this.job.id)!.at;
        this.facing = Math.atan2(at.x - here.x, at.z - here.z);
        this.phase = 'working';
      } else {
        this.facing = Math.PI;
        this.phase = 'idle';
      }
      this.phaseFor = 0;
      return;
    }
    this.target.copy(this.path[0]!);

    // Legs swing, arms counter-swing, and the body rises on each step.
    const cycle = this.clock * 9;
    this.legL.rotation.x = Math.sin(cycle) * 0.72;
    this.legR.rotation.x = -Math.sin(cycle) * 0.72;
    this.armL.rotation.set(0, 0, 0.08);
    this.armR.rotation.set(0, 0, -0.08);
    this.armL.rotation.x = -Math.sin(cycle) * 0.5;
    this.armR.rotation.x = Math.sin(cycle) * 0.5;
    this.hips.rotation.x = 0;
    this.hips.position.y = HIP_HEIGHT + Math.abs(Math.sin(cycle)) * 0.035;
    this.head.rotation.set(0, 0, 0);
    this.body.position.y = 0;
  }

  private work(dt: number): void {
    const job = this.job;
    if (!job) return;
    const at = COMPONENT_BY_ID.get(job.id)!.at;

    this.settle();
    // Crouch toward the part: low for a floor or an exhaust, upright for a roof.
    const reach = Math.min(Math.max((at.y + 0.5) / 1.2, 0), 1);
    this.body.position.y = -(1 - reach) * 0.22;
    this.hips.rotation.x = (1 - reach) * 0.35;

    // The working arm cranks; the other one braces on the car.
    const crank = Math.sin(this.phaseFor * 17);
    this.armR.rotation.x = -1.55 + crank * 0.55;
    this.armL.rotation.x = -1.1;
    this.armL.rotation.z = 0.25;
    this.head.rotation.x = 0.3;

    // A spark on the down-stroke, in car space, at the part itself. The `dt`
    // in the chance is what keeps the rate the same on a 30 Hz phone and a
    // 144 Hz monitor: a flat probability per frame is a frame-rate-dependent
    // emitter, which is how an effect ends up four times as dense on a laptop.
    if (crank < -0.85 && Math.random() < 30 * dt) this.spark(at);

    if (this.phaseFor >= this.workTime()) {
      job.done();
      // Kept as the current job so `attention` still points here through the
      // cheer, and its callback cleared so a re-entry cannot fire it twice.
      this.job = { id: job.id, done: () => {} };
      this.phase = 'cheering';
      this.phaseFor = 0;
    }
  }

  private cheer(): void {
    this.settle();
    // Both arms up and a small hop. The one moment he is not looking at a car.
    const t = Math.min(this.phaseFor / CHEER_FOR, 1);
    this.armL.rotation.set(-2.5, 0, -0.3);
    this.armR.rotation.set(-2.5, 0, 0.3);
    this.body.position.y = Math.sin(t * Math.PI) * 0.16;
    this.head.rotation.x = -0.25;
    if (this.phaseFor >= CHEER_FOR) {
      this.job = null;
      this.next();
    }
  }

  private idle(): void {
    this.settle();
    // Breathing, and a look around every few seconds so he is not a statue.
    this.hips.position.y += Math.sin(this.clock * 1.8) * 0.012;
    this.head.rotation.y = Math.sin(this.clock * 0.42) * 0.55;
  }

  /** Put every joint back to standing, for a pose to work from. */
  private settle(): void {
    this.legL.rotation.x = 0;
    this.legR.rotation.x = 0;
    this.armL.rotation.set(0, 0, 0.08);
    this.armR.rotation.set(0, 0, -0.08);
    this.hips.rotation.x = 0;
    this.hips.position.y = HIP_HEIGHT;
    this.head.rotation.set(0, 0, 0);
    this.body.position.y = 0;
  }

  /**
   * How long one component takes, seconds.
   *
   * A queue shortens each stop, so a full repair is a brisk round rather than
   * six unhurried jobs back to back. Floored, or the montage becomes a flicker.
   */
  private workTime(): number {
    return Math.max(WORK_FOR / (1 + this.queue.length * 0.45), 0.55);
  }

  private spark(at: { x: number; y: number; z: number }): void {
    const slot = this.sparkLife.findIndex((life) => life <= 0);
    if (slot < 0) return;
    const position = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    position.setXYZ(slot, at.x, at.y, at.z);
    this.sparkVel[slot]!.set(
      (Math.random() - 0.5) * 1.6,
      0.6 + Math.random() * 1.1,
      (Math.random() - 0.5) * 1.6,
    );
    this.sparkLife[slot] = 0.4 + Math.random() * 0.25;
  }

  private updateSparks(dt: number): void {
    const position = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    let any = false;
    for (let i = 0; i < this.sparkLife.length; i++) {
      const life = this.sparkLife[i]!;
      if (life <= 0) continue;
      this.sparkLife[i] = life - dt;
      const v = this.sparkVel[i]!;
      v.y -= 6 * dt;
      position.setXYZ(
        i,
        position.getX(i) + v.x * dt,
        position.getY(i) + v.y * dt,
        position.getZ(i) + v.z * dt,
      );
      // Parked well out of shot rather than merely left: a `Points` draws every
      // vertex in its buffer, so a dead spark where it died is a bright dot
      // sitting on the floor forever.
      if (this.sparkLife[i]! <= 0) position.setXYZ(i, 0, -999, 0);
      else any = true;
      position.needsUpdate = true;
    }
    this.sparks.visible = any;
  }
}

/** Shortest way round to an angle, radians. */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Take `count` items spread evenly through a list rather than the first few.
 *
 * The component table is grouped — four suspensions, then four hubs, then four
 * tyres — so taking the head of it sends him to the same corner four times and
 * nowhere else. An even stride across the list visits the car.
 */
function spread<T>(items: readonly T[], count: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(items[Math.floor((i * items.length) / count)]!);
  return out;
}
