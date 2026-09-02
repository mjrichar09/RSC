/**
 * Impact calibration.
 *
 *   npm run crash
 *   npm run crash -- --speed=30,60,90 --face=front
 *   npm run crash -- --drop=1,2,3,4 --pitch=0.3
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
import { strikeImpulse } from '../src/sim/wildlife.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const speeds = arg('speed', '20,35,50,70,95,130').split(',').map(Number);
/** front drives nose-first; side approaches at an angle. */
const face = arg('face', 'front');

const WALL_AT = 260;

/**
 * Landing calibration: drop the car from a height and report what it costs.
 *
 * A landing is an impact too, and it needs the same treatment as the wall — a
 * height in metres is something you can picture, unlike a bump-stop impulse.
 * `--pitch` tips the car nose-down so the front corners take it alone, which is
 * the difference between a bad landing and a merely heavy one.
 */
/**
 * Two-wheel balance probe.
 *
 * The plan says to measure before touching the artificial stabilisers, because
 * `yawDamping` is already gated on being grounded and the anti-roll bar already
 * needs both wheels of an axle down — so a two-wheel balance may already be
 * possible. This drops the car with a roll angle and a sideways nudge and
 * reports how long it actually stays on two wheels.
 */
/**
 * Deer strike calibration.
 *
 * A deer barely changes the car's momentum and still destroys the front of it,
 * so the strike carries a concentration factor. This is where that factor gets
 * checked against outcomes anyone can judge: a fright, a bad accident, a
 * written-off front end.
 */
const deerSpec = arg('deer', '');
if (deerSpec) {
  console.log('Deer strike calibration\n');
  console.log(['speed', 'impulse', 'condition', 'bill', 'outcome'].map((h, i) => (i === 4 ? h : h.padStart(10))).join('  '));
  console.log('-'.repeat(80));

  for (const kph of deerSpec.split(',').map(Number)) {
    const world = await createWorld({ baseSurface: 'tarmac', damage: true });
    const damage = world.damage!;
    const speed = kph / 3.6;
    // The same call the world makes when the proximity test fires — literally
    // the same function, so this cannot drift from the game again.
    const impulse = strikeImpulse(speed);
    damage.applyImpact({ x: 0, y: 0, z: 1.8 }, impulse);

    const hurt = COMPONENTS.filter((c) => damage.get(c.id) < 0.999)
      .sort((a, b) => damage.get(a.id) - damage.get(b.id))
      .map((c) => `${c.label} ${(damage.get(c.id) * 100).toFixed(0)}%`)
      .slice(0, 5);
    console.log(
      [
        `${kph} km/h`.padStart(10),
        impulse.toFixed(0).padStart(10),
        `${(damage.condition * 100).toFixed(1)}%`.padStart(10),
        String(damage.repairBill().total).padStart(10),
      ].join('  ') +
        `  ${damage.failures.size > 0 ? `FAILED: ${[...damage.failures].join(', ')}` : hurt.join(', ') || 'unscathed'}`,
    );
  }
  process.exit(0);
}

const balanceSpec = arg('balance', '');
if (balanceSpec) {
  console.log('Two-wheel balance — dropped with roll and a sideways nudge\n');
  console.log(
    ['roll', 'nudge', 'peak roll', 'on two', 'longest', 'ended'].map((h) => h.padStart(11)).join('  '),
  );
  console.log('-'.repeat(74));

  for (const rollDeg of balanceSpec.split(',').map(Number)) {
    for (const nudge of [0, 2.5, 5]) {
      const roll = (rollDeg * Math.PI) / 180;
      const world = await createWorld({
        baseSurface: 'tarmac',
        damage: true,
        spawn: { position: { x: 0, y: 1.6, z: 0 }, heading: 0 },
      });
      world.vehicle.body.setRotation(
        { x: 0, y: 0, z: Math.sin(roll / 2), w: Math.cos(roll / 2) },
        true,
      );
      world.vehicle.body.setLinvel({ x: nudge, y: 0, z: 22 }, true);

      let onTwo = 0;
      let run = 0;
      let longest = 0;
      let peak = 0;
      for (let i = 0; i < 900; i++) {
        world.step({ throttle: 0.35, brake: 0, steer: 0, handbrake: 0 });
        const state = world.state();
        const grounded = state.wheels.filter((w) => w.grounded).length;
        // Roll angle from the car's own up vector against world up.
        const q = state.rotation;
        const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
        peak = Math.max(peak, (Math.acos(Math.max(Math.min(upY, 1), -1)) * 180) / Math.PI);
        if (grounded === 2) {
          onTwo += world.dt;
          run += world.dt;
          longest = Math.max(longest, run);
        } else {
          run = 0;
        }
      }
      const state = world.state();
      const grounded = state.wheels.filter((w) => w.grounded).length;
      console.log(
        [
          `${rollDeg}°`,
          `${nudge} m/s`,
          `${peak.toFixed(0)}°`,
          `${onTwo.toFixed(2)} s`,
          `${longest.toFixed(2)} s`,
          `${grounded} wheels`,
        ]
          .map((c) => c.padStart(11))
          .join('  '),
      );
    }
  }
  process.exit(0);
}

const dropSpec = arg('drop', '');
if (dropSpec) {
  const pitch = Number(arg('pitch', '0'));
  const roll = Number(arg('roll', '0'));
  console.log(`Landing calibration — dropped ${
      pitch === 0 && roll === 0 ? 'flat' : `pitch ${pitch} roll ${roll} rad`
    }\n`);
  console.log(
    ['height', 'impact', 'impulse', 'condition', 'bill', 'outcome']
      .map((h, i) => (i === 5 ? h : h.padStart(10)))
      .join('  '),
  );
  console.log('-'.repeat(84));

  for (const height of dropSpec.split(',').map(Number)) {
    const world = await createWorld({
      baseSurface: 'tarmac',
      damage: true,
      spawn: { position: { x: 0, y: 0.9 + height, z: 0 }, heading: 0 },
    });
    const damage = world.damage!;
    if (pitch !== 0 || roll !== 0) {
      // Nose-down and/or rolled, so fewer wheels land first and each takes more
      // of the car. One corner landing alone is the bad case.
      const cp = Math.cos(pitch / 2);
      const sp = Math.sin(pitch / 2);
      const cr = Math.cos(roll / 2);
      const sr = Math.sin(roll / 2);
      world.vehicle.body.setRotation(
        { x: sp * cr, y: sp * sr, z: cp * sr, w: cp * cr },
        true,
      );
    }

    let impact = 0;
    for (let i = 0; i < 480; i++) {
      impact = Math.max(impact, -world.state().velocity.y);
      world.step({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
      damage.drainEvents();
    }

    const hurt = COMPONENTS.filter((c) => damage.get(c.id) < 0.999)
      .sort((a, b) => damage.get(a.id) - damage.get(b.id))
      .map((c) => `${c.label} ${(damage.get(c.id) * 100).toFixed(0)}%`)
      .slice(0, 5);
    const bill = damage.repairBill();

    console.log(
      [
        `${height} m`.padStart(10),
        `${impact.toFixed(1)} m/s`.padStart(10),
        damage.peakImpulse.toFixed(0).padStart(10),
        `${(damage.condition * 100).toFixed(1)}%`.padStart(10),
        String(bill.total).padStart(10),
      ].join('  ') +
        `  ${damage.failures.size > 0 ? `FAILED: ${[...damage.failures].join(', ')}` : hurt.join(', ') || 'unscathed'}`,
    );
  }
  process.exit(0);
}

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
