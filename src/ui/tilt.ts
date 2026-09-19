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
 * thirty degrees each way before the grip has to change, and a little past
 * that with a small shoulder movement nobody minds making.
 *
 * It was 26° first, reasoned from that limit alone — keep full lock inside
 * what the wrists do and the screen never turns away from the player's eyes.
 * Driven, it was too sharp: every degree is 4.5% of lock at 26° and the car
 * is nervous on a straight, where the input is never quite still. 35° is the
 * whole range rather than the comfortable part of it, and trades a movement
 * you notice making for a car that holds a line.
 */
const FULL_LOCK = (35 * Math.PI) / 180;

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

/**
 * How long to wait for the sensor to say anything, ms.
 *
 * `deviceorientation` fires at about 60 Hz wherever it fires at all, so a
 * working sensor answers within a frame or two and this is never waited out in
 * the case that matters. It is long enough to cover a first event that has to
 * spin a sensor up, and short enough that a device with nothing to say hands
 * the button back before the player has decided it is broken.
 */
const SENSOR_WAIT = 700;

/**
 * How turning tilt on went.
 *
 * Four outcomes rather than a boolean, because they are four different
 * situations for the player and only one of them is their fault. `denied` is
 * fixable from a settings screen, `silent` is a device with no readings to
 * give, and `unsupported` is a browser with no such event — a button that can
 * only say "no" to all three is a dead end, which is exactly what it was.
 */
export type TiltStart = 'on' | 'denied' | 'silent' | 'unsupported';

/** Whether this browser has the event at all. Desktops mostly do not. */
export const tiltAvailable = (): boolean =>
  typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;

/**
 * Whether this browser wants to be asked first.
 *
 * iOS 13 put device orientation behind a permission prompt that can only be
 * raised from inside a user gesture. Feature-detected, because that is exactly
 * what it is — a static method that either exists or does not.
 *
 * **A "no" from it is not the last word**, which is the thing this got wrong.
 * It is not only iOS that defines this method, and elsewhere it can be a stub
 * that refuses — or throws — on a device whose sensor works perfectly. Taking
 * it as authoritative is what made the tilt button say NO on a OnePlus 13 with
 * a working gyroscope and no way to find out why. `enable` asks the sensor
 * afterwards regardless, and the readings decide.
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

  /** Resolves the wait in `enable` on the first reading worth having. */
  private heard: (() => void) | null = null;

  private readonly listener = (event: DeviceOrientationEvent) => {
    if (event.beta === null || event.gamma === null) return;
    // After the null guard: an event carrying nothing proves nothing about
    // whether there is a sensor behind it.
    this.heard?.();
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
   * Turn it on: ask where asking is required, then ask the sensor.
   *
   * The permission call used to be the whole decision, and that is the bug
   * this shape exists to prevent. A browser that defines `requestPermission`
   * and answers anything other than `granted` — including throwing — may still
   * deliver readings, and on a device whose gyroscope works the honest test is
   * whether any arrive. So a refusal demotes to a *suspicion* and the listener
   * goes on either way; readings settle it.
   *
   * Which means the only thing that turns tilt on is the sensor actually
   * speaking, and `silent` becomes a real answer instead of a button that
   * lights up over an input that never moves.
   */
  async enable(): Promise<TiltStart> {
    if (this.on) return 'on';
    if (!tiltAvailable()) return 'unsupported';

    let refused = false;
    if (tiltNeedsPermission()) {
      const ask = (DeviceOrientationEvent as unknown as {
        requestPermission: () => Promise<PermissionState | 'granted' | 'denied'>;
      }).requestPermission;
      try {
        refused = (await ask()) !== 'granted';
      } catch {
        // Thrown rather than refused when this did not come from a gesture, or
        // on an insecure origin. Still only a suspicion.
        refused = true;
      }
    }

    const wasListening = this.listening;
    this.listen();
    if (!(await this.waitForReading())) {
      // Nothing came. Leave the listener exactly as it was found, or a refused
      // attempt quietly accumulates handlers on the window.
      if (!wasListening) this.unlisten();
      return refused ? 'denied' : 'silent';
    }

    this.on = true;
    // The pose being held at the moment it comes on is straight ahead, so the
    // reading that proved the sensor works is deliberately thrown away — the
    // next one, a frame later, is the one the player meant.
    this.recentre();
    this.onChange?.();
    return 'on';
  }

  disable(): void {
    if (!this.on) return;
    this.on = false;
    this.roll = null;
    this.reference = null;
    this.unlisten();
    this.onChange?.();
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('deviceorientation', this.listener);
    window.addEventListener('orientationchange', this.rotated);
    screen.orientation?.addEventListener?.('change', this.rotated);
  }

  private unlisten(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('deviceorientation', this.listener);
    window.removeEventListener('orientationchange', this.rotated);
    screen.orientation?.removeEventListener?.('change', this.rotated);
  }

  /** True if the sensor said anything usable inside `SENSOR_WAIT`. */
  private waitForReading(): Promise<boolean> {
    return new Promise((resolve) => {
      let timer = 0;
      const settle = (heard: boolean) => {
        this.heard = null;
        clearTimeout(timer);
        resolve(heard);
      };
      timer = setTimeout(() => settle(false), SENSOR_WAIT) as unknown as number;
      this.heard = () => settle(true);
    });
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
