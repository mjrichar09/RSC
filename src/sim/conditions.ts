/**
 * Time of day and weather.
 *
 * Conditions are simulation state, not decoration: rain genuinely takes grip
 * away, and darkness genuinely takes away what you can see. Both are needed —
 * weather that only changes the palette is a filter over the screen, and a
 * night stage you can see perfectly is a night stage in name only.
 *
 * Pure data and pure functions. Rendering reads this; it never writes it.
 */

import type { Surface, SurfaceId } from './surfaces.js';

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';
export type Weather = 'clear' | 'overcast' | 'rain' | 'fog' | 'snowfall';

export interface Conditions {
  timeOfDay: TimeOfDay;
  weather: Weather;
}

export const CLEAR_DAY: Conditions = { timeOfDay: 'day', weather: 'clear' };

/**
 * How much standing water each weather brings, 0..1.
 *
 * Fog is wet air rather than a wet road, so it barely affects grip while
 * costing the most visibility — which is what makes it a different challenge
 * from rain rather than a milder one.
 */
const WETNESS: Record<Weather, number> = {
  clear: 0,
  overcast: 0.05,
  rain: 1,
  fog: 0.2,
  snowfall: 0.55,
};

/**
 * How badly water hurts each surface.
 *
 * Not a flat multiplier: a dry racing line on tarmac is the thing water ruins,
 * whereas gravel was already loose and has much less to lose. Ice in the rain
 * is the worst combination in the game, and snow falling on snow changes almost
 * nothing.
 */
const WET_SENSITIVITY: Record<SurfaceId, number> = {
  tarmac: 0.2,
  gravel: 0.07,
  dirt: 0.14,
  mud: 0.16,
  snow: 0.04,
  ice: 0.26,
  grass: 0.12,
};

/** Grip multiplier for a surface under these conditions. 1 is dry. */
export function gripMultiplier(conditions: Conditions, surface: Surface): number {
  const wet = WETNESS[conditions.weather];
  return 1 - wet * WET_SENSITIVITY[surface.id];
}

/** True when the road is wet enough to throw spray and darken the surface. */
export const isWet = (conditions: Conditions): boolean => WETNESS[conditions.weather] > 0.3;

export interface Visibility {
  /** Distance at which fog starts, metres. */
  fogNear: number;
  /** Distance at which fog is total, metres. */
  fogFar: number;
  /**
   * How much headlights matter here, 0..1.
   *
   * Above zero, the `lights` component stops being a repair line with no
   * gameplay behind it and starts deciding whether you can see the next corner.
   */
  headlightWeight: number;
}

const DARKNESS: Record<TimeOfDay, number> = { dawn: 0.45, day: 0, dusk: 0.5, night: 1 };

/** Fog distances and headlight importance for these conditions. */
export function visibility(conditions: Conditions): Visibility {
  const dark = DARKNESS[conditions.timeOfDay];

  // Clear daylight is the reference: the existing 90/260 fog.
  let near = 90;
  let far = 260;

  switch (conditions.weather) {
    case 'fog':
      near = 14;
      far = 62;
      break;
    case 'rain':
      near = 45;
      far = 150;
      break;
    case 'snowfall':
      near = 35;
      far = 120;
      break;
    case 'overcast':
      near = 75;
      far = 220;
      break;
    case 'clear':
      break;
  }

  // Darkness closes everything in further, and compounds with weather.
  const closeIn = 1 - dark * 0.55;
  return {
    fogNear: near * closeIn,
    fogFar: far * closeIn,
    headlightWeight: dark,
  };
}

/**
 * Ambient air temperature, 0 (freezing night) to 1 (hot afternoon).
 * Brake and coolant cooling read this, so a cold night genuinely helps.
 */
export function ambientTemperature(conditions: Conditions): number {
  const byTime: Record<TimeOfDay, number> = { dawn: 0.3, day: 0.8, dusk: 0.55, night: 0.2 };
  const byWeather: Record<Weather, number> = {
    clear: 0.1,
    overcast: 0,
    rain: -0.1,
    fog: -0.05,
    snowfall: -0.25,
  };
  return Math.min(Math.max(byTime[conditions.timeOfDay] + byWeather[conditions.weather], 0), 1);
}

/**
 * How much harder these conditions are to drive, as a multiplier on a target
 * time. Used to set medal times for a variant.
 *
 * The grip half is measured — the AI drives the variant and its own lap
 * reflects the reduced grip. The visibility half is NOT: the AI reads the
 * centreline and is not slowed by darkness or fog at all, so this factor is an
 * estimate standing in for a human's caution. It wants re-tuning once someone
 * has actually driven a night stage.
 */
export function visibilityPenalty(conditions: Conditions): number {
  const dark = DARKNESS[conditions.timeOfDay];
  const murk: Record<Weather, number> = {
    clear: 0,
    overcast: 0.15,
    rain: 0.4,
    fog: 1,
    snowfall: 0.6,
  };
  return 1 + dark * 0.1 + murk[conditions.weather] * 0.09;
}

/** Short human label, e.g. "Night · Rain". */
export function describeConditions(conditions: Conditions): string {
  const time = conditions.timeOfDay[0]!.toUpperCase() + conditions.timeOfDay.slice(1);
  if (conditions.weather === 'clear') return time;
  const weather = conditions.weather === 'snowfall' ? 'Snow' : conditions.weather;
  return `${time} · ${weather[0]!.toUpperCase()}${weather.slice(1)}`;
}
