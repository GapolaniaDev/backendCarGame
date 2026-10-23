// Rewarded ads paid by the ad network's server-to-server callback (plan
// T-25, P-04; audit PC-05).
//
// `ad_watched` used to pay on the client's own call (any client could
// mint coins). Now the reward is paid only here, when LevelPlay's S2S
// callback arrives signed (`ads/levelplay.ts`):
//
//   ads_levelplay_callback   server-to-server, `http_key` (no session):
//     the callback URL configured in the LevelPlay dashboard. The signing
//     "Private Key" is `LEVELPLAY_S2S_PRIVATE_KEY` in runtime.env; while
//     it is empty every callback is rejected. A valid callback pays the
//     reward once per event id (durable: the event row and the wallet
//     movement share one transaction) and answers `<eventId>:OK`, also
//     for a repeated event (LevelPlay retries until it reads it).
//   ad_reward_status         player session: the caller's recent
//     callback rewards, today's count and the cap; the client polls it
//     after an ad closes.
//
// The amount must be one of the ad_rewards.json tiers (5/15/30/60
// coins): the dashboard reward per placement has to match a tier. The
// daily cap (10, D75) counts paid events; an event over the cap, or with
// an amount that is not a tier, is recorded and acknowledged without
// paying (a retry would not change it). Bad signature, missing secret or
// malformed parameters are errors without `:OK`, so LevelPlay retries
// them (and the dashboard shows the failure).

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok } from '../core/response';
import { parseInput } from '../core/parse_input';
import { serverNowMs } from '../core/time';
import { envString } from '../core/runtime_env';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';
import { emit } from '../core/admin/analytics';
import { moveWallet, walletGet } from '../economy/wallet';
import { sendNotice } from '../liveops/inbox';
import { getAdRewardsCatalog } from './catalog';
import { AD_DAILY_CAP, utcDateKey, endOfUtcDayUtc } from './grant';
import { levelPlaySignature, parseLevelPlayCallback, signaturesMatch } from './levelplay';
import {
  adDailyCountWrite,
  adS2sRewardWrite,
  listAdS2sRewards,
  readAdDailyCount,
  readAdDailyCountWithVersion,
  readAdS2sReward,
  type AdS2sReward,
  type AdS2sStatus,
} from './repo';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

export const LEVELPLAY_KEY_ENV = 'LEVELPLAY_S2S_PRIVATE_KEY';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTEMPTS = 3;

export interface AdCallbackOutput {
  /** `<eventId>:OK` — what LevelPlay looks for in the body. */
  ack: string;
  eventId: string;
  userId: string;
  status: AdS2sStatus | 'unknown_user';
  coinsGranted: number;
  /** True when the event was already processed by an earlier callback. */
  idempotent: boolean;
}

function ackOut(eventId: string, userId: string, status: AdCallbackOutput['status'], coins: number, idempotent: boolean): string {
  const out: AdCallbackOutput = { ack: `${eventId}:OK`, eventId, userId, status, coinsGranted: coins, idempotent };
  return JSON.stringify(ok(out));
}

function userExists(nk: INakama, userId: string): boolean {
  if (!UUID_RE.test(userId)) return false;
  try {
    return nk.usersGetId([userId]).length > 0;
  } catch {
    return false;
  }
}

export const ads_levelplay_callback_impl: RpcHandler = (ctx, logger, nk, body) => {
  // Server-to-server only: a player session never reaches the payout.
  if (typeof ctx?.userId === 'string' && ctx.userId.length > 0) {
    return JSON.stringify(err('FORBIDDEN', 'server-to-server callback (http_key) only'));
  }
  const secret = envString(ctx, LEVELPLAY_KEY_ENV);
  if (secret.length === 0) {
    logger.warn('ads_levelplay_callback rejected: %s is not configured', LEVELPLAY_KEY_ENV);
    return JSON.stringify(err('SERVICE_UNAVAILABLE', 'ad callbacks are not configured', { reason: 'NOT_CONFIGURED' }));
  }
  let raw: Record<string, unknown> = {};
  if (body.trim().length > 0) {
    const parsed = parseInput(body);
    if (!parsed.ok) return parsed.error;
    raw = parsed.raw;
  }
  const cb = parseLevelPlayCallback(ctx.queryParams, raw);
  if (!cb.ok) return JSON.stringify(err('BAD_REQUEST', cb.reason));
  const event = cb.value;
  if (!signaturesMatch(levelPlaySignature(nk, event, secret), event.signature)) {
    logger.warn('ads_levelplay_callback rejected: bad signature for event %s', event.eventId);
    emit(nk, logger, 'ad_watch_failed', { userId: event.userId, transactionId: event.eventId, errorCode: 'FORBIDDEN', failureReason: 'bad_signature' });
    return JSON.stringify(err('FORBIDDEN', 'signature does not match', { reason: 'BAD_SIGNATURE' }));
  }
  if (!userExists(nk, event.userId)) {
    // Signed by LevelPlay but nobody to pay (deleted account, wrong user
    // id in the SDK): acknowledged so it is not retried for a week.
    logger.warn('ads_levelplay_callback: unknown user %s for event %s, acknowledged without payment', event.userId, event.eventId);
    return ackOut(event.eventId, event.userId, 'unknown_user', 0, false);
  }
  const userId = event.userId;

  const tier = getAdRewardsCatalog().find((t) => t.coins === event.rewards);
  const key = `ad_reward:levelplay:${event.eventId}`;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const seen = readAdS2sReward(nk, userId, 'levelplay', event.eventId);
    if (seen !== null) return ackOut(event.eventId, userId, seen.status, seen.coins, true);

    const nowUtc = serverNowMs();
    const day = utcDateKey(nowUtc);
    const count = readAdDailyCountWithVersion(nk, userId, day);
    const row: AdS2sReward = {
      network: 'levelplay',
      eventId: event.eventId,
      status: 'granted',
      coins: 0,
      rewards: event.rewards,
      receivedAtUtc: nowUtc,
      ...(tier !== undefined ? { tier: tier.tier } : {}),
      ...(event.placementName !== undefined ? { placementName: event.placementName } : {}),
      ...(event.adNetwork !== undefined ? { adNetwork: event.adNetwork } : {}),
    };
    if (tier === undefined) row.status = 'rejected_amount';
    else if ((count?.value.count ?? 0) >= AD_DAILY_CAP) row.status = 'capped';

    if (row.status !== 'granted') {
      try {
        nk.storageWrite([adS2sRewardWrite(userId, row)]);
      } catch {
        continue; // a concurrent callback wrote it: re-read
      }
      logger.warn('ads_levelplay_callback: event %s %s (rewards=%d), acknowledged without payment',
        event.eventId, row.status, event.rewards);
      return ackOut(event.eventId, userId, row.status, 0, false);
    }

    row.coins = tier!.coins;
    const moved = moveWallet(nk, userId, key, [{
      changeset: { coins: row.coins },
      metadata: { reason: 'ad_reward', sourceId: `levelplay:${event.eventId}` },
    }], {
      extraWrites: [
        adS2sRewardWrite(userId, row),
        adDailyCountWrite(userId, day, { count: (count?.value.count ?? 0) + 1, lastUpdatedUtc: nowUtc }, count?.version ?? '*'),
      ],
      result: { status: 'granted', coins: row.coins },
    });
    if (!moved.ok) {
      const reason = (moved.error.details as { reason?: string } | undefined)?.reason;
      if (moved.error.code === 'CONFLICT' && reason === 'VERSION_CONFLICT') continue;
      logger.error('ads_levelplay_callback: payment of event %s failed: %s', event.eventId, moved.error.message);
      return JSON.stringify(moved);
    }
    if (moved.data.replayed) return ackOut(event.eventId, userId, 'granted', row.coins, true);

    sendNotice(nk, userId, 'ad_reward', { coins: row.coins, note: `ad reward (${tier!.tier})` }, key, nowUtc);
    emit(nk, logger, 'ad_watch_granted', {
      userId, transactionId: event.eventId, tier: tier!.tier, adUnitId: event.placementName ?? '', amountCoins: row.coins,
    });
    return ackOut(event.eventId, userId, 'granted', row.coins, false);
  }
  return JSON.stringify(err('CONFLICT', 'concurrent update; please retry', { reason: 'VERSION_CONFLICT' }));
};

export interface AdRewardStatusOutput {
  rewards: AdS2sReward[];
  dailyCount: number;
  dailyCap: number;
  /** Next UTC midnight, when the count resets. */
  dailyResetAtUtc: number;
  newBalance: { coins: number; gems: number };
}

export const ad_reward_status_impl: RpcHandler = (ctx, _logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.raw);
  if (!caller.ok) return caller.error;
  const sinceRaw = parsed.raw['sinceUtc'];
  const limitRaw = parsed.raw['limit'];
  if (sinceRaw !== undefined && (typeof sinceRaw !== 'number' || !Number.isFinite(sinceRaw))) {
    return JSON.stringify(err('BAD_REQUEST', 'sinceUtc must be a number'));
  }
  if (limitRaw !== undefined && (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 50)) {
    return JSON.stringify(err('BAD_REQUEST', 'limit must be an integer in [1, 50]'));
  }
  const nowUtc = serverNowMs();
  const since = typeof sinceRaw === 'number' ? sinceRaw : 0;
  const rewards = listAdS2sRewards(nk, caller.id, typeof limitRaw === 'number' ? limitRaw : 20)
    .filter((r) => r.receivedAtUtc > since);
  const out: AdRewardStatusOutput = {
    rewards,
    dailyCount: readAdDailyCount(nk, caller.id, utcDateKey(nowUtc))?.count ?? 0,
    dailyCap: AD_DAILY_CAP,
    dailyResetAtUtc: endOfUtcDayUtc(nowUtc),
    newBalance: walletGet(nk, caller.id),
  };
  return JSON.stringify(ok(out));
};

export const ads_levelplay_callback: RpcHandler = withRuntime(ads_levelplay_callback_impl);
export const ad_reward_status: RpcHandler = withRuntime(ad_reward_status_impl);
