/**
 * Keyboard and gamepad input, mapped onto the sim's `DriverInput`.
 *
 * Analogue steering matters a lot for this game, so keyboard steering is
 * ramped rather than binary — a digital ±1 makes the car feel broken on
 * loose surfaces regardless of how good the tire model is.
 */

import type { DriverInput } from '../sim/input.js';
import { clamp, moveToward } from '../sim/math.js';

const KEY_STEER_RATE = 3.2;
const KEY_STEER_RETURN = 5.5;
const DEADZONE = 0.12;

const applyDeadzone = (v: number): number =>
  Math.abs(v) < DEADZONE ? 0 : Math.sign(v) * ((Math.abs(v) - DEADZONE) / (1 - DEADZONE));

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

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.repeat) return;
      this.held.add(ev.code);
      if (ev.code === 'KeyR' || ev.code === 'Enter') this.onReset?.();
      if (ev.code === 'KeyT') this.onToggleTuning?.();
      if (ev.code === 'KeyQ') this.onRescue?.();
      if (ev.code === 'KeyM') this.onMute?.();
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

  private down(...codes: string[]): boolean {
    return codes.some((c) => this.held.has(c));
  }

  sample(dt: number): DriverInput {
    const pad = navigator.getGamepads?.().find((p) => p !== null) ?? null;

    let throttle = this.down('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = this.down('KeyS', 'ArrowDown') ? 1 : 0;
    let handbrake = this.down('Space') ? 1 : 0;

    const left = this.down('KeyA', 'ArrowLeft');
    const right = this.down('KeyD', 'ArrowRight');
    const wanted = (right ? 1 : 0) - (left ? 1 : 0);
    const rate = wanted === 0 ? KEY_STEER_RETURN : KEY_STEER_RATE;
    this.keySteer = moveToward(this.keySteer, wanted, rate * dt);
    let steer = this.keySteer;

    if (pad) {
      // Standard mapping: triggers on axes 6/7 for some pads, buttons 6/7 for others.
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      handbrake = Math.max(handbrake, pad.buttons[0]?.value ?? 0);
      const stick = applyDeadzone(pad.axes[0] ?? 0);
      if (stick !== 0) steer = stick;
      if (pad.buttons[9]?.pressed) this.onReset?.();
    }

    return {
      throttle: clamp(throttle, 0, 1),
      brake: clamp(brake, 0, 1),
      steer: clamp(steer, -1, 1),
      handbrake: clamp(handbrake, 0, 1),
    };
  }
}
