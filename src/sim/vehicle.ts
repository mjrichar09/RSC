/**
 * The car.
 *
 * A Rapier dynamic body with four raycast wheels. Each wheel contributes a
 * suspension force along the body's up axis and a tire force in the contact
 * plane; the chassis itself never touches the ground in normal driving.
 *
 * Wheel angular velocity is integrated explicitly so that wheelspin and lockup
 * emerge from the model rather than being faked — that matters because P4 hangs
 * per-corner brake and tire damage off exactly these numbers.
 */

import type RAPIER from '@dimforge/rapier3d-compat';
import type { VehicleTuning } from '../data/tuning.js';
import type { DriverInput } from './input.js';
import { type Surface, surface } from './surfaces.js';
import { slipAngle, slipRatio, tireForces } from './tires.js';
import {
  type Quat,
  type Vec3,
  add,
  clamp,
  cross,
  dot,
  length,
  moveToward,
  normalize,
  rotate,
  sampleCurve,
  scale,
  sub,
  v3,
} from './math.js';

const RPM_PER_RAD_S = 60 / (2 * Math.PI);
/** Rotational inertia of one wheel+hub assembly, kg·m². */
const WHEEL_INERTIA = 1.2;
/** Real cars rotate more willingly than a solid box of the same size. */
const YAW_INERTIA_SCALE = 0.62;

export interface WheelState {
  /** Contact point in world space, or the ray end when airborne. */
  contact: Vec3;
  grounded: boolean;
  /** 0..1 suspension compression. */
  compression: number;
  /** Vertical load, newtons. */
  load: number;
  /** Steering angle, radians. */
  steer: number;
  /** Spin, rad/s. Positive drives the car forward. */
  spin: number;
  /** Accumulated wheel rotation for rendering, radians. */
  rotation: number;
  slipAngle: number;
  slipRatio: number;
  /** 0..1+, how saturated the tire is. Drives skid audio and particles. */
  saturation: number;
  surface: Surface;
}

export interface VehicleState {
  position: Vec3;
  rotation: Quat;
  velocity: Vec3;
  /** Forward speed in m/s (signed). */
  speed: number;
  rpm: number;
  gear: number;
  /** Angle between the car's nose and its direction of travel, radians. */
  driftAngle: number;
  wheels: WheelState[];
  airborne: boolean;
}

export interface VehicleOptions {
  /** Resolves the surface under a contact point. P0 uses a single surface. */
  surfaceAt?: (point: Vec3) => Surface;
}

export class Vehicle {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;

  private readonly rapier: typeof RAPIER;
  private readonly world: RAPIER.World;
  private readonly tuning: VehicleTuning;
  private readonly surfaceAt: (point: Vec3) => Surface;

  readonly wheels: WheelState[] = [];

  private steerAngle = 0;
  private gearIndex = 1;
  private shiftTimer = 0;
  private engineRpm: number;

  constructor(
    rapier: typeof RAPIER,
    world: RAPIER.World,
    tuning: VehicleTuning,
    spawn: { position: Vec3; heading?: number },
    options: VehicleOptions = {},
  ) {
    this.rapier = rapier;
    this.world = world;
    this.tuning = tuning;
    this.engineRpm = tuning.idleRpm;
    this.surfaceAt = options.surfaceAt ?? (() => surface('tarmac'));

    const h = tuning.halfExtents;
    const heading = spawn.heading ?? 0;

    const desc = rapier
      .RigidBodyDesc.dynamic()
      .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
      .setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) })
      .setLinearDamping(0.02)
      .setAngularDamping(0.35)
      .setCcdEnabled(true);

    // Mass properties are set explicitly rather than derived from the collider,
    // so the centre of mass can be dropped below the collider centre.
    const m = tuning.mass;
    desc.setAdditionalMassProperties(
      m,
      tuning.centerOfMass,
      {
        x: (m / 12) * (4 * h.y * h.y + 4 * h.z * h.z),
        y: (m / 12) * (4 * h.x * h.x + 4 * h.z * h.z) * YAW_INERTIA_SCALE,
        z: (m / 12) * (4 * h.x * h.x + 4 * h.y * h.y),
      },
      { x: 0, y: 0, z: 0, w: 1 },
    );

    this.body = world.createRigidBody(desc);
    this.collider = world.createCollider(
      rapier.ColliderDesc.cuboid(h.x, h.y, h.z)
        .setDensity(0)
        .setFriction(0.2)
        .setRestitution(0.1)
        .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(2000),
      this.body,
    );

    for (const p of tuning.wheelPositions) {
      this.wheels.push({
        contact: v3(p.x, p.y, p.z),
        grounded: false,
        compression: 0,
        load: 0,
        steer: 0,
        spin: 0,
        rotation: 0,
        slipAngle: 0,
        slipRatio: 0,
        saturation: 0,
        surface: surface('tarmac'),
      });
    }
  }

  private isFront(i: number): boolean {
    return i < 2;
  }

  private isDriven(i: number): boolean {
    const d = this.tuning.drivetrain;
    return d === 'awd' || (d === 'fwd' && this.isFront(i)) || (d === 'rwd' && !this.isFront(i));
  }

  /** Fraction of engine torque this wheel receives. */
  private torqueShare(i: number): number {
    if (!this.isDriven(i)) return 0;
    const { drivetrain, awdRearBias } = this.tuning;
    if (drivetrain !== 'awd') return 0.5;
    return this.isFront(i) ? (1 - awdRearBias) / 2 : awdRearBias / 2;
  }

  /** Advance one fixed step. Call before `world.step()`. */
  step(dt: number, input: DriverInput): void {
    const t = this.tuning;
    const body = this.body;

    body.resetForces(false);
    body.resetTorques(false);

    const pos = body.translation() as Vec3;
    const rot = body.rotation() as Quat;
    const linvel = body.linvel() as Vec3;
    const angvel = body.angvel() as Vec3;

    const up = rotate(rot, v3(0, 1, 0));
    const nose = rotate(rot, v3(0, 0, 1));
    const speed = dot(linvel, nose);
    const planarSpeed = Math.hypot(linvel.x, linvel.z);

    this.updateSteering(dt, input.steer, planarSpeed);

    // --- Suspension pass -----------------------------------------------------
    // Forces are gathered first so the anti-roll bar can see both sides of an
    // axle before anything is applied.
    const susp: number[] = [0, 0, 0, 0];
    const hit: ({ point: Vec3; normal: Vec3 } | null)[] = [null, null, null, null];

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i]!;
      const mountLocal = t.wheelPositions[i]!;
      const mount = add(pos, rotate(rot, mountLocal));
      const maxToi = t.suspensionRestLength + t.wheelRadius;

      const ray = new this.rapier.Ray(mount, scale(up, -1));
      const result = this.world.castRayAndGetNormal(
        ray,
        maxToi,
        true,
        undefined,
        undefined,
        this.collider,
      );

      if (!result) {
        w.grounded = false;
        w.compression = 0;
        w.load = 0;
        w.saturation = 0;
        w.slipAngle = 0;
        w.slipRatio = 0;
        w.contact = add(mount, scale(up, -maxToi));
        continue;
      }

      const toi = result.timeOfImpact;
      const point = add(mount, scale(up, -toi));
      const compression = clamp(maxToi - toi, 0, t.suspensionRestLength);

      const pointVel = add(linvel, cross(angvel, sub(point, this.worldCenterOfMass())));
      const compressionSpeed = -dot(pointVel, up);

      const damping =
        compressionSpeed >= 0 ? t.suspensionDamping : t.suspensionReboundDamping;
      const force = Math.max(0, t.suspensionStiffness * compression + damping * compressionSpeed);

      susp[i] = force;
      hit[i] = { point, normal: result.normal as Vec3 };

      w.grounded = true;
      w.compression = compression / t.suspensionRestLength;
      w.contact = point;
      w.surface = this.surfaceAt(point);
    }

    // Anti-roll bars couple the two wheels on each axle, which is what stops the
    // car rolling onto its door in a fast corner.
    for (const [l, r] of [
      [0, 1],
      [2, 3],
    ] as const) {
      const diff = (this.wheels[l]!.compression - this.wheels[r]!.compression) * t.antiRollStiffness;
      if (this.wheels[l]!.grounded) susp[l] = Math.max(0, susp[l]! - diff);
      if (this.wheels[r]!.grounded) susp[r] = Math.max(0, susp[r]! + diff);
    }

    for (let i = 0; i < 4; i++) {
      const h = hit[i];
      if (!h) continue;
      this.wheels[i]!.load = susp[i]!;
      body.addForceAtPoint(scale(up, susp[i]!), h.point, true);
    }

    // --- Drivetrain ----------------------------------------------------------
    this.updateGearbox(dt, speed, input);
    const engineTorque = this.engineTorque(input.throttle);
    const gearRatio = t.gearRatios[this.gearIndex] ?? 0;
    const shifting = this.shiftTimer > 0;
    const axleTorque = shifting
      ? 0
      : engineTorque * gearRatio * t.finalDrive * t.drivetrainEfficiency;

    // --- Tire pass -----------------------------------------------------------
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i]!;
      const front = this.isFront(i);
      w.steer = front ? this.steerAngle : 0;

      const driveTorque = axleTorque * this.torqueShare(i);
      const brakeInput = input.brake * (front ? t.brakeBias : 1 - t.brakeBias) * 2;
      const brakeTorque =
        t.brakeTorque * clamp(brakeInput, 0, 1) +
        (front ? 0 : t.handbrakeTorque * input.handbrake);

      const h = hit[i];
      if (!h) {
        // Airborne: the wheel is free, so it just spins up under drive torque
        // and bleeds off slowly. Keeps the visual spin honest over jumps.
        w.spin += ((driveTorque - Math.sign(w.spin) * brakeTorque) / WHEEL_INERTIA) * dt;
        w.spin *= 0.995;
        w.rotation += w.spin * dt;
        continue;
      }

      const steerRot: Quat = {
        x: 0,
        y: Math.sin(w.steer / 2),
        z: 0,
        w: Math.cos(w.steer / 2),
      };
      // Wheel axes, flattened into the contact plane so slopes don't inject
      // spurious longitudinal force.
      const forward = normalize(this.projectOntoPlane(rotate(rot, rotate(steerRot, v3(0, 0, 1))), up));
      const right = normalize(cross(up, forward));

      const pointVel = add(linvel, cross(angvel, sub(h.point, this.worldCenterOfMass())));
      const vForward = dot(pointVel, forward);
      const vLateral = dot(pointVel, right);

      const sa = slipAngle(vForward, vLateral);
      const sr = slipRatio(w.spin * t.wheelRadius, vForward);

      const balance = front ? t.tireGripBalance : 2 - t.tireGripBalance;
      const handbrakeLoss =
        front || input.handbrake === 0 ? 1 : 1 - input.handbrake * (1 - t.handbrakeGripLoss);
      const mu = t.tireGrip * w.surface.grip * balance * handbrakeLoss;

      const f = tireForces({
        load: susp[i]!,
        mu,
        slipAngle: sa,
        slipRatio: sr,
        peakSlipAngle: t.peakSlipAngle,
        peakSlipRatio: t.peakSlipRatio,
        slideFloor: t.slideGripFloor,
        driveScale: 1,
      });

      w.slipAngle = sa;
      w.slipRatio = sr;
      w.saturation = f.saturation;

      const rolling = -Math.sign(vForward) * w.surface.rollingResistance * susp[i]!;
      const tireForce = add(scale(forward, f.longitudinal + rolling), scale(right, f.lateral));
      body.addForceAtPoint(tireForce, h.point, true);

      // Wheel spin responds to drive torque minus the tire's reaction, then the
      // brake is applied as a clamped impulse so it can never spin the wheel
      // backwards within a single step.
      const reaction = f.longitudinal * t.wheelRadius;
      w.spin += ((driveTorque - reaction) / WHEEL_INERTIA) * dt;

      const brakeDelta = (brakeTorque / WHEEL_INERTIA) * dt;
      w.spin = moveToward(w.spin, 0, brakeDelta);
      w.rotation += w.spin * dt;
    }

    // --- Body forces ---------------------------------------------------------
    const v = length(linvel);
    if (v > 0.1) {
      body.addForce(scale(normalize(linvel), -t.dragFactor * v * v), true);
    }
    const grounded = this.wheels.some((w) => w.grounded);
    if (grounded) {
      body.addForce(scale(up, -t.downforceFactor * v * v), true);
      body.addTorque(scale(up, -t.yawDamping * dot(angvel, up)), true);
    }
  }

  /** Snapshot for rendering, telemetry and ghost recording. */
  state(): VehicleState {
    const rot = this.body.rotation() as Quat;
    const linvel = this.body.linvel() as Vec3;
    const nose = rotate(rot, v3(0, 0, 1));
    const planar = v3(linvel.x, 0, linvel.z);
    const drift =
      length(planar) > 1.5
        ? Math.acos(clamp(dot(normalize(planar), normalize(v3(nose.x, 0, nose.z))), -1, 1))
        : 0;

    return {
      position: this.body.translation() as Vec3,
      rotation: rot,
      velocity: linvel,
      speed: dot(linvel, nose),
      rpm: this.engineRpm,
      gear: this.gearIndex,
      driftAngle: drift,
      wheels: this.wheels,
      airborne: !this.wheels.some((w) => w.grounded),
    };
  }

  private worldCenterOfMass(): Vec3 {
    return this.body.worldCom() as Vec3;
  }

  private projectOntoPlane(vec: Vec3, normal: Vec3): Vec3 {
    return sub(vec, scale(normal, dot(vec, normal)));
  }

  private updateSteering(dt: number, target: number, speed: number): void {
    const t = this.tuning;
    const falloff =
      1 -
      (1 - t.steerSpeedFalloff) * clamp(speed / t.steerSpeedFalloffAt, 0, 1);
    const desired = clamp(target, -1, 1) * t.maxSteerAngle * falloff;
    const rate = Math.abs(target) < 0.05 ? t.steerReturnRate : t.steerRate;
    this.steerAngle = moveToward(this.steerAngle, desired, rate * t.maxSteerAngle * dt);
  }

  private engineTorque(throttle: number): number {
    const t = this.tuning;
    const rpm = clamp(this.engineRpm, t.idleRpm, t.maxRpm);
    const peak = sampleCurve(t.torqueCurve, rpm);
    // A little torque at zero throttle keeps the engine off its idle floor
    // instead of dragging the car to a stop the moment you lift.
    return peak * (0.06 + 0.94 * clamp(throttle, 0, 1));
  }

  private updateGearbox(dt: number, speed: number, input: DriverInput): void {
    const t = this.tuning;
    if (this.shiftTimer > 0) this.shiftTimer -= dt;

    const driven = this.wheels.filter((_, i) => this.isDriven(i));
    const avgSpin = driven.reduce((s, w) => s + w.spin, 0) / Math.max(driven.length, 1);

    const ratio = t.gearRatios[this.gearIndex] ?? 1;
    const rawRpm = Math.abs(avgSpin * ratio * t.finalDrive) * RPM_PER_RAD_S;
    this.engineRpm = clamp(Math.max(rawRpm, t.idleRpm), t.idleRpm, t.maxRpm);

    // Reverse engages from a near-stop when braking with no throttle.
    if (speed < 0.6 && input.brake > 0.5 && input.throttle < 0.1) {
      this.gearIndex = 0;
      return;
    }
    if (this.gearIndex === 0 && input.throttle > 0.1) {
      this.gearIndex = 1;
      return;
    }
    if (this.gearIndex === 0 || this.shiftTimer > 0) return;

    const frac = this.engineRpm / t.maxRpm;
    if (frac > t.upshiftAt && this.gearIndex < t.gearRatios.length - 1) {
      this.gearIndex++;
      this.shiftTimer = t.shiftTime;
    } else if (frac < t.downshiftAt && this.gearIndex > 1) {
      this.gearIndex--;
      this.shiftTimer = t.shiftTime;
    }
  }

  /** Put the car back on its wheels at a given point. */
  reset(position: Vec3, heading = 0): void {
    this.body.setTranslation(position, true);
    this.body.setRotation(
      { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) },
      true,
    );
    this.body.setLinvel(v3(), true);
    this.body.setAngvel(v3(), true);
    this.steerAngle = 0;
    this.gearIndex = 1;
    this.shiftTimer = 0;
    this.engineRpm = this.tuning.idleRpm;
    for (const w of this.wheels) {
      w.spin = 0;
      w.rotation = 0;
      w.saturation = 0;
    }
  }
}
