/**
 * Procedural stage generation.
 *
 * Generation is cheap; validation is what makes the output shippable. These
 * check both halves — that a seed always produces the same stage, that the
 * layout constraints hold, and that the drivability net actually catches a
 * stage that cannot be driven.
 */

import { describe, expect, it } from 'vitest';
import { BIOMES, calibrate, generateStage } from '../src/sim/generator.js';
import { validateStage } from '../src/sim/runStage.js';
import { Stage, type StageDef } from '../src/sim/stage.js';

const generate = (seed: number, biome?: string) =>
  generateStage({ seed, ...(biome ? { biome } : {}) });

describe('generation', () => {
  it('is deterministic — a seed always gives the same stage', () => {
    const a = generate(4242)!;
    const b = generate(4242)!;
    expect(a.def.controlPoints).toEqual(b.def.controlPoints);
    expect(a.def.name).toBe(b.def.name);
    expect(a.def.biome).toBe(b.def.biome);
  });

  it('gives different seeds different stages', () => {
    expect(generate(1)!.def.controlPoints).not.toEqual(generate(2)!.def.controlPoints);
  });

  it('spreads across biomes rather than always picking the first', () => {
    // A biased RNG silently produced nothing but forest stages, which looked
    // fine one stage at a time and was obvious across a batch.
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const candidate = generate(seed);
      if (candidate) seen.add(candidate.def.biome);
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  it('honours a requested biome', () => {
    for (const biome of BIOMES) {
      const candidate = generate(77, biome.id)!;
      expect(candidate.def.biome).toBe(biome.id);
      expect(candidate.def.verge).toBe(biome.verge);
    }
  });

  it('produces a stage of a sensible length with checkpoints', () => {
    for (let seed = 10; seed < 20; seed++) {
      const candidate = generate(seed);
      if (!candidate) continue;
      expect(candidate.stage.length).toBeGreaterThan(400);
      expect(candidate.stage.length).toBeLessThan(2000);
      expect(candidate.stage.checkpoints.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('never returns a stage whose corridor runs into itself', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const candidate = generate(seed);
      if (candidate) expect(candidate.stage.selfIntersections()).toEqual([]);
    }
  });

  it('lays camera zones along the stage, in order', () => {
    const candidate = generate(9)!;
    const zones = candidate.def.cameraZones!;
    expect(zones.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < zones.length; i++) {
      expect(zones[i]!.from).toBeGreaterThan(zones[i - 1]!.from);
    }
  });

  it('starts the car on the road', () => {
    const candidate = generate(31)!;
    const here = candidate.stage.progressAt(candidate.stage.start.position);
    expect(here.onRoad).toBe(true);
  });
});

describe('calibration', () => {
  const def = generate(5)!.def;

  it('anchors medals to the measured lap, in order', () => {
    const tuned = calibrate(def, 60, 900);
    expect(tuned.medals.author).toBeLessThan(tuned.medals.gold);
    expect(tuned.medals.gold).toBeLessThan(tuned.medals.silver);
    expect(tuned.medals.silver).toBeLessThan(tuned.medals.bronze);

    // The AI is honest rather than fast, so its time should land around silver,
    // leaving gold and author for a human.
    expect(tuned.medals.silver).toBeLessThanOrEqual(60);
    expect(tuned.medals.bronze).toBeGreaterThan(60);
  });

  it('always pays more than it costs to enter', () => {
    for (const aiTime of [30, 60, 120]) {
      const tuned = calibrate(def, aiTime, 900);
      expect(tuned.payouts.finish).toBeGreaterThan(tuned.entryFee);
      expect(tuned.payouts.author).toBeGreaterThan(tuned.payouts.gold);
    }
  });

  it('pays more for a longer, slower stage', () => {
    expect(calibrate(def, 90, 1400).payouts.gold).toBeGreaterThan(
      calibrate(def, 40, 600).payouts.gold,
    );
  });
});

describe('validation', () => {
  it('accepts a stage the generator produced', async () => {
    const candidate = generate(3)!;
    const result = await validateStage(candidate.stage);
    expect(result.ok).toBe(true);
    expect(result.time).toBeGreaterThan(5);
  }, 60_000);

  it('rejects a stage no car could drive', async () => {
    // A hairpin far tighter than the corridor is wide. The layout constraints
    // would never emit this, which is exactly why the net has to be tested
    // against something built deliberately — otherwise "the validator works"
    // is an assumption rather than a fact.
    const impossible: StageDef = {
      id: 'test-impossible',
      name: 'Impossible',
      biome: 'forest',
      verge: 'grass',
      bank: 'dirt',
      entryFee: 0,
      medals: { author: 1, gold: 2, silver: 3, bronze: 4 },
      payouts: { author: 0, gold: 0, silver: 0, bronze: 0, finish: 0 },
      checkpoints: 2,
      controlPoints: [
        { pos: { x: 0, y: 0, z: 0 }, width: 5, surface: 'gravel' },
        { pos: { x: 0, y: 0, z: 60 }, width: 5, surface: 'gravel' },
        { pos: { x: 6, y: 0, z: 62 }, width: 5, surface: 'gravel' },
        { pos: { x: 2, y: 0, z: 8 }, width: 5, surface: 'gravel' },
        { pos: { x: 8, y: 0, z: 4 }, width: 5, surface: 'gravel' },
        { pos: { x: 10, y: 0, z: 64 }, width: 5, surface: 'gravel' },
      ],
    };

    const result = await validateStage(new Stage(impossible));
    expect(result.ok).toBe(false);
    expect(result.reason).not.toBeNull();
  }, 60_000);
});
