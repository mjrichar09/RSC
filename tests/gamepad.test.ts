/**
 * Gamepad bindings: the rules, without a browser.
 *
 * The failure this exists for is the pedals landing on the shoulder buttons
 * for a pad the browser did not recognise. A pad is only a list of numbers, so
 * the rules can be fed one directly.
 */

import { describe, expect, it } from 'vitest';
import {
  STANDARD_BINDINGS,
  cleanBindings,
  defaultBindings,
  readBinding,
} from '../src/ui/gamepad.js';

const pad = (mapping: GamepadMappingType, axes: number[], buttons: number[] = []): Gamepad =>
  ({
    id: 'test pad',
    index: 0,
    connected: true,
    mapping,
    axes,
    buttons: buttons.map((value) => ({ value, pressed: value > 0.5, touched: value > 0 })),
    timestamp: 0,
    hapticActuators: [],
    vibrationActuator: null,
  }) as unknown as Gamepad;

describe('default bindings', () => {
  it('puts the pedals on the triggers of a standard pad', () => {
    const b = defaultBindings(pad('standard', [0, 0, 0, 0]));
    expect(b.throttle).toEqual({ kind: 'button', index: 7 });
    expect(b.brake).toEqual({ kind: 'button', index: 6 });
  });

  it('finds triggers reported as axes resting at -1 on an unrecognised pad', () => {
    // The Firefox-on-Linux shape of an Xbox pad: sticks on 0/1 and 3/4,
    // triggers on 2 and 5, both at rest at -1.
    const b = defaultBindings(pad('', [0, 0, -1, 0, 0, -1]));
    expect(b.brake).toEqual({ kind: 'axis', index: 2, from: -1, to: 1 });
    expect(b.throttle).toEqual({ kind: 'axis', index: 5, from: -1, to: 1 });
  });

  it('falls back to the standard table when nothing looks like a trigger', () => {
    expect(defaultBindings(pad('', [0, 0, 0, 0]))).toEqual(STANDARD_BINDINGS);
  });
});

describe('reading a binding', () => {
  it('maps a trigger axis from rest to full onto 0..1', () => {
    const b = { kind: 'axis', index: 2, from: -1, to: 1 } as const;
    expect(readBinding(pad('', [0, 0, -1]), b)).toBe(0);
    expect(readBinding(pad('', [0, 0, 0]), b)).toBe(0.5);
    expect(readBinding(pad('', [0, 0, 1]), b)).toBe(1);
  });

  it('keeps a steering axis signed, and inverted when bound pushing the other way', () => {
    const right = { kind: 'axis', index: 0, from: 0, to: 1 } as const;
    const flipped = { kind: 'axis', index: 0, from: 0, to: -1 } as const;
    expect(readBinding(pad('', [-0.5]), right, true)).toBe(-0.5);
    expect(readBinding(pad('', [-0.5]), flipped, true)).toBe(0.5);
  });

  it('reads an analogue button as its travel', () => {
    expect(readBinding(pad('standard', [], [0, 0, 0, 0, 0, 0, 0, 0.3]), { kind: 'button', index: 7 })).toBe(0.3);
  });
});

describe('stored bindings', () => {
  it('keeps what is a binding and drops what is not', () => {
    const cleaned = cleanBindings({
      throttle: { kind: 'axis', index: 5, from: -1, to: 1 },
      brake: { kind: 'button', index: 'six' },
      handbrake: { kind: 'axis', index: 2, from: 0, to: 0 },
      restart: { kind: 'button', index: 3 },
      nonsense: { kind: 'button', index: 1 },
    });
    expect(cleaned).toEqual({
      throttle: { kind: 'axis', index: 5, from: -1, to: 1 },
      restart: { kind: 'button', index: 3 },
    });
  });

  it('survives something that is not an object at all', () => {
    expect(cleanBindings(null)).toEqual({});
    expect(cleanBindings('RT')).toEqual({});
  });
});
