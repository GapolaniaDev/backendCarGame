// Phase 9 Chunk 3 — Pure grant planner for IAP purchases.
//
// Decides WHAT to grant (coins / cosmetic / subscription activation)
// based on the pack kind + first-time flag. PURE: no I/O. The RPC
// layer (rpcs.ts) drives storage and wallet updates from this plan.
//
// Subscriptions are stubbed in this chunk: Chunk 4 wires the full
// renewal / cancel / grace-period flow. The plan only records the
// first-month expiry timestamp.

import type { IapPack } from './types';

export interface IapGrantPlan {
  /** Coins to credit. 0 for non-consumable / subscription. */
  coins: number;
  /** First-time bonus coins. 0 unless `isFirstTime` is true. */
  firstTimeBonus: number;
  /** Cosmetic id (non-consumable only). */
  cosmeticId?: string;
  /** Subscription id (subscription only) = pack.id. */
  subscriptionId?: string;
  /** Monthly coin grant (subscription only). */
  monthlyCoins?: number;
  /** Monthly cosmetic id (subscription only). */
  monthlyCosmeticId?: string;
  /** First-month expiry UTC ms (subscription only). */
  expiresAtUtc?: number;
}

const MS_PER_DAY = 86_400_000;

export function planGrant(
  pack: IapPack,
  isFirstTime: boolean,
  nowUtc: number,
): IapGrantPlan {
  if (pack.kind === 'consumable') {
    return {
      coins: pack.baseCoins,
      firstTimeBonus: isFirstTime ? pack.firstTimeBonus : 0,
    };
  }
  if (pack.kind === 'non_consumable') {
    return {
      coins: 0,
      firstTimeBonus: 0,
      cosmeticId: pack.cosmeticId,
    };
  }
  // subscription
  return {
    coins: 0,
    firstTimeBonus: 0,
    subscriptionId: pack.id,
    monthlyCoins: pack.monthlyCoins,
    monthlyCosmeticId: pack.monthlyCosmeticId,
    expiresAtUtc: nowUtc + pack.durationDays * MS_PER_DAY,
  };
}

/** Total coins credited in one go. Used by the wallet grant call. */
export function totalCoins(plan: IapGrantPlan): number {
  return plan.coins + plan.firstTimeBonus;
}
