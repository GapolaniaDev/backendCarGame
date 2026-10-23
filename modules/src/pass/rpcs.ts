// Phase 6 Chunk 6 — battle pass RPCs:
//
//   pass_get                — lazy-create the PassRecord, close the
//                             season once `endUtc` has passed, return
//                             level/xp/claimed/premium + next-level info.
//   pass_claim              — claim the reward of one level (free or
//                             premium track) in one transaction (T-19).
//   pass_buy_premium        — charge `premiumPriceGems` and unlock the
//                             premium track in one transaction (T-19).
//   admin_grant_premium     — flip the flag without charging (shared-secret
//                             gated, NOT maintenance-gated).
//   admin_pass_season_close — settle every record of a closed season,
//                             resumable (T-19; also run by the ticker).
//
// All player-facing RPCs are gated by `assertNotInMaintenance`. The
// admin RPCs bypass maintenance (same precedent as `account_delete` /
// `admin_*`).
//
// The season close (`season.ts`) settles EVERY player: their unclaimed
// levels go to the inbox. `pass_get` opens the close when `endUtc` has
// passed and settles the caller at once; the service ticker settles the
// rest page by page.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import { parseInput } from '../core/parse_input';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import { assertAdminKey } from '../admin/auth';
import { getPassCatalog, xpToLevel, xpToNextLevel } from './catalog';
import {
  ensurePassRecord,
  readPassRecord,
  writePassUpdate,
  PASS_COLLECTION,
  passRecordKey,
} from './pass_repo';
import {
  closePassSeason,
  getCurrentSeasonId,
  maybeCloseSeason,
  readSeasonCloseMarker,
  settleClosedSeasonRewards,
} from './season';
import { buyPassPremium, claimPassLevel, type PassGrantResult } from './claim';
import type { PassLevelReward } from './types';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

// ─── Rate limits ─────────────────────────────────────────────────────────────

const PASS_RATE_LIMITS = {
  pass_get: { maxPerWindow: 60, windowSec: 60 },
  pass_claim: { maxPerWindow: 30, windowSec: 60 },
  pass_buy_premium: { maxPerWindow: 10, windowSec: 60 },
  admin_grant_premium: { maxPerWindow: 30, windowSec: 60 },
} as const;

// ─── Caller plumbing ───────────────────────────────────────────────────────────



function parseBody<T>(body: string): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed;
  return { ok: true, data: parsed.value as T };
}

function checkRateOrLimit(
  nk: INakama,
  logger: ILogger,
  rpcName: keyof typeof PASS_RATE_LIMITS,
  userId: string,
): Resp<unknown> | null {
  const opts = PASS_RATE_LIMITS[rpcName];
  const verdict = checkRateLimit(nk, {
    rpcName,
    userId,
    maxPerWindow: opts.maxPerWindow,
    windowSec: opts.windowSec,
  });
  if (!verdict.allowed) {
    logger.warn(
      '%s rate limit exceeded user=%s %d/%d',
      rpcName, userId, verdict.count, verdict.limit,
    );
    return err(
      'RATE_LIMITED',
      `${rpcName} rate limit exceeded (${verdict.count}/${verdict.limit})`,
    );
  }
  return null;
}

// ─── Output shapes ───────────────────────────────────────────────────────────

export interface PassLevelOutput {
  level: number;
  xpRequired: number;
  freeReward: PassLevelReward;
  premiumReward: PassLevelReward;
  freeClaimed: boolean;
  premiumClaimed: boolean;
}

export interface PassGetOutput {
  userId: string;
  seasonId: string;
  seasonClosed: boolean;
  endUtc: string;
  xp: number;
  currentLevel: number;
  nextLevel: number | null;
  xpRequired: number;
  xpRemaining: number;
  premiumPurchased: boolean;
  levels: PassLevelOutput[];
  premiumPriceGems: number;
}

// ─── pass_get ────────────────────────────────────────────────────────────────

/**
 * Lazy-create the player's PassRecord, lazy-close the season when
 * applicable, and return the full pass view. The response includes the
 * level cards (so the client can render the track without a second
 * call).
 */
export const pass_get_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseBody<{ callerUserId?: string }>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.data);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const rl = checkRateOrLimit(nk, logger, 'pass_get', userId);
  if (rl !== null) return toJson(rl);

  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  const catalog = getPassCatalog();
  const now = Date.now();

  // Season close (T-19): once endUtc has passed, open the close (once)
  // and settle the caller now — their unclaimed levels go to the inbox.
  // The service ticker settles every other player.
  maybeCloseSeason(nk, logger, now, catalog.seasonId);
  if (readSeasonCloseMarker(nk, catalog.seasonId) !== null) {
    settleClosedSeasonRewards(nk, logger, userId, catalog.seasonId, now);
  }

  // Re-read AFTER the close check so the response reflects the new
  // seasonClosed flag when the lazy close just flipped it.
  const ensured = ensurePassRecord(nk, logger, userId);
  const record = ensured.record;
  const seasonClosed = record.seasonClosed || readSeasonCloseMarker(nk, catalog.seasonId) !== null;

  const cur = xpToLevel(catalog, record.xp);
  const next = xpToNextLevel(catalog, record.xp);

  const levels: PassLevelOutput[] = catalog.levels.map((lvl) => ({
    level: lvl.level,
    xpRequired: lvl.xpRequired,
    freeReward: lvl.freeReward,
    premiumReward: lvl.premiumReward,
    freeClaimed: record.claimedFree.includes(lvl.level),
    premiumClaimed: record.claimedPremium.includes(lvl.level),
  }));

  const payload: PassGetOutput = {
    userId: record.userId,
    seasonId: record.seasonId,
    seasonClosed,
    endUtc: catalog.endUtc,
    xp: record.xp,
    currentLevel: cur,
    nextLevel: next.nextLevel,
    xpRequired: next.xpRequired,
    xpRemaining: next.xpRemaining,
    premiumPurchased: record.premiumPurchased,
    levels,
    premiumPriceGems: catalog.premiumPriceGems,
  };

  emit(nk, logger, 'pass_get_called', {
    userId,
    seasonId: record.seasonId,
    seasonClosed,
    currentLevel: cur,
    xp: record.xp,
    premiumPurchased: record.premiumPurchased,
  });

  return toJson(ok(payload));
};
export const pass_get: RpcHandler = withRuntime(pass_get_impl);

// ─── pass_claim ──────────────────────────────────────────────────────────────

export interface PassClaimInput {
  level: number;
  track: 'free' | 'premium';
  callerUserId?: string;
}

export interface PassClaimOutput {
  level: number;
  track: 'free' | 'premium';
  reward: PassLevelReward;
  granted: PassGrantResult;
  newXp: number;
  currentLevel: number;
  nextLevel: number | null;
  /** Additive (T-19): reward items missing from the catalogs, not delivered. */
  undelivered?: string[];
  /** Additive (T-19): `{coins, gems}` like every money RPC. */
  newBalance: { coins: number; gems: number };
}

/**
 * Claim the reward of `track` at `level`. Validates:
 *   - level >= 1 and in the catalog            → BAD_REQUEST / NOT_FOUND
 *   - track is 'free' or 'premium'             → BAD_REQUEST
 *   - player XP >= level.xpRequired             → INVALID_RESULT
 *   - track === 'premium' && !premiumPurchased → FORBIDDEN
 *   - already claimed                          → CONFLICT
 *   - season closed                            → CONFLICT
 *
 * The claim mark, the currencies and the garage items commit in one
 * transaction (`claimPassLevel`): two concurrent claims pay once and a
 * failed payout leaves the level claimable.
 */
export const pass_claim_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseBody<PassClaimInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.data);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const rl = checkRateOrLimit(nk, logger, 'pass_claim', userId);
  if (rl !== null) return toJson(rl);

  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  const level = parsed.data.level;
  const track = parsed.data.track;
  if (!Number.isInteger(level) || level < 1) {
    return toJson(err('BAD_REQUEST', 'level must be a positive integer'));
  }
  if (track !== 'free' && track !== 'premium') {
    return toJson(err('BAD_REQUEST', "track must be 'free' or 'premium'"));
  }

  const claimed = claimPassLevel(nk, logger, userId, level, track, Date.now());
  if (!claimed.ok) return toJson(claimed);
  const { record, reward, granted, undelivered, newBalance } = claimed.data;
  const catalog = getPassCatalog();
  const nx = xpToNextLevel(catalog, record.xp);
  logger.info('pass claim ok user=%s level=%d track=%s', userId, level, track);
  emit(nk, logger, 'pass_claimed', { userId, level, track, reward, granted });
  const payload: PassClaimOutput = {
    level,
    track,
    reward,
    granted,
    newXp: record.xp,
    currentLevel: xpToLevel(catalog, record.xp),
    nextLevel: nx.nextLevel,
    ...(undelivered.length > 0 ? { undelivered } : {}),
    newBalance,
  };
  return toJson(ok(payload));
};
export const pass_claim: RpcHandler = withRuntime(pass_claim_impl);

// ─── pass_buy_premium ────────────────────────────────────────────────────────

export interface PassBuyPremiumInput {
  callerUserId?: string;
}

export interface PassBuyPremiumOutput {
  userId: string;
  seasonId: string;
  premiumPurchased: true;
  priceGems: number;
  newGemsBalance: number;
  /** Additive (T-12): `{coins, gems}` like every money RPC. */
  newBalance: { coins: number; gems: number };
}

/**
 * Charge `premiumPriceGems` and flip `premiumPurchased` in one
 * transaction (`buyPassPremium`): a failed charge changes nothing, a
 * lost CAS charges nothing, and a second call returns the current state
 * without charging again.
 *
 * Errors:
 *   - season closed       → CONFLICT
 *   - insufficient gems   → INSUFFICIENT_FUNDS (state unchanged)
 */
export const pass_buy_premium_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseBody<PassBuyPremiumInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.data);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const rl = checkRateOrLimit(nk, logger, 'pass_buy_premium', userId);
  if (rl !== null) return toJson(rl);

  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  const catalog = getPassCatalog();
  const priceGems = catalog.premiumPriceGems;
  const bought = buyPassPremium(nk, logger, userId);
  if (!bought.ok) return toJson(bought);
  const { record, charged, newBalance } = bought.data;
  if (charged) {
    logger.info('pass premium purchased user=%s seasonId=%s priceGems=%d', userId, record.seasonId, priceGems);
    emit(nk, logger, 'pass_premium_purchased', { userId, seasonId: record.seasonId, priceGems });
  }
  return toJson(ok({
    userId,
    seasonId: record.seasonId,
    premiumPurchased: true as const,
    priceGems,
    newGemsBalance: newBalance.gems,
    newBalance,
  } satisfies PassBuyPremiumOutput));
};
export const pass_buy_premium: RpcHandler = withRuntime(pass_buy_premium_impl);

// ─── admin_grant_premium ─────────────────────────────────────────────────────

export interface AdminGrantPremiumInput {
  userId: string;
  adminKey: string;
}

/**
 * Admin override that flips the `premiumPurchased` flag WITHOUT
 * charging gems. Shared-secret gated (NOT maintenance-gated, NOT
 * rate-limited against the player — the adminRpcKey has its own
 * 30/60s budget under the same admin surface).
 *
 * Idempotent: a second call returns the current state.
 */
export const admin_grant_premium_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const auth = assertAdminKey(logger, nk, parsed.raw);
  if (!auth.ok) return auth.error;

  const targetUserId =
    typeof parsed.raw['userId'] === 'string' ? (parsed.raw['userId'] as string) : '';
  if (targetUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'userId is required'));
  }

  const seasonId = getCurrentSeasonId();
  const rl = checkRateOrLimit(nk, logger, 'admin_grant_premium', targetUserId);
  if (rl !== null) return toJson(rl);

  // Ensure record exists (admin might target a player who never opened the pass).
  ensurePassRecord(nk, logger, targetUserId);

  const existing = readPassRecord(nk, targetUserId, seasonId);
  if (existing === null) {
    return toJson(err('NOT_FOUND', 'pass record missing after lazy-create'));
  }

  if (existing.record.premiumPurchased) {
    return toJson(ok({
      userId: targetUserId,
      seasonId,
      premiumPurchased: true as const,
      viaAdmin: true,
    }));
  }

  let current = existing;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Every attempt writes the record it just read (T-19: a retry with a
    // stale record would overwrite a concurrent claim or XP grant).
    const next = { ...current.record, premiumPurchased: true };
    try {
      writePassUpdate(nk, next, current.version);
      logger.info(
        'admin grant premium user=%s seasonId=%s attempt=%d',
        targetUserId, seasonId, attempt + 1,
      );
      emit(nk, logger, 'pass_admin_grant_premium', {
        userId: targetUserId,
        seasonId,
      });
      return toJson(ok({
        userId: targetUserId,
        seasonId,
        premiumPurchased: true as const,
        viaAdmin: true,
      }));
    } catch (e) {
      logger.warn(
        'admin_grant_premium CAS conflict user=%s attempt=%d: %s',
        targetUserId, attempt + 1,
        e instanceof Error ? e.message : String(e),
      );
      const fresh = readPassRecord(nk, targetUserId, seasonId);
      if (fresh === null) {
        return toJson(err('CONFLICT', 'pass record vanished during admin grant retry'));
      }
      if (fresh.record.premiumPurchased) {
        return toJson(ok({
          userId: targetUserId,
          seasonId,
          premiumPurchased: true as const,
          viaAdmin: true,
        }));
      }
      current = fresh;
    }
  }
  return toJson(err('CONFLICT', 'admin_grant_premium CAS retries exhausted'));
};
export const admin_grant_premium: RpcHandler = withRuntime(admin_grant_premium_impl);

// ─── admin_pass_season_close ─────────────────────────────────────────────────

/**
 * Settle a closed pass season for every player (T-19), page by page;
 * the ticker runs the same close once `endUtc` has passed. Body:
 * `{adminKey, seasonId?, maxRecords?}`. `seasonId` defaults to the loaded
 * season, which must have ended (else CONFLICT). Another season id
 * settles that season's leftover records with the loaded catalog's level
 * table (one pass catalog exists; meant for stray records and drills).
 * Call again until `state` is `settled`.
 */
export const admin_pass_season_close_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const auth = assertAdminKey(logger, nk, parsed.raw);
  if (!auth.ok) return auth.error;

  const catalog = getPassCatalog();
  const raw = parsed.raw;
  const seasonId = typeof raw['seasonId'] === 'string' && raw['seasonId'].length > 0
    ? raw['seasonId'] as string
    : catalog.seasonId;
  const now = Date.now();
  if (seasonId === catalog.seasonId && Date.parse(catalog.endUtc) > now) {
    return toJson(err('CONFLICT', `pass season ${seasonId} is still active (ends ${catalog.endUtc})`));
  }
  if (seasonId !== catalog.seasonId) {
    logger.warn('admin_pass_season_close: season %s is not the loaded %s; using the loaded level table', seasonId, catalog.seasonId);
  }
  const maxRecords = typeof raw['maxRecords'] === 'number' ? raw['maxRecords'] as number : 2000;
  const run = closePassSeason(nk, logger, seasonId, now, { maxRecords });
  return toJson(ok(run));
};
export const admin_pass_season_close: RpcHandler = withRuntime(admin_pass_season_close_impl);

// Re-export the storage key so unit tests can seed it directly without
// duplicating the schema.
export { PASS_COLLECTION, passRecordKey };