// Phase 6 Chunk 5 — 2 RPCs:
//
//   achievements_get    — current achievements list (lazy-creates the
//                         storage row on first call per D13)
//   achievement_claim   — claim reward of a single achievement whose
//                         progress >= target and !claimed
//
// Both are gated by maintenance (NOT min-version — admin tools still
// need to inspect during maintenance windows).
//
// The HTTP gateway path requires `callerUserId` to match the body's
// claim (defense-in-depth per Phase 5 Chunk 6).

import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import { parseInput } from '../core/parse_input';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import type { IContext, ILogger, INakama } from '../nkruntime';
import { getAchievementsCatalog } from './catalog';
import {
  claimAchievement,
  ensureAchievements,
} from './achievements_repo';
import type {
  AchievementDefinition,
  MissionReward,
} from './types';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';
import { locKey } from '../core/loc_keys';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

// ─── Rate limits (achievements-specific) ─────────────────────────────────────

const ACHIEVEMENTS_RATE_LIMITS = {
  achievements_get: { maxPerWindow: 60, windowSec: 60 },
  achievement_claim: { maxPerWindow: 30, windowSec: 60 },
} as const;

// ─── Input shapes ────────────────────────────────────────────────────────────

export interface AchievementsGetInput {
  callerUserId?: string;
}

export interface AchievementClaimInput {
  achievementId: string;
  callerUserId?: string;
}

// ─── Output shapes ───────────────────────────────────────────────────────────

export interface AchievementCardOutput {
  achievementId: string;
  title: string;
  description: string;
  /** Localization key of `title` (D-11). */
  titleKey: string;
  /** Localization key of `description` (D-11). */
  descriptionKey: string;
  kind: AchievementDefinition['kind'];
  target: number;
  reward: MissionReward;
  progress: number;
  completed: boolean;
  claimed: boolean;
  locked: boolean;
}

export interface AchievementsGetOutput {
  achievements: AchievementCardOutput[];
  nowUtc: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the player's level for `unlockLevel` gating. Mirrors the
 * pattern in `missions/rpcs.ts` (Phase 6 Chunk 3): profile storage
 * key = `profiles/{userId}/{userId}` per Phase 3 Chunk 3. Missing
 * profile → default level 1.
 */
function resolvePlayerLevel(nk: INakama, userId: string): number {
  const objs = nk.storageRead([
    { collection: 'profiles', key: userId, userId },
  ]);
  const obj = objs[0];
  if (!obj) return 1;
  const value = obj.value as { progression?: { level?: number } } | null;
  const lvl = value?.progression?.level;
  return typeof lvl === 'number' && lvl >= 1 ? lvl : 1;
}

/**
 * Materialise an AchievementCardOutput from the catalog + record.
 * `completed = progress >= target` (no separate `completed` flag in
 * the record — derived per D13). `locked` is per `unlockLevel`, but
 * achievements catalog has no `unlockLevel` field; reserved for
 * future catalog extensions (current behavior: locked=false).
 */
function buildAchievementCard(
  def: AchievementDefinition,
  recordProgress: number,
  recordClaimed: boolean,
  playerLevel: number,
): AchievementCardOutput {
  const completed = recordProgress >= def.target;
  // Achievements don't carry an unlockLevel in the catalog today; the
  // field is reserved for future use. We never lock an achievement
  // out based on a missing property.
  const unlockLevel = (def as { unlockLevel?: number }).unlockLevel;
  const locked = typeof unlockLevel === 'number' && unlockLevel > playerLevel;
  return {
    achievementId: def.id,
    title: def.title,
    description: def.description,
    titleKey: locKey('achievement', def.id, 'title'),
    descriptionKey: locKey('achievement', def.id, 'description'),
    kind: def.kind,
    target: def.target,
    reward: def.reward,
    progress: recordProgress,
    completed,
    claimed: recordClaimed,
    locked,
  };
}

function parseBody<T>(body: string): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed;
  return { ok: true, data: parsed.value as T };
}



function checkRateOrLimit(
  nk: INakama,
  logger: ILogger,
  rpcName: keyof typeof ACHIEVEMENTS_RATE_LIMITS,
  userId: string,
): Resp<unknown> | null {
  const opts = ACHIEVEMENTS_RATE_LIMITS[rpcName];
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

// ─── achievements_get ────────────────────────────────────────────────────────

export const achievements_get_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseBody<AchievementsGetInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.data);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const rl = checkRateOrLimit(nk, logger, 'achievements_get', userId);
  if (rl !== null) return toJson(rl);

  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  const result = ensureAchievements(nk, logger, userId);
  const catalog = getAchievementsCatalog();
  const playerLevel = resolvePlayerLevel(nk, userId);

  const cards: AchievementCardOutput[] = catalog.map((def) => {
    const progress = result.record.progress[def.id] ?? 0;
    const claimed = result.record.claimed[def.id] === true;
    return buildAchievementCard(def, progress, claimed, playerLevel);
  });

  emit(nk, logger, 'achievements_get_called', {
    userId,
    achievementCount: cards.length,
    unlocked: cards.filter((c) => !c.locked).length,
    completed: cards.filter((c) => c.completed).length,
    claimed: cards.filter((c) => c.claimed).length,
  });

  const payload: AchievementsGetOutput = {
    achievements: cards,
    nowUtc: new Date().toISOString(),
  };
  return toJson(ok(payload));
};

// ─── achievement_claim ──────────────────────────────────────────────────────

export const achievement_claim_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseBody<AchievementClaimInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.data);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const rl = checkRateOrLimit(nk, logger, 'achievement_claim', userId);
  if (rl !== null) return toJson(rl);

  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  const achievementId = parsed.data.achievementId;
  if (typeof achievementId !== 'string' || achievementId.length === 0) {
    return toJson(err('BAD_REQUEST', 'achievementId is required'));
  }

  // ensureAchievements first so a never-locked attempt yields NOT_FOUND
  // (no row) consistently — without this, the first claim after a
  // subscriber-only progress write would 404.
  ensureAchievements(nk, logger, userId);

  const catalog = getAchievementsCatalog();
  const claimResp = claimAchievement(nk, logger, userId, achievementId, catalog);
  if (!claimResp.ok) return toJson(claimResp);

  // The claim, the coins/gems, the cosmetic and the pass XP were one
  // transaction (plan T-20).
  const { reward, granted, undelivered, xpGranted, passLevel, levelUps } = claimResp.data;
  if (xpGranted > 0) {
    emit(nk, logger, 'pass_xp_gained', {
      userId,
      source: 'achievement_claim',
      amount: xpGranted,
      achievementId,
      newLevel: passLevel,
      levelUps,
    });
  }

  emit(nk, logger, 'achievement_claimed', {
    userId,
    achievementId,
    reward,
    grant: granted,
  });

  return toJson(ok({
    achievementId,
    reward,
    granted,
    xpGranted,
    passLevel,
    levelUps,
    // Additive (T-20): reward items missing from the catalogs, and the wallet.
    ...(undelivered.length > 0 ? { undelivered } : {}),
    newBalance: claimResp.data.balance,
  }));
};

// ─── Top-level bindings ──────────────────────────────────────────────────────

// Global names the 3.27 registration scanner resolves (main.ts). Each one
// loads the VM's runtime state first (plan T-29, D-11; audit N8).
export const achievements_get: RpcHandler = withRuntime(achievements_get_impl);
export const achievement_claim: RpcHandler = withRuntime(achievement_claim_impl);
