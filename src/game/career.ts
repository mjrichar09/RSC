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
import type { StageDef } from '../sim/stage.js';

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
    return Math.min(...this.stages.map((s) => s.entryFee));
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

  /** Stages the player holds at least a bronze on. Drives what is unlocked. */
  get medalsHeld(): number {
    return Object.values(this.profile.records).filter((r) => r.medal !== 'finish').length;
  }

  canEnter(stage: StageDef): EntryCheck {
    return canEnter(stage, {
      money: this.money,
      carIsDriveable: this.carIsDriveable,
      medals: this.medalsHeld,
    });
  }

  /** Take the entry fee. Returns false when the stage cannot be entered. */
  async enter(stage: StageDef): Promise<boolean> {
    if (!this.canEnter(stage).allowed) return false;
    await this.save.update((p) => {
      p.money -= stage.entryFee;
    });
    return true;
  }

  /**
   * Settle a completed attempt: pay out, carry the damage forward, and store
   * the ghost if it was a new best. Repairs are deliberately *not* charged
   * here — that is a separate decision the player makes in the garage.
   */
  async settle(
    stage: StageDef,
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

    let earned = 0;
    let floored = false;
    if (!outcome.retired && outcome.medal) {
      const result = payout(stage, outcome.medal, {
        money: this.money,
        cheapestFee: this.cheapestFee,
      });
      earned = result.amount;
      floored = result.floored;
    }

    let newRecord = false;
    if (!outcome.retired && outcome.medal && outcome.time !== null && outcome.ghost) {
      newRecord = await this.save.submitRun(stage.id, outcome.time, outcome.medal, outcome.ghost);
    }

    await this.save.update((p) => {
      p.money += earned;
      p.carHealth = carHealth;
      p.totals.earned += earned;
      if (outcome.retired) p.totals.retirements += 1;
    });

    return {
      ...ledger(stage.entryFee, earned, repairs, floored),
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
