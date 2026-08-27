/**
 * Handling sweeps.
 *
 * Runs a matrix of steady-state corners and prints a table. This is the P1
 * tuning instrument: change a number in `data/tuning.ts`, re-run, and read the
 * effect on balance directly instead of guessing from a screenshot.
 *
 *   npm run sweep
 *   npm run sweep -- --surface=gravel
 *   npm run sweep -- --steer=0.2,0.4,0.6,0.8 --throttle=0.3,0.6,0.9
 */

import type { VehicleTuning } from '../src/data/tuning.js';
import { steadyState } from '../src/sim/steady.js';
import type { SurfaceId } from '../src/sim/surfaces.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const nums = (s: string) => s.split(',').map(Number);

const steers = nums(arg('steer', '0.15,0.3,0.5,0.75,1.0'));
const throttles = nums(arg('throttle', '0.55'));
const surfaces = arg('surface', 'tarmac').split(',') as SurfaceId[];

/**
 * `--set=maxSteerAngle=0.42,peakSlipAngle=0.2` overrides tuning for this run,
 * so a candidate setup can be measured without editing and reverting a file.
 */
const overrides: Partial<VehicleTuning> = {};
const setSpec = arg('set', '');
if (setSpec) {
  for (const pair of setSpec.split(',')) {
    const [k, v] = pair.split('=');
    (overrides as Record<string, unknown>)[k!] = Number(v);
  }
  console.log(`overrides: ${JSON.stringify(overrides)}`);
}

const verdict = (b: number, spun: boolean): string => {
  if (spun) return 'SPIN';
  if (b > 1.5) return 'understeer';
  if (b > 0.4) return 'mild under';
  if (b < -1.5) return 'oversteer';
  if (b < -0.4) return 'mild over';
  return 'neutral';
};

const pad = (s: string | number, n: number, left = false) =>
  left ? String(s).padStart(n) : String(s).padEnd(n);

for (const surfaceId of surfaces) {
  for (const throttle of throttles) {
    console.log(`\nsurface=${surfaceId}  throttle=${throttle}`);
    console.log(
      [
        pad('steer', 7),
        pad('km/h', 7, true),
        pad('radius', 8, true),
        pad('yaw°/s', 8, true),
        pad('drift°', 8, true),
        pad('lat g', 7, true),
        pad('fSlip°', 8, true),
        pad('rSlip°', 8, true),
        pad('bal', 7, true),
        '  verdict',
      ].join(''),
    );
    console.log('-'.repeat(81));

    for (const steer of steers) {
      const r = await steadyState({ steer, throttle, surface: surfaceId, tuning: overrides });
      console.log(
        [
          pad(steer.toFixed(2), 7),
          pad(r.speedKph.toFixed(1), 7, true),
          pad(r.radius > 900 ? '—' : r.radius.toFixed(1), 8, true),
          pad(r.yawRate.toFixed(1), 8, true),
          pad(r.driftDeg.toFixed(1), 8, true),
          pad(r.lateralG.toFixed(2), 7, true),
          pad(r.frontSlipDeg.toFixed(2), 8, true),
          pad(r.rearSlipDeg.toFixed(2), 8, true),
          pad(r.balance.toFixed(2), 7, true),
          `  ${verdict(r.balance, r.spun)}`,
        ].join(''),
      );
    }
  }
}
