/**
 * Deterministic input traces.
 *
 * Every automated check — unit tests, telemetry runs, screenshot composites —
 * drives the car from one of these instead of from a human. Two runs of the
 * same trace are directly comparable, which is what lets a handling regression
 * show up as a number rather than as "it feels different now".
 */

import { clamp } from './math.js';
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
  /**
   * A closed-loop driver, for traces that ask a question an open-loop input
   * cannot answer.
   *
   * "Can this car hold a drift" is one of them: with fixed inputs the answer
   * depends on whether the recorded steer angle happens to suit the car, so
   * changing the tuning changes what the trace is testing. Given the drift
   * angle and the yaw rate, this steers the way a driver would — and then the
   * measurement is about the car.
   */
  readonly drive?: (t: number, state: TraceState) => Partial<DriverInput>;
}

/** What a closed-loop trace gets to look at. Deliberately very little. */
export interface TraceState {
  /** Degrees between the nose and the direction of travel; signed. */
  drift: number;
  /** Degrees per second, positive turning right. */
  yawRate: number;
  /** Metres per second along the nose. */
  speed: number;
}

export function traceDuration(trace: Trace): number {
  return trace.segments.reduce((s, seg) => s + seg.duration, 0);
}

/** Input at time `t` seconds into the trace. Past the end, everything releases. */
export function sampleTrace(trace: Trace, t: number, state?: TraceState): DriverInput {
  if (trace.drive && state) {
    return { throttle: 0, brake: 0, steer: 0, handbrake: 0, ...trace.drive(t, state) };
  }
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

  stops: {
    // Five cycles is what fits: the proving ground is 400 m from the spawn to
    // its edge, and a trace that drives off it measures a fall, not the brakes.
    name: 'stops',
    description: 'Five accelerate-and-stop cycles at threshold pressure, for brake temperature.',
    // A third of the pedal, not all of it: past about 0.42 at these speeds
    // every wheel locks, and a locked disc turns no work into heat at all. The
    // trace that measures brake temperature has to be one that keeps the discs
    // turning — which is also the fastest way to stop.
    segments: Array.from({ length: 5 }, () => [seg(3, { throttle: 1 }), seg(2.4, { brake: 0.35 })]).flat(),
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

  /**
   * Held sideways, then swapped, by a driver rather than by a recording.
   *
   * Closed-loop on purpose. With fixed inputs the answer depends on whether
   * the recorded steer angle happens to suit the car, so changing the tuning
   * changes what the trace is testing — and every tuning A/B then measures the
   * trace instead of the car. This one counter-steers proportionally to how
   * far past the target the car has gone, the way a person does, and the
   * target flips sign twice so the transitions are in the measurement.
   */
  drift: {
    name: 'drift',
    description:
      'A driver holding a drift, then swapping it, twice. Says whether the car ' +
      'can be driven sideways on purpose: a slide you can only survive is not a ' +
      'drift, and a drift you cannot swap out of cannot be chained.',
    segments: [seg(16, {})],
    drive: (t, state) => {
      if (t < 3) return { throttle: 1 };
      // Provoke once, on the handbrake, and never again — everything after
      // this has to come from the throttle and the steering.
      if (t < 3.5) return { throttle: 0.6, steer: -0.8, handbrake: 1 };

      // Thirty degrees, swapping sides every three and a half seconds.
      const phase = Math.floor((t - 3.5) / 3.5) % 2;
      const target = phase === 0 ? -30 : 30;
      const error = target - state.drift;
      // Counter-steer opposes the slide, so it works against the error; the
      // yaw-rate term is the damping a driver applies without thinking about
      // it, and without it this oscillates rather than settling.
      const steer = clamp(-error * 0.055 - state.yawRate * 0.012, -1, 1);
      // More throttle the further short of the angle it is: once the handbrake
      // has let go, throttle is what holds it out.
      const want = Math.min(Math.abs(state.drift) / Math.abs(target), 1);
      return { throttle: 0.55 + (1 - want) * 0.45, steer };
    },
  },

  circle: {
    name: 'circle',
    description: 'Constant-radius cornering — the steady-state grip benchmark.',
    segments: [seg(2, { throttle: 1 }), seg(10, { throttle: 0.55, steer: 0.6 })],
  },
};

export const traceNames = (): string[] => Object.keys(TRACES);
