/**
 * Component-level damage.
 *
 * Every part that can break is a component with a position on the car, a
 * toughness, and a repair cost. An impact is resolved to a point on the
 * chassis, and each component takes damage in proportion to how close it is to
 * that point and how hard the hit was — so a nose-first hit into a bank wrecks
 * the radiator and the front suspension, while the same energy taken on the
 * rear quarter mostly costs panels.
 *
 * Two rules shape the whole design:
 *
 * 1. Effects are continuous and always legible. A component at 70% health
 *    degrades the car by a visible, felt amount; nothing is a hidden stat.
 * 2. Total failures are rare, loud, and always the consequence of something the
 *    player saw happen. "Hardcore" has to mean consequential, not arbitrary.
 */

import { type Vec3, clamp, length, sub, v3 } from './math.js';

export type ComponentId =
  | 'engine'
  | 'cooling'
  | 'turbo'
  | 'transmission'
  | 'driveshaft'
  | 'differential'
  | 'steering'
  | 'fuelLine'
  | 'lights'
  | 'suspensionFL' | 'suspensionFR' | 'suspensionRL' | 'suspensionRR'
  | 'hubFL' | 'hubFR' | 'hubRL' | 'hubRR'
  | 'tyreFL' | 'tyreFR' | 'tyreRL' | 'tyreRR'
  | 'brakeFL' | 'brakeFR' | 'brakeRL' | 'brakeRR'
  | 'panelFront' | 'panelRear' | 'panelLeft' | 'panelRight' | 'panelRoof' | 'panelFloor'
  // Bolt-on bodywork. Separate from the four flanks because "the left side is
  // damaged" is not something you can look at and act on, while "the front left
  // wing is hanging off" is — and because each of these can leave the car.
  | 'bonnet' | 'boot' | 'wingFL' | 'wingFR' | 'quarterRL' | 'quarterRR'
  | 'doorL' | 'doorR' | 'mirrorL' | 'mirrorR' | 'windscreen' | 'exhaust';

export interface ComponentDef {
  id: ComponentId;
  label: string;
  /** Position in chassis-local space, metres. */
  at: Vec3;
  /** Radius over which an impact still reaches this component, metres. */
  reach: number;
  /** Impulse below which this component is unharmed, newton-seconds. */
  threshold: number;
  /** Impulse above the threshold that would destroy it outright. */
  scale: number;
  /** Cost to repair from destroyed to new. */
  repairCost: number;
  /** Whether a rollcage protects it. Panels and glass are not protected. */
  caged: boolean;
}

const WHEEL_AT = {
  FL: v3(-0.78, -0.25, 1.32),
  FR: v3(0.78, -0.25, 1.32),
  RL: v3(-0.78, -0.25, -1.32),
  RR: v3(0.78, -0.25, -1.32),
} as const;

const corner = (
  id: ComponentId,
  label: string,
  at: Vec3,
  threshold: number,
  scale: number,
  repairCost: number,
  reach = 1.0,
): ComponentDef => ({ id, label, at, reach, threshold, scale, repairCost, caged: true });

/**
 * Thresholds and scales are in newton-seconds, calibrated with `npm run crash`
 * against measured impacts. As a reference point, a flat nose-first hit into a
 * wall produces roughly 350 N·s per km/h of entry speed:
 *
 *   20 km/h  ~7 000    a parking scrape — paint and a light
 *   50 km/h  ~18 000   radiator holed, panel wrecked, engine bruised
 *   70 km/h  ~25 000   a genuinely expensive accident
 *  100 km/h  ~35 000   the race is very likely over
 */
export const COMPONENTS: ComponentDef[] = [
  // Drivetrain. Deep in the car, so it takes a serious hit to reach.
  corner('engine', 'Engine', v3(0, -0.1, 1.5), 17000, 17000, 4200, 1.8),
  // The radiator sits in front of everything and is made of foil.
  corner('cooling', 'Radiator', v3(0, -0.15, 1.92), 7500, 16000, 620, 1.1),
  corner('turbo', 'Turbo', v3(0.4, 0.05, 1.25), 16000, 28000, 1800, 0.9),
  corner('transmission', 'Gearbox', v3(0, -0.2, 0.6), 19000, 34000, 2600, 1.1),
  corner('driveshaft', 'Driveshaft', v3(0, -0.32, 0), 26000, 22000, 1400, 1.6),
  corner('differential', 'Differential', v3(0, -0.3, -1.25), 19000, 34000, 1900, 1.0),
  corner('steering', 'Steering rack', v3(0, -0.24, 1.15), 14000, 26000, 1100, 1.0),
  corner('fuelLine', 'Fuel line', v3(0, -0.32, -0.8), 15000, 26000, 340, 1.0),
  corner('lights', 'Lights', v3(0, 0.12, 1.94), 4000, 9000, 260, 0.9),

  // Suspension, hubs, tyres and brakes: one of each per corner, all clustered
  // at the wheel so a corner impact takes several of them together.
  ...(['FL', 'FR', 'RL', 'RR'] as const).flatMap((c) => [
    corner(`suspension${c}` as ComponentId, `Suspension ${c}`, WHEEL_AT[c], 9000, 20000, 880, 0.95),
    corner(`hub${c}` as ComponentId, `Hub ${c}`, WHEEL_AT[c], 24000, 24000, 1250, 1.0),
    corner(`tyre${c}` as ComponentId, `Tyre ${c}`, WHEEL_AT[c], 7000, 16000, 310, 0.85),
    corner(`brake${c}` as ComponentId, `Brake ${c}`, WHEEL_AT[c], 13000, 26000, 540, 0.85),
  ]),

  // Body panels: cheap, fragile, and the first thing you notice.
  { id: 'panelFront', label: 'Front panel', at: v3(0, 0, 1.9), reach: 1.5, threshold: 4200, scale: 20000, repairCost: 520, caged: false },
  { id: 'panelRear', label: 'Rear panel', at: v3(0, 0, -1.9), reach: 1.5, threshold: 4200, scale: 20000, repairCost: 480, caged: false },
  { id: 'panelLeft', label: 'Left flank', at: v3(-0.84, 0, 0), reach: 1.25, threshold: 4200, scale: 20000, repairCost: 420, caged: false },
  { id: 'panelRight', label: 'Right flank', at: v3(0.84, 0, 0), reach: 1.25, threshold: 4200, scale: 20000, repairCost: 420, caged: false },
  { id: 'panelRoof', label: 'Roof', at: v3(0, 0.46, 0), reach: 1.6, threshold: 5000, scale: 21000, repairCost: 560, caged: false },
  { id: 'panelFloor', label: 'Floor', at: v3(0, -0.46, 0), reach: 1.6, threshold: 9000, scale: 28000, repairCost: 700, caged: false },

  // Bolt-on panels: cheaper than the structure behind them, fragile, and each
  // one is somewhere you can point at on the car. A bonnet is a bigger target
  // than a mirror and takes more to shift; a mirror goes if you brush anything.
  { id: 'bonnet', label: 'Bonnet', at: v3(0, 0.3, 1.25), reach: 1.15, threshold: 4000, scale: 15000, repairCost: 380, caged: false },
  { id: 'boot', label: 'Boot lid', at: v3(0, 0.28, -1.35), reach: 1.1, threshold: 4000, scale: 15000, repairCost: 340, caged: false },
  { id: 'wingFL', label: 'Front wing L', at: v3(-0.82, 0.05, 1.3), reach: 1.0, threshold: 3600, scale: 14000, repairCost: 300, caged: false },
  { id: 'wingFR', label: 'Front wing R', at: v3(0.82, 0.05, 1.3), reach: 1.0, threshold: 3600, scale: 14000, repairCost: 300, caged: false },
  { id: 'quarterRL', label: 'Rear quarter L', at: v3(-0.82, 0.05, -1.3), reach: 1.0, threshold: 3600, scale: 14000, repairCost: 300, caged: false },
  { id: 'quarterRR', label: 'Rear quarter R', at: v3(0.82, 0.05, -1.3), reach: 1.0, threshold: 3600, scale: 14000, repairCost: 300, caged: false },
  { id: 'doorL', label: 'Left door', at: v3(-0.86, 0.08, -0.05), reach: 1.0, threshold: 4400, scale: 16000, repairCost: 460, caged: false },
  { id: 'doorR', label: 'Right door', at: v3(0.86, 0.08, -0.05), reach: 1.0, threshold: 4400, scale: 16000, repairCost: 460, caged: false },
  { id: 'mirrorL', label: 'Mirror L', at: v3(-0.95, 0.4, 0.5), reach: 0.7, threshold: 1800, scale: 6000, repairCost: 90, caged: false },
  { id: 'mirrorR', label: 'Mirror R', at: v3(0.95, 0.4, 0.5), reach: 0.7, threshold: 1800, scale: 6000, repairCost: 90, caged: false },
  { id: 'windscreen', label: 'Windscreen', at: v3(0, 0.5, 0.55), reach: 1.0, threshold: 5200, scale: 18000, repairCost: 520, caged: false },
  { id: 'exhaust', label: 'Exhaust', at: v3(0.35, -0.42, -1.7), reach: 0.9, threshold: 5000, scale: 15000, repairCost: 240, caged: false },
];

export const COMPONENT_BY_ID = new Map(COMPONENTS.map((c) => [c.id, c]));

export type FailureId =
  | 'engine-seized'
  | 'overheated'
  | 'driveshaft-snapped'
  | 'out-of-fuel'
  | `wheel-lost-${'FL' | 'FR' | 'RL' | 'RR'}`;

/** What each failure means, in words. The single source for every surface. */
export const FAILURE_LABEL: Record<FailureId, string> = {
  'engine-seized': 'Engine seized',
  overheated: 'Engine overheated — the radiator was holed',
  'driveshaft-snapped': 'Driveshaft snapped',
  'out-of-fuel': 'Out of fuel',
  'wheel-lost-FL': 'Lost the front left wheel',
  'wheel-lost-FR': 'Lost the front right wheel',
  'wheel-lost-RL': 'Lost the rear left wheel',
  'wheel-lost-RR': 'Lost the rear right wheel',
};

export interface DamageEvent {
  component: ComponentId;
  label: string;
  /** How much health this single impact removed, 0..1. */
  amount: number;
  /** Health remaining afterwards. */
  remaining: number;
}

/** Multipliers the vehicle applies. All are 1 (or 0) on an undamaged car. */
export interface DamageEffects {
  engineTorque: number;
  /** Random misfire this step — a torque dropout from a damaged engine. */
  misfiring: boolean;
  wheelGrip: [number, number, number, number];
  wheelBrake: [number, number, number, number];
  wheelSuspension: [number, number, number, number];
  /** Wheels that have detached. Those corners have no grip and no suspension. */
  wheelLost: [boolean, boolean, boolean, boolean];
  /** Constant steering offset from a bent rack, radians. Pulls to one side. */
  steeringOffset: number;
  steeringRange: number;
  /** Extra aerodynamic drag from crumpled panels and a flapping bonnet. */
  dragScale: number;
  /** Chance per shift that the gearbox refuses. */
  shiftFailure: number;
  retired: boolean;
}

export interface DamageOptions {
  /** 0..1 reduction applied to caged components. A rollcage upgrade in P5. */
  rollcage?: number;
  /** Litres of fuel carried. */
  fuel?: number;
  /** Deterministic random source, so headless runs stay reproducible. */
  random?: () => number;
  /** Seed for the built-in stream. Only matters if `random` is not supplied. */
  seed?: number;
  /** Ambient air, 0..1 as `ambientTemperature()` reports it. */
  ambient?: number;
}

const WHEEL_KEYS = ['FL', 'FR', 'RL', 'RR'] as const;

/** Half-extents of the chassis, used to project impacts onto its surface. */
const CHASSIS = v3(0.85, 0.45, 1.95);

/**
 * Approximate the impact point on the chassis from the direction the impact
 * force pushed the car.
 *
 * Rapier's contact-force events report a force magnitude and direction but not
 * a reliable contact point, so the point is reconstructed: the car is pushed
 * away from whatever it hit, so the impact is on the surface opposite the
 * force. Projecting onto the chassis box is accurate enough to tell a nose-on
 * hit from a rear-quarter scrape, which is the distinction that matters.
 */
export function impactPointFromForce(localForceDirection: Vec3): Vec3 {
  const d = v3(-localForceDirection.x, -localForceDirection.y, -localForceDirection.z);
  const mag = length(d);
  if (mag < 1e-6) return v3(0, 0, CHASSIS.z);

  // Scale along the direction until it first crosses a face of the box.
  const t = Math.min(
    Math.abs(d.x) > 1e-6 ? CHASSIS.x / Math.abs(d.x) : Infinity,
    Math.abs(d.y) > 1e-6 ? CHASSIS.y / Math.abs(d.y) : Infinity,
    Math.abs(d.z) > 1e-6 ? CHASSIS.z / Math.abs(d.z) : Infinity,
  );
  return v3(d.x * t, d.y * t, d.z * t);
}

/**
 * Brake thermal model, in real units so the numbers can be argued with.
 *
 * A ventilated disc plus its pads and hat is roughly 5 kg of steel, and steel
 * holds about 460 J per kg per kelvin: ~2300 J/K per corner. That mass is what
 * makes the sums come out where a real car does — stopping this car from
 * 145 km/h puts about 300 kJ into each front disc, which is a 110 K rise, and
 * two or three of those in quick succession is what it takes to see any glow.
 */
const DISC_HEAT_CAPACITY = 1500;
/** Fraction of the friction work that lands in the disc rather than the pad, air and tyre. */
const DISC_ABSORPTION = 0.85;
/** Convective loss, watts per kelvin: a standing term plus airflow with speed. */
const DISC_COOL_BASE = 4;
const DISC_COOL_PER_MPS = 0.35;
/** Ambient air, °C, at the two ends of `ambientTemperature()`. */
const AMBIENT_COLD = 0;
const AMBIENT_HOT = 30;
/** Fade starts here on healthy brakes and is total 200 K later. */
const FADE_START_C = 520;
const FADE_SPAN_C = 220;
/** What is left of the brakes when they are completely cooked. */
const FADE_FLOOR = 0.35;
/**
 * What the disc looks like, in two stages, because a hot disc changes colour
 * long before it emits any light.
 *
 * Steel oxidises straw, then bronze, then blue from about 200°C — that is the
 * `tint`. Actual incandescence starts around 500°C and reaches orange-white
 * near 800. Measured against a hard AI lap of Quarry Run, which peaks around
 * 345°C, the tint is a normal sight and the glow is something you have to
 * earn — a long descent, a dragged pedal, or brakes already damaged.
 */
const TINT_START_C = 200;
const TINT_FULL_C = 450;
const GLOW_START_C = 500;
const GLOW_FULL_C = 800;

/**
 * Small deterministic stream, the same shape as the one stages use. Kept here
 * rather than imported so `damage.ts` stays free of stage concerns.
 */
function seededStream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DamageModel {
  /** Health per component, 1 = new, 0 = destroyed. */
  readonly health = new Map<ComponentId, number>();

  /** Coolant temperature, 0 = cold, 1 = boiling. */
  temperature = 0;
  /** Brake disc temperature per corner, °C. */
  readonly brakeTemp: [number, number, number, number] = [0, 0, 0, 0];
  /** Ambient air temperature, °C. Set from the stage's conditions. */
  ambientC = AMBIENT_HOT;
  fuel: number;
  readonly fuelCapacity: number;

  readonly failures = new Set<FailureId>();
  /** Largest single impact impulse seen, newton-seconds. Used for calibration. */
  peakImpulse = 0;
  /** Damage events since the last drain. The HUD turns these into toasts. */
  private pending: DamageEvent[] = [];

  private readonly rollcage: number;
  private readonly random: () => number;

  constructor(options: DamageOptions = {}) {
    this.rollcage = clamp(options.rollcage ?? 0, 0, 0.9);
    this.fuelCapacity = options.fuel ?? 45;
    this.fuel = this.fuelCapacity;
    // Seeded by default, not `Math.random`. Everything that draws from this —
    // misfires, gearbox refusals, and now which second a loose part chooses to
    // let go — has to give the same answer twice for a headless run to mean
    // anything, and a default of `Math.random` silently broke that.
    this.random = options.random ?? seededStream(options.seed ?? 0x5eed1e);
    this.setAmbient(options.ambient ?? 0.8);
    this.brakeTemp.fill(this.ambientC);
    for (const c of COMPONENTS) this.health.set(c.id, 1);
  }

  get(id: ComponentId): number {
    return this.health.get(id) ?? 1;
  }

  /** True once the car can no longer complete the stage. */
  get retired(): boolean {
    return this.failures.size > 0;
  }

  /** Average condition across every component, for a single headline number. */
  get condition(): number {
    let total = 0;
    for (const c of COMPONENTS) total += this.get(c.id);
    return total / COMPONENTS.length;
  }

  /**
   * The model's random source.
   *
   * Exposed so everything stochastic about a damaged car draws from the same
   * injectable stream. A headless run has to be reproducible, and reaching for
   * `Math.random` anywhere in the simulation quietly breaks that.
   */
  nextRandom(): number {
    return this.random();
  }

  drainEvents(): DamageEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /**
   * Apply an impact.
   *
   * @param localPoint where the impact landed, in chassis-local space
   * @param impulse    total impulse of the contact, newton-seconds
   */
  applyImpact(localPoint: Vec3, impulse: number): void {
    this.peakImpulse = Math.max(this.peakImpulse, impulse);
    for (const def of COMPONENTS) {
      const distance = length(sub(def.at, localPoint));
      if (distance > def.reach) continue;

      // Linear falloff to the edge of the component's reach.
      const proximity = 1 - distance / def.reach;
      const over = impulse - def.threshold;
      if (over <= 0) continue;

      const mitigation = def.caged ? 1 - this.rollcage : 1;
      const amount = clamp((over / def.scale) * proximity * mitigation, 0, 1);
      if (amount < 0.005) continue;

      const before = this.get(def.id);
      const after = clamp(before - amount, 0, 1);
      this.health.set(def.id, after);
      this.pending.push({ component: def.id, label: def.label, amount: before - after, remaining: after });

      if (after <= 0) this.registerFailure(def.id);
    }
  }

  /**
   * Re-derive failures from current component health.
   *
   * Failures are discovered as components are destroyed, but health is what
   * gets persisted between races — so a car loaded with a destroyed engine
   * would otherwise come back with an empty failure set and be treated as
   * perfectly driveable. Anything that writes health directly must call this.
   */
  refreshFailures(): void {
    for (const def of COMPONENTS) {
      if (this.get(def.id) <= 0) this.registerFailure(def.id);
    }
  }

  private registerFailure(id: ComponentId): void {
    if (id === 'engine') this.failures.add('engine-seized');
    if (id === 'driveshaft') this.failures.add('driveshaft-snapped');
    for (const key of WHEEL_KEYS) {
      if (id === `hub${key}`) this.failures.add(`wheel-lost-${key}`);
    }
  }

  /**
   * Wear the tyres.
   *
   * A tyre is consumed by sliding, not by rolling: wear tracks how far past
   * the grip limit it is, scaled by the load it is carrying and how abrasive
   * the surface is. This is what connects driving style directly to the repair
   * bill — a clean run costs a few percent of tyre life, a run spent sideways
   * on gravel costs a great deal more.
   */
  wearTyres(
    dt: number,
    wheels: readonly { saturation: number; load: number; surface: { abrasion: number } }[],
    rate: number,
  ): void {
    const NOMINAL_LOAD = 2900;

    for (let i = 0; i < WHEEL_KEYS.length; i++) {
      const wheel = wheels[i];
      if (!wheel) continue;

      const slip = wheel.saturation - 0.9;
      if (slip <= 0) continue;

      const id = `tyre${WHEEL_KEYS[i]}` as ComponentId;
      const health = this.get(id);
      if (health <= 0) continue;

      const wear =
        rate * Math.min(slip, 1.5) * (wheel.load / NOMINAL_LOAD) * wheel.surface.abrasion * dt;
      const after = clamp(health - wear, 0, 1);
      this.health.set(id, after);

      // A tyre worn to nothing is a puncture, and it is worth announcing.
      if (after <= 0) {
        this.pending.push({
          component: id,
          label: COMPONENT_BY_ID.get(id)!.label,
          amount: health,
          remaining: 0,
        });
      }
    }
  }

  /**
   * Continuous damage: heat and fuel.
   *
   * These are what turn a survivable hit into a race against the clock. A
   * holed radiator does not stop you — it gives you a couple of minutes.
   */
  update(dt: number, load: { rpmFraction: number; speed: number }): void {
    const cooling = this.get('cooling');
    const engine = this.get('engine');

    // Heat generated by revs, shed by the radiator and by airflow.
    //
    // Rated so that a healthy radiator keeps the car cold indefinitely, while a
    // holed one boils it in about half a minute. If overheating took longer
    // than a stage the failure could never actually bite, which would make the
    // radiator the cheapest and least interesting component on the car.
    const generated = 0.05 * (0.25 + load.rpmFraction);
    const shed = 0.055 * (0.15 + cooling * 0.85) * (0.5 + Math.min(Math.abs(load.speed) / 40, 1));
    this.temperature = clamp(this.temperature + (generated - shed) * dt, 0, 1.2);
    if (this.temperature >= 1.15) this.failures.add('overheated');

    // Consumption rises with revs; a holed fuel line dumps the rest overboard.
    const burn = (0.0022 + 0.011 * load.rpmFraction) * (1 + (1 - engine) * 0.4);
    const leak = (1 - this.get('fuelLine')) * 0.05;
    this.fuel = Math.max(0, this.fuel - (burn + leak) * dt * 10);
    if (this.fuel <= 0) this.failures.add('out-of-fuel');
  }

  /**
   * Set ambient air from the stage's conditions, 0..1.
   *
   * Cold brakes on a winter night are not a cosmetic difference: the same
   * descent that fades on a hot afternoon can be driven straight through.
   */
  setAmbient(ambient: number): void {
    // A disc already at rest follows the air; a hot one keeps its heat and
    // cools toward the new ambient on its own.
    const cold = this.brakeTemp.map((t) => t <= this.ambientC + 1);
    this.ambientC = AMBIENT_COLD + clamp(ambient, 0, 1) * (AMBIENT_HOT - AMBIENT_COLD);
    for (let i = 0; i < 4; i++) if (cold[i]) this.brakeTemp[i] = this.ambientC;
  }

  /**
   * Brake heat: friction work in, convection out.
   *
   * `torque` is what the caliper actually applied and `spin` the wheel it
   * applied it to, so the power is the real dissipated watts rather than a
   * proxy for pedal pressure — a locked wheel makes no heat, which is exactly
   * the behaviour that makes threshold braking worth doing.
   */
  updateBrakes(
    dt: number,
    corners: readonly { torque: number; spin: number }[],
    speed: number,
  ): void {
    const airflow = DISC_COOL_BASE + DISC_COOL_PER_MPS * Math.min(Math.abs(speed), 60);
    for (let i = 0; i < 4; i++) {
      const c = corners[i];
      const power = c ? Math.abs(c.torque * c.spin) * DISC_ABSORPTION : 0;
      const loss = (this.brakeTemp[i]! - this.ambientC) * airflow;
      this.brakeTemp[i] = Math.max(
        this.ambientC,
        this.brakeTemp[i]! + ((power - loss) / DISC_HEAT_CAPACITY) * dt,
      );
    }
  }

  /**
   * How much braking is left at this corner, 1 down to `FADE_FLOOR`.
   *
   * A damaged brake fades sooner as well as braking less hard: warped discs
   * and cooked pads are the same failure arriving from two directions.
   */
  brakeFade(i: number): number {
    const start = FADE_START_C * (0.55 + 0.45 * this.get(`brake${WHEEL_KEYS[i]}` as ComponentId));
    const over = clamp((this.brakeTemp[i]! - start) / FADE_SPAN_C, 0, 1);
    return 1 - over * (1 - FADE_FLOOR);
  }

  /** 0..1 heat discolouration of the disc — straw through blue. Render-only. */
  brakeTint(i: number): number {
    return clamp((this.brakeTemp[i]! - TINT_START_C) / (TINT_FULL_C - TINT_START_C), 0, 1);
  }

  /** 0..1 how brightly this disc is actually glowing. Render-only. */
  brakeGlow(i: number): number {
    return clamp((this.brakeTemp[i]! - GLOW_START_C) / (GLOW_FULL_C - GLOW_START_C), 0, 1);
  }

  /** Current handling penalties. Read once per physics step by the vehicle. */
  effects(): DamageEffects {
    const engine = this.get('engine');
    const overheat = clamp((this.temperature - 0.8) / 0.35, 0, 1);

    const wheelGrip: [number, number, number, number] = [1, 1, 1, 1];
    const wheelBrake: [number, number, number, number] = [1, 1, 1, 1];
    const wheelSuspension: [number, number, number, number] = [1, 1, 1, 1];
    const wheelLost: [boolean, boolean, boolean, boolean] = [false, false, false, false];

    WHEEL_KEYS.forEach((key, i) => {
      const tyre = this.get(`tyre${key}` as ComponentId);
      const hub = this.get(`hub${key}` as ComponentId);
      // A punctured tyre keeps a little grip on the rim, and not much.
      wheelGrip[i] = tyre <= 0 ? 0.22 : 0.45 + 0.55 * tyre;
      // Fade is folded in here rather than in the vehicle, so every consumer of
      // `wheelBrake` — including the AI — feels hot brakes without knowing why.
      wheelBrake[i] = this.get(`brake${key}` as ComponentId) * this.brakeFade(i);
      wheelSuspension[i] = 0.3 + 0.7 * this.get(`suspension${key}` as ComponentId);
      wheelLost[i] = hub <= 0;
    });

    // A bent rack pulls the car to one side by an amount you have to hold out.
    const steering = this.get('steering');
    const damage = 1 - steering;

    const panels =
      (this.get('panelFront') + this.get('panelRear') + this.get('panelLeft') + this.get('panelRight')) / 4;

    return {
      engineTorque: (0.25 + 0.75 * engine) * (1 - overheat * 0.7),
      // Below half health the engine starts cutting out at random.
      misfiring: engine < 0.5 && this.random() < (0.5 - engine) * 0.5,
      wheelGrip,
      wheelBrake,
      wheelSuspension,
      wheelLost,
      // Signed by which side the rack bent toward, kept deterministic by
      // deriving it from the component id rather than from a coin flip.
      steeringOffset: damage * 0.12,
      steeringRange: 1 - damage * 0.45,
      dragScale: 1 + (1 - panels) * 0.35,
      shiftFailure: (1 - this.get('transmission')) * 0.4,
      retired: this.retired,
    };
  }

  /**
   * Seconds of racing before this radiator boils the engine, at the given pace.
   * Null when it never will.
   *
   * Derived from the same rates `update` uses, so the warning cannot drift out
   * of step with what actually happens.
   */
  secondsToOverheat(rpmFraction = 0.62, speed = 26): number | null {
    const cooling = this.get('cooling');
    const generated = 0.05 * (0.25 + rpmFraction);
    const shed = 0.055 * (0.15 + cooling * 0.85) * (0.5 + Math.min(Math.abs(speed) / 40, 1));
    const net = generated - shed;
    if (net <= 0) return null;
    return Math.max((1.15 - this.temperature) / net, 0);
  }

  /** Seconds of racing before the tank runs dry at the given pace. */
  secondsToEmpty(rpmFraction = 0.62): number | null {
    const burn = (0.0022 + 0.011 * rpmFraction) * (1 + (1 - this.get('engine')) * 0.4);
    const leak = (1 - this.get('fuelLine')) * 0.05;
    const rate = (burn + leak) * 10;
    return rate <= 0 ? null : this.fuel / rate;
  }

  /**
   * Risks worth telling the player about before they pay to enter a stage.
   *
   * A percentage is not a warning. "Car at 93%" is what the garage said while
   * the radiator was holed and the next two races were guaranteed to end in an
   * overheat — the information existed and told the player nothing. Legibility
   * is what separates a hardcore damage model from an arbitrary one, and that
   * has to extend to the decision *before* the race, not just the HUD during it.
   */
  warnings(): { severity: 'fatal' | 'severe' | 'caution'; text: string }[] {
    const out: { severity: 'fatal' | 'severe' | 'caution'; text: string }[] = [];

    // Read the actual failure set rather than guessing from which components
    // look important. `caged` means "a rollcage protects this", not "the car
    // stops without it" — using it as a proxy claimed destroyed headlights
    // stopped the car from starting, while the car started perfectly well.
    for (const failure of this.failures) {
      out.push({ severity: 'fatal', text: `${FAILURE_LABEL[failure]} — the car cannot start` });
    }

    const boil = this.secondsToOverheat();
    if (boil !== null) {
      out.push({
        severity: boil < 90 ? 'severe' : 'caution',
        text: `Radiator holed — the engine will overheat after about ${Math.round(boil)}s of racing`,
      });
    }

    const dry = this.secondsToEmpty();
    if (dry !== null && dry < 240) {
      out.push({
        severity: dry < 100 ? 'severe' : 'caution',
        text: `Fuel line leaking — about ${Math.round(dry)}s of fuel left`,
      });
    }

    const engine = this.get('engine');
    if (engine > 0 && engine < 0.5) {
      out.push({ severity: 'severe', text: `Engine at ${(engine * 100).toFixed(0)}% — misfiring under load` });
    }

    for (const key of WHEEL_KEYS) {
      const tyre = this.get(`tyre${key}` as ComponentId);
      if (tyre > 0 && tyre < 0.3) {
        out.push({ severity: 'caution', text: `Tyre ${key} at ${(tyre * 100).toFixed(0)}% — close to a puncture` });
      }
      const steering = this.get('steering');
      if (key === 'FL' && steering > 0 && steering < 0.6) {
        out.push({ severity: 'caution', text: `Steering rack bent — the car pulls to one side` });
      }
    }

    const order = { fatal: 0, severe: 1, caution: 2 } as const;
    return out.sort((a, b) => order[a.severity] - order[b.severity]);
  }

  /** Total cost to return the car to new. */
  repairBill(): { total: number; lines: { id: ComponentId; label: string; cost: number }[] } {
    const lines: { id: ComponentId; label: string; cost: number }[] = [];
    let total = 0;
    for (const def of COMPONENTS) {
      const missing = 1 - this.get(def.id);
      if (missing <= 0.001) continue;
      // Slightly superlinear: a light scuff is cheap, a wrecked part is not.
      const cost = Math.round(def.repairCost * Math.pow(missing, 1.15));
      if (cost <= 0) continue;
      lines.push({ id: def.id, label: def.label, cost });
      total += cost;
    }
    lines.sort((a, b) => b.cost - a.cost);
    return { total, lines };
  }

  reset(): void {
    for (const c of COMPONENTS) this.health.set(c.id, 1);
    this.failures.clear();
    this.pending = [];
    this.temperature = 0;
    for (let i = 0; i < 4; i++) this.brakeTemp[i] = this.ambientC;
    this.fuel = this.fuelCapacity;
    this.peakImpulse = 0;
  }
}
