// Phase 9 Chunk 5 — Ad reward RPC (`ad_watched`).
//
// T-25 (PC-05): `ad_watched` NO LONGER PAYS. It used to credit coins on
// the client's own call (mock "verification" of the input shape), so any
// client could mint coins. Rewards are paid only by the ad network's
// signed server-to-server callback (`ads_levelplay_callback`,
// `ads/s2s_rpcs.ts`), and the client reads the result with
// `ad_reward_status`. `ad_watched` stays as an optional, non-paying
// report of a watch seen by the client (analytics `ad_watch_initiated`):
// it answers `granted: false`, `coinsGranted: 0`, the current balance
// and today's paid count. The Unity client does not call any ad RPC yet.
//
// Bypasses maintenance (D77, same precedent as iap_purchase).

import type { IContext, ILogger, INakama } from '../nkruntime';
import { ok, err } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { serverNowMs } from '../core/time';
import { walletGet, type WalletView } from '../economy/wallet';
import { emit } from '../core/admin/analytics';
import { findAdRewardTier } from './catalog';
import { AD_DAILY_CAP, utcDateKey } from './grant';
import { readAdDailyCount } from './repo';
import type { AdProvider, AdTier } from './types';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

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
  /** Always 0 since T-25: the network's callback pays. */
  coinsGranted: number;
  /** Always false since T-25 (additive). */
  granted: boolean;
  /** How the reward arrives: `server_callback` (poll `ad_reward_status`). Additive. */
  rewardVia: 'server_callback';
  /** `{coins, gems}` like every money RPC (T-12; was the coins number). */
  newBalance: WalletView;
  nextEligibleAtUtc: number;
  /** Rewards paid today by the callback. */
  dailyCount: number;
  dailyCap: number;
  idempotent: boolean;
}

const PROVIDERS: ReadonlySet<string> = new Set<AdProvider>(['levelplay', 'mock', 'admob', 'unityads']);

function asInput(raw: Record<string, unknown>): AdWatchedInput | { error: string } {
  const tier = raw['tier'];
  if (tier !== 'small' && tier !== 'medium' && tier !== 'large' && tier !== 'xlarge') {
    return { error: 'tier must be one of small|medium|large|xlarge' };
  }
  const provider = raw['provider'];
  if (typeof provider !== 'string' || !PROVIDERS.has(provider)) {
    return { error: 'provider must be levelplay|mock|admob|unityads' };
  }
  if (typeof raw['adUnitId'] !== 'string' || (raw['adUnitId'] as string).length === 0) {
    return { error: 'adUnitId is required' };
  }
  if (typeof raw['impressionId'] !== 'string' || (raw['impressionId'] as string).length === 0
      || (raw['impressionId'] as string).length > 128) {
    return { error: 'impressionId is required (1-128 characters)' };
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

export const ad_watched_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  // Session identity only (D-03); a body callerUserId must match it.
  const caller = requireCallerId(ctx, parsed.raw);
  if (!caller.ok) return caller.error;
  const userId: string = caller.id;
  const inputOrErr = asInput(parsed.raw);
  if ('error' in inputOrErr) {
    emit(nk, logger, 'ad_watch_failed', {
      userId, errorCode: 'BAD_REQUEST', failureReason: inputOrErr.error,
    });
    return fail('BAD_REQUEST', inputOrErr.error);
  }
  const input = inputOrErr;
  if (!findAdRewardTier(input.tier)) {
    return fail('NOT_FOUND', `unknown tier: ${input.tier}`);
  }
  emit(nk, logger, 'ad_watch_initiated', {
    userId,
    tier: input.tier,
    provider: input.provider,
    adUnitId: input.adUnitId,
    transactionId: input.impressionId,
  });
  const nowUtc = serverNowMs();
  const out: AdWatchedOutput = {
    rewardId: input.impressionId,
    tier: input.tier,
    coinsGranted: 0,
    granted: false,
    rewardVia: 'server_callback',
    newBalance: walletGet(nk, userId),
    nextEligibleAtUtc: nowUtc,
    dailyCount: readAdDailyCount(nk, userId, utcDateKey(nowUtc))?.count ?? 0,
    dailyCap: AD_DAILY_CAP,
    idempotent: false,
  };
  return JSON.stringify(ok(out));
};

export const ad_watched: RpcHandler = withRuntime(ad_watched_impl);
