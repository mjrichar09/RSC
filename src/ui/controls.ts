/**
 * Keyboard and gamepad input, mapped onto the sim's `DriverInput`.
 *
 * Analogue steering matters a lot for this game, so keyboard steering is
 * ramped rather than binary — a digital ±1 makes the car feel broken on
 * loose surfaces regardless of how good the tire model is.
 */

import type { DriverInput } from '../sim/input.js';
import { isTyping } from './typing.js';
import { clamp, moveToward } from '../sim/math.js';
import type { GamepadInput } from './gamepad.js';

const KEY_STEER_RATE = 3.2;
const KEY_STEER_RETURN = 5.5;
/** Pedal travel per second on a keyboard: ~0.4 s to full, released twice as fast. */
const KEY_BRAKE_RATE = 2.6;
const KEY_BRAKE_RELEASE = 6.0;

export class Controls {
  private readonly held = new Set<string>();
  private keySteer = 0;
  /** Fires when the player asks for a restart. */
  onReset: (() => void) | null = null;
  /** Fires on the tuning-panel toggle key. */
  onToggleTuning: (() => void) | null = null;
  /** Fires with a zero-based index when a stage-select key is pressed. */
  onSelectStage: ((index: number) => void) | null = null;
  /** Fires on the manual rescue key. */
  onRescue: (() => void) | null = null;
  /** Fires on the garage toggle key. */
  onGarage: (() => void) | null = null;
  /** Fires on the mute key. */
  onMute: (() => void) | null = null;
  /** Cycle the windscreen effect through its settings. */
  onVision: (() => void) | null = null;
  /** Cycle the crash cinematic — including all the way off. */
  onDrama: (() => void) | null = null;
  /** Fires on the multiplayer lobby key. */
  onMultiplayer: (() => void) | null = null;
  /** Fires on the photo-mode key. */
  onPhoto: (() => void) | null = null;

  /** The pad, when one is wired in. Its bindings and menu handling live there. */
  gamepad: GamepadInput | null = null;

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.repeat) return;
      // Not while there is a text field with the caret in it. Every action
      // below is a bare letter or digit, so typing a room code drove the game:
      // `RMX-2XU` restarted the run, muted the sound and jumped to a stage.
      if (isTyping()) return;
      this.held.add(ev.code);
      if (ev.code === 'KeyR' || ev.code === 'Enter') this.onReset?.();
      if (ev.code === 'KeyT') this.onToggleTuning?.();
      if (ev.code === 'KeyQ') this.onRescue?.();
      if (ev.code === 'KeyM') this.onMute?.();
      if (ev.code === 'KeyV') this.onVision?.();
      if (ev.code === 'KeyK') this.onDrama?.();
      if (ev.code === 'KeyN') this.onMultiplayer?.();
      if (ev.code === 'KeyP') this.onPhoto?.();
      if (ev.code === 'Escape' || ev.code === 'Tab') {
        ev.preventDefault();
        this.onGarage?.();
      }
      if (/^Digit[1-9]$/.test(ev.code)) this.onSelectStage?.(Number(ev.code.slice(5)) - 1);
      if (ev.code === 'Space' || ev.code.startsWith('Arrow')) ev.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.held.delete((e as KeyboardEvent).code));
    target.addEventListener('blur', () => this.held.clear());
  }

  private keyBrake = 0;

  private down(...codes: string[]): boolean {
    return codes.some((c) => this.held.has(c));
  }

  sample(dt: number): DriverInput {
    let throttle = this.down('KeyW', 'ArrowUp') ? 1 : 0;
    // The brake ramps like the steering does, and for the same reason: with a
    // digital pedal every keyboard stop locks all four wheels, so threshold
    // braking — the thing the tyre model now rewards — would be unreachable
    // without a gamepad.
    this.keyBrake = moveToward(
      this.keyBrake,
      this.down('KeyS', 'ArrowDown') ? 1 : 0,
      (this.down('KeyS', 'ArrowDown') ? KEY_BRAKE_RATE : KEY_BRAKE_RELEASE) * dt,
    );
    let brake = this.keyBrake;
    let handbrake = this.down('Space') ? 1 : 0;

    const left = this.down('KeyA', 'ArrowLeft');
    const right = this.down('KeyD', 'ArrowRight');
    const wanted = (right ? 1 : 0) - (left ? 1 : 0);
    const rate = wanted === 0 ? KEY_STEER_RETURN : KEY_STEER_RATE;
    this.keySteer = moveToward(this.keySteer, wanted, rate * dt);
    let steer = this.keySteer;

    const pad = this.gamepad?.driving();
    if (pad) {
      throttle = Math.max(throttle, pad.throttle);
      brake = Math.max(brake, pad.brake);
      handbrake = Math.max(handbrake, pad.handbrake);
      if (pad.steer !== 0) steer = pad.steer;
    }

    return {
      throttle: clamp(throttle, 0, 1),
      brake: clamp(brake, 0, 1),
      steer: clamp(steer, -1, 1),
      handbrake: clamp(handbrake, 0, 1),
    };
  }
}
