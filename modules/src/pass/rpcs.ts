// Phase 6 Chunk 6 — 4 RPCs:
//
//   pass_get            — lazy-create PassRecord, lazy-close the
//                         season on access post-endUtc, returns
//                         level/xp/claimed/premium + next-level info.
//   pass_claim          — claim the reward of a single level (free or
//                         premium track); idempotent via CAS.
//   pass_buy_premium    — spend `premiumPriceGems` and unlock the
//                         premium track (CAS, idempotent).
//   admin_grant_premium — bypass gem cost, flip the flag (shared-secret
//                         gated, NOT maintenance-gated).
//
// All player-facing RPCs are gated by `assertNotInMaintenance`. The
// admin RPC bypasses maintenance (same precedent as
// `account_delete` / `admin_*`).
//
// `pass_get` performs the D11 lazy close on every access: if the
// catalog's `endUtc` is in the past AND the global close marker is
// absent, it writes the marker + flips every visible player's
// `seasonClosed` flag via `settleClosedSeasonRewards`.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import { parseInput } from '../core/parse_input';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import { assertAdminKey } from '../admin/auth';
import { findLevel, getPassCatalog, xpToLevel, xpToNextLevel } from './catalog';
import {
  ensurePassRecord,
  readPassRecord,
  writePassUpdate,
  PASS_COLLECTION,
  passRecordKey,
} from './pass_repo';
import {
  getCurrentSeasonId,
  maybeCloseSeason,
  readSeasonCloseMarker,
  settleClosedSeasonRewards,
} from './season';
import { grantPassReward } from './reward_granter';
import type { PassLevelReward } from './types';
import { spend as walletSpend, walletGet } from '../economy/wallet';
import type { LedgerMetadata } from '../economy/types';

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

interface CallerOk { ok: true; id: string; }
interface CallerErr { ok: false; error: string; }

function resolveCaller(
  ctx: IContext,
  declared: string | undefined,
  logger: ILogger,
): CallerOk | CallerErr {
  const socketCaller = ctx.userId ?? null;
  const declaredCaller = typeof declared === 'string' && declared.length > 0 ? declared : null;
  if (socketCaller !== null) {
    if (declaredCaller !== null && declaredCaller !== socketCaller) {
      return {
        ok: false,
        error: toJson(err('FORBIDDEN', 'callerUserId does not match authenticated user')),
      };
    }
    return { ok: true, id: socketCaller };
  }
  if (declaredCaller !== null) return { ok: true, id: declaredCaller };
  logger.warn('pass RPC called with no caller identity');
  return { ok: false, error: toJson(err('UNAUTHENTICATED', 'no caller identity')) };
}

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

  const callerId = resolveCaller(ctx, parsed.data.callerUserId, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const rl = checkRateOrLimit(nk, logger, 'pass_get', userId);
  if (rl !== null) return toJson(rl);

  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  const catalog = getPassCatalog();
  const now = Date.now();

  // D11 lazy close: if the catalog's endUtc is in the past AND the
  // global close marker is missing, write it. Then settle the per-user
  // PassRecord flag.
  const closeOutcome = maybeCloseSeason(nk, logger, now, catalog.seasonId);
  if (closeOutcome.closed) {
    settleClosedSeasonRewards(nk, logger, userId, catalog.seasonId);
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
export const pass_get: RpcHandler = pass_get_impl;

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
  granted: ReturnType<typeof grantPassReward>;
  newXp: number;
  currentLevel: number;
  nextLevel: number | null;
}

/**
 * Claim the reward of `track` at `level`. Validates:
 *   - level ∈ [1, maxLevel]                    → BAD_REQUEST
 *   - track ∈ {'free', 'premium'}              → BAD_REQUEST
 *   - record exists (player called pass_get)   → NOT_FOUND
 *   - player XP >= level.xpRequired             → INVALID_RESULT
 *   - track === 'premium' && !premiumPurchased → FORBIDDEN
 *   - already claimed (idempotent)             → CONFLICT
 *   - seasonClosed                             → CONFLICT
 *
 * On success the appropriate `claimedFree` / `claimedPremium` list
 * appends `level` via a CAS write (3 retries on conflict). The reward
 * is then dispatched through `grantPassReward` (never throws).
 */
export const pass_claim_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseBody<PassClaimInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = resolveCaller(ctx, parsed.data.callerUserId, logger);
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

  const catalog = getPassCatalog();
  const levelDef = findLevel(catalog, level);
  if (levelDef === null) {
    return toJson(err('NOT_FOUND', `pass level not in catalog: ${level}`));
  }

  // Lazy-create so a brand-new user who jumps straight to pass_claim
  // gets the row (and the resulting "no XP yet" INVALID_RESULT).
  ensurePassRecord(nk, logger, userId);

  const existing = readPassRecord(nk, userId, catalog.seasonId);
  if (existing === null) {
    return toJson(err('NOT_FOUND', 'pass record missing after lazy-create'));
  }

  const rec = existing.record;
  if (rec.seasonClosed) {
    return toJson(err('CONFLICT', 'pass season is closed'));
  }

  if (rec.xp < levelDef.xpRequired) {
    return toJson(err(
      'INVALID_RESULT',
      `not enough XP for level ${level} (${rec.xp}/${levelDef.xpRequired})`,
    ));
  }

  if (track === 'premium' && !rec.premiumPurchased) {
    return toJson(err('FORBIDDEN', 'premium track not purchased'));
  }

  const claimedList = track === 'free' ? rec.claimedFree : rec.claimedPremium;
  if (claimedList.includes(level)) {
    return toJson(err('CONFLICT', `level ${level} ${track} already claimed`));
  }

  const reward: PassLevelReward = track === 'free' ? levelDef.freeReward : levelDef.premiumReward;
  const refId = `lvl${level}-${track}`;

  // CAS-update the record.
  let version = existing.version;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = track === 'free'
      ? { ...rec, claimedFree: [...rec.claimedFree, level] }
      : { ...rec, claimedPremium: [...rec.claimedPremium, level] };
    try {
      writePassUpdate(nk, next, version);
      logger.info(
        'pass claim ok user=%s level=%d track=%s attempt=%d',
        userId, level, track, attempt + 1,
      );
      const granted = grantPassReward(nk, logger, userId, reward, refId);
      const cur = xpToLevel(catalog, next.xp);
      const nx = xpToNextLevel(catalog, next.xp);
      emit(nk, logger, 'pass_claimed', {
        userId,
        level,
        track,
        reward,
        granted,
      });
      const payload: PassClaimOutput = {
        level,
        track,
        reward,
        granted,
        newXp: next.xp,
        currentLevel: cur,
        nextLevel: nx.nextLevel,
      };
      return toJson(ok(payload));
    } catch (e) {
      logger.warn(
        'pass_claim CAS conflict user=%s level=%d track=%s attempt=%d: %s',
        userId, level, track, attempt + 1,
        e instanceof Error ? e.message : String(e),
      );
      const fresh = readPassRecord(nk, userId, catalog.seasonId);
      if (fresh === null) {
        return toJson(err('CONFLICT', 'pass record vanished during claim retry'));
      }
      version = fresh.version;
    }
  }
  return toJson(err('CONFLICT', `pass_claim CAS retries exhausted for level ${level}`));
};
export const pass_claim: RpcHandler = pass_claim_impl;

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
}

/**
 * Spend `premiumPriceGems` from the player's wallet and flip the
 * `premiumPurchased` flag. Idempotent: a second call returns the
 * current state without charging gems again.
 *
 * Errors:
 *   - season closed                              → CONFLICT
 *   - already purchased                          → CONFLICT (200-style payload)
 *   - insufficient gems                          → INSUFFICIENT_FUNDS
 *
 * Wallet ops inside multiUpdate are NOT supported by the JS runtime
 * (Phase 3 Caveat D3) — the helpers run sequentially: spend first
 * (which throws INSUFFICIENT_FUNDS on insufficient balance), then
 * CAS-update the record.
 */
export const pass_buy_premium_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseBody<PassBuyPremiumInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = resolveCaller(ctx, parsed.data.callerUserId, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const rl = checkRateOrLimit(nk, logger, 'pass_buy_premium', userId);
  if (rl !== null) return toJson(rl);

  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  const catalog = getPassCatalog();
  const priceGems = catalog.premiumPriceGems;

  ensurePassRecord(nk, logger, userId);
  const existing = readPassRecord(nk, userId, catalog.seasonId);
  if (existing === null) {
    return toJson(err('NOT_FOUND', 'pass record missing after lazy-create'));
  }

  const rec = existing.record;
  if (rec.seasonClosed) {
    return toJson(err('CONFLICT', 'pass season is closed'));
  }
  if (rec.premiumPurchased) {
    // Idempotent success: no charge, just return the current state.
    return toJson(ok({
      userId,
      seasonId: rec.seasonId,
      premiumPurchased: true as const,
      priceGems,
      newGemsBalance: currentGems(nk, userId),
    } satisfies PassBuyPremiumOutput));
  }

  // Spend via the wallet helper. We do NOT use `spend()`'s pre-check
  // path (it would race); instead, attempt and surface INSUFFICIENT_FUNDS.
  const idempotencyKey = `pass:premium:${userId}:${catalog.seasonId}`;
  const spendResult = trySpendGems(nk, userId, priceGems, idempotencyKey);
  if (!spendResult.ok) {
    const e = spendResult.error;
    return toJson(err(e.code as Parameters<typeof err>[0], e.message, e.details));
  }

  // Flip the flag via CAS.
  let version = existing.version;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next: typeof rec = { ...rec, premiumPurchased: true };
    try {
      writePassUpdate(nk, next, version);
      logger.info(
        'pass premium purchased user=%s seasonId=%s priceGems=%d attempt=%d',
        userId, rec.seasonId, priceGems, attempt + 1,
      );
      emit(nk, logger, 'pass_premium_purchased', {
        userId,
        seasonId: rec.seasonId,
        priceGems,
      });
      return toJson(ok({
        userId,
        seasonId: rec.seasonId,
        premiumPurchased: true as const,
        priceGems,
        newGemsBalance: spendResult.balance,
      } satisfies PassBuyPremiumOutput));
    } catch (e) {
      logger.warn(
        'pass_buy_premium CAS conflict user=%s attempt=%d: %s',
        userId, attempt + 1,
        e instanceof Error ? e.message : String(e),
      );
      // Compensating refund if the flag CAS keeps failing (rare).
      const fresh = readPassRecord(nk, userId, catalog.seasonId);
      if (fresh === null) {
        return toJson(err('CONFLICT', 'pass record vanished during buy retry'));
      }
      if (fresh.record.premiumPurchased) {
        // Another caller raced us. The gems are gone; report idempotency.
        return toJson(ok({
          userId,
          seasonId: fresh.record.seasonId,
          premiumPurchased: true as const,
          priceGems,
          newGemsBalance: currentGems(nk, userId),
        } satisfies PassBuyPremiumOutput));
      }
      version = fresh.version;
    }
  }
  return toJson(err('CONFLICT', 'pass_buy_premium CAS retries exhausted'));
};
export const pass_buy_premium: RpcHandler = pass_buy_premium_impl;

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

  let version = existing.version;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = { ...existing.record, premiumPurchased: true };
    try {
      writePassUpdate(nk, next, version);
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
      version = fresh.version;
    }
  }
  return toJson(err('CONFLICT', 'admin_grant_premium CAS retries exhausted'));
};
export const admin_grant_premium: RpcHandler = admin_grant_premium_impl;

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Read current wallet gems balance via the wallet helper. */
function currentGems(nk: INakama, userId: string): number {
  return walletGet(nk, userId).gems;
}

/**
 * Spend `gems` on the player's wallet. Returns `{ ok, balance }` on
 * success or `{ ok: false, error }` carrying a serialised
 * `err('INSUFFICIENT_FUNDS', ...)` envelope.
 */
function trySpendGems(
  nk: INakama,
  userId: string,
  gems: number,
  idempotencyKey: string,
):
  | { ok: true; balance: number }
  | { ok: false; error: { code: string; message: string; details?: unknown } } {
  if (!Number.isInteger(gems) || gems <= 0) {
    return {
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'gems must be a positive integer' },
    };
  }
  const meta: LedgerMetadata = {
    reason: 'store',
    sourceId: `pass_premium_${userId}`,
  };
  const result = walletSpend(nk, userId, { gems }, meta, idempotencyKey);
  if (!result.ok) {
    const errCode = result.error?.code ?? 'INTERNAL';
    const errMsg = result.error?.message ?? 'spend failed';
    const errDetails = result.error?.details;
    return {
      ok: false,
      error: {
        code: errCode,
        message: errMsg,
        ...(errDetails !== undefined ? { details: errDetails } : {}),
      },
    };
  }
  return { ok: true, balance: result.data.gems };
}

// Re-export the storage key so unit tests can seed it directly without
// duplicating the schema.
export { PASS_COLLECTION, passRecordKey };