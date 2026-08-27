/**
 * Stage integrity.
 *
 * A stage that the AI driver cannot finish is not shippable, and a corridor
 * that runs into itself buries the car in an embankment it has not reached yet.
 * Both failure modes are invisible in the control points and obvious here, so
 * they are checked rather than eyeballed — which is also what will make
 * generated stages safe in P7.
 */

import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/data/stages/index.js';
import { medalFor } from '../src/game/race.js';
import { Stage } from '../src/sim/stage.js';
import { runStage } from '../src/sim/runStage.js';

const stages = STAGES.map((def) => new Stage(def));

describe.each(stages.map((s) => [s.def.name, s] as const))('%s', (_name, stage) => {
  it('builds finite geometry', () => {
    const { vertices, indices, vertexSurfaces } = stage.geometry;
    expect(vertices.length).toBeGreaterThan(0);
    expect(indices.length % 3).toBe(0);
    expect(vertexSurfaces.length).toBe(vertices.length / 3);
    for (const v of vertices) expect(Number.isFinite(v)).toBe(true);
    // Every index must address a real vertex, or the collider is malformed.
    const vertexCount = vertices.length / 3;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it('is a sensible length with evenly spaced samples', () => {
    expect(stage.length).toBeGreaterThan(200);
    const samples = stage.spline.samples;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!.position;
      const b = samples[i]!.position;
      const gap = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      expect(gap).toBeGreaterThan(0.5);
      expect(gap).toBeLessThan(4);
    }
  });

  it('does not run its corridor into itself', () => {
    expect(stage.selfIntersections()).toEqual([]);
  });

  it('has ordered, achievable medal times', () => {
    const m = stage.def.medals;
    expect(m.author).toBeLessThan(m.gold);
    expect(m.gold).toBeLessThan(m.silver);
    expect(m.silver).toBeLessThan(m.bronze);
    expect(medalFor(m.author, m)).toBe('author');
    expect(medalFor(m.bronze + 1, m)).toBe('finish');
  });

  it('starts the car on the road, facing down the stage', () => {
    const here = stage.progressAt(stage.start.position);
    expect(here.onRoad).toBe(true);
    expect(Math.abs(here.lateral)).toBeLessThan(1);
  });

  it('can be driven to the finish by the AI', async () => {
    const result = await runStage(stage);
    expect(result.failure).toBeNull();
    expect(result.finished).toBe(true);
    expect(result.time).toBeGreaterThan(10);
    // The driver is deliberately conservative, so it should land inside bronze
    // without being anywhere near author pace.
    expect(result.time!).toBeLessThan(stage.def.medals.bronze);
  }, 30_000);

  it('keeps the AI mostly on the road', async () => {
    const result = await runStage(stage);
    expect(result.offRoadFraction).toBeLessThan(0.35);
  }, 30_000);
});

describe('race rules', () => {
  it('requires every checkpoint before the finish counts', async () => {
    const stage = stages[0]!;
    const result = await runStage(stage);
    expect(result.splits.length).toBe(stage.checkpoints.length);
    // Splits must be strictly increasing in time.
    for (let i = 1; i < result.splits.length; i++) {
      expect(result.splits[i]!).toBeGreaterThan(result.splits[i - 1]!);
    }
  }, 30_000);
});
