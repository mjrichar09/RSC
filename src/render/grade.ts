/**
 * The colour of the light.
 *
 * Every time of day was the same picture at a different brightness. Dawn is not
 * day with the lights turned down: it is cold in the shadows and warm where the
 * sun catches, and it sits at a much lower contrast because the air is full of
 * water. Night is not dim, it is blue and crushed and almost colourless except
 * where the headlights land. Getting that right costs one multiply and one add
 * per pixel, in a pass the game already runs, and it does more for how a stage
 * feels than any amount of geometry.
 *
 * This is a look, so it lives in `render/` and reads `Conditions` — the same
 * conditions that decide grip and visibility, so what you see and what the car
 * is doing can never disagree about the weather.
 *
 * Deliberately a grade rather than a filter: it works on shadows, midtones and
 * saturation separately, so the road stays legible while the light changes. A
 * flat tint over the whole frame is the thing this exists to avoid.
 */

import type { Conditions, TimeOfDay, Weather } from '../sim/conditions.js';

export interface Grade {
  /** Multiplied in: the colour of the light itself. */
  gain: [number, number, number];
  /** Added in: what fills the shadows, and how much haze sits in front. */
  lift: [number, number, number];
  /** 1 leaves colour alone, 0 is monochrome. */
  saturation: number;
  /** Around the midpoint. Above 1 is punchier. */
  contrast: number;
  /** How much the corners fall away. */
  vignette: number;
}

const NEUTRAL: Grade = {
  gain: [1, 1, 1],
  lift: [0, 0, 0],
  saturation: 1,
  contrast: 1,
  vignette: 0,
};

/**
 * By time of day.
 *
 * Day is the reference and is left almost alone — every other grade is read
 * against it, and a game whose "normal" is already pushed has nowhere to go.
 */
const BY_TIME: Record<TimeOfDay, Grade> = {
  dawn: {
    gain: [1.04, 1.0, 0.96],
    // Blue in the shadows and a lot of lift: first light is mostly sky.
    lift: [0.012, 0.02, 0.042],
    saturation: 0.86,
    contrast: 0.9,
    vignette: 0.12,
  },
  day: {
    gain: [1.02, 1.0, 0.97],
    lift: [0, 0, 0],
    saturation: 1.04,
    contrast: 1.05,
    vignette: 0.08,
  },
  dusk: {
    // The warmest the game gets, and the only grade that pushes red past green.
    gain: [1.14, 0.98, 0.86],
    lift: [0.03, 0.012, 0.028],
    saturation: 1.0,
    contrast: 1.0,
    vignette: 0.2,
  },
  night: {
    gain: [0.82, 0.9, 1.1],
    lift: [0.004, 0.008, 0.022],
    // Colour vision goes at night, and a night stage that is merely dark still
    // reads as daytime with the brightness down.
    saturation: 0.62,
    contrast: 1.12,
    vignette: 0.3,
  },
};

/**
 * By weather, applied on top.
 *
 * Multiplicative on gain and saturation, additive on lift, so a foggy dusk is
 * warm *and* washed out rather than one or the other.
 */
const BY_WEATHER: Record<Weather, Partial<Grade>> = {
  clear: {},
  overcast: { gain: [0.97, 0.98, 1.02], saturation: 0.88, contrast: 0.94 },
  rain: { gain: [0.92, 0.96, 1.04], lift: [0.008, 0.012, 0.02], saturation: 0.8, contrast: 0.98 },
  // Fog is the extreme case: almost all lift, almost no contrast, almost no
  // colour. It is the one grade that genuinely takes the stage away from you.
  fog: { gain: [0.95, 0.96, 0.98], lift: [0.06, 0.065, 0.07], saturation: 0.6, contrast: 0.78 },
  snowfall: { gain: [0.98, 1.0, 1.04], lift: [0.03, 0.034, 0.04], saturation: 0.72, contrast: 0.9 },
};

export function gradeFor(conditions: Conditions): Grade {
  const base = BY_TIME[conditions.timeOfDay];
  const over = BY_WEATHER[conditions.weather];
  return {
    gain: [
      base.gain[0] * (over.gain?.[0] ?? 1),
      base.gain[1] * (over.gain?.[1] ?? 1),
      base.gain[2] * (over.gain?.[2] ?? 1),
    ],
    lift: [
      base.lift[0] + (over.lift?.[0] ?? 0),
      base.lift[1] + (over.lift?.[1] ?? 0),
      base.lift[2] + (over.lift?.[2] ?? 0),
    ],
    saturation: base.saturation * (over.saturation ?? 1),
    contrast: base.contrast * (over.contrast ?? 1),
    vignette: base.vignette + (over.vignette ?? 0),
  };
}

/** How far this grade is from doing nothing, so a neutral one can be skipped. */
export function gradeStrength(grade: Grade): number {
  return (
    Math.abs(grade.gain[0] - 1) +
    Math.abs(grade.gain[1] - 1) +
    Math.abs(grade.gain[2] - 1) +
    grade.lift[0] + grade.lift[1] + grade.lift[2] +
    Math.abs(grade.saturation - 1) +
    Math.abs(grade.contrast - 1) +
    grade.vignette
  );
}

export { NEUTRAL as NEUTRAL_GRADE };
