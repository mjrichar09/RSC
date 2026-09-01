/**
 * The adaptive render scale.
 *
 * Pure arithmetic, and worth pinning because the failure modes are both
 * invisible in a screenshot: a scaler that reacts to a single slow frame
 * spends the whole race oscillating, and one that never recovers leaves a
 * phone at half resolution forever after one stutter on a stage load.
 */

import { describe, expect, it } from 'vitest';
import { RenderScale, guessTier, qualityFor } from '../src/render/quality.js';

/** Feed it `seconds` of frames at a steady rate. Returns how often it moved. */
function run(scale: RenderScale, fps: number, seconds: number): number {
  const dt = 1 / fps;
  let changes = 0;
  for (let t = 0; t < seconds; t += dt) if (scale.update(dt)) changes++;
  return changes;
}

describe('render scale', () => {
  it('gives up pixels when the frame rate will not hold', () => {
    const scale = new RenderScale();
    run(scale, 30, 10);
    expect(scale.value).toBeLessThan(1);
    // And never below half: past that the game is a smear and the frame rate
    // was never the problem.
    expect(scale.value).toBeGreaterThanOrEqual(0.5);
  });

  it('ignores one bad second', () => {
    const scale = new RenderScale();
    run(scale, 60, 4);
    run(scale, 20, 1);
    expect(scale.value).toBe(1);
  });

  it('takes pixels back when the machine can afford them', () => {
    const scale = new RenderScale();
    run(scale, 30, 12);
    const dropped = scale.value;
    expect(dropped).toBeLessThan(1);
    run(scale, 60, 40);
    expect(scale.value).toBeGreaterThan(dropped);
  });

  it('does not flap between two values', () => {
    const scale = new RenderScale();
    // Sitting exactly between the floor and the ceiling is the case that makes
    // a naive scaler oscillate once a second forever.
    const changes = run(scale, 50, 30);
    expect(changes).toBe(0);
    expect(scale.value).toBe(1);
  });
});

describe('quality tiers', () => {
  it('turns off the expensive things at the bottom tier', () => {
    const low = qualityFor('low');
    // The shadow pass is the single biggest cost in the frame and the least
    // missed on a five-inch screen.
    expect(low.shadowMap).toBe(0);
    expect(low.vision).toBe(false);
    expect(low.maxPixelRatio).toBeLessThan(qualityFor('high').maxPixelRatio);
  });

  it('guesses a tier without a window', () => {
    // The headless tools import the renderer's module graph; this must not
    // throw when there is no `window` to ask.
    expect(guessTier()).toBe('high');
  });
});
