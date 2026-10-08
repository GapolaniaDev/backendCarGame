// Phase 9 Chunk 4 — Subscription storage.
//
// One row per user at `iap_subscriptions/{userId}` (R=1/W=0). Apple
// and Google both enforce "one active subscription per store
// account" so a single row is enough; a user who buys a different
// subscription pack replaces the old row (the old sub expires
// naturally on its own expiresAtUtc).
//
// The row carries the full state: originalTransactionId (for renewal
// detection), latestTransactionId (for cancel ownership check),
// activatedAtUtc, expiresAtUtc, cancelledAtUtc?, autoRenewing,
// renewalHistory[] (audit trail of renewals), and a
// monthlyCosmeticGranted flag to gate the per-cycle cosmetic grant.

import type { IStorageObject, INakama } from '../nkruntime';
import type { IapSubscription } from './subscription';
import type { IapPlatform } from './types';

export const SUBSCRIPTIONS_COLLECTION = 'iap_subscriptions';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asSubscription(v: unknown, userId: string): IapSubscription | null {
  if (!isPlainObject(v)) return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r['packId'] !== 'string'
    || typeof r['originalTransactionId'] !== 'string'
    || typeof r['latestTransactionId'] !== 'string'
    || typeof r['activatedAtUtc'] !== 'number'
    || typeof r['expiresAtUtc'] !== 'number'
    || typeof r['autoRenewing'] !== 'boolean'
  ) {
    return null;
  }
  const platform = r['platform'];
  if (platform !== 'apple' && platform !== 'google') return null;
  const history = Array.isArray(r['renewalHistory'])
    ? (r['renewalHistory'] as Array<Record<string, unknown>>).map((h) => ({
        transactionId: typeof h['transactionId'] === 'string' ? (h['transactionId'] as string) : '',
        renewedAtUtc: typeof h['renewedAtUtc'] === 'number' ? (h['renewedAtUtc'] as number) : 0,
        expiresAtUtc: typeof h['expiresAtUtc'] === 'number' ? (h['expiresAtUtc'] as number) : 0,
        monthlyCoinsGranted: typeof h['monthlyCoinsGranted'] === 'number' ? (h['monthlyCoinsGranted'] as number) : 0,
      }))
    : [];
  return {
    userId,
    packId: r['packId'] as string,
    platform: platform as IapPlatform,
    originalTransactionId: r['originalTransactionId'] as string,
    latestTransactionId: r['latestTransactionId'] as string,
    activatedAtUtc: r['activatedAtUtc'] as number,
    expiresAtUtc: r['expiresAtUtc'] as number,
    ...(typeof r['cancelledAtUtc'] === 'number' ? { cancelledAtUtc: r['cancelledAtUtc'] as number } : {}),
    autoRenewing: r['autoRenewing'] as boolean,
    renewalHistory: history,
    monthlyCosmeticGranted: r['monthlyCosmeticGranted'] === true,
    ...(r['warnedExpiring'] === true ? { warnedExpiring: true } : {}),
    ...(r['expiredNotified'] === true ? { expiredNotified: true } : {}),
  };
}

export function readSubscription(nk: INakama, userId: string): IapSubscription | null {
  const reads = nk.storageRead([
    { collection: SUBSCRIPTIONS_COLLECTION, key: userId, userId },
  ]);
  const obj = reads[0];
  if (!obj || obj.value === undefined) return null;
  return asSubscription(obj.value, userId);
}

export function readSubscriptionWithVersion(
  nk: INakama,
  userId: string,
): { version: string; value: IapSubscription } | null {
  const reads = nk.storageRead([
    { collection: SUBSCRIPTIONS_COLLECTION, key: userId, userId },
  ]);
  const obj = reads[0];
  if (!obj || obj.value === undefined) return null;
  const v = asSubscription(obj.value, userId);
  if (!v) return null;
  if (typeof obj.version !== 'string') return null;
  return { version: obj.version, value: v };
}

export function writeSubscriptionCreate(nk: INakama, sub: IapSubscription): void {
  const obj: IStorageObject = {
    collection: SUBSCRIPTIONS_COLLECTION,
    key: sub.userId,
    userId: sub.userId,
    value: sub as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  };
  nk.storageWrite([obj]);
}

export function writeSubscriptionUpdate(
  nk: INakama,
  sub: IapSubscription,
  expectedVersion: string,
): void {
  const obj: IStorageObject = {
    collection: SUBSCRIPTIONS_COLLECTION,
    key: sub.userId,
    userId: sub.userId,
    value: sub as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
    version: expectedVersion,
  };
  nk.storageWrite([obj]);
}

export function deleteSubscription(nk: INakama, userId: string, _expectedVersion?: string): void {
  nk.storageDelete([{ collection: SUBSCRIPTIONS_COLLECTION, key: userId, userId }]);
}

/** Scan ALL subscriptions (any user). Used by the 5min scanner. */
export function listAllSubscriptions(nk: INakama, limit = 1000): Array<{ userId: string; version: string; value: IapSubscription }> {
  const list = nk.storageList({ collection: SUBSCRIPTIONS_COLLECTION, limit });
  const out: Array<{ userId: string; version: string; value: IapSubscription }> = [];
  for (const o of list.objects) {
    const v = asSubscription(o.value, o.userId);
    if (!v) continue;
    if (typeof o.version !== 'string') continue;
    out.push({ userId: o.userId, version: o.version, value: v });
  }
  return out;
}
