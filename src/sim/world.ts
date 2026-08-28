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

export class SimWorld {
  readonly world: RAPIER.World;
  readonly vehicle: Vehicle;
  readonly stage: Stage | null;
  readonly damage: DamageModel | null;
  /** Parts still bolted to the car, and the ones that are not. Null without damage. */
  readonly debris: DebrisModel | null;
  /**
   * Loose parts as physics bodies, oldest first.
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
  /** Transform at the start of the last fixed step, for render interpolation. */
  private previous: { position: Vec3; rotation: Quat } = {
    position: v3(),
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
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
    this.damage =
      options.damage === undefined || options.damage === false
        ? null
        : new DamageModel({
            // Ambient air comes from the stage's conditions, so brakes and
            // coolant both behave differently on a winter night.
            ambient: ambientTemperature(this.conditions),
            ...(options.damage === true ? {} : options.damage),
          });
    this.debris = this.damage
      ? new DebrisModel({ random: () => this.damage!.nextRandom() })
      : null;
    this.wildlife =
      this.damage && this.stage
        ? new Wildlife(this.stage.spline, this.stage.length, {
            // Seeded from the stage id, so a stage's animals stand in the same
            // places on every load — the same rule its hazards follow.
            random: stageStream(this.stage.def.id),
          })
        : null;
    this.ambient =
      this.damage && this.stage
        ? new Ambient({
            biome: this.stage.def.biome,
            conditions: this.conditions,
            random: () => this.damage!.nextRandom(),
          })
        : null;
    this.events = this.damage ? new RAPIER.EventQueue(true) : null;

    this.vehicle = new Vehicle(RAPIER, this.world, resolveTuning(options.tuning), spawn, {
      surfaceAt: (p) => surface(this.surfaceIdAt(p)),
      conditions: this.conditions,
      ...(this.damage ? { damage: this.damage } : {}),
      ...(this.debris ? { debris: this.debris } : {}),
    });
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
    if (!this.events || !this.damage) return;

    this.lastImpact = 0;
    const carHandle = this.vehicle.collider.handle;
    const rotation = this.vehicle.body.rotation() as Quat;

    this.events.drainContactForceEvents((event) => {
      const involvesCar = event.collider1() === carHandle || event.collider2() === carHandle;
      if (!involvesCar) return;

      const impulse = event.totalForceMagnitude() * this.dt;
      if (impulse <= 0) return;
      this.lastImpact = Math.max(this.lastImpact, impulse);

      const worldDirection = event.maxForceDirection() as Vec3;
      // Rapier's force direction points from collider1 toward collider2. When
      // the car is collider2 that already means "the way the car was pushed";
      // when it is collider1 the direction points away from it and has to be
      // flipped. Getting this backwards puts a nose-first impact through the
      // back of the car.
      const sign = event.collider1() === carHandle ? -1 : 1;
      const local = rotateInverse(rotation, {
        x: worldDirection.x * sign,
        y: worldDirection.y * sign,
        z: worldDirection.z * sign,
      });

      const at = impactPointFromForce(local);
      this.damage!.applyImpact(at, impulse);
      // The same hit works the mounts loose. One impact, two consequences:
      // what it costs to repair, and whether the part is still on the car.
      this.debris?.applyImpact(at, impulse);
    });
  }

  /**
   * Advance the attachment state machines and turn anything that came off into
   * a real body, then clear away what is far behind.
   */
  private updateDebris(): void {
    if (!this.debris || !this.damage) return;

    const state = this.vehicle.state();
    const speed = Math.abs(state.speed);
    this.debris.update(this.dt, speed, (id) => this.damage!.get(id) <= 0);

    for (const event of this.debris.drainDetached()) this.spawnLoose(event, state);

    // Cleanup runs on distance rather than on age: a part dropped at the finish
    // line is worth keeping in view, and one dropped two corners ago is not.
    const here = state.position;
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
   * Wildlife and weather: the two things in the game that happen *to* the car
   * rather than because of it.
   */
  private updateWorldEvents(): void {
    if (!this.damage || !this.stage) return;
    const state = this.vehicle.state();
    const speed = Math.abs(state.speed);

    if (this.wildlife) {
      const here = this.stage.progressAt(state.position, this.splineHint);
      this.wildlife.update(this.dt, here.distance, speed);

      const hit = this.wildlife.strike(state.position, state.velocity, state.rotation);
      if (hit) {
        // Through the nose, like any other frontal impact — a deer strike is
        // not a special case in the damage model, it is just a heavy one.
        this.damage.applyImpact(v3(0, 0, 1.8), hit.impulse);
        this.debris?.applyImpact(v3(0, 0, 1.8), hit.impulse);
        // Felt and heard, not just billed: this is what the camera shake and
        // the impact sound read.
        this.lastImpact = Math.max(this.lastImpact, hit.impulse);
        this.notices.push('Deer strike');
        // And the car loses the momentum it gave the deer, which at speed is
        // a couple of metres per second and a very unwelcome shove.
        this.vehicle.body.applyImpulse(
          {
            x: -hit.push.x * DEER_MASS * speed,
            y: 0,
            z: -hit.push.z * DEER_MASS * speed,
          },
          true,
        );
      }
    }

    // A landing that bottomed out is an impact the player has to feel.
    if (this.vehicle.landingImpact > 0) {
      this.lastImpact = Math.max(this.lastImpact, this.vehicle.landingImpact);
      if (this.vehicle.landingImpact > 8000) this.notices.push('Heavy landing');
      this.vehicle.landingImpact = 0;
    }

    if (this.ambient) {
      this.ambient.update(this.dt, speed, this.surfaceIdAt(state.position));
      if (this.ambient.gust !== 0) {
        // A crosswind, applied across the car's own heading so it pushes the
        // line wide rather than shoving it up or down the road.
        const right = rotate(state.rotation, v3(1, 0, 0));
        const impulse = CAR.mass * this.ambient.gust * this.dt;
        this.vehicle.body.applyImpulse(
          { x: right.x * impulse, y: 0, z: right.z * impulse },
          true,
        );
      }
      for (const stone of this.ambient.drainStones()) {
        this.damage.applyImpact(stone.at, stone.impulse);
        // A stone is cosmetic, but it is a sharp crack you should hear.
        this.lastImpact = Math.max(this.lastImpact, stone.impulse * 0.4);
      }
    }
  }

  /** Turn a detached part into a dynamic body carrying the car's motion. */
  private spawnLoose(event: DetachEvent, state: VehicleState): void {
    // The *farthest* goes first, not the oldest. Recycling by age can delete a
    // bumper lying across the road ten metres ahead while a door dropped two
    // corners back survives — the one thing the player is looking at is the one
    // thing that vanishes.
    while (this.loose.length >= DEBRIS_BUDGET) this.removeLoose(this.farthestLoose(state.position));

    const rot = state.rotation;
    const offset = rotate(rot, event.at);
    const spin = () => (this.damage!.nextRandom() - 0.5) * 12;

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
        .setLinvel(
          state.velocity.x,
          state.velocity.y + 1.5 + this.damage!.nextRandom() * 2,
          state.velocity.z,
        )
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
    this.loose.push({ id: event.id, label: event.label, body, half: event.half });
  }

  /** Headline events since the last call, for the HUD to announce. */
  drainNotices(): string[] {
    const out = this.notices;
    this.notices = [];
    return out;
  }

  /** Put every part back on the car and clear the road. Used on a restart. */
  clearDebris(): void {
    this.notices = [];
    this.debris?.reset();
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

  /** One fixed step. Prefer `advance` from a render loop. */
  step(input: DriverInput): void {
    this.previous = {
      position: { ...(this.vehicle.body.translation() as Vec3) },
      rotation: { ...(this.vehicle.body.rotation() as Quat) },
    };
    this.vehicle.step(this.dt, input);
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
  advance(elapsed: number, input: DriverInput = NEUTRAL_INPUT): number {
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
  renderTransform(alpha: number): { position: Vec3; rotation: Quat } {
    const current = this.vehicle.body.translation() as Vec3;
    const rotation = this.vehicle.body.rotation() as Quat;
    return {
      position: lerpVec(this.previous.position, current, alpha),
      rotation: slerp(this.previous.rotation, rotation, alpha),
    };
  }
}

/** Convenience for headless callers: init wasm, then build a world. */
export async function createWorld(options: WorldOptions = {}): Promise<SimWorld> {
  await initPhysics();
  return new SimWorld(options);
}

export { RAPIER };
