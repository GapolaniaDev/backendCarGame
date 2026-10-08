// Phase 9 Chunk 4 — Subscription RPCs.
//
//   iap_subscription_status   — read the caller's current sub state
//   iap_subscription_cancel   — one-way cancel (autoRenewing→false)
//
// Both bypass maintenance (money flows). No `assertNotInMaintenance`.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { ok, err, type Resp } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { serverNowMs } from '../core/time';
import { readSubscriptionWithVersion, writeSubscriptionUpdate } from './subscription_repo';
import {
  isActive,
  isExpired,
  timeRemainingMs,
  markCancelled,
  type IapSubscription,
} from './subscription';
import { emit } from '../core/admin/analytics';

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

// ─── Status ───────────────────────────────────────────────────────────────

export interface IapSubscriptionStatusOutput {
  hasSubscription: boolean;
  subscription?: {
    packId: string;
    platform: 'apple' | 'google';
    activatedAtUtc: number;
    expiresAtUtc: number;
    timeRemainingMs: number;
    isActive: boolean;
    isExpired: boolean;
    cancelledAtUtc?: number;
    autoRenewing: boolean;
    renewalCount: number;
  };
}

export const iap_subscription_status_impl: RpcHandler = (ctx, _logger, _nk, _body) => {
  if (!ctx.userId) return fail('UNAUTHENTICATED', 'missing userId');
  const userId: string = ctx.userId;
  const sub = readSubscriptionWithVersion(_nk, userId)?.value ?? null;
  if (sub === null) {
    return JSON.stringify(ok({ hasSubscription: false }));
  }
  const nowUtc = serverNowMs();
  return JSON.stringify(ok({
    hasSubscription: true,
    subscription: viewFor(sub, nowUtc),
  }));
};

function viewFor(sub: IapSubscription, nowUtc: number): IapSubscriptionStatusOutput['subscription'] {
  return {
    packId: sub.packId,
    platform: sub.platform,
    activatedAtUtc: sub.activatedAtUtc,
    expiresAtUtc: sub.expiresAtUtc,
    timeRemainingMs: timeRemainingMs(sub, nowUtc),
    isActive: isActive(sub, nowUtc),
    isExpired: isExpired(sub, nowUtc),
    ...(sub.cancelledAtUtc !== undefined ? { cancelledAtUtc: sub.cancelledAtUtc } : {}),
    autoRenewing: sub.autoRenewing,
    renewalCount: sub.renewalHistory.length,
  };
}

// ─── Cancel ───────────────────────────────────────────────────────────────

export interface IapSubscriptionCancelInput {
  platform: 'apple' | 'google';
  /** The most recent transaction id (Apple: transaction_id, Google: orderId). */
  transactionId: string;
}

export interface IapSubscriptionCancelOutput {
  cancelledAtUtc: number;
  expiresAtUtc: number;
  willRemainActiveUntilUtc: number;
}

export const iap_subscription_cancel_impl: RpcHandler = (ctx, logger, nk, body) => {
  if (!ctx.userId) return fail('UNAUTHENTICATED', 'missing userId');
  const userId: string = ctx.userId;
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const raw = parsed.raw;
  if (typeof raw['platform'] !== 'string' || (raw['platform'] !== 'apple' && raw['platform'] !== 'google')) {
    return fail('BAD_REQUEST', 'platform must be apple|google');
  }
  if (typeof raw['transactionId'] !== 'string' || (raw['transactionId'] as string).length === 0) {
    return fail('BAD_REQUEST', 'transactionId is required');
  }
  const input: IapSubscriptionCancelInput = {
    platform: raw['platform'] as 'apple' | 'google',
    transactionId: raw['transactionId'] as string,
  };

  const obj = readSubscriptionWithVersion(nk, userId);
  if (obj === null) {
    return fail('NOT_FOUND', 'no subscription on file');
  }
  const sub = obj.value;
  if (sub.cancelledAtUtc !== undefined) {
    return fail('CONFLICT', 'subscription already cancelled');
  }
  // Ownership check: the cancelling transactionId must match the
  // latest or original transactionId. Apple/Google guarantee that
  // the user knows their most recent receipt id (the App Store /
  // Play Store surfaces it).
  if (input.transactionId !== sub.latestTransactionId
      && input.transactionId !== sub.originalTransactionId) {
    return fail('BAD_REQUEST', 'transactionId does not match any on file');
  }
  const nowUtc = serverNowMs();
  const cancelled = markCancelled(sub, nowUtc);
  try {
    writeSubscriptionUpdate(nk, cancelled, obj.version);
  } catch (e) {
    return fail('INTERNAL', e instanceof Error ? e.message : 'storage write failed');
  }
  emit(nk, logger, 'iap_subscription_cancelled', {
    userId,
    packId: sub.packId,
    cancelledAtUtc: nowUtc,
    expiresAtUtc: sub.expiresAtUtc,
  });
  const out: IapSubscriptionCancelOutput = {
    cancelledAtUtc: nowUtc,
    expiresAtUtc: sub.expiresAtUtc,
    willRemainActiveUntilUtc: sub.expiresAtUtc,
  };
  return JSON.stringify(ok(out));
};

export const iap_subscription_status: RpcHandler = iap_subscription_status_impl;
export const iap_subscription_cancel: RpcHandler = iap_subscription_cancel_impl;
