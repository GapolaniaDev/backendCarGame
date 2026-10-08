// Phase 9 Chunk 6 — Admin IAP RPCs.
//
// 6 RPCs, all `assertAdminKey` (Phase 5 D7) + bypass maintenance
// (precedent: iap_purchase D63, iap_subscription D72) +
// `emitAdminAction` audit (Phase 5 Chunk 6). Same pattern as the
// tournament admin RPCs (Phase 8 Chunk 7).
//
// Refund flow (D90): `wallet.spend` is the REVERSE of `wallet.grant`
// from Chunk 3. The 90d cap is server-enforced — refunds for older
// purchases are rejected to prevent stale-abuse. Idempotency key
// `admin_refund:{adminUserId}:{transactionId}` lets the same admin
// re-query without double-refunding.
//
// Revenue stats (D83): excludes refunded purchases. 60s TTL cache.
// The cache is invalidated by `admin_iap_refund` and (best-effort)
// by `admin_iap_fraud_flag_action` so the operator UI doesn't show
// stale totals.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { serverNowMs } from '../core/time';
import { assertAdminKey, withoutAdminKey } from '../admin/auth';
import { emit, emitAdminAction } from '../core/admin/analytics';
import { spend, type WalletView } from '../economy/wallet';
import { sendReward } from '../liveops/inbox';
import { readPurchaseWithVersion, writePurchaseUpdate } from './purchase_repo';
import {
  readFraudFlagWithVersion,
  writeFraudFlagUpdate,
  listAllFraudFlags,
  listAndFilterPurchases,
  getCachedRevenueStats,
  cacheRevenueStats,
  computeRevenueStats,
  invalidateRevenueStatsCache,
  type FraudFlag,
  type FraudFlagAction,
  type FraudFlagStatus,
} from './admin_repo';
import type { IapPlatform } from './types';

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

const REFUND_WINDOW_MS = 90 * 86_400_000;
const FRAUD_BAN_HOURS = 720; // 30d

const VALID_PLATFORMS: ReadonlySet<IapPlatform> = new Set<IapPlatform>(['apple', 'google']);
const VALID_ACTIONS: ReadonlySet<FraudFlagAction> = new Set<FraudFlagAction>(['ban', 'dismiss', 'confirm']);
const VALID_STATUSES: ReadonlySet<FraudFlagStatus> = new Set<FraudFlagStatus>(['pending', 'reviewed', 'actioned']);

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
  // YYYY-MM-DD
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
  const raw = parsed.raw;
  const auth = assertAdminKey(logger, nk, raw);
  if (!auth.ok) return auth;
  return { ok: true, raw };
}

function getAdminUserId(ctx: IContext): string {
  // The admin tool is identified by its auth token, but in the JS
  // runtime the only stable id is `ctx.userId`. The audit row stores
  // this so fraud actions are traceable to the admin's account.
  return ctx.userId ?? 'admin';
}

// ─── admin_iap_purchases_list ──────────────────────────────────────────

export interface AdminIapPurchasesListInput {
  adminKey: string;
  platform?: IapPlatform;
  packId?: string;
  userId?: string;
  refunded?: boolean;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

export interface AdminIapPurchaseRow {
  userId: string;
  transactionId: string;
  packId: string;
  platform: IapPlatform;
  productId: string;
  coinsGranted: number;
  grantedAtUtc: number;
  refunded: boolean;
  refundedAtUtc?: number;
  refundedReason?: string;
}

export interface AdminIapPurchasesListOutput {
  purchases: AdminIapPurchaseRow[];
}

export const admin_iap_purchases_list_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const platformRaw = raw['platform'];
  if (platformRaw !== undefined && (typeof platformRaw !== 'string' || !VALID_PLATFORMS.has(platformRaw as IapPlatform))) {
    return fail('BAD_REQUEST', 'platform must be apple|google');
  }
  const limit = readNumber(raw, 'limit') ?? 50;
  if (limit < 1 || limit > 1000) return fail('BAD_REQUEST', 'limit must be 1..1000');
  const fromDate = readDate(raw, 'fromDate');
  const toDate = readDate(raw, 'toDate');
  const rows = listAndFilterPurchases(nk, {
    ...(typeof platformRaw === 'string' ? { platform: platformRaw as IapPlatform } : {}),
    ...(typeof raw['packId'] === 'string' && (raw['packId'] as string).length > 0 ? { packId: raw['packId'] as string } : {}),
    ...(typeof raw['userId'] === 'string' && (raw['userId'] as string).length > 0 ? { userId: raw['userId'] as string } : {}),
    ...(typeof raw['refunded'] === 'boolean' ? { refunded: raw['refunded'] as boolean } : {}),
    ...(fromDate !== undefined ? { fromDate } : {}),
    ...(toDate !== undefined ? { toDate } : {}),
    limit,
  });
  const purchases: AdminIapPurchaseRow[] = rows.map(({ userId, transactionId, record }) => {
    const row: AdminIapPurchaseRow = {
      userId,
      transactionId,
      packId: record.packId,
      platform: record.platform,
      productId: record.productId,
      coinsGranted: (record.content as { coins?: number }).coins ?? 0,
      grantedAtUtc: record.grantedAtUtc,
      refunded: record.refunded === true,
    };
    if (record.refundedAtUtc !== undefined) row.refundedAtUtc = record.refundedAtUtc;
    if (record.refundedReason !== undefined) row.refundedReason = record.refundedReason;
    return row;
  });
  emitAdminAction(nk, logger, 'admin_iap_purchases_list', { count: purchases.length, filters: withoutAdminKey(pre.raw) });
  return JSON.stringify(ok({ purchases }));
};

export const admin_iap_purchases_list: RpcHandler = admin_iap_purchases_list_impl;

// ─── admin_iap_purchases_get ───────────────────────────────────────────

export interface AdminIapPurchaseGetInput {
  adminKey: string;
  userId: string;
  transactionId: string;
}

export interface AdminIapPurchaseGetOutput {
  purchase: AdminIapPurchaseRow;
  fraudFlags: FraudFlag[];
}

export const admin_iap_purchases_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const userId = readString(raw, 'userId');
  const transactionId = readString(raw, 'transactionId');
  if (userId.length === 0) return fail('BAD_REQUEST', 'userId is required');
  if (transactionId.length === 0) return fail('BAD_REQUEST', 'transactionId is required');
  const obj = readPurchaseWithVersion(nk, userId, transactionId);
  if (!obj) return fail('NOT_FOUND', 'purchase not found');
  const r = obj.record;
  const row: AdminIapPurchaseRow = {
    userId,
    transactionId,
    packId: r.packId,
    platform: r.platform,
    productId: r.productId,
    coinsGranted: (r.content as { coins?: number }).coins ?? 0,
    grantedAtUtc: r.grantedAtUtc,
    refunded: r.refunded === true,
  };
  if (r.refundedAtUtc !== undefined) row.refundedAtUtc = r.refundedAtUtc;
  if (r.refundedReason !== undefined) row.refundedReason = r.refundedReason;
  // Pull any fraud flag for this transactionId.
  const all = listAllFraudFlags(nk, 10_000);
  const fraudFlags = all.filter((f) => f.flag.transactionId === transactionId).map((f) => f.flag);
  emitAdminAction(nk, logger, 'admin_iap_purchases_get', { userId, transactionId });
  return JSON.stringify(ok({ purchase: row, fraudFlags }));
};

export const admin_iap_purchases_get: RpcHandler = admin_iap_purchases_get_impl;

// ─── admin_iap_refund ──────────────────────────────────────────────────

export interface AdminIapRefundInput {
  adminKey: string;
  userId: string;
  transactionId: string;
  reason: string;
}

export interface AdminIapRefundOutput {
  refundedAtUtc: number;
  amountRefunded: number;
  newBalance: number;
  adminUserId: string;
}

export const admin_iap_refund_impl: RpcHandler = (ctx, logger, nk, body) => {
  const pre = adminPrelude(ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const userId = readString(raw, 'userId');
  const transactionId = readString(raw, 'transactionId');
  const reason = readString(raw, 'reason');
  if (userId.length === 0) return fail('BAD_REQUEST', 'userId is required');
  if (transactionId.length === 0) return fail('BAD_REQUEST', 'transactionId is required');
  if (reason.length === 0) return fail('BAD_REQUEST', 'reason is required');
  const obj = readPurchaseWithVersion(nk, userId, transactionId);
  if (!obj) return fail('NOT_FOUND', 'purchase not found');
  if (obj.record.refunded === true) {
    return fail('CONFLICT', 'purchase already refunded');
  }
  const nowUtc = serverNowMs();
  if (nowUtc - obj.record.grantedAtUtc > REFUND_WINDOW_MS) {
    return fail('CONFLICT', 'refund window expired (90d)');
  }
  const amount = (obj.record.content as { coins?: number }).coins ?? 0;
  if (amount <= 0) {
    return fail('BAD_REQUEST', 'refund amount must be > 0');
  }
  const adminUserId = getAdminUserId(ctx);
  // Idempotency: admin_refund:{adminUserId}:{transactionId} — re-running
  // the same admin refund returns the cached wallet view instead of
  // double-spending. Cross-admin re-runs land on a different key.
  const idemKey = `admin_refund:${adminUserId}:${transactionId}`;
  const r: Resp<WalletView> = spend(
    nk,
    userId,
    { coins: amount },
    { reason: 'admin', sourceId: `admin_refund:${transactionId}` },
    idemKey,
  );
  if (!r.ok) {
    return fail(asCode(r.error?.code), r.error?.message ?? 'spend failed');
  }
  // CAS-update the purchase row with the refund markers.
  const updated = {
    ...obj.record,
    refunded: true,
    refundedAtUtc: nowUtc,
    refundedReason: reason,
    refundedByAdminId: adminUserId,
  };
  try {
    writePurchaseUpdate(nk, transactionId, updated, obj.version);
  } catch (e) {
    return fail('INTERNAL', e instanceof Error ? e.message : 'storage write failed');
  }
  // Inbox notification to the user.
  sendReward(
    nk,
    userId,
    'iap_refund',
    {
      coins: amount,
      note: `iap refund (txId ${transactionId}): ${reason}`,
    },
    `iap_refund:${transactionId}`,
    nowUtc,
  );
  // Invalidate the stats cache so the operator sees the new totals.
  invalidateRevenueStatsCache();
  // Phase 9 Chunk 7: iap_refund_completed (D89 — analytics payload includes reason + amount).
  emit(nk, logger, 'iap_refund_completed', {
    userId,
    transactionId,
    amountCoins: amount,
    reason,
    adminUserId,
  });
  emitAdminAction(nk, logger, 'admin_iap_refund', {
    userId,
    transactionId,
    adminUserId,
    amount,
    reason,
  });
  const out: AdminIapRefundOutput = {
    refundedAtUtc: nowUtc,
    amountRefunded: amount,
    newBalance: r.data.coins,
    adminUserId,
  };
  return JSON.stringify(ok(out));
};

export const admin_iap_refund: RpcHandler = admin_iap_refund_impl;

// ─── admin_iap_fraud_flags_list ───────────────────────────────────────

export interface AdminIapFraudFlagsListInput {
  adminKey: string;
  status?: FraudFlagStatus;
  limit?: number;
}

export interface AdminIapFraudFlagsListOutput {
  flags: FraudFlag[];
}

export const admin_iap_fraud_flags_list_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const statusRaw = raw['status'];
  if (statusRaw !== undefined && (typeof statusRaw !== 'string' || !VALID_STATUSES.has(statusRaw as FraudFlagStatus))) {
    return fail('BAD_REQUEST', 'status must be pending|reviewed|actioned');
  }
  const status = typeof statusRaw === 'string' ? statusRaw as FraudFlagStatus : undefined;
  const limit = readNumber(raw, 'limit') ?? 100;
  if (limit < 1 || limit > 1000) return fail('BAD_REQUEST', 'limit must be 1..1000');
  const all = listAllFraudFlags(nk, 10_000);
  let rows = all.map((r) => r.flag);
  if (status !== undefined) rows = rows.filter((f) => f.status === status);
  rows.sort((a, b) => b.detectedAtUtc - a.detectedAtUtc);
  if (rows.length > limit) rows = rows.slice(0, limit);
  emitAdminAction(nk, logger, 'admin_iap_fraud_flags_list', { count: rows.length, status });
  return JSON.stringify(ok({ flags: rows }));
};

export const admin_iap_fraud_flags_list: RpcHandler = admin_iap_fraud_flags_list_impl;

// ─── admin_iap_fraud_flag_action ──────────────────────────────────────

export interface AdminIapFraudFlagActionInput {
  adminKey: string;
  transactionId: string;
  action: FraudFlagAction;
  reason: string;
}

export interface AdminIapFraudFlagActionOutput {
  actionedAtUtc: number;
  newStatus: FraudFlagStatus;
  newAction: FraudFlagAction;
  targetUserId: string;
  adminUserId: string;
}

export const admin_iap_fraud_flag_action_impl: RpcHandler = (ctx, logger, nk, body) => {
  const pre = adminPrelude(ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const transactionId = readString(raw, 'transactionId');
  const actionRaw = raw['action'];
  const reason = readString(raw, 'reason');
  if (transactionId.length === 0) return fail('BAD_REQUEST', 'transactionId is required');
  if (typeof actionRaw !== 'string' || !VALID_ACTIONS.has(actionRaw as FraudFlagAction)) {
    return fail('BAD_REQUEST', 'action must be ban|dismiss|confirm');
  }
  if (reason.length === 0) return fail('BAD_REQUEST', 'reason is required');
  const action = actionRaw as FraudFlagAction;
  const obj = readFraudFlagWithVersion(nk, transactionId);
  if (!obj) return fail('NOT_FOUND', 'fraud flag not found');
  if (obj.flag.status === 'actioned') {
    return fail('CONFLICT', 'flag already actioned');
  }
  const nowUtc = serverNowMs();
  const adminUserId = getAdminUserId(ctx);
  let newStatus: FraudFlagStatus;
  switch (action) {
    case 'ban':
      newStatus = 'actioned';
      break;
    case 'dismiss':
      newStatus = 'reviewed';
      break;
    case 'confirm':
      newStatus = 'actioned';
      break;
  }
  const updated: FraudFlag = {
    ...obj.flag,
    status: newStatus,
    actionedAtUtc: nowUtc,
    actionedByAdminId: adminUserId,
    actionedReason: reason,
  };
  try {
    writeFraudFlagUpdate(nk, transactionId, updated, obj.version);
  } catch (e) {
    return fail('INTERNAL', e instanceof Error ? e.message : 'storage write failed');
  }
  // For 'ban', add a sanction to the claimed-by user via the
  // anti_cheat module. We emit an admin_action; the anti_cheat
  // subscriber (Phase 8 Chunk 4) treats this as a sanction.
  if (action === 'ban') {
    emitAdminAction(nk, logger, 'admin_anti_cheat_sanction', {
      userId: obj.flag.claimedByUserId,
      markId: `iap_fraud:${transactionId}`,
      durationHours: FRAUD_BAN_HOURS,
      reason: 'iap_fraud_cross_user',
      sourceFlagTransactionId: transactionId,
    });
  }
  emitAdminAction(nk, logger, 'admin_iap_fraud_flag_action', {
    transactionId, action, reason, newStatus, adminUserId,
  });
  const out: AdminIapFraudFlagActionOutput = {
    actionedAtUtc: nowUtc,
    newStatus,
    newAction: action,
    targetUserId: obj.flag.claimedByUserId,
    adminUserId,
  };
  return JSON.stringify(ok(out));
};

export const admin_iap_fraud_flag_action: RpcHandler = admin_iap_fraud_flag_action_impl;

// ─── admin_iap_revenue_stats_get ──────────────────────────────────────

export interface AdminIapRevenueStatsGetInput {
  adminKey: string;
  fromDate: string;
  toDate: string;
}

export const admin_iap_revenue_stats_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
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
  const nowUtc = serverNowMs();
  let stats = getCachedRevenueStats(fromDate, toDate, nowUtc);
  if (stats === null) {
    stats = computeRevenueStats(nk, fromDate, toDate);
    cacheRevenueStats(fromDate, toDate, stats, nowUtc);
  }
  emitAdminAction(nk, logger, 'admin_iap_revenue_stats_get', { fromDate, toDate });
  return JSON.stringify(ok(stats));
};

export const admin_iap_revenue_stats_get: RpcHandler = admin_iap_revenue_stats_get_impl;
