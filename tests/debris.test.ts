/**
 * Parts coming off, and landings that hurt.
 *
 * The property these protect is the fairness rule, which is the whole reason
 * the module exists: randomness decides *when* a part lets go, damage state
 * decides *whether it can at all*. A car in one piece must never shed anything,
 * however unlucky the seed.
 */

import { describe, expect, it } from 'vitest';
import { DebrisModel, PARTS, PART_BY_ID, type PartId } from '../src/sim/debris.js';
import { createWorld } from '../src/sim/world.js';
import { v3 } from '../src/sim/math.js';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
const NOSE = v3(0, 0, 1.9);

/** A stream that always says "yes": the unluckiest possible run. */
const alwaysUnlucky = () => 0;

function run(model: DebrisModel, seconds: number, speed = 30): void {
  for (let i = 0; i < seconds * 120; i++) model.update(1 / 120, speed, () => false);
}

describe('attachment', () => {
  it('never sheds a part from an undamaged car, however unlucky', () => {
    const model = new DebrisModel({ random: alwaysUnlucky });
    run(model, 120);
    expect(model.drainDetached()).toEqual([]);
    for (const part of PARTS) expect(model.stateOf(part.id)).toBe('attached');
  });

  it('needs a real impact to loosen anything', () => {
    const model = new DebrisModel({ random: alwaysUnlucky });
    // A 10 km/h nudge is about 3 500 N·s, below every part's threshold.
    model.applyImpact(NOSE, 3500);
    expect(model.get('bumperFront')).toBe(1);
    model.applyImpact(NOSE, 12000);
    expect(model.get('bumperFront')).toBeLessThan(1);
  });

  it('only loosens parts the impact was actually near', () => {
    const model = new DebrisModel();
    model.applyImpact(NOSE, 30000);
    expect(model.get('bumperFront')).toBeLessThan(1);
    expect(model.get('bumperRear')).toBe(1);
    expect(model.get('doorLeft')).toBe(1);
  });
});

describe('the bumper, which is the model case', () => {
  it('drags before it goes, and the drag is what you are warned by', () => {
    const model = new DebrisModel({ random: () => 1 }); // never rolls a detach
    model.applyImpact(NOSE, 14000);
    run(model, 30);
    expect(model.stateOf('bumperFront')).toBe('dragging');
    expect(model.dragging()).toContain('bumperFront');
    // And it costs something while it hangs there.
    expect(model.dragScale).toBeGreaterThan(1);
    expect(model.drainDetached()).toEqual([]);
  });

  it('goes at an unpredictable moment once it is dragging', () => {
    const model = new DebrisModel({ random: alwaysUnlucky });
    model.applyImpact(NOSE, 14000);
    run(model, 10);
    expect(model.stateOf('bumperFront')).toBe('gone');
    const gone = model.drainDetached();
    expect(gone.map((d) => d.id)).toContain('bumperFront');
    expect(gone[0]!.mass).toBeGreaterThan(0);
  });

  it('hangs on longer at a crawl than at racing speed', () => {
    const attempt = (speed: number) => {
      // A stream that says yes one time in eight, so the roll's own weighting
      // decides the outcome rather than the stream.
      let n = 0;
      const model = new DebrisModel({ random: () => (n++ % 8 === 0 ? 0.05 : 0.9) });
      model.applyImpact(NOSE, 13000);
      for (let i = 0; i < 60 * 120; i++) {
        model.update(1 / 120, speed, () => false);
        if (model.stateOf('bumperFront') === 'gone') return i / 120;
      }
      return Infinity;
    };
    expect(attempt(4)).toBeGreaterThan(attempt(40));
  });
});

describe('wheels', () => {
  it('leaves with its hub rather than on a roll of the dice', () => {
    const model = new DebrisModel({ random: alwaysUnlucky });
    run(model, 20);
    expect(model.stateOf('wheelFL')).toBe('attached');

    model.update(1 / 120, 30, (id) => id === 'hubFL');
    expect(model.stateOf('wheelFL')).toBe('gone');
    expect(model.stateOf('wheelFR')).toBe('attached');
  });
});

describe('debris in the world', () => {
  it('spawns a collidable body that carries the car with it', async () => {
    const world = await createWorld({ baseSurface: 'tarmac', damage: true });
    for (let i = 0; i < 120; i++) world.step({ ...NEUTRAL, throttle: 1 });

    world.debris!.detach(PART_BY_ID.get('bumperFront')!);
    world.step(NEUTRAL);

    expect(world.loose).toHaveLength(1);
    const body = world.loose[0]!.body;
    // It left with the car's motion, not from a standstill.
    expect(Math.abs(body.linvel().z)).toBeGreaterThan(1);
  });

  it('keeps within its budget however much comes off', async () => {
    const world = await createWorld({ baseSurface: 'tarmac', damage: true });
    for (let i = 0; i < 60; i++) world.step(NEUTRAL);
    // More parts than the budget: a completely destroyed car sheds twenty-odd
    // pieces and only the most recent twelve stay in the world.
    expect(PARTS.length).toBeGreaterThan(12);
    for (const part of PARTS) world.debris!.detach(part);
    world.step(NEUTRAL);
    expect(world.loose).toHaveLength(12);
    // Oldest recycled first, so what is on the road is what just came off.
    const shed = world.loose.map((l) => l.id);
    expect(shed).toContain(PARTS[PARTS.length - 1]!.id);
    expect(shed).not.toContain(PARTS[0]!.id);
  });

  it('clears what is far behind, and everything on a restart', async () => {
    const world = await createWorld({ baseSurface: 'tarmac', damage: true });
    for (let i = 0; i < 60; i++) world.step(NEUTRAL);
    world.debris!.detach(PART_BY_ID.get('bumperRear')!);
    world.step(NEUTRAL);
    expect(world.loose).toHaveLength(1);

    // Drive 200 m away: past the keep radius, so the body is recycled.
    world.vehicle.reset(v3(0, 1.2, 300), 0);
    world.step(NEUTRAL);
    expect(world.loose).toHaveLength(0);

    world.debris!.detach(PART_BY_ID.get('bonnet')!);
    world.step(NEUTRAL);
    world.clearDebris();
    expect(world.loose).toHaveLength(0);
    expect(world.debris!.stateOf('bonnet')).toBe('attached');
  });

  it('is reproducible: the same seed sheds the same parts at the same time', async () => {
    const attempt = async (): Promise<[PartId[], number]> => {
      const world = await createWorld({ baseSurface: 'tarmac', damage: true });
      for (let i = 0; i < 60; i++) world.step(NEUTRAL);
      world.debris!.applyImpact(NOSE, 15000);
      let steps = 0;
      const shed: PartId[] = [];
      while (steps < 120 * 40 && shed.length === 0) {
        world.step({ ...NEUTRAL, throttle: 1 });
        for (const part of world.loose) if (!shed.includes(part.id)) shed.push(part.id);
        steps++;
      }
      return [shed, steps];
    };
    const [partsA, stepsA] = await attempt();
    const [partsB, stepsB] = await attempt();
    expect(partsA).toEqual(partsB);
    expect(stepsA).toBe(stepsB);
  });
});

describe('landing damage', () => {
  /** Drop the car from `height`, optionally tipped, and report the damage. */
  const drop = async (height: number, pitch = 0, roll = 0) => {
    const world = await createWorld({
      baseSurface: 'tarmac',
      damage: true,
      spawn: { position: { x: 0, y: 0.9 + height, z: 0 }, heading: 0 },
    });
    if (pitch !== 0 || roll !== 0) {
      const cp = Math.cos(pitch / 2);
      const sp = Math.sin(pitch / 2);
      const cr = Math.cos(roll / 2);
      const sr = Math.sin(roll / 2);
      world.vehicle.body.setRotation({ x: sp * cr, y: sp * sr, z: cp * sr, w: cp * cr }, true);
    }
    for (let i = 0; i < 480; i++) world.step(NEUTRAL);
    return world.damage!;
  };

  it('costs nothing for a landing the suspension can absorb', async () => {
    const damage = await drop(2);
    expect(damage.repairBill().total).toBe(0);
    expect(damage.peakImpulse).toBe(0);
  });

  it('costs a suspension when one corner takes the whole car', async () => {
    const flat = await drop(5);
    // Nose-down and rolled, so one corner arrives first and takes the lot.
    const cornered = await drop(5, 0.35, 0.45);
    expect(cornered.peakImpulse).toBeGreaterThan(flat.peakImpulse);
    expect(cornered.repairBill().total).toBeGreaterThan(flat.repairBill().total);
    // Specifically the parts a bad landing bends, not the bodywork.
    const worst = Math.min(
      cornered.get('suspensionRL'),
      cornered.get('suspensionRR'),
      cornered.get('suspensionFL'),
      cornered.get('suspensionFR'),
    );
    expect(worst).toBeLessThan(1);
  });
});
