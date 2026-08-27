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

  it('stops under braking, then reverses if the brake is held', async () => {
    const { recorder } = await runTrace(TRACES.brake!);
    const braking = recorder.samples.filter((s) => s.t > 6);

    // It has to actually come to a stop...
    const slowest = Math.min(...braking.map((s) => Math.abs(s.speed)));
    expect(slowest).toBeLessThan(1);

    // ...and then reverse out, which is the arcade convention: at a standstill
    // the brake becomes reverse. Holding it must not just pin the car in place.
    const last = recorder.samples.at(-1)!;
    expect(last.speed).toBeLessThan(-1);
  });

  it('does not snap into reverse the instant the car stops', async () => {
    const { recorder } = await runTrace(TRACES.brake!);
    // Find the moment the car first stops, and check it stays stopped briefly
    // rather than immediately rolling backwards.
    const stop = recorder.samples.find((s) => s.t > 6 && Math.abs(s.speed) < 0.5);
    expect(stop).toBeDefined();
    const justAfter = recorder.samples.find((s) => s.t > stop!.t + 0.3);
    expect(Math.abs(justAfter!.speed)).toBeLessThan(2);
  });
});

describe('cornering', () => {
  it('actually turns, and turns toward the steering input', async () => {
    const { recorder } = await runTrace(TRACES.circle!);
    // Sample once the car has settled into the corner.
    const cornering = recorder.samples.filter((s) => s.t > 4);
    const meanYaw = cornering.reduce((a, s) => a + s.yawRate, 0) / cornering.length;
    const meanRadius = cornering.reduce((a, s) => a + s.turnRadius, 0) / cornering.length;

    // The circle trace steers right, which is a positive yaw rate. Asserting on
    // yaw rather than final position keeps this honest now that the car corners
    // tightly enough to come back around on itself.
    expect(meanYaw).toBeGreaterThan(5);
    expect(meanRadius).toBeLessThan(120);
  });

  it('rotates the car well past straight during a handbrake turn', async () => {
    const { summary } = await runTrace(TRACES.handbrake!);
    expect(summary.maxDriftDeg).toBeGreaterThan(25);
  });

  it('lets a provoked slide be caught with opposite lock', async () => {
    const { summary, recorder } = await runTrace(TRACES.catch!);

    // It has to actually slide, or the test proves nothing.
    expect(summary.maxDriftDeg).toBeGreaterThan(30);

    // ...and then come back. A car you cannot catch is punishing, not exciting.
    const settled = recorder.samples.at(-1)!;
    expect(settled.drift).toBeLessThan(15);
    expect(Math.abs(settled.speed)).toBeGreaterThan(10);
  });

  it('does not spin all the way round under a normal handbrake pull', async () => {
    const { summary } = await runTrace(TRACES.handbrake!);
    // Past ~150° the car has swapped ends, which is a loss of control rather
    // than a rally slide.
    expect(summary.maxDriftDeg).toBeLessThan(150);
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
  it('sustains more than 0.9g of lateral grip on tarmac', async () => {
    const { recorder } = await runTrace(TRACES.circle!);
    const cornering = recorder.samples.filter((s) => s.t > 4);
    const peakG = Math.max(
      ...cornering.map((s) => Math.abs((s.speed * s.yawRate * Math.PI) / 180) / 9.81),
    );
    // Guards against the whole class of bug that made the car corner on two
    // wheels at 0.67g: any regression in suspension, anti-roll or tire load
    // handling shows up here first.
    expect(peakG).toBeGreaterThan(0.9);
  });

  it('keeps all four wheels on the ground through a hard corner', async () => {
    const { recorder } = await runTrace(TRACES.circle!);
    for (const s of recorder.samples.filter((x) => x.t > 4)) {
      expect(s.wheelsGrounded).toBe(4);
    }
  });

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

describe('determinism with a damaged car', () => {
  /** A seeded stream, so "reproducible" means the same numbers, not luck. */
  const seeded = () => {
    let a = 12345;
    return () => {
      a = (a * 1664525 + 1013904223) >>> 0;
      return a / 4294967296;
    };
  };

  it('gives the same run twice with a failing gearbox', async () => {
    // A damaged gearbox refuses shifts at random. Drawing that from
    // `Math.random` rather than the model's injected stream made headless runs
    // silently irreproducible — and only for a damaged car, so every existing
    // determinism test still passed.
    const options = {
      damage: { random: seeded() },
      damageTo: { transmission: 0.35, engine: 0.4 },
    };

    const a = await runTrace(TRACES.launch!, { ...options, damage: { random: seeded() } });
    const b = await runTrace(TRACES.launch!, { ...options, damage: { random: seeded() } });

    expect(b.summary.distance).toBeCloseTo(a.summary.distance, 6);
    expect(b.summary.topSpeedKph).toBeCloseTo(a.summary.topSpeedKph, 6);
    expect(b.summary.finalPosition.z).toBeCloseTo(a.summary.finalPosition.z, 6);
  });

  it('is meaningfully slower with a damaged engine and gearbox', async () => {
    const healthy = await runTrace(TRACES.launch!);
    const sick = await runTrace(TRACES.launch!, {
      damage: { random: seeded() },
      damageTo: { transmission: 0.35, engine: 0.4 },
    });
    expect(sick.summary.distance).toBeLessThan(healthy.summary.distance * 0.95);
  });
});
