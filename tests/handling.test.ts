/**
 * Handling regression suite.
 *
 * These are deliberately broad bands, not golden numbers: the point is to catch
 * "the car silently got 40% slower / stopped turning / started flipping" after a
 * refactor, without failing every time a tuning value is intentionally nudged.
 * Tighten a band only when the value it guards is meant to be stable.
 */

import { describe, expect, it } from 'vitest';
import { TRACES } from '../src/sim/trace.js';
import { runTrace } from '../src/sim/run.js';

describe('straight-line performance', () => {
  it('accelerates like a rally car and holds a straight line', async () => {
    const { summary } = await runTrace(TRACES.launch!);

    expect(summary.zeroToHundred).not.toBeNull();
    expect(summary.zeroToHundred!).toBeGreaterThan(3);
    expect(summary.zeroToHundred!).toBeLessThan(8);
    expect(summary.topSpeedKph).toBeGreaterThan(120);
    expect(summary.topSpeedKph).toBeLessThan(230);

    // No steering input, so any meaningful lateral drift is a bug in the
    // suspension or tire force application.
    expect(Math.abs(summary.finalPosition.x)).toBeLessThan(1);
    expect(summary.distance).toBeGreaterThan(150);
  });

  it('keeps the car on its wheels at a sane ride height', async () => {
    const { recorder } = await runTrace(TRACES.launch!);
    for (const s of recorder.samples) {
      expect(s.y).toBeGreaterThan(0.4);
      expect(s.y).toBeLessThan(2.0);
    }
  });

  it('stops under braking', async () => {
    const { recorder } = await runTrace(TRACES.brake!);
    const last = recorder.samples.at(-1)!;
    expect(Math.abs(last.speed)).toBeLessThan(1.5);
  });
});

describe('cornering', () => {
  it('actually turns, and turns toward the steering input', async () => {
    const { summary } = await runTrace(TRACES.circle!);
    // The circle trace steers right (+), so the car must end up at +x.
    expect(summary.finalPosition.x).toBeGreaterThan(10);
  });

  it('rotates the car well past straight during a handbrake turn', async () => {
    const { summary } = await runTrace(TRACES.handbrake!);
    expect(summary.maxDriftDeg).toBeGreaterThan(25);
  });

  it('returns to grip after the slide rather than spinning out', async () => {
    const { recorder } = await runTrace(TRACES.handbrake!);
    const settled = recorder.samples.at(-1)!;
    // Power-on exit: by the end the car should be tracking roughly forward again.
    expect(settled.drift).toBeLessThan(30);
    expect(settled.speed).toBeGreaterThan(3);
  });
});

describe('surfaces', () => {
  it('gives less grip and less speed as the surface gets looser', async () => {
    const tarmac = await runTrace(TRACES.launch!, { baseSurface: 'tarmac' });
    const gravel = await runTrace(TRACES.launch!, { baseSurface: 'gravel' });
    const ice = await runTrace(TRACES.launch!, { baseSurface: 'ice' });

    expect(gravel.summary.distance).toBeLessThan(tarmac.summary.distance);
    expect(ice.summary.distance).toBeLessThan(gravel.summary.distance);
  });

  it('makes loose surfaces slide more under the same cornering input', async () => {
    const tarmac = await runTrace(TRACES.circle!, { baseSurface: 'tarmac' });
    const ice = await runTrace(TRACES.circle!, { baseSurface: 'ice' });
    expect(ice.summary.timeSliding).toBeGreaterThan(0);
    expect(ice.summary.topSpeedKph).toBeLessThan(tarmac.summary.topSpeedKph);
  });
});

describe('simulation integrity', () => {
  it('runs the expected number of fixed steps for a trace duration', async () => {
    const { summary } = await runTrace(TRACES.launch!);
    // 10 s at 120 Hz, give or take the final partial step.
    expect(summary.steps).toBeGreaterThanOrEqual(1199);
    expect(summary.steps).toBeLessThanOrEqual(1201);
  });

  it('never produces a non-finite value', async () => {
    const { recorder } = await runTrace(TRACES.slalom!);
    for (const s of recorder.samples) {
      for (const [k, v] of Object.entries(s)) {
        expect(Number.isFinite(v), `${k} was ${v}`).toBe(true);
      }
    }
  });

  it('is reproducible: the same trace twice gives the same result', async () => {
    const a = await runTrace(TRACES.slalom!);
    const b = await runTrace(TRACES.slalom!);
    expect(b.summary.distance).toBeCloseTo(a.summary.distance, 3);
    expect(b.summary.finalPosition.x).toBeCloseTo(a.summary.finalPosition.x, 3);
  });
});
