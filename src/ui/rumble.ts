/**
 * Rumble: the car through your hands, on a gamepad and on a phone.
 *
 * Two very different instruments. A gamepad has two motors that can be driven
 * continuously and at any strength, so it carries the road — gravel buzzes,
 * tarmac is smooth, a ford shakes — as well as the hits. A phone has one motor
 * that is on or off (`navigator.vibrate`), and buzzing it for a whole stage is
 * a battery and an annoyance, so it only marks events: impacts and landings.
 * iOS has no vibration API at all and simply gets nothing.
 *
 * Everything is scaled by what the simulation reports — impact severity, how
 * long the car was in the air, speed and slip — so it says what is happening
 * rather than decorating it.
 */

import type { VehicleState } from '../sim/vehicle.js';
import type { SurfaceId } from '../sim/surfaces.js';
import type { GamepadInput } from './gamepad.js';

/** How much each surface buzzes the light motor at 100 km/h. */
const TEXTURE: Record<SurfaceId, number> = {
  tarmac: 0.03,
  ice: 0.02,
  snow: 0.1,
  grass: 0.14,
  dirt: 0.18,
  gravel: 0.24,
  mud: 0.2,
  water: 0.4,
};

/** Seconds between continuous effects: each one is a little longer than this. */
const TICK = 0.1;

export class Rumble {
  /** Off means nothing is ever sent. Remembered with the profile. */
  enabled = true;
  /** True when the player is on a touch screen, which is when the phone buzzes. */
  phone = false;

  private since = 0;
  private airborneFor = 0;

  constructor(private readonly gamepad: GamepadInput) {}

  /** One hit, 0..1. */
  impact(severity: number): void {
    if (!this.enabled || severity <= 0) return;
    this.pulse(Math.min(severity * 1.2, 1), Math.min(severity, 1), 120 + severity * 380);
  }

  /** Called every frame of a race. */
  update(state: VehicleState, dt: number): void {
    if (!this.enabled) return;
    const grounded = state.wheels.filter((w) => w.grounded);

    // A landing, weighed by how long the car was up: a crest you skim is a
    // tap, a jump you fly is a thump.
    if (grounded.length === 0) {
      this.airborneFor += dt;
    } else {
      if (this.airborneFor > 0.25) {
        const weight = Math.min(this.airborneFor / 1.2, 1);
        this.pulse(weight, weight * 0.6, 90 + weight * 200);
      }
      this.airborneFor = 0;
    }

    // The road, on the pad only.
    this.since += dt;
    if (this.since < TICK || grounded.length === 0) return;
    this.since = 0;
    const pad = this.gamepad.current;
    const actuator = pad?.vibrationActuator;
    if (!actuator) return;
    const speed = Math.abs(state.speed);
    const surface = grounded[0]!.surface.id;
    const slip = Math.max(0, Math.max(...state.wheels.map((w) => w.saturation)) - 1);
    const weak = Math.min(TEXTURE[surface] * Math.min(speed / 28, 1.3) + slip * 0.25, 1);
    const strong = Math.min(slip * 0.18, 0.4);
    if (weak < 0.02 && strong < 0.02) return;
    void actuator
      .playEffect('dual-rumble', {
        duration: TICK * 1000 + 30,
        weakMagnitude: weak,
        strongMagnitude: strong,
      })
      .catch(() => undefined);
  }

  private pulse(strong: number, weak: number, ms: number): void {
    const actuator = this.gamepad.current?.vibrationActuator;
    if (actuator) {
      void actuator
        .playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak })
        .catch(() => undefined);
    } else if (this.phone && typeof navigator.vibrate === 'function') {
      // One motor, on or off: the length is the strength.
      navigator.vibrate(Math.round(ms * (0.4 + strong * 0.6)));
    }
  }
}
