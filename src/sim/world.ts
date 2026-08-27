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
import { type Quat, type Vec3, lerpVec, slerp, v3 } from './math.js';
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
  /** Default surface outside every patch. */
  baseSurface?: SurfaceId;
  /** Rectangular surface patches, tested in order. Replaced by stages in P2. */
  patches?: GroundPatch[];
  spawn?: { position: Vec3; heading?: number };
  /** Overrides merged over the default car. Drives the sweep tool and the live panel. */
  tuning?: Partial<VehicleTuning>;
}

/** Merge overrides over the baseline car setup. */
export const resolveTuning = (overrides?: Partial<VehicleTuning>): VehicleTuning => ({
  ...CAR,
  ...overrides,
});

export class SimWorld {
  readonly world: RAPIER.World;
  readonly vehicle: Vehicle;
  readonly dt = 1 / SIM.hz;

  /** Simulated seconds since construction. Not wall-clock time. */
  time = 0;
  /** Fixed steps taken. Useful as a determinism/regression handle. */
  steps = 0;

  private accumulator = 0;
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

    // P0 ground: a large static slab. P2 replaces this with generated stage
    // geometry, but the surface lookup below already works the same way.
    const groundBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(400, 0.5, 400).setFriction(1.0),
      groundBody,
    );

    this.vehicle = new Vehicle(
      RAPIER,
      this.world,
      resolveTuning(options.tuning),
      options.spawn ?? { position: v3(0, 1.2, 0), heading: 0 },
      { surfaceAt: (p) => surface(this.surfaceIdAt(p)) },
    );
  }

  private surfaceIdAt(p: Vec3): SurfaceId {
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
    this.world.step();
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
