/**
 * Simulation cost.
 *
 *   npm run perf
 *
 * Measures CPU time per fixed step, headless and GPU-independent. The number
 * that matters is milliseconds of CPU per second of game time: the sim runs at
 * a fixed 120 Hz, so 120 steps have to fit inside one second alongside
 * everything else.
 */

import { STAGES } from '../src/data/stages/index.js';
import { Stage } from '../src/sim/stage.js';
import { createWorld } from '../src/sim/world.js';
import { Driver } from '../src/sim/driver.js';
import { PARTS } from '../src/sim/debris.js';

for (const [label, opts] of [
  ['flat proving ground', {}],
  ['stage, no damage', { stage: new Stage(STAGES[0]!) }],
  ['stage, with damage', { stage: new Stage(STAGES[0]!), damage: true }],
  // A full debris budget is the expensive case: twelve dynamic bodies rolling
  // around a trimesh corridor. The budget exists because of this number.
  ['stage, full debris', { stage: new Stage(STAGES[0]!), damage: true, debris: 'full' }],
] as const) {
  const { debris: debrisMode, ...worldOpts } = opts as Record<string, unknown>;
  const world = await createWorld(worldOpts as never);
  if (debrisMode === 'full') {
    // Shed everything the car has, so the loose-body cap is actually reached.
    for (const part of PARTS) world.debris!.detach(part);
    world.step({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
  }
  const driver = world.stage ? new Driver(world.stage) : null;
  const input = { throttle: 1, brake: 0, steer: 0.2, handbrake: 0 };

  for (let i = 0; i < 600; i++) world.step(input);   // warm up

  const N = 6000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    world.step(driver ? driver.input(world.state(), world.dt) : input);
  }
  const ms = (performance.now() - t0) / N;
  // 120 sim steps make one second of game time.
  console.log(
    label.padEnd(22),
    `${(ms * 1000).toFixed(0).padStart(4)} µs/step`,
    `| ${(ms * 120).toFixed(2).padStart(5)} ms of CPU per second of game`,
    `| headroom ×${(1000 / (ms * 120)).toFixed(0)}`,
  );
}

// Stage construction cost, which happens on every stage load.
const t1 = performance.now();
for (let i = 0; i < 20; i++) new Stage(STAGES[i % STAGES.length]!);
console.log(`\nstage build          ${((performance.now() - t1) / 20).toFixed(1)} ms each`);
