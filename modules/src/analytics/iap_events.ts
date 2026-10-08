// Phase 9 Chunk 7 — IAP + Ad analytics events.
//
// 11 new event types are added to `AnalyticsEventName` (see
// `core/admin/analytics.ts`). This file centralises the event-name
// constants + the `IapAdEventPayload` props shape so the emitting
// sites (`iap/rpcs.ts`, `iap/subscription_rpcs.ts`, `iap/admin.ts`,
// `ads/rpcs.ts`) and the consuming RPCs (`analytics/rpcs.ts`) share a
// single source of truth.
//
// Event idempotency: the storage row is keyed by `<ts>-<uuid>` from
// `nk.uuidv4()` in the `emit()` helper. Each emission is a separate
// row — for IAP we treat the 4 stages (initiated/validated/delivered/
// failed) as 4 distinct events keyed off the same `transactionId`
// inside the `props`. For ads the `impressionId` is the natural key.

import type { AdTier } from '../ads/types';

export const IAP_EVENT_NAMES = {
  IAP_PURCHASE_INITIATED: 'iap_purchase_initiated',
  IAP_PURCHASE_VALIDATED: 'iap_purchase_validated',
  IAP_PURCHASE_DELIVERED: 'iap_purchase_delivered',
  IAP_PURCHASE_FAILED: 'iap_purchase_failed',
  IAP_REFUND_COMPLETED: 'iap_refund_completed',
  IAP_SUBSCRIPTION_ACTIVATED: 'iap_subscription_activated',
  IAP_SUBSCRIPTION_RENEWED: 'iap_subscription_renewed',
  IAP_SUBSCRIPTION_CANCELLED: 'iap_subscription_cancelled',
  AD_WATCH_INITIATED: 'ad_watch_initiated',
  AD_WATCH_GRANTED: 'ad_watch_granted',
  AD_WATCH_BLOCKED: 'ad_watch_blocked',
  AD_WATCH_FAILED: 'ad_watch_failed',
} as const;

export type IapAdEventName =
  typeof IAP_EVENT_NAMES[keyof typeof IAP_EVENT_NAMES];

/** All event names. Order is significant — funnel / LTV consumers
 *  depend on the relative ordering (initiated < validated < delivered). */
export const IAP_FUNNEL_STAGES = [
  IAP_EVENT_NAMES.IAP_PURCHASE_INITIATED,
  IAP_EVENT_NAMES.IAP_PURCHASE_VALIDATED,
  IAP_EVENT_NAMES.IAP_PURCHASE_DELIVERED,
] as const;

export type IapAdEventPayload = {
  platform?: 'apple' | 'google' | 'mock';
  packId?: string;
  productId?: string;
  /** IAP transactionId or ad impressionId. Acts as the funnel "id". */
  transactionId?: string;
  /** Coins credited (or attempted). For IAP = baseCoins + firstTimeBonus. */
  amountCoins?: number;
  /** Optional USD-equivalent for cross-currency LTV (from catalog). */
  amountUsd?: number;
  /** Ad tier. */
  tier?: AdTier;
  adUnitId?: string;
  /** For `iap_purchase_failed` events. */
  failureReason?: string;
  /** For `ad_watch_failed` events. */
  errorCode?: string;
  /** Cohort-friendly: ISO date (YYYY-MM-DD) when the user first appeared. */
  cohortDate?: string;
};

export interface IapAdAnalyticsRow {
  /** ts from the storage row. */
  ts: number;
  name: IapAdEventName;
  userId?: string;
  props: IapAdEventPayload;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asAdTier(v: unknown): AdTier | undefined {
  if (v === 'small' || v === 'medium' || v === 'large' || v === 'xlarge') {
    return v;
  }
  return undefined;
}

function asPlatform(v: unknown): 'apple' | 'google' | 'mock' | undefined {
  if (v === 'apple' || v === 'google' || v === 'mock') return v;
  return undefined;
}

/** Parse a raw storage row into a typed `IapAdAnalyticsRow`. */
export function asIapAdEvent(
  rawName: unknown,
  rawProps: unknown,
  ts: number,
  userId: unknown,
): IapAdAnalyticsRow | null {
  if (typeof rawName !== 'string') return null;
  // Only the 11 IAP/ad event names.
  const known = (Object.values(IAP_EVENT_NAMES) as string[]).includes(rawName);
  if (!known) return null;
  const out: IapAdAnalyticsRow = {
    ts,
    name: rawName as IapAdEventName,
    props: {},
  };
  if (typeof userId === 'string' && userId.length > 0) out.userId = userId;
  if (isPlainObject(rawProps)) {
    const p = rawProps;
    const props: IapAdEventPayload = {};
    const platform = asPlatform(p['platform']);
    if (platform !== undefined) props.platform = platform;
    const packId = asString(p['packId']);
    if (packId !== undefined) props.packId = packId;
    const productId = asString(p['productId']);
    if (productId !== undefined) props.productId = productId;
    const transactionId = asString(p['transactionId']);
    if (transactionId !== undefined) props.transactionId = transactionId;
    const amountCoins = asNumber(p['amountCoins']);
    if (amountCoins !== undefined) props.amountCoins = amountCoins;
    const amountUsd = asNumber(p['amountUsd']);
    if (amountUsd !== undefined) props.amountUsd = amountUsd;
    const tier = asAdTier(p['tier']);
    if (tier !== undefined) props.tier = tier;
    const adUnitId = asString(p['adUnitId']);
    if (adUnitId !== undefined) props.adUnitId = adUnitId;
    const failureReason = asString(p['failureReason']);
    if (failureReason !== undefined) props.failureReason = failureReason;
    const errorCode = asString(p['errorCode']);
    if (errorCode !== undefined) props.errorCode = errorCode;
    const cohortDate = asString(p['cohortDate']);
    if (cohortDate !== undefined) props.cohortDate = cohortDate;
    out.props = props;
  }
  return out;
}
