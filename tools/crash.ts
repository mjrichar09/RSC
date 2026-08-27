/**
 * Impact calibration.
 *
 *   npm run crash
 *   npm run crash -- --speed=30,60,90 --face=front
 *
 * Accelerates down a flat proving ground into a wall at a known speed and
 * reports the impulse recorded, what broke, and the repair bill.
 *
 * Damage thresholds are in newton-seconds, which nobody has intuition for.
 * This is how they get set to numbers that actually mean "a scrape", "an
 * expensive mistake" and "your race is over".
 */

import { COMPONENTS } from '../src/sim/damage.js';
import { createWorld } from '../src/sim/world.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const speeds = arg('speed', '20,35,50,70,95,130').split(',').map(Number);
/** front drives nose-first; side approaches at an angle. */
const face = arg('face', 'front');

const WALL_AT = 260;

console.log(`Impact calibration — ${face}-on into a wall\n`);
console.log(
  ['entry', 'impulse', 'condition', 'bill', 'outcome'].map((h, i) => (i === 4 ? h : h.padStart(10))).join('  '),
);
console.log('-'.repeat(78));

for (const targetKph of speeds) {
  const world = await createWorld({
    baseSurface: 'tarmac',
    damage: true,
    wall: { x: 0, z: WALL_AT, halfX: 40, halfY: 3, halfZ: 1 },
  });
  const damage = world.damage!;

  for (let i = 0; i < 60; i++) world.step({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });

  // Hold the target speed all the way down the straight, so the impact happens
  // at the speed asked for rather than at whatever is left after a long coast.
  const steer = face === 'side' ? 0.5 : 0;
  const target = targetKph / 3.6;
  let entry = 0;

  for (let i = 0; i < 12_000; i++) {
    const state = world.state();
    const toWall = WALL_AT - state.position.z;
    if (toWall > 6) entry = Math.abs(state.speed) * 3.6;

    const throttle = state.speed < target ? 1 : 0;
    const brake = state.speed > target * 1.05 ? 0.35 : 0;
    world.step({ throttle, brake, steer: toWall > 25 ? 0 : steer, handbrake: 0 });

    damage.drainEvents();
    if (toWall < 12 && Math.abs(world.state().speed) < 0.6) break;
  }

  const hurt = COMPONENTS.filter((c) => damage.get(c.id) < 0.999)
    .sort((a, b) => damage.get(a.id) - damage.get(b.id))
    .map((c) => `${c.label} ${(damage.get(c.id) * 100).toFixed(0)}%`)
    .slice(0, 6);

  const bill = damage.repairBill();
  const outcome =
    damage.failures.size > 0 ? `FAILED: ${[...damage.failures].join(', ')}` : hurt.join(', ') || 'unscathed';

  console.log(
    [
      `${entry.toFixed(0)} km/h`.padStart(10),
      damage.peakImpulse.toFixed(0).padStart(10),
      `${(damage.condition * 100).toFixed(1)}%`.padStart(10),
      String(bill.total).padStart(10),
    ].join('  ') + `  ${outcome}`,
  );
}
