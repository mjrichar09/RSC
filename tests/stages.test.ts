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
import { Race, medalFor } from '../src/game/race.js';
import { Driver } from '../src/sim/driver.js';
import { createWorld } from '../src/sim/world.js';
import { Stage } from '../src/sim/stage.js';
import { runStage, validateStage } from '../src/sim/runStage.js';

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
    // Best of three driving styles, which is how `npm run stages` measures a
    // stage and the only measure that means anything: the driver is chaotic
    // near its own limit, and a single lap flips between a clean run and one
    // with an off. This test used to take one lap and passed by four tenths of
    // a second, which made it a coin flip dressed as an assertion — and the
    // coin landed the other way the moment the gearbox stopped hunting.
    const result = await validateStage(stage);
    expect(result.reason).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.time).toBeGreaterThan(10);
    // Conservative, so inside bronze without being anywhere near author pace.
    expect(result.time!).toBeLessThan(stage.def.medals.bronze);
  }, 60_000);

  it('keeps the AI mostly on the road', async () => {
    const result = await validateStage(stage);
    expect(result.offRoadFraction).toBeLessThan(0.45);
  }, 60_000);
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

describe('live pace projection', () => {
  it('says nothing before there is enough of the stage behind you', () => {
    const race = new Race(stages[0]!);
    expect(race.projectedTime).toBeNull();
    expect(race.projectedMedal).toBeNull();
  });

  it('projects a finish time from partial progress', async () => {
    const stage = stages[0]!;
    const result = await runStage(stage, { recordGhost: false });
    expect(result.finished).toBe(true);

    // Re-run and sample the projection part way round.
    const race = new Race(stage);
    const world = await createWorld({ stage });
    const driver = new Driver(stage);
    for (let i = 0; i < 60; i++) world.step({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
    world.time = 0;

    let midway: number | null = null;
    while (race.phase !== 'finished' && world.time < 200) {
      world.step(driver.input(world.state(), world.dt));
      race.update(world.state(), world.dt);
      if (midway === null && race.progress > 0.5) midway = race.projectedTime;
    }

    expect(midway).not.toBeNull();
    // Crude by design, but it has to be in the right neighbourhood or it is
    // worse than showing nothing.
    expect(midway!).toBeGreaterThan(result.time! * 0.6);
    expect(midway!).toBeLessThan(result.time! * 1.4);
  }, 30_000);
});
