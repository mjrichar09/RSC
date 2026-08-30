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
import { Career, type RaceTarget } from '../src/game/career.js';
import { RECOVERY_FLOOR, canEnter, ledger, payout } from '../src/game/economy.js';
import { UPGRADES, investedIn, nextCost, rollcageMitigation, tuneFor } from '../src/game/garage.js';
import { SaveStore, STARTING_MONEY } from '../src/game/save.js';
import { impactPointFromForce } from '../src/sim/damage.js';
import { v3 } from '../src/sim/math.js';
import { stageVariants } from '../src/sim/stage.js';

const FREE = STAGES.find((s) => s.entryFee === 0)!;
const PAID = STAGES.find((s) => s.entryFee > 0)!;

// What the career layer actually takes: a stage under particular conditions.
// The baseline variant is clear daylight, carrying the stage's own numbers.
const FREE_T: RaceTarget = { def: FREE, variant: stageVariants(FREE)[0]! };
const PAID_T: RaceTarget = { def: PAID, variant: stageVariants(PAID)[0]! };
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

  it('offers every stage-and-conditions pairing as its own race', () => {
    const targets = career.targets();
    // Every stage contributes at least its clear-daylight baseline.
    expect(targets.length).toBeGreaterThan(STAGES.length);
    // Keys are unique, or two variants would share one record and one ghost.
    const keys = targets.map((t) => career.keyFor(t));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(`${FREE.id}:day-clear`);
  });

  it('makes a harder variant its own entry, paying more and unlocking later', () => {
    const variants = career.targets().filter((t) => t.def.id === FREE.id);
    const base = variants[0]!;
    const harder = variants[1];
    // The free stage has at least one alternative set of conditions to race.
    expect(harder).toBeDefined();
    expect(harder!.variant.payouts.gold).toBeGreaterThan(base.variant.payouts.gold);
    expect(harder!.variant.requiresMedals).toBeGreaterThan(base.variant.requiresMedals);
    // Locked to begin with, and by its own requirement rather than the stage's.
    expect(career.canEnter(harder!)).toMatchObject({ allowed: false, reason: 'locked' });
  });

  it('keeps a record per variant, so a night time never displaces a day one', async () => {
    const [base, harder] = career.targets().filter((t) => t.def.id === FREE.id);
    await career.settle(base!, {
      medal: 'gold',
      time: 40,
      retired: false,
      damage: career.buildDamage(),
      ghost: { stageId: base!.def.id, time: 40, recordedAt: 0, frames: new Float32Array(0) },
    });
    expect(career.recordFor(base!)?.time).toBe(40);
    expect(career.recordFor(harder!)).toBeNull();
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
    expect(await career.enter(FREE_T)).toBe(true);
    expect(career.money).toBe(before);

    expect(await career.enter(PAID_T)).toBe(true);
    expect(career.money).toBe(before - PAID.entryFee);
  });

  it('refuses entry it cannot afford', async () => {
    await career['save'].update((p) => {
      p.money = 10;
      p.records['pine-loop'] = { time: 50, medal: 'silver', setAt: 0 };
      p.records['north-pass'] = { time: 50, medal: 'silver', setAt: 0 };
    });
    expect(await career.enter(PAID_T)).toBe(false);
    expect(career.money).toBe(10);
  });

  it('pays out on a finish and carries the damage forward', async () => {
    const damage = career.buildDamage();
    damage.applyImpact(impactPointFromForce(HEAD_ON), 22_000);

    const before = career.money;
    const result = await career.settle(FREE_T, {
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
    const result = await career.settle(PAID_T, { medal: null, time: null, retired: true, damage });

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
    await career.settle(FREE_T, { medal: 'bronze', time: 60, retired: false, damage });

    const carried = career.buildDamage();
    expect(carried.condition).toBeLessThan(1);
    // Still driveable, so the player may choose to race on and risk it.
    expect(career.carIsDriveable).toBe(true);
  });

  it('repairs everything when it can be afforded', async () => {
    const damage = career.buildDamage();
    damage.applyImpact(impactPointFromForce(HEAD_ON), 20_000);
    await career.settle(FREE_T, { medal: 'gold', time: 40, retired: false, damage });

    const bill = career.repairBill().total;
    const before = career.money;
    expect(await career.repairAll()).toBe(bill);
    expect(career.money).toBe(before - bill);
    expect(career.condition).toBe(1);
  });

  it('refuses a repair it cannot afford, and changes nothing', async () => {
    const damage = career.buildDamage();
    for (let i = 0; i < 4; i++) damage.applyImpact(impactPointFromForce(HEAD_ON), 40_000);
    await career.settle(FREE_T, { medal: null, time: null, retired: true, damage });

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
    await career.settle(FREE_T, { medal: 'gold', time: 40, retired: false, damage });

    const worst = career.repairBill().lines[0]!;
    const spent = await career.repairComponent(worst.id);
    expect(spent).toBe(worst.cost);
    expect(career.buildDamage().get(worst.id)).toBe(1);
    expect(career.repairBill().total).toBeGreaterThan(0);
  });

  it('can fix just enough to get the car to the start line', async () => {
    const damage = career.buildDamage();
    // Hard enough to stop the car, not hard enough to write it off. Five hits
    // at 46 kN·s now destroy literally everything — a structural impact folds
    // the whole shell rather than just what it landed on — and then "just
    // enough to start" and "the whole car" are the same bill, which is a true
    // statement about a total loss and not what this option is for.
    for (let i = 0; i < 3; i++) damage.applyImpact(impactPointFromForce(HEAD_ON), 26_000);
    await career.settle(FREE_T, { medal: null, time: null, retired: true, damage });
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

describe('the dead end, and the ways out of it', () => {
  let career: Career;
  let save: SaveStore;

  beforeEach(async () => {
    save = new SaveStore();
    await save.open();
    await save.clear();
    career = new Career(save, STAGES);
  });

  /** Wreck the engine and empty the wallet: the one state with no move in it. */
  const stranded = async () => {
    await save.update((p) => {
      p.money = 40;
      p.carHealth = { engine: 0, cooling: 0 };
    });
  };

  it('recognises a car that cannot start and cannot be afforded', async () => {
    await stranded();
    expect(career.carIsDriveable).toBe(false);
    expect(career.essentialsCost()).toBeGreaterThan(career.money);
    // Every stage is refused, including the free one — which is the dead end.
    expect(career.targets().every((t) => !career.canEnter(t).allowed)).toBe(true);
    expect(career.canSalvage).toBe(true);
  });

  it('salvages the car back to something that runs, for everything you have', async () => {
    await stranded();
    expect(await career.salvage()).toBe(true);

    expect(career.money).toBe(0);
    expect(career.carIsDriveable).toBe(true);
    // Badly: a quarter health is a car that overheats, pulls and wants doing
    // properly. It is the worst deal in the game and that is the point.
    expect(career.profile.carHealth.engine).toBe(0.25);
    // And the free stage is enterable again, which is the whole purpose.
    const free = career.targets().find((t) => t.variant.entryFee === 0)!;
    expect(career.canEnter(free).allowed).toBe(true);
  });

  it('is not offered when the player can simply pay', async () => {
    await save.update((p) => {
      p.money = 20_000;
      p.carHealth = { engine: 0 };
    });
    expect(career.canSalvage).toBe(false);
    expect(await career.salvage()).toBe(false);
    expect(await career.repairEssentials()).toBeGreaterThan(0);
    expect(career.carIsDriveable).toBe(true);
  });

  it('resets a career without resetting the player', async () => {
    await save.update((p) => {
      p.money = 12;
      p.carHealth = { engine: 0.1 };
      p.upgrades = { rollcage: 2 } as never;
      p.records['pine-loop:day-clear'] = { time: 61.2, medal: 'gold', setAt: 1 };
      p.settings.vision = 0.35;
    });

    await career.reset();

    expect(career.money).toBe(STARTING_MONEY);
    expect(career.profile.records).toEqual({});
    expect(career.profile.upgrades).toEqual({});
    expect(career.profile.carHealth).toEqual({});
    // The windscreen strength is a taste setting, not a career achievement.
    expect(career.profile.settings.vision).toBe(0.35);
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

  it('opens every variant in a reachable order too', async () => {
    // The same dead-end rule, but counted across variants: a night run is a
    // medal of its own, so the ladder is longer and easy to mis-gate.
    const save = new SaveStore();
    await save.open();
    await save.clear();
    const targets = new Career(save, STAGES).targets();
    targets.forEach((target, index) => {
      expect(target.variant.requiresMedals).toBeLessThanOrEqual(index);
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
