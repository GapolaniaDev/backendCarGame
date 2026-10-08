// Phase 9 Chunk 7 — Admin IAP analytics RPCs.
//
// 4 admin RPCs (all `assertAdminKey` D7 + maintenance-bypass D91 +
// `emitAdminAction` audit):
//
//   - admin_iap_analytics_get  — aggregated stats for a date range
//   - admin_iap_ltv_get        — cohort LTV (7d/30d/90d)
//   - admin_iap_funnel_get     — funnel conversion (per stage + per pack / per platform)
//   - admin_iap_top_buyers_get — top buyers list (privacy-sensitive)
//
// All 4 read from `analytics_events` (Phase 5 Chunk 7) via a 1-arg
// `storageList` with the 10 000-row cap (D64). The 4 caches are
// keyed on the input parameters so identical requests share results
// for 60s.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { assertAdminKey, withoutAdminKey } from '../admin/auth';
import { emitAdminAction } from '../core/admin/analytics';
import { ANALYTICS_COLLECTION } from '../core/admin/analytics';
import { asIapAdEvent, type IapAdAnalyticsRow } from './iap_events';
import { computeLtv, type LtvResult, type LtvWindow } from './ltv';
import { computeFunnel, type FunnelResult, type FunnelFilters } from './funnel';
import { computeTopBuyers, type TopBuyer } from './top_buyers';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

const ERR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
  'RATE_LIMITED', 'INVALID_RESULT', 'INTERNAL', 'CATALOG_INVALID',
  'INSUFFICIENT_FUNDS', 'SERVICE_UNAVAILABLE', 'UPGRADE_REQUIRED',
  'NOT_IMPLEMENTED',
]);
function asCode(code: string | undefined): ErrorCode {
  if (code !== undefined && (ERR_CODES as Set<string>).has(code)) return code as ErrorCode;
  return 'INTERNAL';
}
function fail(code: ErrorCode, message: string): string {
  return JSON.stringify(err(code, message));
}

const CACHE_TTL_MS = 60_000;
const CACHE_ANALYTICS = new Map<string, { result: unknown; expiresAt: number }>();
const CACHE_LTV = new Map<string, { result: unknown; expiresAt: number }>();
const CACHE_FUNNEL = new Map<string, { result: unknown; expiresAt: number }>();
const CACHE_TOP_BUYERS = new Map<string, { result: unknown; expiresAt: number }>();

function readString(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  return typeof v === 'string' ? v : '';
}
function readNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function readBool(raw: Record<string, unknown>, key: string): boolean | undefined {
  const v = raw[key];
  return v === true ? true : v === false ? false : undefined;
}
function readDate(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  if (typeof v !== 'string' || v.length === 0) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  return v;
}

function adminPrelude(
  _ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): { ok: true; raw: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed;
  const auth = assertAdminKey(logger, nk, parsed.raw);
  if (!auth.ok) return auth;
  return { ok: true, raw: parsed.raw };
}

function getCached(
  cache: Map<string, { result: unknown; expiresAt: number }>,
  key: string,
  nowUtc: number,
): unknown | null {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > nowUtc) return entry.result;
  if (entry) cache.delete(key);
  return null;
}
function setCached(
  cache: Map<string, { result: unknown; expiresAt: number }>,
  key: string,
  result: unknown,
  nowUtc: number,
): void {
  cache.set(key, { result, expiresAt: nowUtc + CACHE_TTL_MS });
}

export function invalidateAnalyticsCache(): void { CACHE_ANALYTICS.clear(); }
export function invalidateLtvCache(): void { CACHE_LTV.clear(); }
export function invalidateFunnelCache(): void { CACHE_FUNNEL.clear(); }
export function invalidateTopBuyersCache(): void { CACHE_TOP_BUYERS.clear(); }
export function invalidateAllAnalyticsCaches(): void {
  invalidateAnalyticsCache();
  invalidateLtvCache();
  invalidateFunnelCache();
  invalidateTopBuyersCache();
}

/** Read all `analytics_events` rows (cap 10 000) and parse them as
 *  IAP/ad event rows. Rows whose `name` isn't in the 11-event set are
 *  silently dropped. */
export function readIapAdEvents(nk: INakama, limit: number = 10_000): IapAdAnalyticsRow[] {
  const list = nk.storageList({ collection: ANALYTICS_COLLECTION, limit });
  const out: IapAdAnalyticsRow[] = [];
  for (const o of list.objects) {
    const rawName = (o.value as { name?: unknown })?.name;
    const rawProps = (o.value as { props?: unknown })?.props;
    const ts = (o.value as { ts?: unknown })?.ts;
    const userId = (o.value as { userId?: unknown })?.userId;
    if (typeof ts !== 'number') continue;
    const parsed = asIapAdEvent(rawName, rawProps, ts, userId);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Filter rows whose `ts` falls inside `[from, to]` (inclusive on both ends). */
export function filterByDateRange(
  rows: IapAdAnalyticsRow[],
  fromDate: string,
  toDate: string,
): IapAdAnalyticsRow[] {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T23:59:59Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return rows;
  return rows.filter((r) => r.ts >= from && r.ts <= to);
}

// ─── admin_iap_analytics_get ────────────────────────────────────────

export interface AdminIapAnalyticsInput {
  adminKey: string;
  fromDate: string;
  toDate: string;
}

export interface AdminIapAnalyticsOutput {
  fromDate: string;
  toDate: string;
  totalInitiated: number;
  totalValidated: number;
  totalDelivered: number;
  totalFailed: number;
  validationRate: number;
  deliveryRate: number;
  totalRefunded: number;
  netRevenue: number;
  purchaseCount: number;
  uniqueBuyers: number;
  adWatchCount: number;
  adCoinsGranted: number;
  averageOrderValue: number;
}

function buildAnalyticsResult(rows: IapAdAnalyticsRow[], fromDate: string, toDate: string): AdminIapAnalyticsOutput {
  let totalInitiated = 0;
  let totalValidated = 0;
  let totalDelivered = 0;
  let totalFailed = 0;
  let totalRefunded = 0;
  let netRevenue = 0;
  let adWatchCount = 0;
  let adCoinsGranted = 0;
  const buyers = new Set<string>();
  const deliveredByUser = new Map<string, number>();
  for (const r of rows) {
    switch (r.name) {
      case 'iap_purchase_initiated': totalInitiated += 1; break;
      case 'iap_purchase_validated': totalValidated += 1; break;
      case 'iap_purchase_delivered':
        totalDelivered += 1;
        if (typeof r.userId === 'string') {
          buyers.add(r.userId);
          deliveredByUser.set(r.userId, (deliveredByUser.get(r.userId) ?? 0) + 1);
        }
        if (typeof r.props.amountCoins === 'number') netRevenue += r.props.amountCoins;
        break;
      case 'iap_purchase_failed': totalFailed += 1; break;
      case 'iap_refund_completed':
        totalRefunded += 1;
        if (typeof r.props.amountCoins === 'number') netRevenue -= r.props.amountCoins;
        break;
      case 'ad_watch_granted':
        adWatchCount += 1;
        if (typeof r.props.amountCoins === 'number') adCoinsGranted += r.props.amountCoins;
        break;
      default: break;
    }
  }
  const validationRate = totalInitiated === 0 ? 0 : totalValidated / totalInitiated;
  const deliveryRate = totalValidated === 0 ? 0 : totalDelivered / totalValidated;
  const averageOrderValue = totalDelivered === 0 ? 0 : netRevenue / totalDelivered;
  return {
    fromDate,
    toDate,
    totalInitiated,
    totalValidated,
    totalDelivered,
    totalFailed,
    validationRate,
    deliveryRate,
    totalRefunded,
    netRevenue,
    purchaseCount: totalDelivered,
    uniqueBuyers: buyers.size,
    adWatchCount,
    adCoinsGranted,
    averageOrderValue,
  };
}

export const admin_iap_analytics_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const fromDate = readDate(raw, 'fromDate');
  const toDate = readDate(raw, 'toDate');
  if (fromDate === undefined) return fail('BAD_REQUEST', 'fromDate is required (YYYY-MM-DD)');
  if (toDate === undefined) return fail('BAD_REQUEST', 'toDate is required (YYYY-MM-DD)');
  if (Date.parse(fromDate) > Date.parse(toDate)) {
    return fail('BAD_REQUEST', 'fromDate must be <= toDate');
  }
  const nowUtc = Date.now();
  const key = `${fromDate}|${toDate}`;
  const cached = getCached(CACHE_ANALYTICS, key, nowUtc);
  if (cached !== null) {
    emitAdminAction(nk, logger, 'admin_iap_analytics_get', { fromDate, toDate, cacheHit: true });
    return JSON.stringify(ok(cached));
  }
  const all = readIapAdEvents(nk);
  const rows = filterByDateRange(all, fromDate, toDate);
  const result = buildAnalyticsResult(rows, fromDate, toDate);
  setCached(CACHE_ANALYTICS, key, result, nowUtc);
  emitAdminAction(nk, logger, 'admin_iap_analytics_get', { fromDate, toDate });
  return JSON.stringify(ok(result));
};

export const admin_iap_analytics_get: RpcHandler = admin_iap_analytics_get_impl;

// ─── admin_iap_ltv_get ──────────────────────────────────────────────

export interface AdminIapLtvInput {
  adminKey: string;
  cohortWeekStart: string;
  windows: LtvWindow[];
}

export type AdminIapLtvOutput = LtvResult;

export const admin_iap_ltv_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const cohortWeekStart = readDate(raw, 'cohortWeekStart');
  if (cohortWeekStart === undefined) {
    return fail('BAD_REQUEST', 'cohortWeekStart is required (YYYY-MM-DD)');
  }
  const rawWindows = raw['windows'];
  const windows: LtvWindow[] = [];
  if (Array.isArray(rawWindows)) {
    for (const w of rawWindows) {
      if (w === '7d' || w === '30d' || w === '90d') windows.push(w);
    }
  }
  if (windows.length === 0) {
    return fail('BAD_REQUEST', 'windows must contain at least one of 7d|30d|90d');
  }
  const nowUtc = Date.now();
  const key = `${cohortWeekStart}|${windows.slice().sort().join(',')}`;
  const cached = getCached(CACHE_LTV, key, nowUtc);
  if (cached !== null) {
    emitAdminAction(nk, logger, 'admin_iap_ltv_get', { cohortWeekStart, cacheHit: true });
    return JSON.stringify(ok(cached));
  }
  const all = readIapAdEvents(nk);
  const result = computeLtv({ rows: all, cohortWeekStart, windows });
  setCached(CACHE_LTV, key, result, nowUtc);
  emitAdminAction(nk, logger, 'admin_iap_ltv_get', { cohortWeekStart });
  return JSON.stringify(ok(result));
};

export const admin_iap_ltv_get: RpcHandler = admin_iap_ltv_get_impl;

// ─── admin_iap_funnel_get ───────────────────────────────────────────

export interface AdminIapFunnelInput {
  adminKey: string;
  packId?: string;
  platform?: 'apple' | 'google' | 'mock';
  fromDate?: string;
  toDate?: string;
}

export interface AdminIapFunnelOutput extends FunnelResult {
  fromDate?: string;
  toDate?: string;
}

export const admin_iap_funnel_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const fromDate = readDate(raw, 'fromDate');
  const toDate = readDate(raw, 'toDate');
  if (fromDate !== undefined && toDate === undefined) {
    return fail('BAD_REQUEST', 'toDate is required when fromDate is set');
  }
  if (toDate !== undefined && fromDate === undefined) {
    return fail('BAD_REQUEST', 'fromDate is required when toDate is set');
  }
  if (fromDate !== undefined && Date.parse(fromDate) > Date.parse(toDate!)) {
    return fail('BAD_REQUEST', 'fromDate must be <= toDate');
  }
  const platformRaw = raw['platform'];
  if (platformRaw !== undefined
      && (typeof platformRaw !== 'string'
          || (platformRaw !== 'apple' && platformRaw !== 'google' && platformRaw !== 'mock'))) {
    return fail('BAD_REQUEST', 'platform must be apple|google|mock');
  }
  const platform = typeof platformRaw === 'string' ? platformRaw as 'apple' | 'google' | 'mock' : undefined;
  const packIdRaw = raw['packId'];
  const packId = typeof packIdRaw === 'string' && packIdRaw.length > 0 ? packIdRaw : undefined;
  const filters: FunnelFilters = {};
  if (packId !== undefined) filters.packId = packId;
  if (platform !== undefined) filters.platform = platform;
  const nowUtc = Date.now();
  const key = `${packId ?? '*'}|${platform ?? '*'}|${fromDate ?? ''}|${toDate ?? ''}`;
  const cached = getCached(CACHE_FUNNEL, key, nowUtc);
  if (cached !== null) {
    emitAdminAction(nk, logger, 'admin_iap_funnel_get', { packId, platform, cacheHit: true });
    return JSON.stringify(ok(cached));
  }
  const all = readIapAdEvents(nk);
  const filtered = fromDate !== undefined && toDate !== undefined
    ? filterByDateRange(all, fromDate, toDate)
    : all;
  const baseResult = computeFunnel({ rows: filtered, filters });
  const result: AdminIapFunnelOutput = {
    ...baseResult,
    ...(fromDate !== undefined ? { fromDate } : {}),
    ...(toDate !== undefined ? { toDate } : {}),
  };
  setCached(CACHE_FUNNEL, key, result, nowUtc);
  emitAdminAction(nk, logger, 'admin_iap_funnel_get', { packId, platform });
  return JSON.stringify(ok(result));
};

export const admin_iap_funnel_get: RpcHandler = admin_iap_funnel_get_impl;

// ─── admin_iap_top_buyers_get ───────────────────────────────────────

export interface AdminIapTopBuyersInput {
  adminKey: string;
  fromDate: string;
  toDate: string;
  limit?: number;
}

export interface AdminIapTopBuyersOutput {
  buyers: TopBuyer[];
}

export const admin_iap_top_buyers_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const fromDate = readDate(raw, 'fromDate');
  const toDate = readDate(raw, 'toDate');
  if (fromDate === undefined) return fail('BAD_REQUEST', 'fromDate is required (YYYY-MM-DD)');
  if (toDate === undefined) return fail('BAD_REQUEST', 'toDate is required (YYYY-MM-DD)');
  if (Date.parse(fromDate) > Date.parse(toDate)) {
    return fail('BAD_REQUEST', 'fromDate must be <= toDate');
  }
  const limit = readNumber(raw, 'limit') ?? 20;
  if (limit < 1 || limit > 200) return fail('BAD_REQUEST', 'limit must be 1..200');
  const nowUtc = Date.now();
  const key = `${fromDate}|${toDate}|${limit}`;
  const cached = getCached(CACHE_TOP_BUYERS, key, nowUtc);
  if (cached !== null) {
    emitAdminAction(nk, logger, 'admin_iap_top_buyers_get', { fromDate, toDate, limit, cacheHit: true });
    return JSON.stringify(ok(cached));
  }
  const all = readIapAdEvents(nk);
  const rows = filterByDateRange(all, fromDate, toDate);
  // Privacy-sensitive: pass userLookup that uses accountGetId to resolve
  // the runtime username. The function never throws; a null/missing
  // account yields an empty username (the operator can match by userId).
  const userLookup = (userId: string): { username: string } | null => {
    try {
      const u = nk.accountGetId(userId) as { username?: string } | null | undefined;
      if (u && typeof u.username === 'string') return { username: u.username };
    } catch {
      // ignore
    }
    return null;
  };
  const buyers = computeTopBuyers({ rows, userLookup, limit });
  const result: AdminIapTopBuyersOutput = { buyers };
  setCached(CACHE_TOP_BUYERS, key, result, nowUtc);
  emitAdminAction(nk, logger, 'admin_iap_top_buyers_get', { fromDate, toDate, limit, count: buyers.length });
  return JSON.stringify(ok(result));
};

export const admin_iap_top_buyers_get: RpcHandler = admin_iap_top_buyers_get_impl;
