/**
 * Driving every stage to the finish, split three ways.
 *
 * The AI driving whole stages was 95% of the suite — 526 s of `stages.test.ts`
 * and 453 s of `conditions.test.ts` on CI, against about fifty seconds for the
 * other forty-seven files together. Tests inside one file run one after
 * another, so those two files held two cores for nine minutes while the rest
 * of the machine sat idle. The driving now lives here and is registered by
 * `drive-1/2/3.test.ts`, one shard each, which vitest runs side by side: it
 * gives a run `availableParallelism() - 1` workers, three on CI's four cores.
 *
 * The shards are balanced by what a stage costs to drive rather than by how
 * many there are: three laps for the stage and three for each weather variant,
 * each lap about as long as the author time, at a physics cost per step that
 * grows with the solid scenery — measured at roughly 0.4 ms plus 2.7 µs per
 * solid, which is why Red Planet (1 779 solids, the longest lap in the game)
 * costs as much as a dozen small stages. Computed, so a new stage lands in
 * whichever shard is lightest without anybody editing a list.
 *
 * Each stage is driven once for both of its own checks. "Can be driven to the
 * finish" and "keeps the AI mostly on the road" used to call `validateStage`
 * separately, three laps each, for the same answer.
 *
 * This file is not a test file — vitest only collects `*.test.ts` — so
 * `npm run test:quick` leaves it out by excluding the three shards.
 */

import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/data/stages/index.js';
import type { StageDef } from '../src/sim/stage.js';
import { Stage, stageVariants } from '../src/sim/stage.js';
import { type ValidationResult, validateStage } from '../src/sim/runStage.js';

export const SHARDS = 3;

/**
 * What a stage costs to drive, in arbitrary units. Only the ratios matter.
 *
 * Three laps per variant (the base conditions are the first variant), each as
 * long as the author lap, times the per-step physics cost.
 */
function cost(def: StageDef, stage: Stage): number {
  const solids = stage.scenery.filter((item) => item.solid).length;
  const laps = 3 * stageVariants(def).length;
  return laps * def.medals.author * (0.4 + 0.0027 * solids);
}

/** Longest job first onto the lightest shard: deterministic, and close to even. */
function assign(): Stage[][] {
  const stages = STAGES.map((def) => ({ def, stage: new Stage(def) }))
    .map((entry) => ({ ...entry, cost: cost(entry.def, entry.stage) }))
    .sort((a, b) => b.cost - a.cost || a.def.id.localeCompare(b.def.id));
  const shards: { load: number; stages: Stage[] }[] = Array.from({ length: SHARDS }, () => ({
    load: 0,
    stages: [],
  }));
  for (const entry of stages) {
    const lightest = shards.reduce((a, b) => (b.load < a.load ? b : a));
    lightest.load += entry.cost;
    lightest.stages.push(entry.stage);
  }
  return shards.map((shard) => shard.stages);
}

/**
 * How long three laps of one stage may take, ms.
 *
 * From measurement, not from the eye — a budget set by eye is how these went
 * red twice before (see "A timeout nothing enforces" in CLAUDE.md). Red Planet
 * is the most expensive stage to drive and sets it: on CI, with the three
 * shards running side by side, its three laps measured 226 s and its dust-storm
 * variant 257 s; on the 4-core session container, 237 s. Coldwater Pass was
 * 131–141 s and Grand Traverse 91–103 s on the same run. The runner has already
 * been seen to slow by 1.75× overnight with nothing about the game changed, so
 * this is the worst measurement with about 1.6× on top — room for a machine
 * under load, not for a regression. A stage that needs more than this to
 * drive needs the scenery merge (one collider for all of it, measured 7×
 * cheaper per step on Red Planet), not a bigger number.
 */
const DRIVE_BUDGET = 420_000;

/**
 * Register the driving checks for one shard, numbered from 1.
 *
 * With the shared run a stage's two checks wait on one drive, so each still
 * fits one budget.
 */
export function driveShard(index: number): void {
  const mine = assign()[index - 1] ?? [];

  describe.each(mine.map((stage) => [stage.def.name, stage] as const))('%s', (_name, stage) => {
    // Started by whichever of the two checks runs first, awaited by both.
    let drive: Promise<ValidationResult> | null = null;
    const driven = () => (drive ??= validateStage(stage));

    it('can be driven to the finish by the AI', async () => {
      // Best of three driving styles, which is how `npm run stages` measures a
      // stage and the only measure that means anything: the driver is chaotic
      // near its own limit, and a single lap flips between a clean run and one
      // with an off. This test used to take one lap and passed by four tenths of
      // a second, which made it a coin flip dressed as an assertion — and the
      // coin landed the other way the moment the gearbox stopped hunting.
      const result = await driven();
      expect(result.reason).toBeNull();
      expect(result.ok).toBe(true);
      expect(result.time).toBeGreaterThan(10);
      // Conservative, so inside bronze without being anywhere near author pace.
      expect(result.time!).toBeLessThan(stage.def.medals.bronze);
    }, DRIVE_BUDGET);

    it('keeps the AI mostly on the road', async () => {
      const result = await driven();
      expect(result.offRoadFraction).toBeLessThan(0.45);
    }, DRIVE_BUDGET);

    // A variant nobody can finish is not shippable, same bar as a stage.
    for (const variant of stageVariants(stage.def).slice(1)) {
      it(`can be driven in ${variant.name}`, async () => {
        const result = await validateStage(new Stage(stage.def), variant.conditions);
        expect(result.ok, result.reason ?? '').toBe(true);
        expect(result.time!).toBeLessThan(variant.medals.bronze);
      }, DRIVE_BUDGET);
    }
  });
}
