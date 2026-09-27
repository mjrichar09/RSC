/**
 * The game's look: a style laid over the grade, chosen as a whole.
 *
 * `grade.ts` is the light — what dawn or rain does to the picture — and it is
 * decided by the conditions, because what you see and what the car is doing
 * must agree about the weather. A look is the other thing: what kind of
 * picture this is. Film stock, a model on a table, a page of a comic. It never
 * touches the conditions' grade, only multiplies onto it, so a night stage is
 * still night in every look.
 *
 * All of it happens in the one full-screen pass `vision.ts` already runs, so a
 * look costs a few texture fetches per pixel and nothing in the scene.
 * `?look=` picks one; `standard` is the game as it was.
 */

import type { Grade } from './grade.js';

export type LookId = 'standard' | 'rallye' | 'diorama' | 'ink';

/** What the composite shader does on top of the grade. Zero is off, for every one. */
export interface LookFx {
  /** Film grain or paper fibre, as an amplitude in sRGB. */
  grain: number;
  /** 1 for grain that crawls like film, 0 for texture that stays put like paper. */
  grainMoves: number;
  /** Colour fringing toward the edges of the frame, as a uv offset at the corners. */
  fringe: number;
  /** Highlights bleeding a warm glow into what surrounds them. */
  halation: number;
  /** How far the top and bottom of the frame go out of focus, 0..1. */
  tilt: number;
  /** Strength of the drawn outline on every edge, 0..1. */
  ink: number;
  /** Brightness bands after the grade, hue kept; 0 leaves tone continuous. */
  poster: number;
  /** A paper tone multiplied into the finished picture, and how much of it. */
  paper: [number, number, number];
  paperMix: number;
}

export interface Look {
  id: LookId;
  name: string;
  fx: LookFx;
  /** This look's adjustment, composed onto the conditions' grade. */
  grade: Partial<Grade>;
}

const NONE: LookFx = {
  grain: 0,
  grainMoves: 0,
  fringe: 0,
  halation: 0,
  tilt: 0,
  ink: 0,
  poster: 0,
  paper: [1, 1, 1],
  paperMix: 0,
};

export const LOOKS: Record<LookId, Look> = {
  standard: { id: 'standard', name: 'Standard', fx: NONE, grade: {} },
  /**
   * Rallye '85: the sport as it was broadcast. Faded warm film stock, blacks
   * that never quite reach black, highlights that bloom, fringing at the edges
   * of a long lens and grain crawling over all of it.
   */
  rallye: {
    id: 'rallye',
    name: "Rallye '85",
    fx: { ...NONE, grain: 0.05, grainMoves: 1, fringe: 0.004, halation: 0.3 },
    grade: {
      gain: [1.1, 1.0, 0.82],
      lift: [0.018, 0.014, 0.006],
      saturation: 0.8,
      contrast: 0.96,
      vignette: 0.45,
    },
  },
  /**
   * Diorama: a model railway of a rally stage. Toy saturation, bright even
   * light, and the top and bottom of the frame out of focus, which is the
   * whole trick — a shallow depth of field says "small" before anything else.
   */
  diorama: {
    id: 'diorama',
    name: 'Diorama',
    fx: { ...NONE, tilt: 1 },
    // Saturation is gentle on purpose: the grade works on linear light, where
    // pushing it past about 1.2 sends every brown on the road to red and black.
    grade: {
      gain: [1.14, 1.12, 1.06],
      lift: [0.004, 0.004, 0.008],
      saturation: 1.18,
      contrast: 1.0,
      vignette: 0.12,
    },
  },
  /**
   * Ink: a page from a rally comic. Every edge drawn in, colour flattened into
   * a few printed tones, laid on warm paper.
   */
  ink: {
    id: 'ink',
    name: 'Ink',
    fx: { ...NONE, ink: 1, poster: 4, paper: [0.97, 0.93, 0.84], paperMix: 1, grain: 0.03, grainMoves: 0 },
    grade: { gain: [1.08, 1.06, 1.02], saturation: 1.05, vignette: 0.1 },
  },
};

export const lookById = (id: string | null | undefined): Look =>
  (id && id in LOOKS ? LOOKS[id as LookId] : LOOKS.standard);

/** A conditions grade with a look composed on top: gains multiply, lifts add. */
export function withLook(base: Grade, look: Look): Grade {
  const g = look.grade;
  return {
    gain: g.gain
      ? [base.gain[0] * g.gain[0], base.gain[1] * g.gain[1], base.gain[2] * g.gain[2]]
      : base.gain,
    lift: g.lift ? [base.lift[0] + g.lift[0], base.lift[1] + g.lift[1], base.lift[2] + g.lift[2]] : base.lift,
    saturation: base.saturation * (g.saturation ?? 1),
    contrast: base.contrast * (g.contrast ?? 1),
    vignette: Math.max(base.vignette, g.vignette ?? 0),
  };
}

/** True when a look changes the picture at all, so the pass cannot be skipped. */
export const lookActive = (fx: LookFx): boolean =>
  fx.grain > 0 || fx.fringe > 0 || fx.halation > 0 || fx.tilt > 0 || fx.ink > 0 || fx.poster > 0 || fx.paperMix > 0;
