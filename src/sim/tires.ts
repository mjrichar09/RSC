/**
 * Tire force model.
 *
 * A simplified Pacejka-shaped curve: force rises smoothly to a peak at the
 * characteristic slip value, then decays toward a floor as the tire slides.
 * The floor is the single most important number for how the car *feels* — a
 * high floor means a slide still carries useful force, so drifts are
 * controllable and recoverable rather than a one-way trip into the scenery.
 */

import { clamp } from './math.js';

/** Rate at which force decays past the peak. Higher = snappier, less forgiving. */
const FALLOFF = 1.25;

/**
 * Normalised force for a normalised slip value (slip / peakSlip).
 * Returns a signed value in roughly [-1, 1]; magnitude peaks at |s| = 1.
 */
export function slipCurve(normalisedSlip: number, slideFloor: number): number {
  const s = Math.abs(normalisedSlip);
  const sign = normalisedSlip < 0 ? -1 : 1;
  if (s <= 1) {
    // Quarter sine: zero slope at the peak, linear-ish near zero.
    return sign * Math.sin((Math.PI / 2) * s);
  }
  const decay = Math.exp(-(s - 1) * FALLOFF);
  return sign * (slideFloor + (1 - slideFloor) * decay);
}

/** Slip angle in radians: the angle between where the wheel points and where it goes. */
export function slipAngle(forwardVel: number, lateralVel: number): number {
  return Math.atan2(lateralVel, Math.max(Math.abs(forwardVel), 1.0));
}

/**
 * Slip ratio: how much faster the tire contact patch is turning than the ground
 * beneath it. Positive under power, negative under braking.
 */
export function slipRatio(wheelSurfaceSpeed: number, forwardVel: number): number {
  const denom = Math.max(Math.abs(forwardVel), 1.0);
  return clamp((wheelSurfaceSpeed - forwardVel) / denom, -4, 4);
}

export interface TireInput {
  /** Vertical load on the tire, newtons. */
  load: number;
  /** Peak friction coefficient, after surface and damage multipliers. */
  mu: number;
  slipAngle: number;
  slipRatio: number;
  peakSlipAngle: number;
  peakSlipRatio: number;
  slideFloor: number;
  /** Floor for a locked wheel — the braking side of the longitudinal curve. */
  lockedFloor?: number;
  /** Fraction of longitudinal capability available (0 while a wheel is locked). */
  driveScale: number;
}

export interface TireOutput {
  /** Force along the wheel's forward axis, newtons. */
  longitudinal: number;
  /** Force along the wheel's lateral axis, newtons. Opposes lateral slip. */
  lateral: number;
  /** 0..1+, how far into the friction circle this tire is. >1 means it saturated. */
  saturation: number;
}

/**
 * Evaluate both axes and clamp the result to the friction circle, so a tire can
 * never deliver full grip in two directions at once. This is what makes
 * trail-braking and throttle-steering work.
 */
export function tireForces(i: TireInput): TireOutput {
  const capacity = Math.max(i.load, 0) * i.mu;

  const lat = -slipCurve(i.slipAngle / i.peakSlipAngle, i.slideFloor) * capacity;
  // Braking and driving get different floors: a locked tyre loses far more
  // than a spinning one, which is what makes threshold braking worth doing.
  const longFloor = i.slipRatio < 0 ? (i.lockedFloor ?? i.slideFloor) : i.slideFloor;
  const long = slipCurve(i.slipRatio / i.peakSlipRatio, longFloor) * capacity * i.driveScale;

  const mag = Math.hypot(lat, long);
  const saturation = capacity > 1e-6 ? mag / capacity : 0;
  if (saturation > 1) {
    const k = 1 / saturation;
    return { longitudinal: long * k, lateral: lat * k, saturation };
  }
  return { longitudinal: long, lateral: lat, saturation };
}
