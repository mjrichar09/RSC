/**
 * Economy, upgrades and career state.
 *
 * The properties these protect are design commitments rather than arithmetic:
 * no run can strand a player permanently, every upgrade is a trade rather than
 * a straight gain, and damage belongs to the car so it follows you to the next
 * start line.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { STAGES } from '../src/data/stages/index.js';
import { CAR } from '../src/data/tuning.js';
import { Career } from '../src/game/career.js';
import { RECOVERY_FLOOR, canEnter, ledger, payout } from '../src/game/economy.js';
import { UPGRADES, investedIn, nextCost, rollcageMitigation, tuneFor } from '../src/game/garage.js';
import { SaveStore } from '../src/game/save.js';
import { impactPointFromForce } from '../src/sim/damage.js';
import { v3 } from '../src/sim/math.js';

const FREE = STAGES.find((s) => s.entryFee === 0)!;
const PAID = STAGES.find((s) => s.entryFee > 0)!;
const HEAD_ON = v3(0, 0, -1);

describe('payouts', () => {
  it('pays more for a better medal', () => {
    const p = FREE.payouts;
    expect(p.author).toBeGreaterThan(p.gold);
    expect(p.gold).toBeGreaterThan(p.silver);
    expect(p.silver).toBeGreaterThan(p.bronze);
    expect(p.bronze).toBeGreaterThan(p.finish);
  });

  it('pays more on a stage that costs more to enter', () => {
    expect(PAID.payouts.gold).toBeGreaterThan(FREE.payouts.gold);
  });

  it('always beats its own entry fee at every medal', () => {
    // Otherwise finishing a stage could lose money outright, before repairs.
    for (const stage of STAGES) {
      expect(stage.payouts.finish).toBeGreaterThan(stage.entryFee);
    }
  });

  it('makes sure the free stage alone can fund the cheapest paid entry', () => {
    // The real anti-softlock guarantee: finish the free stage and you can
    // always afford to race again, without relying on the floor at all.
    const cheapestFee = Math.min(...STAGES.filter((s) => s.entryFee > 0).map((s) => s.entryFee));
    expect(FREE.payouts.finish).toBeGreaterThanOrEqual(cheapestFee);
  });

  it('floors a broke player up to the cheapest entry fee if payouts ever drop', () => {
    // A guard rather than everyday behaviour — it only bites if the free
    // stage's payouts are ever tuned below what a re-entry costs.
    const stingy = { ...FREE, payouts: { ...FREE.payouts, finish: 40 } };
    const broke = payout(stingy, 'finish', { money: 0, cheapestFee: 250 });
    expect(broke.amount).toBe(Math.max(RECOVERY_FLOOR, 250));
    expect(broke.floored).toBe(true);
  });

  it('does not floor a player who can still afford to race', () => {
    const fine = payout(FREE, 'finish', { money: 5000, cheapestFee: 250 });
    expect(fine.amount).toBe(FREE.payouts.finish);
    expect(fine.floored).toBe(false);
  });

  it('never floors a paid stage — the safety net is the free one', () => {
    expect(payout(PAID, 'finish', { money: 0, cheapestFee: 250 }).floored).toBe(false);
  });
});

describe('entry rules', () => {
  const unlocked = { medals: 99 };

  it('lets a solvent player with a working car in', () => {
    expect(canEnter(PAID, { money: 9999, carIsDriveable: true, ...unlocked }).allowed).toBe(true);
  });

  it('refuses a player who cannot pay', () => {
    expect(canEnter(PAID, { money: 10, carIsDriveable: true, ...unlocked })).toEqual({
      allowed: false,
      reason: 'too-poor',
    });
  });

  it('refuses a broken car even on the free stage', () => {
    expect(canEnter(FREE, { money: 0, carIsDriveable: false, medals: 0 }).reason).toBe('undriveable');
  });

  it('always lets a solvent player onto the free stage', () => {
    expect(canEnter(FREE, { money: 0, carIsDriveable: true, medals: 0 }).allowed).toBe(true);
  });
});

describe('ledger', () => {
  it('nets out fee, payout and repairs', () => {
    expect(ledger(250, 1800, 600).net).toBe(950);
    expect(ledger(500, 1000, 4000).net).toBe(-3500);
  });
});

describe('upgrades', () => {
  it('costs more at every level', () => {
    for (const u of UPGRADES) {
      for (let i = 1; i < u.costs.length; i++) {
        expect(u.costs[i]!).toBeGreaterThan(u.costs[i - 1]!);
      }
    }
  });

  it('reports the next cost, and nothing once maxed', () => {
    expect(nextCost({}, 'engine')).toBe(UPGRADES.find((u) => u.id === 'engine')!.costs[0]);
    expect(nextCost({ engine: 4 }, 'engine')).toBeNull();
  });

  it('leaves the stock car untouched with nothing fitted', () => {
    expect(tuneFor({})).toEqual(CAR);
  });

  it('never mutates the baseline tuning', () => {
    const before = CAR.mass;
    tuneFor({ engine: 3, weight: 2, tyres: 2 });
    expect(CAR.mass).toBe(before);
    expect(tuneFor({}).torqueCurve).toEqual(CAR.torqueCurve);
  });

  it('makes the engine stronger', () => {
    const stock = CAR.torqueCurve[3]![1];
    const tuned = tuneFor({ engine: 2 }).torqueCurve[3]![1];
    expect(tuned).toBeGreaterThan(stock);
  });

  it('trades grip for a snappier limit on better tyres', () => {
    const t = tuneFor({ tyres: 3 });
    expect(t.tireGrip).toBeGreaterThan(CAR.tireGrip);
    // Every upgrade is a trade: more peak grip, less warning when it goes.
    expect(t.slideGripFloor).toBeLessThan(CAR.slideGripFloor);
  });

  it('trades weight for protection on the rollcage', () => {
    const caged = tuneFor({ rollcage: 3 });
    expect(caged.mass).toBeGreaterThan(CAR.mass);
    expect(rollcageMitigation({ rollcage: 3 })).toBeGreaterThan(0.5);
    expect(rollcageMitigation({})).toBe(0);
  });

  it('cancels weight reduction against a fitted cage', () => {
    expect(tuneFor({ weight: 2 }).mass).toBeLessThan(CAR.mass);
    expect(tuneFor({ weight: 2, rollcage: 3 }).mass).toBeGreaterThan(tuneFor({ weight: 2 }).mass);
  });

  it('totals what has been invested', () => {
    const engine = UPGRADES.find((u) => u.id === 'engine')!;
    expect(investedIn({ engine: 2 })).toBe(engine.costs[0]! + engine.costs[1]!);
    expect(investedIn({})).toBe(0);
  });
});

describe('career', () => {
  let career: Career;

  beforeEach(async () => {
    const save = new SaveStore();
    await save.open();
    await save.clear();
    career = new Career(save, STAGES);
  });

  it('starts with money and an undamaged car', () => {
    expect(career.money).toBeGreaterThan(0);
    expect(career.condition).toBe(1);
    expect(career.carIsDriveable).toBe(true);
  });

  it('charges the entry fee, and only when the stage is entered', async () => {
    // Unlock the paid stage first: entry fees and progression are separate
    // rules, and this one is about the fee.
    await career['save'].update((p) => {
      p.records['pine-loop'] = { time: 50, medal: 'silver', setAt: 0 };
      p.records['north-pass'] = { time: 50, medal: 'silver', setAt: 0 };
    });
    const before = career.money;
    expect(await career.enter(FREE)).toBe(true);
    expect(career.money).toBe(before);

    expect(await career.enter(PAID)).toBe(true);
    expect(career.money).toBe(before - PAID.entryFee);
  });

  it('refuses entry it cannot afford', async () => {
    await career['save'].update((p) => {
      p.money = 10;
      p.records['pine-loop'] = { time: 50, medal: 'silver', setAt: 0 };
      p.records['north-pass'] = { time: 50, medal: 'silver', setAt: 0 };
    });
    expect(await career.enter(PAID)).toBe(false);
    expect(career.money).toBe(10);
  });

  it('pays out on a finish and carries the damage forward', async () => {
    const damage = career.buildDamage();
    damage.applyImpact(impactPointFromForce(HEAD_ON), 22_000);

    const before = career.money;
    const result = await career.settle(FREE, {
      medal: 'silver',
      time: 55,
      retired: false,
      damage,
    });

    expect(result.payout).toBe(FREE.payouts.silver);
    expect(career.money).toBe(before + FREE.payouts.silver);
    expect(result.repairs).toBeGreaterThan(0);

    // The damage is the car's now, not the run's.
    expect(career.condition).toBeLessThan(1);
    expect(career.repairBill().total).toBeGreaterThan(0);
  });

  it('pays nothing for a retirement, and still leaves the bill', async () => {
    const damage = career.buildDamage();
    for (let i = 0; i < 5; i++) damage.applyImpact(impactPointFromForce(HEAD_ON), 46_000);

    const before = career.money;
    const result = await career.settle(PAID, { medal: null, time: null, retired: true, damage });

    expect(result.payout).toBe(0);
    expect(career.money).toBe(before);
    expect(result.repairs).toBeGreaterThan(0);
    expect(result.net).toBeLessThan(0);
    // And a wrecked engine means the car cannot go out again as it is.
    expect(career.carIsDriveable).toBe(false);
  });

  it('lets damage be left unrepaired — that is the whole gamble', async () => {
    const damage = career.buildDamage();
    damage.applyImpact(impactPointFromForce(HEAD_ON), 20_000);
    await career.settle(FREE, { medal: 'bronze', time: 60, retired: false, damage });

    const carried = career.buildDamage();
    expect(carried.condition).toBeLessThan(1);
    // Still driveable, so the player may choose to race on and risk it.
    expect(career.carIsDriveable).toBe(true);
  });

  it('repairs everything when it can be afforded', async () => {
    const damage = career.buildDamage();
    damage.applyImpact(impactPointFromForce(HEAD_ON), 20_000);
    await career.settle(FREE, { medal: 'gold', time: 40, retired: false, damage });

    const bill = career.repairBill().total;
    const before = career.money;
    expect(await career.repairAll()).toBe(bill);
    expect(career.money).toBe(before - bill);
    expect(career.condition).toBe(1);
  });

  it('refuses a repair it cannot afford, and changes nothing', async () => {
    const damage = career.buildDamage();
    for (let i = 0; i < 4; i++) damage.applyImpact(impactPointFromForce(HEAD_ON), 40_000);
    await career.settle(FREE, { medal: null, time: null, retired: true, damage });

    await career['save'].update((p) => {
      p.money = 5;
    });
    expect(await career.repairAll()).toBe(0);
    expect(career.money).toBe(5);
    expect(career.condition).toBeLessThan(1);
  });

  it('repairs a single component, leaving the rest broken', async () => {
    const damage = career.buildDamage();
    damage.applyImpact(impactPointFromForce(HEAD_ON), 24_000);
    await career.settle(FREE, { medal: 'gold', time: 40, retired: false, damage });

    const worst = career.repairBill().lines[0]!;
    const spent = await career.repairComponent(worst.id);
    expect(spent).toBe(worst.cost);
    expect(career.buildDamage().get(worst.id)).toBe(1);
    expect(career.repairBill().total).toBeGreaterThan(0);
  });

  it('can fix just enough to get the car to the start line', async () => {
    const damage = career.buildDamage();
    for (let i = 0; i < 5; i++) damage.applyImpact(impactPointFromForce(HEAD_ON), 46_000);
    await career.settle(FREE, { medal: null, time: null, retired: true, damage });
    expect(career.carIsDriveable).toBe(false);

    // Enough in the bank that this tests the mechanism, not affordability.
    await career['save'].update((p) => {
      p.money = 50_000;
    });
    const fullBill = career.repairBill().total;
    const essentials = await career.repairEssentials();
    expect(essentials).toBeGreaterThan(0);
    // The point of the option: cheaper than putting the whole car right.
    expect(essentials).toBeLessThan(fullBill);
    expect(career.carIsDriveable).toBe(true);
    expect(career.repairBill().total).toBeGreaterThan(0);
  });

  it('buys upgrades and refuses what it cannot afford', async () => {
    const cost = nextCost(career.upgrades, 'brakes')!;
    await career['save'].update((p) => {
      p.money = cost;
    });

    expect(await career.buy('brakes')).toBe(true);
    expect(career.money).toBe(0);
    expect(career.tuning().brakeTorque).toBeGreaterThan(CAR.brakeTorque);
    expect(await career.buy('brakes')).toBe(false);
  });

  it('applies a fitted rollcage to the damage the car takes', async () => {
    const bare = career.buildDamage();
    await career['save'].update((p) => {
      p.upgrades.rollcage = 3;
    });
    const caged = career.buildDamage();

    for (const d of [bare, caged]) d.applyImpact(impactPointFromForce(HEAD_ON), 26_000);
    expect(caged.get('engine')).toBeGreaterThan(bare.get('engine'));
  });
});

describe('progression', () => {
  it('never locks the free stage', () => {
    expect(FREE.requiresMedals ?? 0).toBe(0);
    expect(canEnter(FREE, { money: 0, carIsDriveable: true, medals: 0 }).allowed).toBe(true);
  });

  it('locks a stage until enough medals are held', () => {
    const gated = { ...PAID, requiresMedals: 3 };
    expect(canEnter(gated, { money: 99_999, carIsDriveable: true, medals: 2 })).toEqual({
      allowed: false,
      reason: 'locked',
    });
    expect(canEnter(gated, { money: 99_999, carIsDriveable: true, medals: 3 }).allowed).toBe(true);
  });

  it('reports locked before poor, since locked is the more useful answer', () => {
    const gated = { ...PAID, requiresMedals: 3 };
    expect(canEnter(gated, { money: 0, carIsDriveable: false, medals: 0 }).reason).toBe('locked');
  });

  it('opens stages in a reachable order', () => {
    // Every stage must be reachable by medals earned on stages already open,
    // or the career dead-ends with money in the bank and nothing to spend it on.
    const byRequirement = [...STAGES].sort(
      (a, b) => (a.requiresMedals ?? 0) - (b.requiresMedals ?? 0),
    );
    byRequirement.forEach((stage, index) => {
      // With `index` stages already open, at most `index` medals can be held.
      expect(stage.requiresMedals ?? 0).toBeLessThanOrEqual(index);
    });
  });

  it('counts only stages actually medalled', async () => {
    const save = new SaveStore();
    await save.open();
    await save.clear();
    const career = new Career(save, STAGES);

    expect(career.medalsHeld).toBe(0);
    await career['save'].update((p) => {
      p.records['pine-loop'] = { time: 50, medal: 'silver', setAt: 0 };
      p.records['quarry-run'] = { time: 90, medal: 'finish', setAt: 0 };
    });
    // Finishing without a medal is not a medal.
    expect(career.medalsHeld).toBe(1);
  });
});
