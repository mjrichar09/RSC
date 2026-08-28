/**
 * The simulation world: Rapier setup, the fixed-timestep loop, and whatever
 * ground the current phase provides.
 *
 * This module runs unchanged in the browser and in Node — nothing here touches
 * the DOM or three.js — which is what makes `npm run telemetry` and the vitest
 * regression suite possible.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { CAR, SIM, type VehicleTuning } from '../data/tuning.js';
import type { DriverInput } from './input.js';
import { NEUTRAL_INPUT } from './input.js';
import { CLEAR_DAY, type Conditions, ambientTemperature } from './conditions.js';
import { DamageModel, type DamageOptions, impactPointFromForce } from './damage.js';
import { DebrisModel, type DetachEvent, type PartId } from './debris.js';
import { Ambient } from './ambient.js';
import { DEER_MASS, Wildlife } from './wildlife.js';
import { type Quat, type Vec3, add, lerpVec, rotate, rotateInverse, slerp, v3 } from './math.js';
import { type Stage } from './stage.js';
import { type SurfaceId, surface } from './surfaces.js';
import { Vehicle, type VehicleState } from './vehicle.js';

let rapierReady: Promise<void> | null = null;

/** Idempotent — Rapier's wasm only needs initialising once per process. */
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

export interface GroundPatch {
  /** Centre of the patch on the XZ plane. */
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  surface: SurfaceId;
}

export interface WorldOptions {
  /**
   * Drive a generated stage corridor instead of the flat proving ground. When
   * set, the spawn, ground geometry and surface lookup all come from the stage.
   */
  stage?: Stage;
  /** Default surface outside every patch. */
  baseSurface?: SurfaceId;
  /** Rectangular surface patches, tested in order. Replaced by stages in P2. */
  patches?: GroundPatch[];
  /**
   * A static wall on the proving ground, for controlled impact calibration.
   * Damage thresholds are in units nobody has intuition for, so they are set by
   * driving into this at a known speed rather than by guessing.
   */
  wall?: { x: number; z: number; halfX: number; halfY: number; halfZ: number };
  spawn?: { position: Vec3; heading?: number };
  /** Overrides merged over the default car. Drives the sweep tool and the live panel. */
  tuning?: Partial<VehicleTuning>;
  /**
   * Enable component damage. Pass options to configure it, or `false`/omit for
   * an indestructible car — which is what the handling tests and the tuning
   * sweep want, since they are measuring the car, not the crashing.
   */
  damage?: DamageOptions | boolean;
  /** Start the car with these components already damaged. For tests. */
  damageTo?: Record<string, number>;
  /** Weather and time of day. Defaults to clear daylight. */
  conditions?: Conditions;
  /**
   * How many cars share this world. Defaults to one.
   *
   * They line up across the start apron and collide with each other like
   * anything else: being rammed goes through the same damage pipeline as
   * hitting a rock, which is why multiplayer needed no new damage code.
   */
  cars?: number;
}

/** Merge overrides over the baseline car setup. */
export const resolveTuning = (overrides?: Partial<VehicleTuning>): VehicleTuning => ({
  ...CAR,
  ...overrides,
});

/** A part that has come off the car and is now part of the world. */
export interface LooseBody {
  id: PartId;
  label: string;
  body: RAPIER.RigidBody;
  /** Half-extents, so the renderer can size a box without re-deriving them. */
  half: Vec3;
}

/** Deterministic stream keyed to a stage id, for anything placed along it. */
function stageStream(id: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hard cap on loose bodies.
 *
 * Set to a whole car. There are nineteen detachable parts, and a loose body
 * costs about 1.3 µs of simulation per fixed step — measured by sweeping the
 * count in one process and taking the minimum of three passes, because a single
 * run on a shared machine varies by a factor of two and will happily report a
 * bare stage as slower than one strewn with wreckage.
 *
 * Nineteen bodies is 24 µs on top of a 118 µs step: 17 ms of CPU per second of
 * game against 14, with sixty times more headroom than that needs. The earlier
 * cap of twelve was set when the car had ten parts, so it could never bind —
 * it was measured, but against a case that could not happen.
 *
 * The cap is what stops the bill growing without limit if this ever becomes
 * four cars sharing a world; it is not protecting a single-car stage from
 * anything.
 */
export const DEBRIS_BUDGET = 19;
/** Loose bodies further than this from the car are removed, metres. */
const DEBRIS_KEEP_RADIUS = 120;

/**
 * One car in the world, with everything that belongs to it.
 *
 * Damage, debris and attachment are per car rather than per world: in a race
 * with four of them, being rammed has to break *your* bumper. Single-player is
 * the same structure with one entry, which is what keeps one code path.
 */
export interface Car {
  vehicle: Vehicle;
  damage: DamageModel | null;
  debris: DebrisModel | null;
  /** Loose parts this car has shed. Pooled against the world's budget. */
  readonly loose: LooseBody[];
}

export class SimWorld {
  readonly world: RAPIER.World;
  /**
   * Every car in the world. Index 0 is the local one — the car the camera
   * follows and the HUD is about — and in single-player it is the only one.
   */
  readonly cars: Car[] = [];
  readonly stage: Stage | null;
  /** How many cars this world was built for. */
  readonly carCount: number;

  /**
   * Loose parts as physics bodies, oldest first, across every car.
   *
   * Capped, because a long stage otherwise accumulates bodies until the step
   * cost climbs — and everything here is collidable, so your own bumper is now
   * an obstacle on the road.
   */
  readonly loose: LooseBody[] = [];
  /**
   * Animals at the roadside, and the weather's own mischief.
   *
   * Both are gated on the damage model being present, which means they are on
   * in the game and off in stage validation. That is deliberate: a stage must
   * not be judged unshippable because a deer stepped out in front of the AI,
   * which cannot see one.
   */
  readonly wildlife: Wildlife | null;
  readonly ambient: Ambient | null;
  readonly conditions: Conditions;
  readonly dt = 1 / SIM.hz;

  /** Simulated seconds since construction. Not wall-clock time. */
  time = 0;
  /** Fixed steps taken. Useful as a determinism/regression handle. */
  steps = 0;

  private accumulator = 0;
  /** Transform at the start of the last fixed step, per car, for interpolation. */
  private previousTransforms: { position: Vec3; rotation: Quat }[] = [];
  /**
   * Last spline sample the car was near. Feeding this back as a hint turns the
   * per-wheel surface lookup into a short local scan instead of a spatial query.
   */
  private splineHint: number | undefined;
  /** Collects contact-force events so impacts can be turned into damage. */
  private readonly events: RAPIER.EventQueue | null;

  /**
   * Largest impact impulse in the step just simulated, newton-seconds.
   *
   * Damage has a threshold, but a bump the car shrugs off should still be felt
   * and heard, so the presentation layer reads the raw impulse rather than the
   * damage events.
   */
  lastImpact = 0;
  /**
   * Headline events since the last drain — "Deer strike", "Heavy landing".
   *
   * Damage events name the component that broke, which is the wrong headline
   * for something that happened *to* the car. Hitting a deer produced a quiet
   * "Lights 32%" and nothing else: no shake, no thud, no mention of the deer.
   * It read as taking no damage at all.
   */
  private notices: string[] = [];
  /** The local car — the one the camera follows and the HUD is about. */
  get vehicle(): Vehicle {
    return this.cars[0]!.vehicle;
  }

  /** The local car's damage. Every car has its own; this is the player's. */
  get damage(): DamageModel | null {
    return this.cars[0]!.damage;
  }

  /** The local car's attachment state. */
  get debris(): DebrisModel | null {
    return this.cars[0]!.debris;
  }

  private readonly patches: GroundPatch[];
  private readonly baseSurface: SurfaceId;

  constructor(options: WorldOptions = {}) {
    this.baseSurface = options.baseSurface ?? 'tarmac';
    this.patches = options.patches ?? [];

    this.world = new RAPIER.World({ x: 0, y: SIM.gravity, z: 0 });
    this.world.integrationParameters.dt = this.dt;
    this.stage = options.stage ?? null;

    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    if (this.stage) {
      // The stage corridor is a single trimesh: road, verges and embankments in
      // one mesh, with the surface resolved analytically rather than per-triangle.
      this.world.createCollider(
        RAPIER.ColliderDesc.trimesh(this.stage.geometry.vertices, this.stage.geometry.indices)
          .setFriction(1.0),
        ground,
      );
    } else {
      // Proving ground: a large static slab, used by the handling tests and the
      // free-roam surface patchwork.
      ground.setTranslation({ x: 0, y: -0.5, z: 0 }, false);
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(400, 0.5, 400).setFriction(1.0),
        ground,
      );
    }

    if (options.wall) {
      const w = options.wall;
      const wallBody = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(w.x, w.halfY, w.z),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(w.halfX, w.halfY, w.halfZ).setFriction(0.8),
        wallBody,
      );
    }

    if (this.stage) {
      // Hazards are static cylinders standing on the verge. They are what give
      // the damage model something to actually hit.
      for (const prop of this.stage.props) {
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(
            prop.position.x,
            prop.position.y + prop.height / 2,
            prop.position.z,
          ),
        );
        this.world.createCollider(
          RAPIER.ColliderDesc.cylinder(prop.height / 2, prop.radius).setFriction(0.7),
          body,
        );
      }
    }

    const spawn =
      options.spawn ??
      (this.stage
        ? { position: this.stage.start.position, heading: this.stage.start.heading }
        : { position: v3(0, 1.2, 0), heading: 0 });

    this.conditions = options.conditions ?? CLEAR_DAY;
    this.carCount = Math.max(1, Math.floor(options.cars ?? 1));

    const wantsDamage = options.damage !== undefined && options.damage !== false;
    this.wildlife =
      wantsDamage && this.stage
        ? new Wildlife(this.stage.spline, this.stage.length, {
            // Seeded from the stage id, so a stage's animals stand in the same
            // places on every load — the same rule its hazards follow.
            random: stageStream(this.stage.def.id),
          })
        : null;
    this.events = wantsDamage ? new RAPIER.EventQueue(true) : null;

    const tuning = resolveTuning(options.tuning);
    for (let i = 0; i < this.carCount; i++) {
      const damage = wantsDamage
        ? new DamageModel({
            // Ambient air comes from the stage's conditions, so brakes and
            // coolant both behave differently on a winter night.
            ambient: ambientTemperature(this.conditions),
            // Each car draws from its own stream, or four cars in one world
            // would shed their bumpers in lockstep.
            seed: 0x5eed1e + i * 0x9e37,
            ...(options.damage === true || options.damage === undefined ? {} : options.damage),
          })
        : null;
      const debris = damage ? new DebrisModel({ random: () => damage.nextRandom() }) : null;

      const vehicle = new Vehicle(RAPIER, this.world, tuning, this.gridSlot(spawn, i), {
        surfaceAt: (p) => surface(this.surfaceIdAt(p)),
        conditions: this.conditions,
        ...(damage ? { damage } : {}),
        ...(debris ? { debris } : {}),
      });

      this.cars.push({ vehicle, damage, debris, loose: [] });
      this.previousTransforms.push({
        position: { ...(vehicle.body.translation() as Vec3) },
        rotation: { ...(vehicle.body.rotation() as Quat) },
      });
    }

    this.ambient =
      wantsDamage && this.stage
        ? new Ambient({
            biome: this.stage.def.biome,
            conditions: this.conditions,
            random: () => this.cars[0]!.damage!.nextRandom(),
          })
        : null;
  }

  /**
   * Where car `index` starts.
   *
   * Cars line up across the road rather than one behind the other: a rally
   * start is one at a time, but a race between four of them that begins with
   * three of them staring at a bumper is not a race.
   */
  private gridSlot(
    spawn: { position: Vec3; heading?: number },
    index: number,
  ): { position: Vec3; heading?: number } {
    if (index === 0 || this.carCount === 1) return spawn;
    const heading = spawn.heading ?? 0;
    // Alternate sides so the grid grows outward from the racing line.
    const side = index % 2 === 0 ? 1 : -1;
    const rank = Math.ceil(index / 2);
    const across = side * rank * 3.0;
    const back = rank * 5.5;
    return {
      position: {
        x: spawn.position.x + Math.cos(heading) * across - Math.sin(heading) * back,
        y: spawn.position.y,
        z: spawn.position.z - Math.sin(heading) * across - Math.cos(heading) * back,
      },
      heading,
    };
  }

  /**
   * Turn this step's contact forces into component damage.
   *
   * Rapier reports a force magnitude and the direction of the strongest
   * contact, but not a dependable contact point, so the impact location is
   * reconstructed from the direction the car was pushed — see
   * `impactPointFromForce`. Force is integrated over the step into an impulse,
   * which means a long gentle scrape does little while a single hard hit does
   * a lot, exactly as it should.
   */
  private processImpacts(): void {
    if (!this.events) return;

    this.lastImpact = 0;
    // Handle to car index, rebuilt each step because a car can be added or
    // removed between them when a player joins or drops.
    const byHandle = new Map<number, number>();
    for (let i = 0; i < this.cars.length; i++) {
      byHandle.set(this.cars[i]!.vehicle.collider.handle, i);
    }

    this.events.drainContactForceEvents((event) => {
      const first = byHandle.get(event.collider1());
      const second = byHandle.get(event.collider2());
      if (first === undefined && second === undefined) return;

      const impulse = event.totalForceMagnitude() * this.dt;
      if (impulse <= 0) return;
      // Only the local car's hits shake the local camera.
      if (first === 0 || second === 0) this.lastImpact = Math.max(this.lastImpact, impulse);

      const worldDirection = event.maxForceDirection() as Vec3;

      // Both sides of a car-to-car hit take damage, each in its own frame and
      // each pushed its own way. Being rammed is the same event as hitting a
      // rock, which is exactly why this needed no new damage model.
      for (const index of [first, second]) {
        if (index === undefined) continue;
        const car = this.cars[index]!;
        if (!car.damage) continue;

        // Rapier's force direction points from collider1 toward collider2. For
        // collider1 that is away from it and has to be flipped, or a nose-first
        // impact lands through the back of the car.
        const sign = byHandle.get(event.collider1()) === index ? -1 : 1;
        const rotation = car.vehicle.body.rotation() as Quat;
        const local = rotateInverse(rotation, {
          x: worldDirection.x * sign,
          y: worldDirection.y * sign,
          z: worldDirection.z * sign,
        });

        const at = impactPointFromForce(local);
        car.damage.applyImpact(at, impulse);
        // The same hit works the mounts loose. One impact, two consequences:
        // what it costs to repair, and whether the part is still on the car.
        car.debris?.applyImpact(at, impulse);
      }
    });
  }

  /**
   * Parts coming off, for every car.
   *
   * Cleanup runs on distance from the *local* car rather than on age: a part
   * dropped at the finish line is worth keeping in view and one dropped two
   * corners back is not, and what matters is what the player can see.
   */
  private updateDebris(): void {
    for (const car of this.cars) {
      if (!car.debris || !car.damage) continue;
      const state = car.vehicle.state();
      car.debris.update(this.dt, Math.abs(state.speed), (id) => car.damage!.get(id) <= 0);
      for (const event of car.debris.drainDetached()) this.spawnLoose(car, event, state);
    }

    const here = this.cars[0]!.vehicle.state().position;
    for (let i = this.loose.length - 1; i >= 0; i--) {
      const at = this.loose[i]!.body.translation() as Vec3;
      const dx = at.x - here.x;
      const dz = at.z - here.z;
      if (dx * dx + dz * dz > DEBRIS_KEEP_RADIUS * DEBRIS_KEEP_RADIUS || at.y < -60) {
        this.removeLoose(i);
      }
    }
  }

  /**
   * Wildlife and weather: the two things in the game that happen *to* a car
   * rather than because of it.
   *
   * Every car is exposed to them — a deer that steps out is in the road for
   * whoever arrives, and the wind blows on all of them — but only the local
   * car's misfortune reaches the HUD.
   */
  private updateWorldEvents(): void {
    if (!this.stage) return;

    for (let index = 0; index < this.cars.length; index++) {
      const car = this.cars[index]!;
      if (!car.damage) continue;
      const local = index === 0;
      const state = car.vehicle.state();
      const speed = Math.abs(state.speed);

      if (this.wildlife) {
        // Only the local car advances the animals: they are placed from the
        // stage seed and stepped once, or four cars would step them four times
        // and every deer would bolt at four times the rate.
        if (local) {
          const here = this.stage.progressAt(state.position, this.splineHint);
          this.wildlife.update(this.dt, here.distance, speed);
        }

        const hit = this.wildlife.strike(state.position, state.velocity, state.rotation);
        if (hit) {
          // Through the nose, like any other frontal impact — a deer strike is
          // not a special case in the damage model, it is just a heavy one.
          car.damage.applyImpact(v3(0, 0, 1.8), hit.impulse);
          car.debris?.applyImpact(v3(0, 0, 1.8), hit.impulse);
          if (local) {
            // Felt and heard, not just billed: this is what the camera shake
            // and the impact sound read.
            this.lastImpact = Math.max(this.lastImpact, hit.impulse);
            this.notices.push('Deer strike');
          }
          // And the car loses the momentum it gave the deer, which at speed is
          // a couple of metres per second and a very unwelcome shove.
          car.vehicle.body.applyImpulse(
            { x: -hit.push.x * DEER_MASS * speed, y: 0, z: -hit.push.z * DEER_MASS * speed },
            true,
          );
        }
      }

      // A landing that bottomed out is an impact the player has to feel.
      if (car.vehicle.landingImpact > 0) {
        if (local) {
          this.lastImpact = Math.max(this.lastImpact, car.vehicle.landingImpact);
          if (car.vehicle.landingImpact > 8000) this.notices.push('Heavy landing');
        }
        car.vehicle.landingImpact = 0;
      }

      if (this.ambient) {
        if (local) this.ambient.update(this.dt, speed, this.surfaceIdAt(state.position));
        if (this.ambient.gust !== 0) {
          // A crosswind, applied across the car's own heading so it pushes the
          // line wide rather than shoving it up or down the road.
          const right = rotate(state.rotation, v3(1, 0, 0));
          const impulse = CAR.mass * this.ambient.gust * this.dt;
          car.vehicle.body.applyImpulse(
            { x: right.x * impulse, y: 0, z: right.z * impulse },
            true,
          );
        }
        if (local) {
          for (const stone of this.ambient.drainStones()) {
            car.damage.applyImpact(stone.at, stone.impulse);
            // A stone is cosmetic, but it is a sharp crack you should hear.
            this.lastImpact = Math.max(this.lastImpact, stone.impulse * 0.4);
          }
        }
      }
    }
  }

  /** Turn a detached part into a dynamic body carrying the car's motion. */
  private spawnLoose(car: Car, event: DetachEvent, state: VehicleState): void {
    // The *farthest* goes first, not the oldest. Recycling by age can delete a
    // bumper lying across the road ten metres ahead while a door dropped two
    // corners back survives — the one thing the player is looking at is the one
    // thing that vanishes.
    const here = this.cars[0]!.vehicle.state().position;
    while (this.loose.length >= DEBRIS_BUDGET) this.removeLoose(this.farthestLoose(here));

    const rot = state.rotation;
    const offset = rotate(rot, event.at);
    const random = () => car.damage!.nextRandom();
    const spin = () => (random() - 0.5) * 12;

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(
          state.position.x + offset.x,
          state.position.y + offset.y,
          state.position.z + offset.z,
        )
        .setRotation(rot)
        // It leaves with the car's velocity plus a kick, or it would appear to
        // stop dead the moment it came off.
        .setLinvel(state.velocity.x, state.velocity.y + 1.5 + random() * 2, state.velocity.z)
        .setAngvel({ x: spin(), y: spin(), z: spin() }),
    );
    const volume = 8 * event.half.x * event.half.y * event.half.z;
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(event.half.x, event.half.y, event.half.z)
        .setDensity(Math.max(event.mass / Math.max(volume, 1e-4), 1))
        .setFriction(0.6)
        .setRestitution(0.2),
      body,
    );
    const loose = { id: event.id, label: event.label, body, half: event.half };
    this.loose.push(loose);
    car.loose.push(loose);
  }

  /** Headline events since the last call, for the HUD to announce. */
  drainNotices(): string[] {
    const out = this.notices;
    this.notices = [];
    return out;
  }

  /** Put every part back on every car and clear the road. Used on a restart. */
  clearDebris(): void {
    this.notices = [];
    for (const car of this.cars) {
      car.debris?.reset();
      car.loose.length = 0;
    }
    this.wildlife?.reset();
    this.ambient?.reset();
    while (this.loose.length > 0) this.removeLoose(this.loose.length - 1);
  }

  /** Index of the loose body furthest from a point, for recycling. */
  private farthestLoose(from: Vec3): number {
    let worst = 0;
    let worstDistance = -1;
    for (let i = 0; i < this.loose.length; i++) {
      const at = this.loose[i]!.body.translation() as Vec3;
      const dx = at.x - from.x;
      const dz = at.z - from.z;
      const distance = dx * dx + dz * dz;
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = i;
      }
    }
    return worst;
  }

  private removeLoose(index: number): void {
    const entry = this.loose[index];
    if (!entry) return;
    this.world.removeRigidBody(entry.body);
    this.loose.splice(index, 1);
    for (const car of this.cars) {
      const at = car.loose.indexOf(entry);
      if (at >= 0) car.loose.splice(at, 1);
    }
  }

  private surfaceIdAt(p: Vec3): SurfaceId {
    if (this.stage) {
      const hit = this.stage.surfaceAt(p, this.splineHint);
      this.splineHint = hit.index;
      return hit.surface;
    }
    for (const patch of this.patches) {
      if (
        Math.abs(p.x - patch.x) <= patch.halfX &&
        Math.abs(p.z - patch.z) <= patch.halfZ
      ) {
        return patch.surface;
      }
    }
    return this.baseSurface;
  }

  /**
   * One fixed step.
   *
   * Takes one input for the local car, or one per car for a race. Anything not
   * given an input coasts, which is what a disconnected player's car does until
   * the host removes it.
   */
  step(input: DriverInput | readonly DriverInput[]): void {
    const inputs = Array.isArray(input) ? input : [input as DriverInput];

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i]!;
      const previous = this.previousTransforms[i]!;
      previous.position = { ...(car.vehicle.body.translation() as Vec3) };
      previous.rotation = { ...(car.vehicle.body.rotation() as Quat) };
      car.vehicle.step(this.dt, inputs[i] ?? inputs[0] ?? NEUTRAL_INPUT);
    }

    this.world.step(this.events ?? undefined);
    this.processImpacts();
    this.updateDebris();
    this.updateWorldEvents();
    this.time += this.dt;
    this.steps++;
  }

  /**
   * Consume `elapsed` wall-clock seconds as whole fixed steps, returning the
   * leftover fraction so the renderer can interpolate. Clamped so a stalled tab
   * can't trigger a spiral of death.
   */
  advance(elapsed: number, input: DriverInput | readonly DriverInput[] = NEUTRAL_INPUT): number {
    this.accumulator = Math.min(this.accumulator + elapsed, 0.25);
    while (this.accumulator >= this.dt) {
      this.step(input);
      this.accumulator -= this.dt;
    }
    return this.accumulator / this.dt;
  }

  state(): VehicleState {
    return this.vehicle.state();
  }

  /**
   * Put the car back on the centreline, upright and stationary.
   *
   * A car can end up beached across the verge lip with its chassis resting on
   * the ground and all four wheels dangling — no drive, no way out. Every rally
   * game needs an answer to that, and it is also what keeps the headless stage
   * validator from reporting a stage as impossible because of one bad landing.
   *
   * It rewinds slightly so the corner is re-entered rather than resumed from
   * halfway through.
   */
  rescue(distance?: number): void {
    if (!this.stage) {
      this.vehicle.reset(v3(0, 1.2, 0), 0);
      return;
    }
    const at = distance ?? this.stage.progressAt(this.state().position, this.splineHint).distance;
    const s = this.stage.spline.at(Math.max(at - 8, 0));
    this.vehicle.reset(add(s.position, v3(0, 1.4, 0)), Math.atan2(s.forward.x, s.forward.z));
    this.splineHint = undefined;
  }

  /**
   * Chassis transform blended between the last two fixed steps. Rendering from
   * this instead of the raw state is what keeps a 120 Hz sim smooth on a 60,
   * 144 or 240 Hz display.
   */
  renderTransform(alpha: number, carIndex = 0): { position: Vec3; rotation: Quat } {
    const car = this.cars[carIndex] ?? this.cars[0]!;
    const previous = this.previousTransforms[carIndex] ?? this.previousTransforms[0]!;
    const current = car.vehicle.body.translation() as Vec3;
    const rotation = car.vehicle.body.rotation() as Quat;
    return {
      position: lerpVec(previous.position, current, alpha),
      rotation: slerp(previous.rotation, rotation, alpha),
    };
  }
}

/** Convenience for headless callers: init wasm, then build a world. */
export async function createWorld(options: WorldOptions = {}): Promise<SimWorld> {
  await initPhysics();
  return new SimWorld(options);
}

export { RAPIER };
