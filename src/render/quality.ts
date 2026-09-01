/**
 * How hard to work the GPU.
 *
 * A phone is not a small desktop. It has a fraction of the fill rate, a screen
 * with three times the pixel density, and a thermal budget that a game running
 * flat out exhausts in about ninety seconds — after which the whole thing is
 * slower than it would have been at half the settings from the start.
 *
 * So there are two mechanisms here and they do different jobs:
 *
 *   - A **tier**, chosen once, that decides what exists at all: shadow map
 *     size, how much scenery is scattered, whether the windscreen pass runs.
 *     These are structural and cannot change per frame without rebuilding.
 *   - A **render scale**, adjusted continuously, that decides how many pixels
 *     those things are drawn into. This is the one that actually saves a phone,
 *     because fill rate is what it runs out of first, and it is free to change.
 *
 * The tier is a guess from what the browser will tell us; the scale is a
 * measurement of what is actually happening. The guess only has to be roughly
 * right because the measurement corrects it.
 */

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualitySettings {
  tier: QualityTier;
  /** Shadow map edge, or 0 for no shadows at all. */
  shadowMap: number;
  /** Cap on the device pixel ratio before the adaptive scale is applied. */
  maxPixelRatio: number;
  /** Multiplier on the scenery instance budget. */
  scenery: number;
  /** Multiplier on the particle budget. */
  particles: number;
  /** Whether the windscreen effect is worth its fullscreen pass. */
  vision: boolean;
  antialias: boolean;
}

const TIERS: Record<QualityTier, Omit<QualitySettings, 'tier'>> = {
  // A phone. No shadows: a 2048 map plus the depth pass is the single most
  // expensive thing in the frame and the least missed at this screen size.
  low: { shadowMap: 0, maxPixelRatio: 1.25, scenery: 0.4, particles: 0.5, vision: false, antialias: false },
  // A tablet, or a laptop with integrated graphics.
  medium: { shadowMap: 1024, maxPixelRatio: 1.5, scenery: 0.7, particles: 0.8, vision: true, antialias: false },
  high: { shadowMap: 2048, maxPixelRatio: 2, scenery: 1, particles: 1, vision: true, antialias: true },
};

/**
 * Guess a tier from the machine.
 *
 * `pointer: coarse` with no fine pointer is the closest thing the platform
 * offers to "this is a touchscreen device", and it is right far more often
 * than a user-agent string — which lies by design and would need updating
 * forever. Core count separates a flagship from a budget phone well enough to
 * be worth reading, and the adaptive scale covers the rest.
 */
export function guessTier(): QualityTier {
  if (typeof window === 'undefined') return 'high';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const fine = window.matchMedia?.('(any-pointer: fine)').matches ?? false;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (coarse && !fine) return cores >= 8 ? 'medium' : 'low';
  return cores <= 4 ? 'medium' : 'high';
}

export function qualityFor(tier: QualityTier): QualitySettings {
  return { tier, ...TIERS[tier] };
}

/**
 * Trade resolution for frame rate, continuously.
 *
 * Deliberately slow to react and much slower to recover. A scaler that chases
 * every frame spends its life oscillating, and resolution changing twice a
 * second is more distracting than the frame rate it was fixing. This one wants
 * about a second of sustained evidence before it moves, and it moves in coarse
 * steps so a change is a one-off rather than a shimmer.
 */
export class RenderScale {
  /** Current multiplier on the pixel ratio, 0.5..1. */
  value = 1;

  private accum = 0;
  private frames = 0;
  /** Consecutive seconds spent below the floor, and above the ceiling. */
  private slow = 0;
  private fast = 0;

  constructor(
    /** Frame rate below which pixels start being given up. */
    private readonly floor = 45,
    /** Frame rate above which they can be taken back. */
    private readonly ceiling = 58,
  ) {}

  /** Returns true when the scale changed and the renderer needs resizing. */
  update(dt: number): boolean {
    this.accum += dt;
    this.frames++;
    if (this.accum < 1) return false;

    const fps = this.frames / this.accum;
    this.accum = 0;
    this.frames = 0;

    // Counted as *consecutive* slow seconds, not as time since the last
    // change. Measured the second way, four good seconds followed by one bad
    // one dropped the resolution — so a stage load or a tab coming back cost
    // the player a permanently softer picture.
    this.slow = fps < this.floor ? this.slow + 1 : 0;
    this.fast = fps > this.ceiling ? this.fast + 1 : 0;

    if (this.slow >= 2 && this.value > 0.5) {
      this.value = Math.max(this.value - 0.15, 0.5);
      this.slow = 0;
      return true;
    }
    // Recovery is slower still: five good seconds. Going back up is optional,
    // and a scaler that ratchets between two values every few seconds is worse
    // than one that simply stays low.
    if (this.fast >= 5 && this.value < 1) {
      this.value = Math.min(this.value + 0.1, 1);
      this.fast = 0;
      return true;
    }
    return false;
  }
}
