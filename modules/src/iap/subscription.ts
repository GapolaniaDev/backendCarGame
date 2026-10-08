// Phase 9 Chunk 4 — Pure subscription helpers.
//
// All functions in this file are PURE: no I/O, no `nk.*` calls. The
// RPC and scanner layers drive the actual storage; this module just
// computes the derived state. The shape is a single per-user record
// stored at `iap_subscriptions/{userId}` (R=1/W=0).

const MS_PER_DAY = 86_400_000;

export interface IapSubscription {
  userId: string;
  packId: string;
  platform: 'apple' | 'google';
  /** First-ever transaction id (renewals keep the same value). */
  originalTransactionId: string;
  /** Most recent transaction id (renewals update this). */
  latestTransactionId: string;
  activatedAtUtc: number;
  /** Subscription term end. Renewals bump this by `durationDays`. */
  expiresAtUtc: number;
  /** When the user cancelled (if they did). `undefined` = still active. */
  cancelledAtUtc?: number;
  autoRenewing: boolean;
  renewalHistory: Array<{
    transactionId: string;
    renewedAtUtc: number;
    expiresAtUtc: number;
    monthlyCoinsGranted: number;
  }>;
  /** True if the current cycle's monthly grant has been applied. */
  monthlyCosmeticGranted: boolean;
  /** True if the expiring-soon warning has been sent for the current cycle. */
  warnedExpiring?: boolean;
  /** True if the expired notification has been sent for the current cycle. */
  expiredNotified?: boolean;
}

export function isActive(sub: IapSubscription, nowUtc: number): boolean {
  return sub.expiresAtUtc > nowUtc;
}

export function isExpired(sub: IapSubscription, nowUtc: number): boolean {
  return sub.expiresAtUtc <= nowUtc;
}

export function timeRemainingMs(sub: IapSubscription, nowUtc: number): number {
  return Math.max(0, sub.expiresAtUtc - nowUtc);
}

export function shouldWarnExpiring(
  sub: IapSubscription,
  nowUtc: number,
  warningWindowDays: number = 7,
): boolean {
  if (!isActive(sub, nowUtc)) return false;
  if (sub.warnedExpiring === true) return false;
  const remaining = sub.expiresAtUtc - nowUtc;
  return remaining <= warningWindowDays * MS_PER_DAY && remaining > 0;
}

/** Pure: returns a new sub with extended expiry. Original is untouched. */
export function extendExpiry(
  sub: IapSubscription,
  newExpiresAtUtc: number,
): IapSubscription {
  return { ...sub, expiresAtUtc: newExpiresAtUtc };
}

/** Pure: returns a new sub marked cancelled. autoRenewing→false. */
export function markCancelled(
  sub: IapSubscription,
  cancelledAtUtc: number,
): IapSubscription {
  return { ...sub, cancelledAtUtc, autoRenewing: false };
}
