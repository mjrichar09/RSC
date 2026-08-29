import { describe, expect, it } from 'vitest';
import { ImpactDrama } from '../src/game/drama.js';

describe('crash cinematic', () => {
  it('ignores a bump', () => {
    const drama = new ImpactDrama();
    expect(drama.hit(6000)).toBe(false);
    expect(drama.timeScale).toBe(1);
    expect(drama.duck).toBe(0);
  });

  it('slows the world on a real hit and lets it back up', () => {
    const drama = new ImpactDrama();
    expect(drama.hit(36_000)).toBe(true);
    expect(drama.timeScale).toBeLessThan(0.5);
    expect(drama.duck).toBeGreaterThan(0.8);

    // Eased back rather than released in one step.
    const scales: number[] = [];
    for (let i = 0; i < 40; i++) {
      drama.update(1 / 60);
      scales.push(drama.timeScale);
    }
    for (let i = 1; i < scales.length; i++) expect(scales[i]!).toBeGreaterThanOrEqual(scales[i - 1]!);
    expect(drama.timeScale).toBe(1);
    expect(drama.active).toBe(false);
  });

  it('is completely inert at zero strength', () => {
    const drama = new ImpactDrama(0);
    expect(drama.hit(60_000)).toBe(false);
    expect(drama.timeScale).toBe(1);
    expect(drama.duck).toBe(0);
    expect(drama.active).toBe(false);
  });

  it('will not let a car grinding a wall hold the world in slow motion', () => {
    const drama = new ImpactDrama();
    drama.hit(36_000);
    drama.update(0.2);
    const before = drama.timeScale;
    // A second, weaker hit during the effect neither extends nor deepens it.
    expect(drama.hit(16_000)).toBe(false);
    expect(drama.timeScale).toBe(before);
  });

  it('lets a harder hit take over', () => {
    const drama = new ImpactDrama();
    drama.hit(18_000);
    drama.update(0.1);
    expect(drama.hit(36_000)).toBe(true);
    expect(drama.timeScale).toBeLessThan(0.5);
  });

  it('reset returns the clock immediately', () => {
    const drama = new ImpactDrama();
    drama.hit(36_000);
    drama.reset();
    expect(drama.timeScale).toBe(1);
    expect(drama.duck).toBe(0);
  });
});
