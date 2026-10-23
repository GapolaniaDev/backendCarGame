// Phase 6 Chunk 5 — write-side storage helpers for the achievements
// record. The `achievements` row is created by `achievements_get`
// (`ensureAchievements`) or, since plan T-20, by the race subscriber when
// a race advances an achievement first (progress made before the first
// `achievements_get` is kept, HT Prog-10).
//
// Permission bits: owner read, server-only write (plan T-18, D-10).
// CAS retry budget: 3 attempts, same as `claimDailyMission`.
// A claim commits the `claimed` flag, its coins/gems, its cosmetic and
// its pass XP in ONE wallet movement (plan T-20, HT Prog-7).

import type { IStorageObject, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { moveWallet, type WalletMove } from '../economy/wallet';
import { planGarageDelivery } from '../garage/delivery';
import { planPassXp } from '../pass/pass_repo';
import { achievementXPFor } from '../pass/xp_engine';
import type {
  AchievementDefinition,
  AchievementsRecord,
  MissionReward,
} from './types';
import {
  ACHIEVEMENTS_COLLECTION,
  SERVER_OWNED_READ,
  SERVER_OWNED_WRITE,
  achievementsKey,
  readAchievements,
} from './counter_repo';

const CLAIM_MAX_CAS_RETRIES = 3;

/**
 * Result envelope returned by `ensureAchievements` so the RPC can
 * report a first-vs-existing row to ops dashboards.
 */
export interface EnsureAchievementsResult {
  record: AchievementsRecord;
  created: boolean;
}

/**
 * Lazy-create (or return existing) achievements record for a player.
 * The empty record is `{ schemaVersion: 1, userId, progress: {}, claimed: {} }`
 * — catalog-driven fields are NOT seeded here; the RPC joins with the
 * catalog at response time so a server-side catalog edit shows up
 * without touching storage.
 */
export function ensureAchievements(
  nk: INakama,
  logger: ILogger,
  userId: string,
): EnsureAchievementsResult {
  const existing = readAchievements(nk, userId);
  if (existing !== null) {
    return { record: existing, created: false };
  }

  const rec: AchievementsRecord = {
    schemaVersion: 1,
    userId,
    progress: {},
    claimed: {},
  };
  const obj: IStorageObject = {
    collection: ACHIEVEMENTS_COLLECTION,
    key: achievementsKey(userId),
    userId,
    value: rec as unknown as Record<string, unknown>,
    permissionRead: SERVER_OWNED_READ,
    permissionWrite: SERVER_OWNED_WRITE,
  };
  try {
    nk.storageWrite([{ ...obj, version: '*' }]);
  } catch {
    // Created concurrently (the race subscriber): return that row.
    const now = readAchievements(nk, userId);
    if (now !== null) return { record: now, created: false };
    throw new Error(`achievements for ${userId} could not be created`);
  }
  logger.info('achievements lazy-created user=%s', userId);
  return { record: rec, created: true };
}

/** What an achievement claim delivered (the `granted` shape of achievement_claim). */
export interface AchievementGrant {
  coins: number;
  gems: number;
  cosmetics: string[];
  /** Cosmetics not delivered: already owned, or missing from the catalog (also in `undelivered`). */
  skippedCosmetics: string[];
}

/** Result of `claimAchievement`: the claim and everything it paid. */
export interface ClaimAchievementResult {
  record: AchievementsRecord;
  definition: AchievementDefinition;
  reward: MissionReward;
  granted: AchievementGrant;
  /** Reward items missing from the catalogs (`cosmetic:<id>`), logged as errors. */
  undelivered: string[];
  balance: { coins: number; gems: number };
  xpGranted: number;
  passLevel: number;
  levelUps: number[];
}

/** Durable wallet key of an achievement claim (same shape as before T-20). */
export function achievementClaimKey(userId: string, achievementId: string): string {
  return `achievement:${userId}:${achievementId}`;
}

/**
 * Claim an achievement for the player. Validates:
 *   - achievementId is in the catalog                  → NOT_FOUND
 *   - record exists (player called achievements_get)   → NOT_FOUND
 *   - progress[id] >= target                           → INVALID_RESULT
 *   - claimed[id] === false                            → CONFLICT
 *
 * `claimed[id]`, the coins/gems, the cosmetic and the pass XP commit in
 * one transaction (each attempt re-reads the record): two concurrent
 * claims pay once and a failed payout leaves the achievement claimable.
 */
export function claimAchievement(
  nk: INakama,
  logger: ILogger,
  userId: string,
  achievementId: string,
  catalog: ReadonlyArray<AchievementDefinition>,
  nowMs: number = Date.now(),
): Resp<ClaimAchievementResult> {
  const definition = catalog.find((d) => d.id === achievementId);
  if (definition === undefined) {
    return err('NOT_FOUND', `achievement not in catalog: ${achievementId}`);
  }
  const reward = definition.reward;

  const collection = ACHIEVEMENTS_COLLECTION;
  const key = achievementsKey(userId);

  for (let attempt = 0; attempt < CLAIM_MAX_CAS_RETRIES; attempt++) {
    const objs = nk.storageRead([{ collection, key, userId }]);
    const obj = objs[0];
    if (obj === undefined) {
      return err('NOT_FOUND', `achievements not initialised for ${userId}`);
    }
    const rec = obj.value as AchievementsRecord;
    const version = obj.version ?? '';
    const progress = rec.progress[achievementId] ?? 0;
    const alreadyClaimed = rec.claimed[achievementId] === true;

    if (alreadyClaimed) {
      return err('CONFLICT', `achievement already claimed: ${achievementId}`);
    }
    if (progress < definition.target) {
      return err(
        'INVALID_RESULT',
        `achievement not completed: ${achievementId} (${progress}/${definition.target})`,
      );
    }

    const next: AchievementsRecord = {
      ...rec,
      claimed: { ...rec.claimed, [achievementId]: true },
    };
    const writes: IStorageObject[] = [{
      collection,
      key,
      userId,
      value: next as unknown as Record<string, unknown>,
      permissionRead: SERVER_OWNED_READ,
      permissionWrite: SERVER_OWNED_WRITE,
      version,
    }];
    const delivery = planGarageDelivery(nk, userId, {
      cosmeticIds: typeof reward.cosmeticId === 'string' ? [reward.cosmeticId] : [],
    }, nowMs);
    if (delivery.garageWrite !== null) writes.push(delivery.garageWrite);
    const xp = planPassXp(nk, logger, userId, achievementXPFor(reward));
    if (xp !== null) writes.push(xp.write);
    const changeset: Record<string, number> = {};
    if ((reward.coins ?? 0) > 0) changeset['coins'] = reward.coins as number;
    if ((reward.gems ?? 0) > 0) changeset['gems'] = reward.gems as number;
    const moves: WalletMove[] = Object.keys(changeset).length > 0
      ? [{ changeset, metadata: { reason: 'mission', sourceId: `achievement:${achievementId}` } }]
      : [];

    const moved = moveWallet(nk, userId, achievementClaimKey(userId, achievementId), moves, { extraWrites: writes });
    if (moved.ok) {
      if (moved.data.replayed) return err('CONFLICT', `achievement already claimed: ${achievementId}`);
      for (const missing of delivery.undelivered) {
        logger.error('achievement_claim user=%s id=%s: reward item not in catalog: %s', userId, achievementId, missing);
      }
      logger.info('achievement claimed user=%s id=%s attempt=%d', userId, achievementId, attempt + 1);
      const missingCosmetics = delivery.undelivered.map((x) => x.replace(/^cosmetic:/, ''));
      return ok({
        record: next,
        definition,
        reward,
        granted: {
          coins: changeset['coins'] ?? 0,
          gems: changeset['gems'] ?? 0,
          cosmetics: delivery.cosmetics,
          skippedCosmetics: [...delivery.ownedCosmetics, ...missingCosmetics],
        },
        undelivered: delivery.undelivered,
        balance: moved.data.balance,
        xpGranted: xp?.amount ?? 0,
        passLevel: xp?.newLevel ?? 0,
        levelUps: xp?.levelUps ?? [],
      });
    }
    if (moved.error.code !== 'CONFLICT') return moved; // nothing written: still claimable
    logger.warn(
      'claimAchievement CAS conflict user=%s id=%s attempt=%d',
      userId, achievementId, attempt + 1,
    );
  }
  return err('CONFLICT', `claim CAS retries exhausted for ${achievementId}; nothing was paid, please retry`);
}
