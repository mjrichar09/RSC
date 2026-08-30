/**
 * Stage validator and medal calibrator.
 *
 *   npm run stages
 *   npm run stages -- --stage=quarry-run --grip=0.8
 *
 * Drives every stage with the AI driver and reports whether it is completable,
 * how long it takes, and how much of the run is spent off the road. A stage the
 * driver cannot finish is not shippable, and its time is the anchor the medal
 * thresholds are set against.
 */

import { STAGES, stageById } from '../src/data/stages/index.js';
import { medalFor } from '../src/game/race.js';
import { visibilityPenalty } from '../src/sim/conditions.js';
import { runStage, validateStage } from '../src/sim/runStage.js';
import { Stage, stageVariants } from '../src/sim/stage.js';
import type { VehicleTuning } from '../src/data/tuning.js';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=');
}

/**
 * `--set=yawDamping=1900,slideGripFloor=0.8` overrides tuning for this run.
 *
 * This was documented and not implemented, which quietly made every "the AI
 * still gets round with the new handling" check meaningless — it drove the
 * committed tuning and reported the committed times.
 */
const overrides: Partial<VehicleTuning> = {};
for (const entry of (arg('set') ?? '').split(',').filter(Boolean)) {
  const [k, v] = entry.split('=');
  if (k && v !== undefined) (overrides as Record<string, unknown>)[k] = Number(v);
}
const tuning = Object.keys(overrides).length > 0 ? overrides : undefined;
if (tuning) console.log(`overrides: ${JSON.stringify(tuning)}`);

const only = arg('stage');
const grip = Number(arg('grip') ?? '0.75');
const defs = only ? [stageById(only)] : STAGES;

for (const def of defs) {
  const stage = new Stage(def);
  const overlaps = stage.selfIntersections();
  const result = await runStage(stage, {
    driver: { gripBudget: grip },
    ...(tuning ? { tuning } : {}),
  });
  // Calibrate variants against the best of several driving styles rather than
  // one run: the AI is chaotic near its own limit, and a single lap flips
  // between a clean run and one with an off. Measuring the base the same way
  // the variants are measured is the only way the ratio means anything.
  const baseline = await validateStage(stage, undefined, tuning);

  const status = result.finished
    ? `finished in ${result.time!.toFixed(2)}s  (${medalFor(result.time!, def.medals)})`
    : `DNF: ${result.failure} at ${(result.progress * 100).toFixed(0)}%`;

  console.log(`\n${def.name}  [${def.id}]`);
  console.log(`  length          ${stage.length.toFixed(0)} m, ${stage.checkpoints.length} checkpoints`);
  console.log(`  AI driver       ${status}`);
  console.log(`  splits          ${result.splits.map((t) => t.toFixed(1)).join('  ') || '—'}`);
  console.log(`  top speed       ${result.summary.topSpeedKph.toFixed(1)} km/h`);
  console.log(`  avg speed       ${result.summary.avgSpeedKph.toFixed(1)} km/h`);
  console.log(`  off road        ${(result.offRoadFraction * 100).toFixed(1)}%`);
  console.log(`  rescues         ${result.rescues}`);
  const near = stage.closestApproach();
  console.log(
    `  closest to self ${near.gap.toFixed(0)} m  (${near.a.toFixed(0)}m <-> ${near.b.toFixed(0)}m)` +
      (near.gap < 26 ? '  ⚠ the two corridors are stacked' : ''),
  );
  if (overlaps.length > 0) {
    console.log(`  ⚠ corridor overlaps itself at:`);
    for (const o of overlaps) {
      console.log(`      ${o.a.toFixed(0)}m <-> ${o.b.toFixed(0)}m  (short by ${o.gap.toFixed(1)}m)`);
    }
  }
  // Every variant has to be completable too, and each one's measured lap is
  // what its medal times are scaled from.
  for (const v of stageVariants(def).slice(1)) {
    const run = await validateStage(stage, v.conditions, tuning);
    const gripFactor = run.time && baseline.time ? run.time / baseline.time : NaN;
    const suggested = gripFactor * visibilityPenalty(v.conditions);
    console.log(
      `  variant ${v.id.padEnd(12)} ${
        run.ok ? `${run.time!.toFixed(1)}s` : `REJECTED: ${run.reason}`.padEnd(24)
      }  grip×${gripFactor.toFixed(3)}  +vis → timeScale ${suggested.toFixed(2)}`,
    );
  }
  console.log(`  medals          author ${def.medals.author}  gold ${def.medals.gold}  silver ${def.medals.silver}  bronze ${def.medals.bronze}`);
}
