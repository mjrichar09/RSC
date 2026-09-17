/**
 * Steering by tilting the phone.
 *
 * The thumb drag in `touch.ts` is the default and stays the default: it is
 * analogue, it needs no aiming, and it works lying down. Tilt is the other
 * thing people reach for on a phone, and it buys one real advantage — it frees
 * the left thumb entirely, so both hands hold the phone and neither is doing
 * two jobs. It is opt-in for the same reason it is not the default: a player
 * on a sofa, in a car, or in bed is holding the phone at an angle that has
 * nothing to do with straight ahead.
 *
 * ### What is measured, and what is deliberately not
 *
 * Not `beta`, and not `gamma`. Both are Euler angles in the *device's* frame,
 * and which of them is "roll your wrists" depends on which way round the phone
 * was turned into landscape — so a player who turned theirs the other way
 * steers backwards, and every reading agrees with itself the whole time. That
 * is the handedness trap this codebase has already fallen into twice, so
 * nothing here picks an angle and hopes.
 *
 * What is measured is **where gravity is**, and then **how far it has moved
 * since the player said they were going straight**. Gravity in device axes
 * falls straight out of `beta` and `gamma`; `alpha` drops out of the algebra,
 * which is the arithmetic saying what is obvious physically — spinning on the
 * spot does not change which way is down. The reading is the angle of gravity
 * across the screen, by `atan2`, and the steering is the change in it.
 *
 * Not `screen.orientation.angle`, either, and that one is worth saying because
 * it looks so much like it belongs: the first version of this rotated gravity
 * into screen axes by it, and the parameter did **nothing**. Rotating the
 * frame shifts the live reading and the reference by exactly the same amount,
 * so it cancels in the subtraction — measured at all four angles, the same
 * movement gave the same 22.0° every time. The calibration is what makes this
 * orientation-agnostic, and it is stronger than an orientation table because
 * it also covers the player lying on their side, for whom no orientation the
 * browser can report is the one they mean.
 *
 * The other half of that: an `atan2`, not gravity's sideways *component*. The
 * two stop agreeing as the phone is pitched back toward flat, where less and
 * less of gravity is in the screen's plane at all — two poses that are the
 * same 12.96° tilt within the plane have 1.00 g and 0.774 g in it, and their
 * sideways components are 0.224 and 0.174. A component reading would make the
 * same corner want a 29% bigger movement depending on how the player happens
 * to be holding the phone.
 */

import { clamp } from '../sim/math.js';

/**
 * Wrist roll for full lock, radians.
 *
 * Both hands on a phone in landscape, forearms still: the wrists roll about
 * thirty degrees each way before the grip has to change. Deliberately short of
 * that, so full lock is reachable without the screen turning away from the
 * player's eyes at the moment they most need to see it.
 */
const FULL_LOCK = (26 * Math.PI) / 180;

/**
 * Roll that still counts as straight, radians.
 *
 * Hands are not still. Without this the car wanders on a straight, which reads
 * as the car being unstable rather than as the input being alive, and no
 * amount of work on the tyre model would fix it.
 */
const DEAD_ZONE = (2.2 * Math.PI) / 180;

/**
 * How much of gravity has to lie across the screen for a reading to mean
 * anything, as a fraction of g.
 *
 * Face-up flat on a table, none of it does — the angle is then `atan2` of two
 * numbers that are both noise, and it spins. A phone being played is never
 * anywhere near that, so refusing to answer costs nothing and stops a phone
 * put down mid-race from sawing at the wheel.
 */
const MIN_IN_PLANE = 0.17;

const RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/** A unit vector, in whatever frame it was asked for. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Which way is down, in the device's own axes.
 *
 * Device axes are the ones the orientation event is defined in: +x out of the
 * right edge held in portrait, +y out of the top edge, +z out of the screen.
 * Flat on a table face up is `(0, 0, -1)` — gravity going out through the back
 * of the screen — and upright in portrait is `(0, -1, 0)`, out through the
 * bottom edge.
 */
export function gravityInDevice(beta: number, gamma: number): Vec3 {
  const b = beta * RAD;
  const g = gamma * RAD;
  return {
    x: Math.cos(b) * Math.sin(g),
    y: -Math.sin(b),
    z: -Math.cos(b) * Math.cos(g),
  };
}

/**
 * Where gravity is across the face of the phone, radians, or null when there
 * is too little of it there to tell.
 *
 * An absolute bearing and not a steering angle: on its own it says nothing
 * about which way the phone is being held, and it is not meant to. What makes
 * it useful is that turning the phone about the axis the player looks along —
 * which is the whole of tilting to steer — moves it by exactly that turn, and
 * nothing else does.
 */
export function gravityRoll(beta: number, gamma: number): number | null {
  const g = gravityInDevice(beta, gamma);
  if (Math.hypot(g.x, g.y) < MIN_IN_PLANE) return null;
  return Math.atan2(g.x, -g.y);
}

/** The short way round between two bearings, radians, in (-π, π]. */
export function shortestTurn(from: number, to: number): number {
  return ((to - from + Math.PI * 3) % TWO_PI) - Math.PI;
}

/**
 * Steering from a bearing and the bearing that was called straight ahead.
 *
 * The difference is the *short way round*, which is not fussiness: a reference
 * taken while the phone was held near upside-down sits close to ±π, and a
 * plain subtraction there wraps — so rolling further right crosses the seam
 * and comes out as a bounded-but-opposite number, which is full left lock in
 * the middle of a right-hand corner. It is reachable by a real hand: a big
 * enough reaction to a crash gets there.
 *
 * The dead zone is subtracted rather than masked, so the first degree of real
 * input past it is a small one — a dead zone that gates instead of offsetting
 * makes the car jump to a tenth of lock the instant it is crossed.
 */
export function steerFromRoll(roll: number, reference: number): number {
  const offset = shortestTurn(reference, roll);
  const past = Math.abs(offset) - DEAD_ZONE;
  if (past <= 0) return 0;
  return clamp((Math.sign(offset) * past) / (FULL_LOCK - DEAD_ZONE), -1, 1);
}

/** Whether this browser has the event at all. Desktops mostly do not. */
export const tiltAvailable = (): boolean =>
  typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;

/**
 * Whether the player has to be asked first.
 *
 * iOS 13 put device orientation behind a permission prompt that can only be
 * raised from inside a user gesture. Feature-detected, because that is exactly
 * what it is — a static method that either exists or does not.
 */
export const tiltNeedsPermission = (): boolean =>
  tiltAvailable() &&
  typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission ===
    'function';

/**
 * The live tilt input.
 *
 * Deliberately not an input *source* that anything polls on its own: it holds
 * a number, `touch.ts` reads it, and a thumb on the steering pad outranks it.
 * Somebody who grabs the pad is telling you which input they meant.
 */
export class TiltSteering {
  /** Raised when tilt turns itself on or off, for the button to follow. */
  onChange: (() => void) | null = null;

  private on = false;
  private roll: number | null = null;
  private reference: number | null = null;
  private listening = false;

  private readonly listener = (event: DeviceOrientationEvent) => {
    if (event.beta === null || event.gamma === null) return;
    this.feed(event.beta, event.gamma);
  };
  /**
   * A phone turned round is a new hold.
   *
   * Not because the arithmetic needs it — the reference cancels the
   * orientation out, as the header says — but because a player who has just
   * rotated their phone has physically re-gripped it, and whatever they are
   * holding now is what they mean by straight.
   */
  private readonly rotated = () => this.recentre();

  /** Whether tilt is steering right now. */
  get enabled(): boolean {
    return this.on;
  }

  /**
   * This frame's steering, or null when tilt has nothing to say.
   *
   * Null rather than 0 on purpose: 0 is "held straight", and a caller has to
   * be able to tell that apart from "no reading", which is a phone flat on a
   * table and must leave the wheel wherever the last real input put it.
   */
  get steer(): number | null {
    if (!this.on || this.roll === null || this.reference === null) return null;
    return steerFromRoll(this.roll, this.reference);
  }

  /**
   * Turn it on, asking first where that is required.
   *
   * Resolves false when the player says no, when the browser has no such
   * event, or when this was called outside a gesture on a platform that
   * insists on one — all three are the same thing to a caller, which is that
   * tilt is not available and the thumb is still there.
   */
  async enable(): Promise<boolean> {
    if (this.on) return true;
    if (!tiltAvailable()) return false;

    if (tiltNeedsPermission()) {
      const ask = (DeviceOrientationEvent as unknown as {
        requestPermission: () => Promise<PermissionState | 'granted' | 'denied'>;
      }).requestPermission;
      try {
        if ((await ask()) !== 'granted') return false;
      } catch {
        // Thrown rather than refused when this did not come from a gesture.
        return false;
      }
    }

    this.on = true;
    this.recentre();
    if (!this.listening) {
      this.listening = true;
      window.addEventListener('deviceorientation', this.listener);
      window.addEventListener('orientationchange', this.rotated);
      screen.orientation?.addEventListener?.('change', this.rotated);
    }
    this.onChange?.();
    return true;
  }

  disable(): void {
    if (!this.on) return;
    this.on = false;
    this.roll = null;
    this.reference = null;
    if (this.listening) {
      this.listening = false;
      window.removeEventListener('deviceorientation', this.listener);
      window.removeEventListener('orientationchange', this.rotated);
      screen.orientation?.removeEventListener?.('change', this.rotated);
    }
    this.onChange?.();
  }

  /** However the phone is being held now is straight ahead. */
  recentre(): void {
    this.reference = null;
    this.roll = null;
  }

  /**
   * One reading.
   *
   * Public because the arithmetic above it is the whole of this class, and a
   * test that has to synthesise `DeviceOrientationEvent`s to reach it is a
   * test of the browser.
   */
  feed(beta: number, gamma: number): void {
    const roll = gravityRoll(beta, gamma);
    if (roll === null) {
      // Kept, not cleared: a reading this poor is a phone momentarily flat,
      // and dropping to no-reading would hand the wheel back mid-corner.
      return;
    }
    this.roll = roll;
    // The first reading after being switched on, or after a rotation, is the
    // pose the player is holding. That is straight ahead by definition.
    this.reference ??= roll;
  }
}
