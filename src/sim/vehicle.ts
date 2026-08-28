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
import { CLEAR_DAY, type Conditions, gripMultiplier } from './conditions.js';
import type { DamageEffects, DamageModel } from './damage.js';
import type { DebrisModel } from './debris.js';
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
/**
 * Closing speed below which bottoming out is just a hard bump, m/s.
 *
 * Kerbs and compressions bottom the suspension all the time at low speed; only
 * a landing arrives fast enough to matter, and without a floor here every kerb
 * in the game would quietly bill the player for a suspension.
 */
const BOTTOM_OUT_SPEED = 2.5;
/**
 * How much harsher a bump stop is than an equivalent impact into the nose.
 *
 * The damage thresholds were calibrated against wall impacts, where a crumpling
 * panel and the whole structure sit between the obstacle and the part. A bump
 * stop is steel onto the damper with nothing in between. Set so that a landing
 * on one corner from about 5 m starts costing a suspension, and a flat landing
 * from the same height costs nothing — which is what separates a bad landing
 * from a merely spectacular one. Measured with `npm run crash -- --drop=`.
 */
const BOTTOM_OUT_HARSHNESS = 1.8;
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
  /** Rotation about the car's up axis, rad/s. Signed: positive turns right. */
  yawRate: number;
  wheels: WheelState[];
  airborne: boolean;
  /** True while the gearbox is between gears and delivering no torque. */
  shifting: boolean;
  /**
   * Torque being delivered as a fraction of what these revs could give.
   *
   * Positive on power, **negative on the overrun** — a trailing throttle at
   * high revs is an engine being driven by the car rather than the other way
   * round, and it sounds completely different. Not the same thing as throttle:
   * a pedal buried at 2 000 rpm in top gear is a loaded, labouring engine, and
   * the same pedal at the limiter in first is not.
   */
  engineLoad: number;
}

export interface VehicleOptions {
  /** Resolves the surface under a contact point. P0 uses a single surface. */
  surfaceAt?: (point: Vec3) => Surface;
  /** Component damage. When absent the car behaves as if factory fresh. */
  damage?: DamageModel;
  /** Attachment state, for the drag a scraping part adds. */
  debris?: DebrisModel;
  /** Weather and time of day. Weather takes real grip away. */
  conditions?: Conditions;
}

/** What an undamaged car looks like, so the damage-free path costs nothing. */
const PRISTINE: DamageEffects = {
  engineTorque: 1,
  misfiring: false,
  wheelGrip: [1, 1, 1, 1],
  wheelBrake: [1, 1, 1, 1],
  wheelSuspension: [1, 1, 1, 1],
  wheelLost: [false, false, false, false],
  wheelDrag: [0, 0, 0, 0],
  wheelSink: [0, 0, 0, 0],
  steeringOffset: 0,
  steeringRange: 1,
  dragScale: 1,
  shiftFailure: 0,
  stalled: false,
  retired: false,
};

export class Vehicle {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;

  private readonly rapier: typeof RAPIER;
  private readonly world: RAPIER.World;
  readonly tuning: VehicleTuning;
  private readonly surfaceAt: (point: Vec3) => Surface;
  readonly damage: DamageModel | null;
  readonly debris: DebrisModel | null;
  readonly conditions: Conditions;
  private effects: DamageEffects = PRISTINE;

  readonly wheels: WheelState[] = [];

  private steerAngle = 0;
  private gearIndex = 1;
  private shiftTimer = 0;
  /** Seconds spent stationary under braking, before reverse engages. */
  private reverseHold = 0;
  private engineRpm: number;
  /** Fraction of available torque being delivered; negative on the overrun. */
  private engineLoad = 0;

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
    this.damage = options.damage ?? null;
    this.debris = options.debris ?? null;
    this.conditions = options.conditions ?? CLEAR_DAY;

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

  /**
   * Brake torque actually applied at each corner this step, Nm. The thermal
   * model reads it: heat is the work the caliper did, not the pedal travel.
   */
  private readonly brakeApplied: [number, number, number, number] = [0, 0, 0, 0];

  /** Largest bump-stop impulse this step, N·s. Drained by the world. */
  landingImpact = 0;

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

    if (this.damage) {
      this.damage.update(dt, { rpmFraction: this.engineRpm / t.maxRpm, speed });
      // Wear is read from the previous step's tyre state, which is the state
      // that actually did the sliding.
      this.damage.wearTyres(dt, this.wheels, t.tireWearRate);
      this.effects = this.damage.effects();
    }
    const fx = this.effects;

    // Right is right. The car's local +X points to its left in a right-handed
    // Y-up world with the nose along +Z, so a positive steer input has to be
    // negated here — without this, pressing right turned the car left, which is
    // exactly what it did for the whole of the first nine phases.
    this.updateSteering(dt, -input.steer, planarSpeed);

    // --- Suspension pass -----------------------------------------------------
    // Forces are gathered first so the anti-roll bar can see both sides of an
    // axle before anything is applied.
    const susp: number[] = [0, 0, 0, 0];
    const hit: ({ point: Vec3; normal: Vec3 } | null)[] = [null, null, null, null];
    /** Closing speed at each corner that ran out of suspension travel, m/s. */
    const bottomed: number[] = [0, 0, 0, 0];

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i]!;
      const mountLocal = t.wheelPositions[i]!;
      const mount = add(pos, rotate(rot, mountLocal));
      // A deflated tyre sits the corner down on its sidewall, so the car
      // leans on that corner and the ride height goes with it.
      const maxToi = t.suspensionRestLength + t.wheelRadius - fx.wheelSink[i]!;

      if (fx.wheelLost[i]) {
        // A detached wheel carries no load and generates no force at all.
        w.grounded = false;
        w.compression = 0;
        w.load = 0;
        w.saturation = 0;
        w.contact = mount;
        continue;
      }

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
      // A collapsed spring supports less and rebounds worse, so the corner
      // bottoms out and the car pulls toward the damaged side.
      const wear = fx.wheelSuspension[i]!;
      const force = Math.max(
        0,
        t.suspensionStiffness * wear * compression + damping * wear * compressionSpeed,
      );

      susp[i] = force;
      hit[i] = { point, normal: result.normal as Vec3 };
      // Bottoming out: the spring has run out of travel and whatever closing
      // speed is left goes through the bump stop into the car. Recorded here
      // and turned into damage once every corner is known, because how bad a
      // landing is depends on how many wheels are sharing it.
      bottomed[i] =
        compression >= t.suspensionRestLength - 1e-3 && compressionSpeed > BOTTOM_OUT_SPEED
          ? compressionSpeed
          : 0;

      w.grounded = true;
      w.compression = compression / t.suspensionRestLength;
      w.contact = point;
      w.surface = this.surfaceAt(point);
    }

    // Anti-roll bars couple the two wheels on each axle. The bar resists the
    // difference in compression, so the *more* compressed (outer) wheel gains
    // support and the inner one loses it — that couple is what opposes body
    // roll. Getting this sign backwards amplifies roll instead of resisting it
    // and lifts the inside wheels clean off the ground in a fast corner.
    //
    // It only acts with both wheels on an axle grounded: a real bar needs
    // something to react against, and applying it against an airborne wheel
    // removes support from the one wheel still carrying the car.
    for (const [l, r] of [
      [0, 1],
      [2, 3],
    ] as const) {
      if (!this.wheels[l]!.grounded || !this.wheels[r]!.grounded) continue;
      const diff = (this.wheels[l]!.compression - this.wheels[r]!.compression) * t.antiRollStiffness;
      susp[l] = Math.max(0, susp[l]! + diff);
      susp[r] = Math.max(0, susp[r]! - diff);
    }

    for (let i = 0; i < 4; i++) {
      const h = hit[i];
      if (!h) continue;
      this.wheels[i]!.load = susp[i]!;
      body.addForceAtPoint(scale(up, susp[i]!), h.point, true);
    }

    // A landing that bottoms the suspension is an impact like any other, and it
    // goes through the same pipeline: the car's vertical momentum has to be
    // arrested by however many corners are taking it, so a nose-first landing
    // puts twice as much through each front corner as a flat one does through
    // each of four. This is "landing in a bad place hurts" falling out of the
    // physics rather than being scripted.
    if (this.damage) {
      const sharing = bottomed.filter((v) => v > 0).length;
      if (sharing > 0) {
        for (let i = 0; i < 4; i++) {
          if (bottomed[i]! <= 0) continue;
          const impulse = (t.mass * bottomed[i]! * BOTTOM_OUT_HARSHNESS) / sharing;
          this.damage.applyImpact(t.wheelPositions[i]!, impulse);
          // A landing hard enough to bottom the suspension has to be felt, or
          // the repair bill arrives with no memory of earning it.
          this.landingImpact = Math.max(this.landingImpact, impulse);
        }
      }
    }

    // --- Drivetrain ----------------------------------------------------------
    this.updateGearbox(dt, speed, input);

    // Arcade reverse: at a standstill, holding the brake selects reverse and
    // then *is* the reverse throttle, while the throttle becomes the brake.
    // Without this swap the car engages reverse and then brakes itself in place
    // forever, because any throttle input immediately reselects first gear.
    const inReverse = this.gearIndex === 0;
    const driveInput = inReverse ? input.brake : input.throttle;
    const brakeInput = inReverse ? input.throttle : input.brake;

    // A stalled engine makes nothing and brakes nothing: it is disconnected,
    // not seized to the driveline. The car rolls, steers and brakes exactly as
    // it did — which is what lets a dead car coast over a finish line.
    const engineTorque = fx.stalled
      ? 0
      : this.engineTorque(driveInput) * fx.engineTorque * (fx.misfiring ? 0 : 1);
    // How hard the engine is working, signed, each direction normalised to what
    // it can actually do that way: peak torque on power, and full engine
    // braking at these revs on the overrun. Normalising both against peak
    // torque instead makes the overrun read as 0.02 — technically true, and
    // useless as a signal, because engine braking is a fraction of what an
    // engine can push.
    const revs = clamp(this.engineRpm, t.idleRpm, t.maxRpm);
    const capacity =
      engineTorque >= 0
        ? Math.max(sampleCurve(t.torqueCurve, revs), 1)
        : Math.max(t.engineBraking * (revs / t.maxRpm), 1);
    this.engineLoad = clamp(engineTorque / capacity, -1, 1);
    const gearRatio = t.gearRatios[this.gearIndex] ?? 0;
    const shifting = this.shiftTimer > 0;
    const axleTorque = shifting
      ? 0
      : engineTorque * gearRatio * t.finalDrive * t.drivetrainEfficiency;

    const driveTorques = this.distributeTorque(axleTorque);

    // --- Tire pass -----------------------------------------------------------
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i]!;
      const front = this.isFront(i);
      w.steer = front ? this.steerAngle : 0;

      const driveTorque = driveTorques[i]!;
      const axleBrake = brakeInput * (front ? t.brakeBias : 1 - t.brakeBias) * 2;
      const brakeTorque =
        t.brakeTorque * clamp(axleBrake, 0, 1) * fx.wheelBrake[i]! +
        (front ? 0 : t.handbrakeTorque * input.handbrake);
      this.brakeApplied[i] = brakeTorque;

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
      // Weather multiplies in alongside the surface's own grip: a wet racing
      // line is a different road from a dry one, and the car has to feel that.
      const weather = gripMultiplier(this.conditions, w.surface);
      const mu = t.tireGrip * w.surface.grip * weather * balance * handbrakeLoss * fx.wheelGrip[i]!;

      const f = tireForces({
        load: susp[i]!,
        mu,
        slipAngle: sa,
        slipRatio: sr,
        peakSlipAngle: t.peakSlipAngle,
        peakSlipRatio: t.peakSlipRatio,
        slideFloor: t.slideGripFloor,
        lockedFloor: t.lockedGripFloor,
        driveScale: 1,
      });

      w.slipAngle = sa;
      w.slipRatio = sr;
      w.saturation = f.saturation;

      const rolling =
        -Math.sign(vForward) * (w.surface.rollingResistance + fx.wheelDrag[i]!) * susp[i]!;
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
      // A bumper hanging off the front is worth more drag than a crumpled
      // panel, and it is drag you can hear and see the cause of.
      const debrisDrag = this.debris?.dragScale ?? 1;
      body.addForce(
        scale(normalize(linvel), -t.dragFactor * fx.dragScale * debrisDrag * v * v),
        true,
      );
    }
    const grounded = this.wheels.some((w) => w.grounded);
    if (grounded) {
      body.addForce(scale(up, -t.downforceFactor * v * v), true);
      body.addTorque(scale(up, -t.yawDamping * dot(angvel, up)), true);
    }

    // Brake heat is settled last, on the torques and wheel speeds this step
    // actually produced. The fade it causes arrives next step, through
    // `effects()`.
    if (this.damage) {
      this.damage.updateBrakes(
        dt,
        this.wheels.map((w, i) => ({ torque: this.brakeApplied[i]!, spin: w.spin })),
        planarSpeed,
      );
    }
  }

  /**
   * Split total axle torque across the four wheels through the differentials.
   *
   * Each diff shifts torque away from whichever side is spinning faster, capped
   * at a fraction of what that axle is being given. Because this only ever
   * redistributes torque that already exists, it cannot inject energy — which
   * an implementation that forces wheel speeds together can, and does,
   * violently.
   */
  private distributeTorque(axleTorque: number): number[] {
    const t = this.tuning;
    const out = [0, 0, 0, 0];

    const split = (a: number, b: number, total: number) => {
      const diff = this.wheels[a]!.spin - this.wheels[b]!.spin;
      const cap = Math.abs(total) * t.lsdBias;
      const transfer = clamp(diff * t.lsdLock, -cap, cap);
      out[a] = total / 2 - transfer;
      out[b] = total / 2 + transfer;
    };

    let frontShare = this.torqueShare(0) + this.torqueShare(1);
    let rearShare = this.torqueShare(2) + this.torqueShare(3);

    if (t.drivetrain === 'awd') {
      // Centre diff: same idea one level up, biasing between the axles.
      const front = (this.wheels[0]!.spin + this.wheels[1]!.spin) / 2;
      const rear = (this.wheels[2]!.spin + this.wheels[3]!.spin) / 2;
      const shift = clamp((front - rear) * t.centreLock, -t.centreBias, t.centreBias);
      frontShare = clamp(frontShare - shift, 0, 1);
      rearShare = clamp(rearShare + shift, 0, 1);
    }

    if (frontShare > 0) split(0, 1, axleTorque * frontShare);
    if (rearShare > 0) split(2, 3, axleTorque * rearShare);
    return out;
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

    const angvel = this.body.angvel() as Vec3;
    const up = rotate(rot, v3(0, 1, 0));

    return {
      position: this.body.translation() as Vec3,
      rotation: rot,
      velocity: linvel,
      speed: dot(linvel, nose),
      rpm: this.engineRpm,
      gear: this.gearIndex,
      driftAngle: drift,
      // Negated for the same reason as the steering: positive is a right-hand
      // turn, which is what every consumer of this number assumes.
      yawRate: -dot(angvel, up),
      wheels: this.wheels,
      shifting: this.shiftTimer > 0,
      engineLoad: this.engineLoad,
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
    const fx = this.effects;
    const falloff =
      1 -
      (1 - t.steerSpeedFalloff) * clamp(speed / t.steerSpeedFalloffAt, 0, 1);
    const maxAngle = t.maxSteerAngle * fx.steeringRange;
    // A bent rack biases the whole range, so the car pulls even hands-off and
    // has less lock available to correct with.
    const desired = clamp(
      clamp(target, -1, 1) * maxAngle * falloff + fx.steeringOffset,
      -maxAngle,
      maxAngle,
    );
    const rate = Math.abs(target) < 0.05 ? t.steerReturnRate : t.steerRate;
    this.steerAngle = moveToward(this.steerAngle, desired, rate * t.maxSteerAngle * dt);
  }

  private engineTorque(throttle: number): number {
    const t = this.tuning;
    const rpm = clamp(this.engineRpm, t.idleRpm, t.maxRpm);
    const peak = sampleCurve(t.torqueCurve, rpm);
    const th = clamp(throttle, 0, 1);

    // Engine braking scales with revs and fades out as the throttle opens. It
    // is what makes lifting mid-corner shift weight forward and tuck the nose
    // in — the single most useful thing a rally driver does with their right
    // foot, and the car feels inert without it.
    const braking = t.engineBraking * (rpm / t.maxRpm) * (1 - th);

    return peak * (0.06 + 0.94 * th) - braking;
  }

  private updateGearbox(dt: number, speed: number, input: DriverInput): void {
    const t = this.tuning;
    if (this.shiftTimer > 0) this.shiftTimer -= dt;

    const driven = this.wheels.filter((_, i) => this.isDriven(i));
    const avgSpin = driven.reduce((s, w) => s + w.spin, 0) / Math.max(driven.length, 1);

    const ratio = t.gearRatios[this.gearIndex] ?? 1;
    const rawRpm = Math.abs(avgSpin * ratio * t.finalDrive) * RPM_PER_RAD_S;
    // A stalled engine is not idling: it is stopped, and the rev counter says
    // so. Without this the HUD keeps a dead car ticking over at idle.
    this.engineRpm = this.effects.stalled
      ? 0
      : clamp(Math.max(rawRpm, t.idleRpm), t.idleRpm, t.maxRpm);

    // Reverse engages from a near-stop when braking with no throttle, and is
    // left again by applying throttle once the car has stopped rolling back.
    // The short hold stops a hard stop from flipping straight into reverse
    // while the player still has the brake buried.
    if (this.gearIndex > 0 && speed < 0.6 && input.brake > 0.5 && input.throttle < 0.1) {
      this.reverseHold += dt;
      if (this.reverseHold > 0.45) {
        this.gearIndex = 0;
        this.reverseHold = 0;
      }
      return;
    }
    this.reverseHold = 0;
    if (this.gearIndex === 0) {
      if (speed > -0.6 && input.throttle > 0.4 && input.brake < 0.1) this.gearIndex = 1;
      return;
    }
    if (this.shiftTimer > 0) return;

    const frac = this.engineRpm / t.maxRpm;
    if (frac > t.upshiftAt && this.gearIndex < t.gearRatios.length - 1) {
      // A damaged gearbox sometimes refuses the shift and sits on the limiter.
      // Drawn from the damage model's stream rather than Math.random, so a
      // headless run stays reproducible with a damaged car.
      // Without a damage model there is nothing to fail, so there is no roll
      // to make and no need for a stream at all.
      const roll = this.damage?.nextRandom() ?? 1;
      if (this.effects.shiftFailure > 0 && roll < this.effects.shiftFailure) {
        this.shiftTimer = t.shiftTime * 2;
        return;
      }
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
    this.reverseHold = 0;
    this.engineRpm = this.tuning.idleRpm;
    this.effects = this.damage ? this.damage.effects() : PRISTINE;
    for (const w of this.wheels) {
      w.spin = 0;
      w.rotation = 0;
      w.saturation = 0;
    }
  }
}
