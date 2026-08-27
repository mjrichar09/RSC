/**
 * Every magic number lives here.
 *
 * P1 will put a live slider panel over this object, so keep it flat, plainly
 * named and free of derived values — anything computed belongs in the system
 * that consumes it.
 */

export interface VehicleTuning {
  /** Chassis mass in kg (without the notional driver/fuel, which is folded in). */
  mass: number;
  /** Half-extents of the chassis collider, metres. */
  halfExtents: { x: number; y: number; z: number };
  /** Centre of mass offset from the collider centre, metres. Negative y = lower. */
  centerOfMass: { x: number; y: number; z: number };

  /** Wheel mount points in chassis-local space, metres. +z is forward. */
  wheelPositions: readonly { x: number; y: number; z: number }[];
  wheelRadius: number;

  /** Suspension travel from full droop to the mount, metres. */
  suspensionRestLength: number;
  /** Spring rate, N/m, per wheel. */
  suspensionStiffness: number;
  /** Damper rate, N/(m/s), per wheel. */
  suspensionDamping: number;
  /** Extra damping applied on rebound to stop pogo-ing. */
  suspensionReboundDamping: number;
  /** Anti-roll bar rate, N/m of left-right compression difference. */
  antiRollStiffness: number;

  /** Max steering angle at rest, radians. */
  maxSteerAngle: number;
  /** Steering angle multiplier at `steerSpeedFalloffAt` m/s and above. */
  steerSpeedFalloff: number;
  steerSpeedFalloffAt: number;
  /** Radians per second the front wheels can be turned. */
  steerRate: number;
  /** Radians per second the wheels return to centre with no input. */
  steerReturnRate: number;

  /** Peak engine torque curve as [rpm, Nm] pairs. */
  torqueCurve: readonly (readonly [number, number])[];
  idleRpm: number;
  maxRpm: number;
  /** Gear ratios, index 0 is reverse. */
  gearRatios: readonly number[];
  finalDrive: number;
  drivetrainEfficiency: number;
  /** 'fwd' | 'rwd' | 'awd' — awd splits torque by `awdRearBias`. */
  drivetrain: 'fwd' | 'rwd' | 'awd';
  awdRearBias: number;
  /**
   * Limited-slip differential: N·m of drive torque shifted away from a wheel
   * per rad/s that it is spinning faster than its partner.
   *
   * This biases *torque*, it does not equalise wheel speed. An open diff feeds
   * the wheel with least grip, so an unloaded inside wheel spins up and
   * swallows the engine's output; biasing torque to the slower (gripping) wheel
   * is what actually fires the car out of a corner.
   */
  lsdLock: number;
  /** Ceiling on the LSD's bias, as a fraction of that axle's torque (0..0.5). */
  lsdBias: number;
  /** Centre-diff torque bias between the axles on AWD, N·m per rad/s. */
  centreLock: number;
  /** Ceiling on the centre diff's bias, as a fraction of total torque. */
  centreBias: number;
  /** Engine braking torque at redline with a closed throttle, N·m at the crank. */
  engineBraking: number;

  /** Auto-shift points as a fraction of maxRpm. */
  upshiftAt: number;
  downshiftAt: number;
  /** Seconds of torque interruption during a shift. */
  shiftTime: number;

  /** Max brake torque at the wheel, Nm, split front/rear by `brakeBias`. */
  brakeTorque: number;
  brakeBias: number;
  handbrakeTorque: number;
  /** Rear lateral grip multiplier while the handbrake is pulled. */
  handbrakeGripLoss: number;

  /** Peak friction coefficient of the tire, before surface multipliers. */
  tireGrip: number;
  /** Front/rear grip balance. >1 gives the front more bite (more oversteer). */
  tireGripBalance: number;
  /** Slip angle of peak lateral force, radians. */
  peakSlipAngle: number;
  /** Slip ratio of peak longitudinal force. */
  peakSlipRatio: number;
  /** Fraction of peak force retained at full slide. Higher = more controllable drifts. */
  slideGripFloor: number;

  /** Drag coefficient × frontal area × ½ρ, so drag = this × v². */
  dragFactor: number;
  /** Downforce = this × v², newtons. */
  downforceFactor: number;
  /** Yaw damping torque, N·m per rad/s. Tames spins without killing rotation. */
  yawDamping: number;
}

export const CAR: VehicleTuning = {
  mass: 1180,
  halfExtents: { x: 0.85, y: 0.45, z: 1.95 },
  centerOfMass: { x: 0, y: -0.28, z: -0.05 },

  wheelPositions: [
    { x: -0.78, y: -0.25, z: 1.32 }, // front left
    { x: 0.78, y: -0.25, z: 1.32 }, // front right
    { x: -0.78, y: -0.25, z: -1.32 }, // rear left
    { x: 0.78, y: -0.25, z: -1.32 }, // rear right
  ],
  wheelRadius: 0.34,

  suspensionRestLength: 0.34,
  suspensionStiffness: 42000,
  suspensionDamping: 3600,
  suspensionReboundDamping: 5200,
  antiRollStiffness: 9000,

  maxSteerAngle: 0.5,
  steerSpeedFalloff: 0.3,
  steerSpeedFalloffAt: 24,
  steerRate: 3.6,
  steerReturnRate: 5.0,

  torqueCurve: [
    [1000, 210],
    [2000, 300],
    [3000, 360],
    [4000, 385],
    [5000, 375],
    [6000, 340],
    [7000, 275],
    [7600, 200],
  ],
  idleRpm: 1000,
  maxRpm: 7600,
  gearRatios: [-3.4, 3.55, 2.28, 1.66, 1.28, 1.0, 0.82],
  finalDrive: 4.1,
  drivetrainEfficiency: 0.9,
  drivetrain: 'awd',
  awdRearBias: 0.6,
  lsdLock: 20,
  lsdBias: 0.3,
  centreLock: 18,
  centreBias: 0.3,
  engineBraking: 42,
  upshiftAt: 0.93,
  downshiftAt: 0.45,
  shiftTime: 0.12,

  brakeTorque: 3200,
  brakeBias: 0.62,
  handbrakeTorque: 2600,
  handbrakeGripLoss: 0.42,

  tireGrip: 1.35,
  tireGripBalance: 1.12,
  peakSlipAngle: 0.18,
  peakSlipRatio: 0.14,
  slideGripFloor: 0.74,

  dragFactor: 0.42,
  downforceFactor: 0.22,
  yawDamping: 2200,
};

export const SIM = {
  /** Fixed simulation rate. Render interpolates between steps. */
  hz: 120,
  gravity: -9.81,
  /** Ghost/telemetry sample rate. */
  recordHz: 60,
} as const;

export const CAMERA = {
  /** Orthographic half-height in metres — effectively the zoom. */
  viewSize: 12,
  pitch: 0.66, // ~38°
  yaw: Math.PI * 0.25, // 45°, the classic isometric read
  /** Seconds for the camera to close half the distance to its target. */
  followHalfLife: 0.22,
  /** Seconds for a camera-zone change to close half its distance. */
  zoneHalfLife: 0.9,
  /** Metres of lookahead per m/s of speed. */
  lookaheadPerSpeed: 0.42,
  maxLookahead: 14,
} as const;
