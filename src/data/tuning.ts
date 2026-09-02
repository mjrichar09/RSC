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
  /**
   * How fast the front wheels can be turned, in **full locks per second**.
   *
   * Not radians per second, which is what this said and is not what it does:
   * `vehicle.ts` moves the angle by `steerRate * maxSteerAngle * dt`, so the
   * rate is proportional to the lock. That is the useful behaviour — raising
   * `maxSteerAngle` leaves lock-to-lock time unchanged at 0.56 s rather than
   * making the steering feel heavier — but it means this number is a fraction
   * of the available range, not an angle. At 3.6 with 0.56 rad of lock it is
   * about 2.0 rad/s of actual wheel movement.
   */
  steerRate: number;
  /** The same, in full locks per second, for returning to centre with no input. */
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
  /**
   * How fast a sliding tyre wears, as a fraction of its life per second at
   * full slip on tarmac under nominal load. Softer compounds grip harder and
   * wear faster — the classic trade, and the one that makes the tyre upgrade a
   * decision rather than a free improvement.
   */
  tireWearRate: number;
  /**
   * Front/rear grip balance. >1 gives the front more bite (more oversteer).
   *
   * Applied as `front ? balance : 2 - balance`, so 1.12 means the front tyres
   * get 1.12x their friction coefficient and the rear 0.88x — the rear lets go
   * first, which is oversteer.
   *
   * The direction reads backwards against `npm run sweep`, which calls the car
   * "understeer" at this value, and both are right: the chassis understeers on
   * its own and this dials that out rather than adding oversteer on top of it.
   * Measured, the balance figure (front slip minus rear slip, so positive is
   * understeer) goes 2.00 at 0.90, 1.68 at 1.00, 0.72 at 1.12, and negative at
   * 1.25 — where the car stops cornering and starts spinning. There is very
   * little room above the current value.
   */
  tireGripBalance: number;
  /** Slip angle of peak lateral force, radians. */
  peakSlipAngle: number;
  /** Slip ratio of peak longitudinal force. */
  peakSlipRatio: number;
  /** Fraction of peak force retained at full slide. Higher = more controllable drifts. */
  slideGripFloor: number;
  /**
   * Slide floor for a *locked* wheel, used only on the braking side of the slip
   * curve.
   *
   * Measured, not guessed: with the one shared floor of 0.74, stamping the
   * pedal stopped the car at 1.10 g and the best a driver could hold without
   * locking was also 1.10 g — so threshold braking was worth exactly nothing
   * and the fastest stop was the least skilled one. A locked tyre ploughs; it
   * gives up more than a sliding one, and the drive side keeps its own floor
   * because that is what the launch was calibrated against.
   */
  lockedGripFloor: number;

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

  // The car's right is -X: nose along +Z, up along +Y, right-handed. Mirrored
  // here for a long time, which put every L/R label on the wrong corner.
  wheelPositions: [
    { x: 0.78, y: -0.25, z: 1.32 }, // front left
    { x: -0.78, y: -0.25, z: 1.32 }, // front right
    { x: 0.78, y: -0.25, z: -1.32 }, // rear left
    { x: -0.78, y: -0.25, z: -1.32 }, // rear right
  ],
  wheelRadius: 0.34,

  suspensionRestLength: 0.34,
  suspensionStiffness: 42000,
  suspensionDamping: 3600,
  suspensionReboundDamping: 5200,
  antiRollStiffness: 9000,

  // 0.5 before. More lock at the wheel is more authority to catch a slide with,
  // which is what it is for. It cannot be judged on the `catch` trace: that
  // trace's inputs are *fractions of lock*, so raising this raises the
  // counter-steer it applies and changes what is being tested rather than
  // measuring the car. On the closed-loop `drift` trace, which counter-steers
  // the way a driver does, it buys a transition the car could not previously
  // make (4 unbroken drift stretches to 5) at no cost in held time, and it
  // tightens the minimum turn radius from 56.3 m to 47.9 m. Measured on the
  // stage that punishes handling changes hardest, it is a straight improvement:
  // Grand Traverse goes from 87.3 s and 2.7% off road to 85.5 s and 0.0%.
  maxSteerAngle: 0.56,
  // 0.3 at 24 m/s before, which left only 30% of lock above 86 km/h. Now 60% of
  // it, and not reached until 133 km/h — the car keeps far more steering at
  // speed. Worth knowing what that did to the AI: `DriverInput.steer` is a
  // fraction of lock, so the same output became 2.3x the angle at 100 km/h and
  // the driver's recentring loop, whose gain was chosen against the old lock,
  // started oscillating. That is compensated in `sim/driver.ts` rather than
  // here; see `steerScale` for why only half the loop is compensated.
  steerSpeedFalloff: 0.6,
  steerSpeedFalloffAt: 37,
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

  // 2400 rather than 3200: measured against the locked-wheel floor, anything
  // above about 2600 Nm locks all four wheels from half pedal, which left the
  // whole top of the pedal doing nothing but ploughing. At 2400 the best stop
  // is 1.00 g at around half pedal and locking costs 16%.
  brakeTorque: 2400,
  brakeBias: 0.62,
  handbrakeTorque: 2600,
  handbrakeGripLoss: 0.42,

  // 1.35 before, raised by driving it. Peak lateral grip on tarmac goes to
  // about 1.08 g and every stage's AI lap comes down 2-3.5%, which is why the
  // medal tables were rebased in the same commit — they are calibrated against
  // that lap and go stale the moment the tyres change.
  tireGrip: 1.43,
  tireWearRate: 0.012,
  tireGripBalance: 1.12,
  // Left at 0.20, and this is the record of why, because the obvious next idea
  // is to widen it again. (The figures below were measured at `tireGrip` 1.35,
  // before it was raised; the argument is a ratio and survives, the absolute
  // numbers would need retaking.)
  //
  // A broader peak is more warning before the tyre lets go and a wider window
  // to sit in once it has, and it measures that way: 0.24 moves the held slide
  // on `npm run telemetry -- --trace=catch` from 3.16 s to 3.47 s. But
  // spreading the peak lowers it. `npm run sweep` puts steady-state lateral
  // grip at 1.03 g against 1.15, and the AI plans its corner speeds from grip
  // it no longer has: `npm run stages --stage=grand-traverse` goes from 87.3 s
  // and 2.7% off road to 111.3 s and 20.2%, a silver lap turned bronze. That
  // stage's medals are calibrated on that lap, so this is not a number that can
  // be raised on its own — it would need the driver model and four sets of
  // medal times moving with it. Steering lock buys slide control without the
  // grip; that is where it came from instead.
  peakSlipAngle: 0.20,
  peakSlipRatio: 0.14,
  // Raised from 0.74 to 0.80 to make a slide something you steer rather than
  // something you survive, then settled at 0.77 by driving it. The measurement
  // that motivated 0.80 still stands — on `npm run telemetry -- --trace=catch`
  // the time a provoked slide can be held went from 1.83 s to 3.16 s — but a
  // floor that high also makes a slide hard to *end*, and 0.77 was chosen from
  // the seat for how the car recovers, not from that number. It costs held
  // slide time (3.16 s to 2.03 s at the current tyres) and that is the trade
  // being made deliberately: this is the number the file's own header calls the
  // most important one for feel, and feel is not a metric.
  slideGripFloor: 0.77,
  lockedGripFloor: 0.55,

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
