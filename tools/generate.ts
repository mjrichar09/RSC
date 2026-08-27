/**
 * Stage generator.
 *
 *   npm run generate
 *   npm run generate -- --count=8 --biome=coast --write
 *
 * Generates candidate stages, throws away the ones that fail structural or
 * drivability checks, calibrates medals and payouts from a measured lap, and
 * optionally writes the survivors to `src/data/stages/generated.ts`.
 *
 * The interesting part is the rejection rate: generation is cheap, validation
 * is what makes the output shippable.
 */

import { writeFileSync } from 'node:fs';
import { calibrate, generateStage } from '../src/sim/generator.js';
import { validateStage } from '../src/sim/runStage.js';
import type { StageDef } from '../src/sim/stage.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const wanted = Number(arg('count', '4'));
const biome = arg('biome', '');
const firstSeed = Number(arg('seed', '1'));
const technicality = arg('technicality', '');
const write = process.argv.includes('--write');
const maxAttempts = wanted * 12;

const accepted: StageDef[] = [];
const usedNames = new Set<string>();
const rejections = new Map<string, number>();
let attempts = 0;
let seed = firstSeed;

console.log(`Generating ${wanted} stage(s)${biome ? ` in ${biome}` : ''}...\n`);

while (accepted.length < wanted && attempts < maxAttempts) {
  attempts++;
  const candidate = generateStage({
    seed: seed++,
    ...(biome ? { biome } : {}),
    ...(technicality ? { technicality: Number(technicality) } : {}),
  });

  if (!candidate) {
    rejections.set('bad layout', (rejections.get('bad layout') ?? 0) + 1);
    continue;
  }

  const result = await validateStage(candidate.stage);
  if (!result.ok) {
    rejections.set(result.reason!, (rejections.get(result.reason!) ?? 0) + 1);
    console.log(`  ✗ ${candidate.def.name.padEnd(28)} ${result.reason}`);
    continue;
  }

  // Names come from a small word list, so collisions happen. A set of stages
  // with two "Wind Cove Stage"s is confusing in the garage for no good reason.
  if (usedNames.has(candidate.def.name)) {
    rejections.set('duplicate name', (rejections.get('duplicate name') ?? 0) + 1);
    continue;
  }
  usedNames.add(candidate.def.name);

  const tuned = calibrate(candidate.def, result.time!, candidate.stage.length);
  accepted.push(tuned);
  console.log(
    `  ✓ ${tuned.name.padEnd(28)} ${candidate.stage.length.toFixed(0).padStart(4)} m  ` +
      `AI ${result.time!.toFixed(1)}s  entry ${tuned.entryFee}  gold ${tuned.payouts.gold}  ` +
      `off-road ${(result.offRoadFraction * 100).toFixed(0)}%`,
  );
}

console.log(`\naccepted ${accepted.length}/${attempts} candidates`);
for (const [reason, count] of [...rejections].sort((a, b) => b[1] - a[1])) {
  console.log(`  rejected ${String(count).padStart(3)} × ${reason}`);
}

if (write) {
  const path = 'src/data/stages/generated.ts';
  writeFileSync(path, module(accepted));
  console.log(`\n-> ${path}`);
} else {
  console.log('\n(pass --write to save these to src/data/stages/generated.ts)');
}

/** Emit a plain TS module. Generated stages are data like any other stage. */
function module(stages: StageDef[]): string {
  const biomes = [...new Set(stages.map((s) => s.biome))].join(', ');
  return `/**
 * Generated stages — do not edit by hand.
 *
 * Produced by \`npm run generate --write\`. Every stage here was driven to the
 * finish by the AI at several grip budgets before being accepted, and its medal
 * times and payouts were calibrated from those laps.
 *
 * ${stages.length} stage(s)${biomes ? `, biomes: ${biomes}` : ''}.
 */

import type { StageDef } from '../../sim/stage.js';

export const GENERATED_STAGES: StageDef[] = ${JSON.stringify(stages, null, 2)};
`;
}
