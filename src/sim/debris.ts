/**
 * Parts that come off the car.
 *
 * Attachment is deliberately *not* the same number as component health. A
 * bumper can be crumpled and still bolted on, or barely marked and hanging by
 * one mount after a kerb caught it. Health decides what a repair costs;
 * attachment decides whether the part is still on the car.
 *
 * The fairness rule this module exists to implement:
 *
 *   Randomness decides *when* and *how spectacular*. Damage state decides
 *   *whether it can happen at all*. Nothing that can cost you a run happens
 *   without a prior visible cause.
 *
 * So a bumper that is already scraping the road may tear off at a moment you
 * cannot predict — but a car in one piece never sheds anything, and the
 * scraping came first and lasted seconds. Every roll draws from an injected
 * seeded stream, never `Math.random`, or headless runs stop being reproducible.
 */

import type { ComponentId } from './damage.js';
import { type Vec3, clamp, v3 } from './math.js';

export type PartId =
  | 'bonnet'
  | 'boot'
  | 'bumperFront'
  | 'bumperRear'
  | 'doorLeft'
  | 'doorRight'
  | 'wingFL'
  | 'wingFR'
  | 'quarterRL'
  | 'quarterRR'
  | 'mirrorL'
  | 'mirrorR'
  | 'exhaust'
  | 'wipers'
  | 'wing'
  | 'wheelFL'
  | 'wheelFR'
  | 'wheelRL'
  | 'wheelRR';

export interface PartDef {
  id: PartId;
  label: string;
  /** Where it is mounted, in car-local metres. Impacts are matched against this. */
  at: Vec3;
  /** How far an impact can be from `at` and still shake this part loose. */
  reach: number;
  /** Impulse, N·s, above which an impact starts working the mounts loose. */
  threshold: number;
  /** N·s of impulse over the threshold that would take the part clean off. */
  scale: number;
  /** Mass of the loose part, kg. Debris the size of a wheel behaves like one. */
  mass: number;
  /** Half-extents of the debris body, metres. */
  half: Vec3;
  /** True for parts that hang and scrape before they let go. */
  drags: boolean;
  /**
   * Component whose destruction takes the part with it, if any. A hub at zero
   * means that wheel has left the car whatever its attachment says, and a panel
   * beaten to nothing is not still bolted on.
   */
  boundTo?: ComponentId;
  /**
   * Whether this part can also work loose on its own. False for the wheels,
   * which leave only with their hubs — an unearned wheel is the one piece of
   * drama the fairness rule will not allow.
   */
  rollsLoose: boolean;
}

/**
 * Thresholds are in the same newton-seconds as the damage model, so they can be
 * read against the same reference: a nose-first wall impact is about 350 N·s per
 * km/h of entry speed. A front bumper starts working loose at 6 000 — a 20 km/h
 * knock — and a 50 km/h hit takes it off outright. Doors and the bonnet are
 * held on rather better than that, and the wing rather worse.
 */
export const PARTS: PartDef[] = [
  {
    id: 'bumperFront',
    label: 'Front bumper',
    at: v3(0, -0.18, 1.95),
    reach: 1.5,
    threshold: 6000,
    scale: 12000,
    mass: 9,
    half: v3(0.78, 0.12, 0.14),
    drags: true,
    rollsLoose: true,
    boundTo: 'panelFront',
  },
  {
    id: 'bumperRear',
    label: 'Rear bumper',
    at: v3(0, -0.18, -1.95),
    reach: 1.5,
    threshold: 6000,
    scale: 12000,
    mass: 9,
    half: v3(0.78, 0.12, 0.14),
    drags: true,
    rollsLoose: true,
    boundTo: 'panelRear',
  },
  {
    id: 'bonnet',
    label: 'Bonnet',
    at: v3(0, 0.3, 1.3),
    reach: 1.3,
    threshold: 9000,
    scale: 18000,
    mass: 14,
    half: v3(0.7, 0.05, 0.75),
    drags: false,
    rollsLoose: true,
    boundTo: 'bonnet',
  },
  {
    id: 'boot',
    label: 'Boot lid',
    at: v3(0, 0.28, -1.35),
    reach: 1.1,
    threshold: 8000,
    scale: 17000,
    mass: 11,
    half: v3(0.66, 0.05, 0.5),
    drags: false,
    rollsLoose: true,
    boundTo: 'boot',
  },
  ...(
    [
      ['wingFL', 'Front wing L', 'wingFL', -0.82, 1.3],
      ['wingFR', 'Front wing R', 'wingFR', 0.82, 1.3],
      ['quarterRL', 'Rear quarter L', 'quarterRL', -0.82, -1.3],
      ['quarterRR', 'Rear quarter R', 'quarterRR', 0.82, -1.3],
    ] as const
  ).map(([id, label, component, x, z]): PartDef => ({
    id,
    label,
    at: v3(x, 0.05, z),
    reach: 1.0,
    threshold: 7000,
    scale: 15000,
    mass: 7,
    half: v3(0.1, 0.3, 0.55),
    // A wing torn half off catches the tyre and grinds on it, which is exactly
    // the telegraph a bumper gives.
    drags: true,
    rollsLoose: true,
    boundTo: component,
  })),
  ...(
    [
      ['mirrorL', 'Mirror L', 'mirrorL', -0.95],
      ['mirrorR', 'Mirror R', 'mirrorR', 0.95],
    ] as const
  ).map(([id, label, component, x]): PartDef => ({
    id,
    label,
    at: v3(x, 0.4, 0.5),
    reach: 0.6,
    // A mirror is held on by almost nothing and is the first thing to go.
    threshold: 1500,
    scale: 4000,
    mass: 1.2,
    half: v3(0.07, 0.07, 0.12),
    drags: false,
    rollsLoose: true,
    boundTo: component,
  })),
  {
    id: 'wipers',
    label: 'Wipers',
    at: v3(0, 0.34, 0.95),
    reach: 0.7,
    threshold: 2400,
    scale: 7000,
    mass: 0.6,
    half: v3(0.02, 0.02, 0.32),
    drags: false,
    rollsLoose: true,
    boundTo: 'wipers',
  },
  {
    id: 'exhaust',
    label: 'Exhaust',
    at: v3(0.35, -0.42, -1.7),
    reach: 0.9,
    threshold: 5500,
    scale: 14000,
    mass: 5,
    half: v3(0.07, 0.07, 0.5),
    // It hangs and scrapes long before it finally drops, which is the most
    // recognisable "this car has had a hard life" sound there is.
    drags: true,
    rollsLoose: true,
    boundTo: 'exhaust',
  },
  {
    id: 'wing',
    label: 'Rear wing',
    at: v3(0, 0.55, -1.75),
    reach: 1.1,
    threshold: 7000,
    scale: 14000,
    mass: 6,
    half: v3(0.6, 0.06, 0.2),
    drags: false,
    rollsLoose: true,
    boundTo: 'panelRear',
  },
  {
    id: 'doorLeft',
    label: 'Left door',
    at: v3(-0.86, 0.05, -0.1),
    reach: 1.1,
    threshold: 12000,
    scale: 20000,
    mass: 18,
    half: v3(0.06, 0.35, 0.6),
    drags: false,
    rollsLoose: true,
    boundTo: 'doorL',
  },
  {
    id: 'doorRight',
    label: 'Right door',
    at: v3(0.86, 0.05, -0.1),
    reach: 1.1,
    threshold: 12000,
    scale: 20000,
    mass: 18,
    half: v3(0.06, 0.35, 0.6),
    drags: false,
    rollsLoose: true,
    boundTo: 'doorR',
  },
  ...(
    [
      ['wheelFL', 'hubFL', -0.78, 1.32],
      ['wheelFR', 'hubFR', 0.78, 1.32],
      ['wheelRL', 'hubRL', -0.78, -1.32],
      ['wheelRR', 'hubRR', 0.78, -1.32],
    ] as const
  ).map(([id, hub, x, z]): PartDef => ({
    id,
    label: `Wheel ${id.slice(5)}`,
    at: v3(x, -0.25, z),
    reach: 0.9,
    // A wheel is never shaken off by attachment alone: it leaves when its hub
    // is destroyed, which the damage model already decides.
    threshold: Infinity,
    scale: Infinity,
    mass: 22,
    half: v3(0.13, 0.34, 0.34),
    drags: false,
    rollsLoose: false,
    boundTo: hub,
  })),
];

export const PART_BY_ID = new Map(PARTS.map((p) => [p.id, p]));

export type PartState = 'attached' | 'dragging' | 'gone';

/** A part that has just left the car. The world turns this into a rigid body. */
export interface DetachEvent {
  id: PartId;
  label: string;
  /** Mount point in car-local metres — where the body is spawned. */
  at: Vec3;
  mass: number;
  half: Vec3;
}

export interface DebrisOptions {
  /** Deterministic random source. Headless runs must be reproducible. */
  random?: () => number;
  /** Seed for the built-in stream. Only used when `random` is not supplied. */
  seed?: number;
}

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

/** Attachment below which a part that can drag starts scraping the road. */
const DRAG_AT = 0.4;
/** Attachment below which a part is hanging on by luck alone. */
const CRITICAL_AT = 0.12;
/** How often the "does it let go now?" roll is made, seconds. */
const ROLL_INTERVAL = 1;
/** Extra drag from a bumper scraping along the road, as a multiplier. */
const DRAG_PENALTY = 0.22;

export class DebrisModel {
  /** 1 = bolted on, 0 = gone. */
  readonly attachment = new Map<PartId, number>();
  private readonly state = new Map<PartId, PartState>();
  private readonly random: () => number;
  private rollTimer = 0;
  private pending: DetachEvent[] = [];

  constructor(options: DebrisOptions = {}) {
    // No `Math.random` fallback: this model is always driven from the damage
    // model's seeded stream in the game, and a default that is not seeded is
    // how reproducibility gets lost without anything failing.
    this.random = options.random ?? seededStream(options.seed ?? 0xdeb215);
    for (const p of PARTS) {
      this.attachment.set(p.id, 1);
      this.state.set(p.id, 'attached');
    }
  }

  get(id: PartId): number {
    return this.attachment.get(id) ?? 1;
  }

  stateOf(id: PartId): PartState {
    return this.state.get(id) ?? 'attached';
  }

  /**
   * Parts that are visibly working loose but still on the car.
   *
   * Every part gets a telegraph, not just the ones that scrape: a bonnet that
   * is about to go rattles at its hinges first, which is the difference between
   * a surprise and an ambush.
   */
  isLoose(id: PartId): boolean {
    return this.stateOf(id) === 'attached' && this.get(id) < DRAG_AT;
  }

  /** Parts currently scraping along the road. The telegraph, in other words. */
  dragging(): PartId[] {
    return PARTS.filter((p) => this.stateOf(p.id) === 'dragging').map((p) => p.id);
  }

  /** Aerodynamic penalty from anything hanging off the car. */
  get dragScale(): number {
    return 1 + this.dragging().length * DRAG_PENALTY;
  }

  /**
   * Work the mounts loose. Called with the same impulse and local point the
   * damage model gets, so one hit does both jobs.
   */
  applyImpact(localPoint: Vec3, impulse: number): void {
    for (const def of PARTS) {
      if (this.stateOf(def.id) === 'gone') continue;
      const dx = def.at.x - localPoint.x;
      const dy = def.at.y - localPoint.y;
      const dz = def.at.z - localPoint.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > def.reach) continue;

      const over = impulse - def.threshold;
      if (over <= 0) continue;

      const loosened = (over / def.scale) * (1 - distance / def.reach);
      if (loosened < 0.005) continue;
      this.attachment.set(def.id, clamp(this.get(def.id) - loosened, 0, 1));
    }
  }

  /**
   * Advance the state machines.
   *
   * `speed` is the car's speed in m/s: a part hanging on at walking pace stays
   * put, and the same part at 120 km/h does not. `componentLost` reports what
   * the damage model has already destroyed outright — a panel beaten to nothing
   * is not still bolted on, and neither is a wheel whose hub has gone.
   */
  update(dt: number, speed: number, componentLost: (id: ComponentId) => boolean): void {
    for (const def of PARTS) {
      if (this.stateOf(def.id) === 'gone') continue;

      // Destroyed outright: it leaves, no roll involved. The cause is already
      // visible and already paid for.
      if (def.boundTo && componentLost(def.boundTo)) {
        this.detach(def);
        continue;
      }

      const attachment = this.get(def.id);
      if (def.drags && attachment <= DRAG_AT && this.stateOf(def.id) === 'attached') {
        this.state.set(def.id, 'dragging');
      }

      // Airflow keeps working on a part that is already loose, so a bumper that
      // survived the impact does not simply stay at whatever it was left at.
      if (attachment < 1 && attachment > 0) {
        const stress = 0.0022 * Math.max(speed - 12, 0) * (1 - attachment);
        this.attachment.set(def.id, clamp(attachment - stress * dt, 0, 1));
      }
    }

    this.rollTimer += dt;
    if (this.rollTimer < ROLL_INTERVAL) return;
    this.rollTimer -= ROLL_INTERVAL;

    for (const def of PARTS) {
      if (this.stateOf(def.id) === 'gone' || !def.rollsLoose) continue;
      const attachment = this.get(def.id);
      if (attachment >= DRAG_AT) continue;

      // The unpredictable moment, weighted by how far gone the part is and how
      // hard the air is pulling at it. At CRITICAL_AT and racing speed this is
      // near certain within a couple of seconds; at the drag threshold on a
      // slow section it may hang on for the rest of the stage.
      const looseness = clamp((DRAG_AT - attachment) / (DRAG_AT - CRITICAL_AT), 0, 1);
      const pace = clamp((speed - 8) / 30, 0, 1);
      const chance = looseness * looseness * (0.12 + 0.75 * pace);
      if (this.random() < chance) this.detach(def);
    }
  }

  /** Force a part off. Used by the wheel path and by tests. */
  detach(def: PartDef): void {
    if (this.stateOf(def.id) === 'gone') return;
    this.state.set(def.id, 'gone');
    this.attachment.set(def.id, 0);
    this.pending.push({
      id: def.id,
      label: def.label,
      at: def.at,
      mass: def.mass,
      half: def.half,
    });
  }

  /** Parts that came off since the last call. The world spawns bodies for them. */
  drainDetached(): DetachEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  reset(): void {
    for (const p of PARTS) {
      this.attachment.set(p.id, 1);
      this.state.set(p.id, 'attached');
    }
    this.pending = [];
    this.rollTimer = 0;
  }
}
