/**
 * Headless telemetry runner.
 *
 *   npm run telemetry
 *   npm run telemetry -- --trace=launch,slalom --surface=gravel
 *   npm run telemetry -- --trace=launch --csv
 *
 * Text output only. This is the default way to answer a handling question —
 * screenshots are reserved for questions that are genuinely visual.
 */

import { writeFileSync } from 'node:fs';
import { TRACES, traceNames } from '../src/sim/trace.js';
import { formatSummary } from '../src/sim/telemetry.js';
import { runTrace } from '../src/sim/run.js';
import type { SurfaceId } from '../src/sim/surfaces.js';
import type { VehicleTuning } from '../src/data/tuning.js';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=');
}

const requested = (arg('trace') ?? 'launch,brake,slalom,handbrake,catch,circle').split(',');
const baseSurface = (arg('surface') ?? 'tarmac') as SurfaceId;
const wantCsv = process.argv.includes('--csv');
/** `--damage` runs with the damage model on, which is what brake heat needs. */
const wantDamage = process.argv.includes('--damage');

/** `--set=handbrakeTorque=2000,lsdBias=0.2` overrides tuning for this run. */
const overrides: Partial<VehicleTuning> = {};
const setSpec = arg('set');
if (setSpec) {
  for (const pair of setSpec.split(',')) {
    const [k, v] = pair.split('=');
    (overrides as Record<string, unknown>)[k!] = Number(v);
  }
  console.log(`overrides: ${JSON.stringify(overrides)}`);
}

const unknown = requested.filter((n) => !(n in TRACES));
if (unknown.length > 0) {
  console.error(`Unknown trace(s): ${unknown.join(', ')}`);
  console.error(`Available: ${traceNames().join(', ')}`);
  process.exit(1);
}

console.log(`surface: ${baseSurface}\n`);

for (const name of requested) {
  const trace = TRACES[name]!;
  const { summary, recorder } = await runTrace(trace, {
    baseSurface,
    tuning: overrides,
    ...(wantDamage ? { damage: true } : {}),
  });
  console.log(formatSummary(name, summary));
  console.log(`  ${trace.description}\n`);

  if (wantCsv) {
    const path = `shots/${name}-${baseSurface}.csv`;
    writeFileSync(path, recorder.toCsv());
    console.log(`  -> ${path}\n`);
  }
}
