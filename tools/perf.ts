/**
 * Simulation cost.
 *
 *   npm run perf
 *   npm run perf -- --passes=5
 *
 * Measures CPU time per fixed step, headless and GPU-independent. The number
 * that matters is milliseconds of CPU per second of game time: the sim runs at
 * a fixed 120 Hz, so 120 steps have to fit inside one second alongside
 * everything else.
 *
 * Every case is measured several times, interleaved, and the **minimum** is
 * reported. That is not fussiness: measuring each case once in sequence made
 * this tool report a stage strewn with wreckage as *faster* than a clean one,
 * and a bare stage as slower than one carrying a damage model. Timing noise on
 * a shared machine is worth a factor of two, and it only ever adds — so the
 * minimum of several passes is the honest statistic, and interleaving means
 * drift over the run lands on every case equally.
 */

import { STAGES } from '../src/data/stages/index.js';
import { Stage } from '../src/sim/stage.js';
import { type SimWorld, createWorld } from '../src/sim/world.js';
import { Driver } from '../src/sim/driver.js';
import { PARTS } from '../src/sim/debris.js';

function arg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
}

const PASSES = arg('passes', 3);
const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

interface Case {
  label: string;
  world: SimWorld;
  driver: Driver | null;
  note?: string;
}

const cases: Case[] = [];

for (const [label, opts, shed] of [
  ['flat proving ground', {}, 0],
  ['stage, no damage', { stage: new Stage(STAGES[0]!) }, 0],
  ['stage, with damage', { stage: new Stage(STAGES[0]!), damage: true }, 0],
  // Half a car on the ground, and then all of it: the slope between these two
  // is what the debris budget is actually set from.
  ['stage, half shed', { stage: new Stage(STAGES[0]!), damage: true }, Math.floor(PARTS.length / 2)],
  ['stage, whole car shed', { stage: new Stage(STAGES[0]!), damage: true }, PARTS.length],
  // A full multiplayer grid. The host runs this and its own rendering, so the
  // interesting number is what three extra cars cost the machine hosting.
  ['stage, four cars', { stage: new Stage(STAGES[0]!), damage: true, cars: 4 }, 0],
] as const) {
  const world = await createWorld(opts as never);
  if (shed > 0) {
    for (const part of PARTS.slice(0, shed)) world.debris!.detach(part);
    // Let them settle, so what is measured is bodies resting on and colliding
    // with the corridor rather than bodies still in the air.
    for (let i = 0; i < 240; i++) world.step(NEUTRAL);
  }
  cases.push({
    label,
    world,
    driver: world.stage ? new Driver(world.stage) : null,
    ...(shed > 0 ? { note: `${world.loose.length} loose bodies` } : {}),
  });
}

const input = { throttle: 1, brake: 0, steer: 0.2, handbrake: 0 };
const step = (c: Case) => c.world.step(c.driver ? c.driver.input(c.world.state(), c.world.dt) : input);

// Warm up every case before timing any of them, or the first one measured pays
// for the JIT and the last one gets the benefit.
for (const c of cases) for (let i = 0; i < 600; i++) step(c);

const best = new Map<string, number>();
const N = 4000;
for (let pass = 0; pass < PASSES; pass++) {
  for (const c of cases) {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) step(c);
    const us = ((performance.now() - t0) / N) * 1000;
    best.set(c.label, Math.min(best.get(c.label) ?? Infinity, us));
  }
}

console.log(`best of ${PASSES} passes, interleaved\n`);
const baseline = best.get('stage, with damage')!;
for (const c of cases) {
  const us = best.get(c.label)!;
  const delta = c.note ? `  (+${(us - baseline).toFixed(0)} µs, ${c.note})` : '';
  console.log(
    c.label.padEnd(22),
    `${us.toFixed(0).padStart(4)} µs/step`,
    `| ${((us * 120) / 1000).toFixed(2).padStart(5)} ms of CPU per second of game`,
    `| headroom ×${(1000 / ((us * 120) / 1000)).toFixed(0)}`.padEnd(14) + delta,
  );
}

/**
 * Debris while it is still moving.
 *
 * The settled cases above cost the same as a clean stage, and that is not a
 * mistake: Rapier puts resting bodies to sleep, so wreckage lying at the side
 * of the road is very nearly free. The bill is paid in the couple of seconds
 * while parts are in the air and bouncing off the corridor, which is exactly
 * when the frame is also busiest — so that is the number worth having.
 */
{
  const measure = async (shed: number): Promise<number> => {
    let best = Infinity;
    for (let pass = 0; pass < PASSES; pass++) {
      const world = await createWorld({ stage: new Stage(STAGES[0]!), damage: true });
      const driver = new Driver(world.stage!);
      for (let i = 0; i < 600; i++) world.step(driver.input(world.state(), world.dt));
      for (const part of PARTS.slice(0, shed)) world.debris!.detach(part);

      const N = 240; // two seconds, which is about how long they bounce for
      const t0 = performance.now();
      for (let i = 0; i < N; i++) world.step(driver.input(world.state(), world.dt));
      best = Math.min(best, ((performance.now() - t0) / N) * 1000);
    }
    return best;
  };

  const clean = await measure(0);
  const flying = await measure(PARTS.length);
  console.log(
    `\ndebris in flight     ${flying.toFixed(0)} µs/step against ${clean.toFixed(0)} clean` +
      `  (+${(flying - clean).toFixed(0)} µs for ${PARTS.length} parts, ` +
      `${((flying - clean) / PARTS.length).toFixed(1)} µs each)`,
  );
}

// Stage construction cost, which happens on every stage load.
const t1 = performance.now();
for (let i = 0; i < 20; i++) new Stage(STAGES[i % STAGES.length]!);
console.log(`\nstage build          ${((performance.now() - t1) / 20).toFixed(1)} ms each`);
