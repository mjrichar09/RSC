/**
 * Things the world does to you without warning.
 *
 * This is the fully random tier, and it is bounded by the same fairness rule as
 * everything else in this round: these fire unannounced, and **none of them can
 * end a run on its own**. A gust moves the car; it does not spin it. A stone
 * chips paint and cracks a light; it does not hole a radiator. The unbounded
 * drama lives in the telegraphed tier — a dragging bumper, a deer with its head
 * up — where the player was given something to read first.
 *
 * Exposure is a property of the stage's biome, because a gust on a forest stage
 * makes no sense: trees are the reason it is calm down there.
 */

import type { Conditions } from './conditions.js';
import type { SurfaceId } from './surfaces.js';
import { type Vec3, v3 } from './math.js';

/** How exposed each biome is to wind, 0..1. Forests are sheltered; moors are not. */
const EXPOSURE: Record<string, number> = {
  coast: 1,
  moor: 0.85,
  winter: 0.6,
  quarry: 0.35,
  forest: 0.1,
};

/** Weather that actually blows. Fog is still air, by definition. */
const WINDINESS: Record<string, number> = {
  clear: 0.35,
  overcast: 0.6,
  rain: 0.9,
  fog: 0.05,
  snowfall: 0.75,
};

/** Peak sideways acceleration a gust can apply, m/s². About a tenth of a g. */
const GUST_ACCEL = 1.1;
/** How long a gust takes to rise and fall, seconds. */
const GUST_DURATION = 1.6;
/** Mean seconds between gusts on a fully exposed stage in the worst weather. */
const GUST_INTERVAL = 9;

/** Impulse a flung stone puts through the bodywork, N·s. Cosmetic by design. */
const STONE_IMPULSE = 4600;
/** Mean seconds between stone strikes at full pace on a loose surface. */
const STONE_INTERVAL = 14;
/** Surfaces that throw stones at all. */
const LOOSE: SurfaceId[] = ['gravel', 'dirt'];

export interface AmbientOptions {
  biome?: string;
  conditions?: Conditions;
  /** Deterministic stream. Never `Math.random`. */
  random?: () => number;
}

/** A stone strike, for the presentation layer to crack and flash. */
export interface StoneStrike {
  /** Where it hit, in car-local metres. */
  at: Vec3;
  impulse: number;
}

export class Ambient {
  /** Current sideways acceleration from wind, m/s². Signed: positive is right. */
  gust = 0;

  private readonly random: () => number;
  private readonly exposure: number;
  private gustTimer = 0;
  private gustFor = 0;
  private gustPeak = 0;
  private stoneTimer = 0;
  private pendingStones: StoneStrike[] = [];

  constructor(options: AmbientOptions = {}) {
    this.random = options.random ?? (() => 0.5);
    const biome = EXPOSURE[options.biome ?? ''] ?? 0.4;
    const weather = WINDINESS[options.conditions?.weather ?? 'clear'] ?? 0.4;
    this.exposure = biome * weather;
  }

  /** True when this stage is exposed enough for wind to be worth simulating. */
  get windy(): boolean {
    return this.exposure > 0.15;
  }

  /**
   * Advance the ambient state.
   *
   * `speed` is the car's speed in m/s and `surface` what it is driving on —
   * both gusts and stones scale with pace, so nothing happens to a parked car.
   */
  update(dt: number, speed: number, surface: SurfaceId): void {
    this.updateGust(dt, speed);
    this.updateStones(dt, speed, surface);
  }

  private updateGust(dt: number, speed: number): void {
    if (this.gustFor > 0) {
      this.gustFor -= dt;
      // A half-sine over the gust's life: it arrives and leaves, rather than
      // switching on, which would read as a physics glitch rather than wind.
      const phase = 1 - this.gustFor / GUST_DURATION;
      this.gust = this.gustPeak * Math.sin(Math.PI * Math.min(Math.max(phase, 0), 1));
      if (this.gustFor <= 0) this.gust = 0;
      return;
    }

    this.gust = 0;
    if (!this.windy || speed < 12) return;

    this.gustTimer += dt;
    const interval = GUST_INTERVAL / this.exposure;
    if (this.gustTimer < interval * 0.5) return;

    if (this.random() < dt / interval) {
      this.gustTimer = 0;
      this.gustFor = GUST_DURATION;
      const strength = 0.5 + this.random() * 0.5;
      this.gustPeak = GUST_ACCEL * this.exposure * strength * (this.random() < 0.5 ? -1 : 1);
    }
  }

  private updateStones(dt: number, speed: number, surface: SurfaceId): void {
    if (!LOOSE.includes(surface) || speed < 18) return;
    this.stoneTimer += dt;
    const pace = Math.min((speed - 18) / 22, 1);
    if (this.random() < (dt / STONE_INTERVAL) * pace) {
      this.stoneTimer = 0;
      // Somewhere across the front of the car: bonnet, screen or a light.
      this.pendingStones.push({
        at: v3((this.random() - 0.5) * 1.4, 0.1 + this.random() * 0.4, 1.7 + this.random() * 0.25),
        impulse: STONE_IMPULSE * (0.8 + this.random() * 0.4),
      });
    }
  }

  /** Stones thrown since the last call. The world turns these into damage. */
  drainStones(): StoneStrike[] {
    const out = this.pendingStones;
    this.pendingStones = [];
    return out;
  }

  reset(): void {
    this.gust = 0;
    this.gustFor = 0;
    this.gustTimer = 0;
    this.stoneTimer = 0;
    this.pendingStones = [];
  }
}
