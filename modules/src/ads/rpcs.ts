// Phase 9 Chunk 5 — Ad reward RPC.
//
// One public RPC: `ad_watched`. Idempotent on `impressionId` (24h
// window via the ad_watch_log row). Enforces:
//   1. Per-tier cooldown (from catalog: 5/15/30/60 minutes).
//   2. Per-user daily cap (10, D75).
//   3. UTC-day boundary for the cap (`utcDate(nowUtc)`).
//
// Bypasses maintenance (D77, same precedent as iap_purchase /
// iap_subscription_*). MOCK provider only — real AdMob/Unity Ads
// integration is deferred (D68 gap).

import type { IContext, ILogger, INakama } from '../nkruntime';
import { ok, err, type Resp } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { serverNowMs } from '../core/time';
import { grant, walletGet, type WalletView } from '../economy/wallet';
import { sendReward } from '../liveops/inbox';
import { emit } from '../core/admin/analytics';
import { findAdRewardTier } from './catalog';
import { verifyAdMock, type AdVerifyError } from './verify_mock';
import { planAdReward, utcDateKey, endOfUtcDayUtc } from './grant';
import {
  readAdLastWatched,
  writeAdLastWatched,
  readAdDailyCount,
  writeAdDailyCount,
  readAdWatchLog,
  writeAdWatchLog,
} from './repo';
import type { AdProvider, AdTier, AdWatchLog } from './types';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

const AD_DAILY_CAP = 10;

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

export interface AdWatchedInput {
  tier: AdTier;
  provider: AdProvider;
  adUnitId: string;
  impressionId: string;
  watchedAtUtc: number;
}

export interface AdWatchedOutput {
  rewardId: string;
  tier: AdTier;
  coinsGranted: number;
  newBalance: number;
  nextEligibleAtUtc: number;
  dailyCount: number;
  dailyCap: number;
  idempotent: boolean;
}

function asInput(raw: Record<string, unknown>): AdWatchedInput | { error: string } {
  const tier = raw['tier'];
  if (tier !== 'small' && tier !== 'medium' && tier !== 'large' && tier !== 'xlarge') {
    return { error: 'tier must be one of small|medium|large|xlarge' };
  }
  const provider = raw['provider'];
  if (provider !== 'mock' && provider !== 'admob' && provider !== 'unityads') {
    return { error: 'provider must be mock|admob|unityads' };
  }
  if (typeof raw['adUnitId'] !== 'string' || (raw['adUnitId'] as string).length === 0) {
    return { error: 'adUnitId is required' };
  }
  if (typeof raw['impressionId'] !== 'string' || (raw['impressionId'] as string).length === 0) {
    return { error: 'impressionId is required' };
  }
  if (typeof raw['watchedAtUtc'] !== 'number' || !Number.isFinite(raw['watchedAtUtc'] as number)) {
    return { error: 'watchedAtUtc is required and must be a number' };
  }
  return {
    tier: tier as AdTier,
    provider: provider as AdProvider,
    adUnitId: raw['adUnitId'] as string,
    impressionId: raw['impressionId'] as string,
    watchedAtUtc: raw['watchedAtUtc'] as number,
  };
}

function verifyErrorToCode(e: AdVerifyError | undefined): ErrorCode {
  switch (e) {
    case 'INVALID_PROVIDER':     return 'BAD_REQUEST';
    case 'INVALID_IMPRESSION_ID': return 'BAD_REQUEST';
    case 'FUTURE_WATCHED_AT':    return 'BAD_REQUEST';
    default:                     return 'INTERNAL';
  }
}

export const ad_watched_impl: RpcHandler = (ctx, logger, nk, body) => {
  if (!ctx.userId) return fail('UNAUTHENTICATED', 'missing userId');
  const userId: string = ctx.userId;
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const inputOrErr = asInput(parsed.raw);
  if ('error' in inputOrErr) {
    emit(nk, logger, 'ad_watch_failed', {
      userId, errorCode: 'BAD_REQUEST', failureReason: inputOrErr.error,
    });
    return fail('BAD_REQUEST', inputOrErr.error);
  }
  const input = inputOrErr;
  // Phase 9 Chunk 7: ad_watch_initiated.
  emit(nk, logger, 'ad_watch_initiated', {
    userId,
    tier: input.tier,
    provider: input.provider,
    adUnitId: input.adUnitId,
    transactionId: input.impressionId,
  });

  // 1. Tier lookup.
  const tierRow = findAdRewardTier(input.tier);
  if (!tierRow) {
    emit(nk, logger, 'ad_watch_failed', {
      userId, transactionId: input.impressionId, errorCode: 'NOT_FOUND', failureReason: 'unknown tier',
    });
    return fail('NOT_FOUND', `unknown tier: ${input.tier}`);
  }

  // 2. Idempotency — same impressionId → return cached (no double grant).
  const existing = readAdWatchLog(nk, userId, input.impressionId);
  if (existing) {
    const balance = walletGet(nk, userId);
    const out: AdWatchedOutput = {
      rewardId: input.impressionId,
      tier: existing.tier,
      coinsGranted: existing.coinsGranted,
      newBalance: balance.coins,
      nextEligibleAtUtc: existing.grantedAtUtc + tierRow.cooldownSeconds * 1000,
      dailyCount: 0, // caller can re-fetch the daily count from a follow-up if needed
      dailyCap: AD_DAILY_CAP,
      idempotent: true,
    };
    return JSON.stringify(ok(out));
  }

  // 3. Mock verify (input shape + provider).
  const nowUtc = serverNowMs();
  const v = verifyAdMock(
    input.provider,
    input.adUnitId,
    input.impressionId,
    input.watchedAtUtc,
    nowUtc,
  );
  if (!v.valid) {
    emit(nk, logger, 'ad_watch_failed', {
      userId, transactionId: input.impressionId, tier: input.tier,
      errorCode: v.error ?? 'UNKNOWN', failureReason: 'mock_verify_failed',
    });
    return fail(verifyErrorToCode(v.error), `ad rejected: ${v.error}`);
  }

  // 4. Cooldown + daily cap.
  const lastWatched = readAdLastWatched(nk, userId, input.tier);
  const today = utcDateKey(nowUtc);
  const todayCount = readAdDailyCount(nk, userId, today);
  const plan = planAdReward(
    tierRow,
    nowUtc,
    lastWatched?.lastWatchedAtUtc ?? null,
    todayCount?.count ?? 0,
    AD_DAILY_CAP,
  );
  if (!plan.ok) {
    emit(nk, logger, 'ad_watch_blocked', {
      userId, transactionId: input.impressionId, tier: input.tier,
      failureReason: plan.reason === 'COOLDOWN' ? 'cooldown' : 'daily_cap',
    });
    return fail('CONFLICT', plan.reason === 'COOLDOWN'
      ? `cooldown not elapsed for tier ${input.tier}`
      : 'daily ad cap reached',
    );
  }

  // 5. Grant coins.
  const idemKey = `ad_watch:${input.impressionId}`;
  const r: Resp<WalletView> = grant(
    nk,
    userId,
    { coins: tierRow.coins },
    { reason: 'ad_reward', sourceId: `ad_watch:${input.tier}:${input.impressionId}` },
    idemKey,
  );
  if (!r.ok) {
    return fail(asCode(r.error?.code), r.error?.message ?? 'grant failed');
  }
  const newBalance = r.data.coins;

  // 6. Update sidecar rows.
  writeAdLastWatched(nk, userId, input.tier, {
    lastWatchedAtUtc: nowUtc,
    lastImpressionId: input.impressionId,
  });
  writeAdDailyCount(nk, userId, today, {
    count: (todayCount?.count ?? 0) + 1,
    lastUpdatedUtc: nowUtc,
  });

  // 7. Watch log.
  const log: AdWatchLog = {
    tier: input.tier,
    adUnitId: input.adUnitId,
    provider: input.provider,
    watchedAtUtc: input.watchedAtUtc,
    grantedAtUtc: nowUtc,
    coinsGranted: tierRow.coins,
    newBalance,
    idempotencyKey: idemKey,
  };
  writeAdWatchLog(nk, userId, input.impressionId, log);

  // 8. Inbox notification (idempotent — same key as the wallet grant).
  sendReward(
    nk,
    userId,
    'ad_reward',
    {
      coins: tierRow.coins,
      note: `ad reward (${input.tier})`,
    },
    idemKey,
    nowUtc,
  );

  // 9. Analytics.
  emit(nk, logger, 'ad_watched', {
    userId,
    tier: input.tier,
    provider: input.provider,
    adUnitId: input.adUnitId,
    impressionId: input.impressionId,
    coinsGranted: tierRow.coins,
    newBalance,
    dailyCount: (todayCount?.count ?? 0) + 1,
  });
  // Phase 9 Chunk 7: ad_watch_granted.
  emit(nk, logger, 'ad_watch_granted', {
    userId,
    transactionId: input.impressionId,
    tier: input.tier,
    adUnitId: input.adUnitId,
    amountCoins: tierRow.coins,
  });

  const out: AdWatchedOutput = {
    rewardId: input.impressionId,
    tier: input.tier,
    coinsGranted: tierRow.coins,
    newBalance,
    nextEligibleAtUtc: nowUtc + tierRow.cooldownSeconds * 1000,
    dailyCount: (todayCount?.count ?? 0) + 1,
    dailyCap: AD_DAILY_CAP,
    idempotent: false,
  };
  return JSON.stringify(ok(out));
};

export const ad_watched: RpcHandler = ad_watched_impl;
