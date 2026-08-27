/**
 * Money.
 *
 * The economy exists to give damage a consequence. Repairs are the cost of how
 * you drove; entry fees are the cost of where you race; payouts are what you
 * earn back. The tension the whole game runs on is that a good run on an
 * expensive stage pays less than a bad crash costs, so pace has to be weighed
 * against risk rather than simply maximised.
 *
 * One rule keeps that from becoming a dead end: the basic stage is free to
 * enter and pays a guaranteed floor, so being broke is a setback rather than a
 * game over.
 */

import type { Medal } from './race.js';
import type { StageDef } from '../sim/stage.js';

export interface Payouts {
  author: number;
  gold: number;
  silver: number;
  bronze: number;
  finish: number;
}

/**
 * Guaranteed minimum from a free stage when the player cannot afford anything
 * else. In practice the free stage's ordinary payouts already clear the
 * cheapest entry fee, so this is a guard against a future tuning change
 * quietly creating a dead end rather than something players will normally see.
 */
export const RECOVERY_FLOOR = 260;

export const payoutFor = (medal: Medal, payouts: Payouts): number => payouts[medal];

/**
 * What a finished run actually pays.
 *
 * A player who cannot afford the cheapest entry fee gets the recovery floor on
 * a free stage, however badly they drove. Without it, one expensive crash could
 * leave someone unable to enter anything.
 */
export function payout(
  stage: StageDef,
  medal: Medal,
  options: { money: number; cheapestFee: number },
): { amount: number; floored: boolean } {
  const earned = payoutFor(medal, stage.payouts);
  const broke = options.money < options.cheapestFee;
  // Enough to get back into the cheapest paid stage, whatever the payouts say.
  const floor = Math.max(RECOVERY_FLOOR, options.cheapestFee);
  if (stage.entryFee === 0 && broke && earned < floor) {
    return { amount: floor, floored: true };
  }
  return { amount: earned, floored: false };
}

export type EntryRefusal = 'too-poor' | 'undriveable' | 'locked';

export interface EntryCheck {
  allowed: boolean;
  reason: EntryRefusal | null;
}

/**
 * Whether a stage can be entered.
 *
 * A car with a failed component cannot start at all — you have to repair it
 * first, which is what makes declining a repair a real gamble rather than free
 * money.
 */
export function canEnter(
  stage: StageDef,
  options: { money: number; carIsDriveable: boolean; medals?: number },
): EntryCheck {
  // Locked first: it is a fact about progress rather than about this moment,
  // and telling a player they cannot afford a stage they have not unlocked is
  // the less useful of the two answers.
  if ((stage.requiresMedals ?? 0) > (options.medals ?? 0)) {
    return { allowed: false, reason: 'locked' };
  }
  if (!options.carIsDriveable) return { allowed: false, reason: 'undriveable' };
  if (options.money < stage.entryFee) return { allowed: false, reason: 'too-poor' };
  return { allowed: true, reason: null };
}

/** Ledger for one attempt, shown on the results screen. */
export interface RunLedger {
  entryFee: number;
  payout: number;
  repairs: number;
  floored: boolean;
  net: number;
}

export function ledger(entryFee: number, earned: number, repairs: number, floored = false): RunLedger {
  return { entryFee, payout: earned, repairs, floored, net: earned - entryFee - repairs };
}
