/**
 * The moment of the crash: time dilation and a ducked mix.
 *
 * A big hit currently arrives and is over inside two frames. Burnout's damage
 * aesthetic is at least half presentation — the world slows, the mix goes deaf,
 * and you get a second to look at what you have just done to the car. That
 * second is what makes a crash feel like an event rather than a subtraction
 * from a health bar.
 *
 * Deliberately its own object, outside both the simulation and the renderer,
 * for two reasons. It is a taste effect that some people will hate, so it has
 * to be switchable off with one number (`strength = 0`) and leave no trace when
 * it is. And it is a pure state machine, so what it does to the clock is
 * testable without a browser.
 *
 * It never runs in a network race: slowing one client's world would desync it
 * from the host. That gate lives at the call site, which is the only place that
 * knows whether there is a session.
 */

/** Below this the hit is a bump, and bumps do not get a cinematic. N·s. */
const TRIGGER = 15_000;
/** At and above this the effect is at full strength. N·s. */
const FULL = 36_000;
/** How long the dilation lasts at full strength, real seconds. */
const HOLD = 0.55;
/** Slowest the world runs, as a fraction of real time. */
const SLOWEST = 0.3;

export class ImpactDrama {
  /**
   * How much of the effect to apply, 0..1.
   *
   * 0 is off: `timeScale` is exactly 1, `duck` is exactly 0, and `hit` never
   * fires. Nothing downstream needs to know the feature exists.
   */
  strength: number;

  /** Real seconds left in the current dilation. */
  private left = 0;
  /** How hard the hit that started it was, 0..1. */
  private weight = 0;

  constructor(strength = 1) {
    this.strength = strength;
  }

  /** True while the world is running slow. */
  get active(): boolean {
    return this.left > 0;
  }

  /**
   * What to multiply real time by before it reaches the world.
   *
   * Eased back up rather than released in one step: a hard cut back to full
   * speed reads as a dropped frame, which is the opposite of the effect.
   */
  get timeScale(): number {
    if (this.left <= 0 || this.strength <= 0) return 1;
    const span = HOLD * (0.5 + this.weight * 0.5);
    // 1 at the moment of impact, falling to 0 as the effect releases.
    const t = Math.min(this.left / span, 1);
    const depth = (1 - SLOWEST) * this.weight * this.strength * t * t;
    return 1 - depth;
  }

  /** How muffled the mix should be, 0..1. */
  get duck(): number {
    if (this.left <= 0 || this.strength <= 0) return 0;
    const span = HOLD * (0.5 + this.weight * 0.5);
    return Math.min(this.left / span, 1) * this.weight * this.strength;
  }

  /**
   * Offer an impact. Returns true if it was big enough to trigger.
   *
   * A harder hit during an existing dilation extends and deepens it; a lighter
   * one is ignored, so a car grinding down a wall does not hold the world in
   * slow motion indefinitely.
   */
  hit(impulse: number): boolean {
    if (this.strength <= 0 || impulse < TRIGGER) return false;
    const weight = Math.min((impulse - TRIGGER) / (FULL - TRIGGER), 1);
    if (this.left > 0 && weight <= this.weight) return false;
    this.weight = weight;
    this.left = HOLD * (0.5 + weight * 0.5);
    return true;
  }

  update(dt: number): void {
    if (this.left > 0) this.left = Math.max(this.left - dt, 0);
  }

  /** Back to normal time immediately — a restart, or leaving for the garage. */
  reset(): void {
    this.left = 0;
    this.weight = 0;
  }
}
