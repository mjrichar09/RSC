/**
 * Upgrades.
 *
 * Every upgrade is a trade, not a straight improvement: more power makes the
 * car harder to place, a rollcage costs weight, soft tyres wear the fastest.
 * An upgrade tree where every purchase is strictly better turns money into a
 * formality, and the economy stops being a decision.
 */

import { CAR, type VehicleTuning } from '../data/tuning.js';

export type UpgradeId =
  | 'engine'
  | 'turbo'
  | 'gearbox'
  | 'suspension'
  | 'brakes'
  | 'tyres'
  | 'weight'
  | 'rollcage';

export interface UpgradeDef {
  id: UpgradeId;
  label: string;
  description: string;
  /** Cost of each level, in order. Length is the maximum level. */
  costs: number[];
}

export const UPGRADES: UpgradeDef[] = [
  {
    id: 'engine',
    label: 'Engine',
    description: '+9% torque per level. Faster everywhere, and harder to place on loose surfaces.',
    costs: [2400, 5800, 12500, 25000],
  },
  {
    id: 'turbo',
    label: 'Turbo',
    description: '+7% torque per level, and more heat. A holed radiator becomes a shorter fuse.',
    costs: [3200, 7600, 16000],
  },
  {
    id: 'gearbox',
    label: 'Gearbox',
    description: 'Shorter shifts and a wider limited-slip bias. Sharper corner exits.',
    costs: [2800, 6400, 13500],
  },
  {
    id: 'suspension',
    label: 'Suspension',
    description: 'Stiffer springs and better anti-roll. More grip, less forgiving over crests.',
    costs: [2200, 5200, 11000],
  },
  {
    id: 'brakes',
    label: 'Brakes',
    description: '+12% brake torque per level. Later braking, more chance of locking a wheel.',
    costs: [1800, 4200, 9000],
  },
  {
    id: 'tyres',
    label: 'Tyres',
    description: '+6% peak grip per level. Softer compounds: quicker, snappier at the limit, and they wear noticeably faster.',
    costs: [2600, 6200, 13000],
  },
  {
    id: 'weight',
    label: 'Weight reduction',
    description: '−4% mass per level. Better in every direction, and less forgiving of impacts.',
    costs: [3400, 8200, 17500],
  },
  {
    id: 'rollcage',
    label: 'Rollcage',
    description: 'Cuts damage to mechanical parts by 18% per level. Adds weight; does nothing for bodywork.',
    costs: [2000, 4800, 10500],
  },
];

export const UPGRADE_BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

export type UpgradeLevels = Partial<Record<UpgradeId, number>>;

export const levelOf = (levels: UpgradeLevels, id: UpgradeId): number => levels[id] ?? 0;

export const maxLevel = (id: UpgradeId): number => UPGRADE_BY_ID.get(id)?.costs.length ?? 0;

/** Cost of the next level, or null when it is already maxed. */
export function nextCost(levels: UpgradeLevels, id: UpgradeId): number | null {
  const def = UPGRADE_BY_ID.get(id);
  if (!def) return null;
  const level = levelOf(levels, id);
  return level >= def.costs.length ? null : def.costs[level]!;
}

/** Total spent on a set of upgrades, used for the car's resale value in the UI. */
export function investedIn(levels: UpgradeLevels): number {
  let total = 0;
  for (const def of UPGRADES) {
    for (let i = 0; i < levelOf(levels, def.id); i++) total += def.costs[i]!;
  }
  return total;
}

/** Damage mitigation the fitted rollcage provides, 0..1. */
export const rollcageMitigation = (levels: UpgradeLevels): number =>
  Math.min(levelOf(levels, 'rollcage') * 0.18, 0.72);

/**
 * Apply fitted upgrades to the baseline car.
 *
 * Returns a new tuning object; the baseline in `data/tuning.ts` is never
 * mutated, so the handling tests and the sweep tool always measure the stock
 * car.
 */
export function tuneFor(levels: UpgradeLevels): VehicleTuning {
  const t: VehicleTuning = { ...CAR };

  const engine = levelOf(levels, 'engine');
  const turbo = levelOf(levels, 'turbo');
  if (engine > 0 || turbo > 0) {
    const scale = 1 + engine * 0.09 + turbo * 0.07;
    t.torqueCurve = CAR.torqueCurve.map(([rpm, nm]) => [rpm, nm * scale] as const);
  }

  const gearbox = levelOf(levels, 'gearbox');
  if (gearbox > 0) {
    t.shiftTime = CAR.shiftTime * (1 - gearbox * 0.22);
    t.lsdBias = Math.min(CAR.lsdBias + gearbox * 0.04, 0.5);
  }

  const suspension = levelOf(levels, 'suspension');
  if (suspension > 0) {
    t.suspensionStiffness = CAR.suspensionStiffness * (1 + suspension * 0.1);
    t.suspensionDamping = CAR.suspensionDamping * (1 + suspension * 0.08);
    t.antiRollStiffness = CAR.antiRollStiffness * (1 + suspension * 0.14);
  }

  const brakes = levelOf(levels, 'brakes');
  if (brakes > 0) t.brakeTorque = CAR.brakeTorque * (1 + brakes * 0.12);

  const tyres = levelOf(levels, 'tyres');
  if (tyres > 0) {
    t.tireGrip = CAR.tireGrip * (1 + tyres * 0.06);
    // Grippier tyres let go later but more abruptly — the trade for the pace.
    t.slideGripFloor = Math.max(CAR.slideGripFloor - tyres * 0.03, 0.55);
    // And a softer compound is a consumable: pace now, tyre bills later.
    t.tireWearRate = CAR.tireWearRate * (1 + tyres * 0.35);
  }

  const weight = levelOf(levels, 'weight');
  const cage = levelOf(levels, 'rollcage');
  const massScale = (1 - weight * 0.04) * (1 + cage * 0.022);
  if (massScale !== 1) t.mass = Math.round(CAR.mass * massScale);

  return t;
}
