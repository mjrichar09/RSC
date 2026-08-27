/**
 * Deterministic input traces.
 *
 * Every automated check — unit tests, telemetry runs, screenshot composites —
 * drives the car from one of these instead of from a human. Two runs of the
 * same trace are directly comparable, which is what lets a handling regression
 * show up as a number rather than as "it feels different now".
 */

import type { DriverInput } from './input.js';

export interface TraceSegment {
  /** Seconds this segment lasts. */
  duration: number;
  input: Partial<DriverInput>;
}

export interface Trace {
  readonly name: string;
  readonly description: string;
  readonly segments: readonly TraceSegment[];
}

export function traceDuration(trace: Trace): number {
  return trace.segments.reduce((s, seg) => s + seg.duration, 0);
}

/** Input at time `t` seconds into the trace. Past the end, everything releases. */
export function sampleTrace(trace: Trace, t: number): DriverInput {
  let acc = 0;
  for (const seg of trace.segments) {
    acc += seg.duration;
    if (t < acc) {
      return { throttle: 0, brake: 0, steer: 0, handbrake: 0, ...seg.input };
    }
  }
  return { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
}

const seg = (duration: number, input: Partial<DriverInput>): TraceSegment => ({ duration, input });

export const TRACES: Record<string, Trace> = {
  launch: {
    name: 'launch',
    description: 'Standing start, full throttle in a straight line for 10s.',
    segments: [seg(10, { throttle: 1 })],
  },

  brake: {
    name: 'brake',
    description: 'Accelerate for 6s, then full brakes to a stop.',
    segments: [seg(6, { throttle: 1 }), seg(6, { brake: 1 })],
  },

  slalom: {
    name: 'slalom',
    description: 'Power on, alternating full lock. Exposes weight transfer and roll.',
    segments: [
      seg(3, { throttle: 1 }),
      seg(1.4, { throttle: 0.8, steer: -1 }),
      seg(1.4, { throttle: 0.8, steer: 1 }),
      seg(1.4, { throttle: 0.8, steer: -1 }),
      seg(1.4, { throttle: 0.8, steer: 1 }),
      seg(2, { throttle: 0.8 }),
    ],
  },

  handbrake: {
    name: 'handbrake',
    description: 'Build speed, then a lifted handbrake turn and a power-on exit.',
    segments: [
      seg(4, { throttle: 1 }),
      seg(0.9, { steer: -0.9, handbrake: 1 }),
      seg(1.6, { throttle: 0.9, steer: -0.5 }),
      seg(2, { throttle: 1, steer: -0.1 }),
    ],
  },

  catch: {
    name: 'catch',
    description:
      'Provoke a slide with the handbrake, then counter-steer and power out. ' +
      'Tests whether a slide is recoverable — the difference between a car that ' +
      'is exciting and one that is just punishing.',
    segments: [
      seg(4, { throttle: 1 }),
      seg(0.7, { steer: -0.85, handbrake: 1 }),
      // Opposite lock plus throttle: the classic catch.
      seg(1.6, { throttle: 0.75, steer: 0.85 }),
      seg(1.2, { throttle: 0.9, steer: 0.2 }),
      seg(1.5, { throttle: 1 }),
      // Ease off to let it settle. On full power the car sits at a small drift
      // angle by design, so measuring recovery needs a lift first.
      seg(1.5, { throttle: 0.45 }),
    ],
  },

  circle: {
    name: 'circle',
    description: 'Constant-radius cornering — the steady-state grip benchmark.',
    segments: [seg(2, { throttle: 1 }), seg(10, { throttle: 0.55, steer: 0.6 })],
  },
};

export const traceNames = (): string[] => Object.keys(TRACES);
