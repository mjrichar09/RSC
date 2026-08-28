/**
 * What the driver can actually see.
 *
 * This is in `sim/` rather than `render/` on purpose: how far you can see is
 * not decoration, it is the difficulty of a night stage, and it is the reason a
 * broken wiper is worth paying to fix. The renderer reads these numbers; it
 * does not decide them.
 *
 * Three things stack:
 *
 * - **Darkness.** At night you see what the headlights light and very little
 *   else, so the world outside a cone ahead of the car falls away.
 * - **Soiling.** Rain, snow and mud land on the screen and build up. It is
 *   cleared by the wipers, in sweeps, so visibility comes back in steps rather
 *   than smoothly — the moment before a sweep is the worst you will see.
 * - **Damage.** A dead wiper stops clearing. On a wet night that is the
 *   difference between a stage you can drive and one you cannot, which is
 *   exactly what a component is supposed to be.
 */

import type { Conditions } from './conditions.js';
import { visibility } from './conditions.js';
import type { SurfaceId } from './surfaces.js';
import { clamp } from './math.js';

/** How fast each weather dirties the screen, in units of occlusion per second. */
const SOILING_RATE: Record<string, number> = {
  clear: 0,
  overcast: 0,
  rain: 0.36,
  fog: 0.04,
  snowfall: 0.5,
};

/** Surfaces that throw material onto the screen, and how much of it. */
const SPRAY: Partial<Record<SurfaceId, number>> = {
  mud: 0.55,
  dirt: 0.22,
  gravel: 0.12,
  snow: 0.16,
};

/**
 * How much of the view each material is allowed to take, at its worst.
 *
 * None of them reach 1. Water sheets off glass and you always see something
 * through it; mud is the one that genuinely blinds you, and even that leaves
 * gaps. A screen you cannot see through at all is not difficulty, it is a
 * black rectangle.
 */
const MAX_OCCLUSION: Record<VisionKind, number> = {
  water: 0.55,
  snow: 0.72,
  mud: 0.88,
};

/** Seconds for one wiper sweep across the screen. */
const SWEEP_TIME = 0.55;
/** Seconds between sweeps at full speed. Slower when there is less to clear. */
const SWEEP_INTERVAL = 1.5;
/** What a sweep leaves behind: a wiper smears, it does not polish. */
const SMEAR = 0.12;

export type VisionKind = 'water' | 'snow' | 'mud';


export interface VisionState {
  /**
   * How dark the world is outside the headlights, 0..1. At 1 the only thing
   * lit is what the beams reach.
   */
  darkness: number;
  /** How far the beams reach, as a fraction of the screen. */
  coneReach: number;
  /** Half-angle of the lit cone, radians. Narrows as the lights are damaged. */
  coneAngle: number;
  /** How much of the screen is covered by whatever is landing on it, 0..1. */
  occlusion: number;
  /** What is on the screen, which decides how it is drawn. */
  kind: VisionKind;
  /**
   * Where the blade is, 0..1 across the screen, or null when it is parked.
   * The renderer clears everything the blade has passed this sweep.
   */
  wiper: number | null;
  /** True when the wipers cannot clear at all any more. */
  wipersDead: boolean;
}

export interface VisionInput {
  conditions: Conditions;
  /** Speed in m/s: spray and rain both arrive faster the faster you go. */
  speed: number;
  /** What the car is driving on, for spray thrown up off the road. */
  surface: SurfaceId;
  /** Health of the `wipers` component, 0..1. */
  wiperHealth: number;
  /** Health of the `lights` component, 0..1. */
  lightHealth: number;
}

/**
 * The vision model.
 *
 * Stateful because soiling accumulates and wipers sweep — both are about what
 * happened over the last few seconds, not about this instant.
 */
export class Vision {
  /** 0 = clean screen, 1 = cannot see through it. */
  private soiling = 0;
  /** Seconds since the current sweep began, or null when parked. */
  private sweep: number | null = null;
  private sinceSweep = 0;

  update(dt: number, input: VisionInput): VisionState {
    const { conditions, speed, surface, wiperHealth, lightHealth } = input;

    // What is landing, and what it is made of. Mud thrown off the road beats
    // whatever the sky is doing: you cannot wipe your way out of a mud bath.
    const spray = (SPRAY[surface] ?? 0) * clamp(speed / 25, 0, 1);
    const weather = SOILING_RATE[conditions.weather] ?? 0;
    const arriving = weather * (0.4 + clamp(speed / 30, 0, 1) * 0.6) + spray;
    const kind: VisionKind =
      spray > weather ? 'mud' : conditions.weather === 'snowfall' ? 'snow' : 'water';

    this.soiling = clamp(this.soiling + arriving * dt, 0, MAX_OCCLUSION[kind]);

    // Wipers. They run when there is something to clear and they still work.
    const wipersDead = wiperHealth <= 0;
    if (!wipersDead && this.soiling > 0.05) {
      this.sinceSweep += dt;
      // A tired wiper is a slow wiper, so the gap between sweeps stretches as
      // the component wears rather than snapping from perfect to useless.
      const interval = SWEEP_INTERVAL / Math.max(wiperHealth, 0.25);
      if (this.sweep === null && this.sinceSweep >= interval) {
        this.sweep = 0;
        this.sinceSweep = 0;
      }
    }

    let wiper: number | null = null;
    if (this.sweep !== null) {
      this.sweep += dt;
      const progress = this.sweep / SWEEP_TIME;
      if (progress >= 1) {
        this.sweep = null;
        // A sweep clears most of it and smears the rest.
        this.soiling = Math.min(this.soiling, SMEAR * (1 - wiperHealth * 0.5));
      } else {
        wiper = progress;
      }
    }

    const view = visibility(conditions);
    const lit = 0.35 + 0.65 * lightHealth;

    return {
      darkness: view.headlightWeight,
      // A damaged lamp both dims and narrows: the cone is the thing you steer
      // by at night, so losing half of it is felt immediately.
      coneReach: 0.34 + 0.42 * lit,
      coneAngle: 0.34 + 0.14 * lit,
      occlusion: this.soiling,
      kind,
      wiper,
      wipersDead,
    };
  }

  reset(): void {
    this.soiling = 0;
    this.sweep = null;
    this.sinceSweep = 0;
  }
}
