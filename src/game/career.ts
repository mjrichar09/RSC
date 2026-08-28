/**
 * Career state: money, upgrades, and the car's condition between races.
 *
 * This is the layer that makes the damage model matter. Damage belongs to the
 * car, not to the run, so it follows you to the next start line unless you pay
 * to put it right — and paying is the choice the whole economy turns on.
 */

import { type EntryCheck, type RunLedger, canEnter, ledger, payout } from './economy.js';
import { type UpgradeId, type UpgradeLevels, levelOf, nextCost, rollcageMitigation, tuneFor } from './garage.js';
import type { Medal } from './race.js';
import type { Profile, SaveStore } from './save.js';
import { COMPONENTS, type ComponentId, DamageModel } from '../sim/damage.js';
import type { VehicleTuning } from '../data/tuning.js';
import { type StageDef, type StageVariant, stageVariants, variantKey } from '../sim/stage.js';

/** A stage under particular conditions — what a player actually enters. */
export interface RaceTarget {
  def: StageDef;
  variant: StageVariant;
}

/**
 * Every stage-and-conditions pairing available in the game, in the order they
 * open up.
 *
 * Sorting by unlock requirement rather than by stage keeps the garage list a
 * progression: grouped per stage it zig-zagged, offering a five-medal night
 * variant of the first stage above the one-medal second stage. It also makes
 * the numbered shortcut keys mean something.
 */
export const allTargets = (stages: StageDef[]): RaceTarget[] =>
  stages
    .flatMap((def) => stageVariants(def).map((variant) => ({ def, variant })))
    .sort((a, b) => a.variant.requiresMedals - b.variant.requiresMedals || a.variant.entryFee - b.variant.entryFee);

export interface SettleResult extends RunLedger {
  medal: Medal | null;
  retired: boolean;
  newRecord: boolean;
}

export class Career {
  private readonly save: SaveStore;
  private readonly stages: StageDef[];

  constructor(save: SaveStore, stages: StageDef[]) {
    this.save = save;
    this.stages = stages;
  }

  get profile(): Profile {
    return this.save.getProfile();
  }

  get money(): number {
    return this.profile.money;
  }

  get upgrades(): UpgradeLevels {
    return this.profile.upgrades;
  }

  /** The cheapest stage anyone can enter — the anti-softlock reference point. */
  get cheapestFee(): number {
    return Math.min(...allTargets(this.stages).map((t) => t.variant.entryFee));
  }

  /** Everything the player can see in the garage. */
  targets(): RaceTarget[] {
    return allTargets(this.stages);
  }

  /** Record key for a target: stage and conditions together. */
  keyFor(target: RaceTarget): string {
    return variantKey(target.def.id, target.variant.id);
  }

  /** Tuning with the fitted upgrades applied. */
  tuning(): VehicleTuning {
    return tuneFor(this.upgrades);
  }

  /** A fresh damage model carrying whatever condition the car is already in. */
  buildDamage(): DamageModel {
    const model = new DamageModel({ rollcage: rollcageMitigation(this.upgrades) });
    for (const [id, health] of Object.entries(this.profile.carHealth)) {
      if (typeof health === 'number') model.health.set(id as ComponentId, health);
    }
    // The shape of the damage as well as its price: a car that arrives at the
    // start line with a folded wing should still have the fold.
    model.dents.push(...this.profile.carDents.map((dent) => ({ ...dent, at: { ...dent.at } })));
    model.dentVersion++;
    // Health is what persists; the failures it implies have to be re-derived,
    // or a car with a destroyed engine comes back looking perfectly driveable.
    model.refreshFailures();
    return model;
  }

  /** False when something is broken badly enough that the car cannot start. */
  get carIsDriveable(): boolean {
    return this.buildDamage().retired === false;
  }

  /** Overall condition of the car sitting in the garage, 0..1. */
  get condition(): number {
    return this.buildDamage().condition;
  }

  /** Risks worth showing before the player pays to enter a stage. */
  warnings(): ReturnType<DamageModel['warnings']> {
    return this.buildDamage().warnings();
  }

  /**
   * Medals held. Each stage-and-conditions pairing counts separately, so a
   * night variant is its own achievement rather than a repeat of the day one.
   */
  get medalsHeld(): number {
    return Object.values(this.profile.records).filter((r) => r.medal !== 'finish').length;
  }

  canEnter(target: RaceTarget): EntryCheck {
    // A variant carries its own fee and its own unlock requirement, so the
    // check runs against the variant rather than its parent stage.
    return canEnter(
      { ...target.def, entryFee: target.variant.entryFee, requiresMedals: target.variant.requiresMedals },
      { money: this.money, carIsDriveable: this.carIsDriveable, medals: this.medalsHeld },
    );
  }

  /** Take the entry fee. Returns false when the target cannot be entered. */
  async enter(target: RaceTarget): Promise<boolean> {
    if (!this.canEnter(target).allowed) return false;
    await this.save.update((p) => {
      p.money -= target.variant.entryFee;
    });
    return true;
  }

  /** Best time and medal for a target, or null if never completed. */
  recordFor(target: RaceTarget) {
    return this.save.recordFor(this.keyFor(target));
  }

  /**
   * Settle a completed attempt: pay out, carry the damage forward, and store
   * the ghost if it was a new best. Repairs are deliberately *not* charged
   * here — that is a separate decision the player makes in the garage.
   */
  async settle(
    target: RaceTarget,
    outcome: {
      medal: Medal | null;
      time: number | null;
      retired: boolean;
      damage: DamageModel;
      ghost?: Parameters<SaveStore['submitRun']>[3];
    },
  ): Promise<SettleResult> {
    const repairs = outcome.damage.repairBill().total;

    // Carry the car's condition forward, including any failed components.
    const carHealth: Partial<Record<ComponentId, number>> = {};
    for (const c of COMPONENTS) carHealth[c.id] = outcome.damage.get(c.id);
    const carDents = outcome.damage.dents.map((dent) => ({ ...dent, at: { ...dent.at } }));

    let earned = 0;
    let floored = false;
    if (!outcome.retired && outcome.medal) {
      const result = payout(
        { ...target.def, entryFee: target.variant.entryFee, payouts: target.variant.payouts },
        outcome.medal,
        { money: this.money, cheapestFee: this.cheapestFee },
      );
      earned = result.amount;
      floored = result.floored;
    }

    let newRecord = false;
    if (!outcome.retired && outcome.medal && outcome.time !== null && outcome.ghost) {
      newRecord = await this.save.submitRun(
        this.keyFor(target),
        outcome.time,
        outcome.medal,
        outcome.ghost,
      );
    }

    await this.save.update((p) => {
      p.money += earned;
      p.carHealth = carHealth;
      p.carDents = carDents;
      p.totals.earned += earned;
      if (outcome.retired) p.totals.retirements += 1;
    });

    return {
      ...ledger(target.variant.entryFee, earned, repairs, floored),
      medal: outcome.retired ? null : outcome.medal,
      retired: outcome.retired,
      newRecord,
    };
  }

  /** Itemised repair bill for the car's current condition. */
  repairBill(): ReturnType<DamageModel['repairBill']> {
    return this.buildDamage().repairBill();
  }

  /** Repair everything, if it can be afforded. Returns what was spent. */
  async repairAll(): Promise<number> {
    const bill = this.repairBill();
    if (bill.total === 0 || bill.total > this.money) return 0;
    await this.save.update((p) => {
      p.money -= bill.total;
      p.carHealth = {};
      // A full repair straightens the panels too. Anything less leaves them:
      // paying to fix the radiator does not take the dents out of the wing.
      p.carDents = [];
      p.totals.spentOnRepairs += bill.total;
    });
    return bill.total;
  }

  /**
   * Repair a single component.
   *
   * Repairing piecemeal is the interesting move when money is tight: fix the
   * radiator so the car can finish, and live with the bent panels.
   */
  async repairComponent(id: ComponentId): Promise<number> {
    const line = this.repairBill().lines.find((l) => l.id === id);
    if (!line || line.cost > this.money) return 0;
    await this.save.update((p) => {
      p.money -= line.cost;
      p.carHealth[id] = 1;
      p.totals.spentOnRepairs += line.cost;
    });
    return line.cost;
  }

  /** Repair only what is stopping the car from starting. */
  async repairEssentials(): Promise<number> {
    const damage = this.buildDamage();
    if (!damage.retired) return 0;

    const broken = COMPONENTS.filter((c) => damage.get(c.id) <= 0);
    const cost = this.repairBill().lines.filter((l) => broken.some((b) => b.id === l.id));
    const total = cost.reduce((a, l) => a + l.cost, 0);
    if (total === 0 || total > this.money) return 0;

    await this.save.update((p) => {
      p.money -= total;
      for (const line of cost) p.carHealth[line.id] = 1;
      p.totals.spentOnRepairs += total;
    });
    return total;
  }

  /**
   * What it would cost to make the car able to start at all.
   *
   * Separate from `repairEssentials` because the garage has to say the number
   * before the player can decide whether they can pay it.
   */
  essentialsCost(): number {
    const damage = this.buildDamage();
    if (!damage.retired) return 0;
    const broken = new Set(COMPONENTS.filter((c) => damage.get(c.id) <= 0).map((c) => c.id));
    return this.repairBill()
      .lines.filter((l) => broken.has(l.id))
      .reduce((total, line) => total + line.cost, 0);
  }

  /**
   * The dead end, and the way out of it.
   *
   * A big enough accident can leave the car unable to start and the player
   * unable to afford the repair that would let them earn the money for it.
   * Every other tight spot in this game is a decision; that one is just over.
   *
   * So: a salvage job. It takes whatever money is left and puts the failed
   * components back together badly — a quarter health, which drives, overheats,
   * pulls and will need doing properly the moment there is money for it. It is
   * deliberately the worst deal in the game, and it is only ever offered when
   * the alternative is not playing.
   */
  get canSalvage(): boolean {
    return !this.carIsDriveable && this.essentialsCost() > this.money;
  }

  async salvage(): Promise<boolean> {
    if (!this.canSalvage) return false;
    const damage = this.buildDamage();
    const broken = COMPONENTS.filter((c) => damage.get(c.id) <= 0).map((c) => c.id);
    const spent = this.money;
    await this.save.update((p) => {
      p.money = 0;
      for (const id of broken) p.carHealth[id] = 0.25;
      p.totals.spentOnRepairs += spent;
    });
    return true;
  }

  /** Start the career again from nothing. Keeps the player's settings. */
  async reset(): Promise<void> {
    await this.save.clear({ keepSettings: true });
  }

  canBuy(id: UpgradeId): boolean {
    const cost = nextCost(this.upgrades, id);
    return cost !== null && cost <= this.money;
  }

  async buy(id: UpgradeId): Promise<boolean> {
    const cost = nextCost(this.upgrades, id);
    if (cost === null || cost > this.money) return false;
    await this.save.update((p) => {
      p.money -= cost;
      p.upgrades[id] = levelOf(p.upgrades, id) + 1;
      p.totals.spentOnUpgrades += cost;
    });
    return true;
  }
}
