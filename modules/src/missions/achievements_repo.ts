// Phase 6 Chunk 5 — write-side storage helpers for the achievements
// record. The `achievements` storage collection is LAZY-created by
// `achievements_get` (this module's `ensureAchievements`) the first
// time a player asks. The subscriber (Chunk 4) deliberately does NOT
// auto-create — a player who never opened the achievements tab has no
// row, which is exactly what D13 asks for.
//
// Permission bits: server-owned (Phase 4/5 convention).
// CAS retry budget: 3 attempts, same as `claimDailyMission`.

import type { IStorageObject, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
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
  nk.storageWrite([obj]);
  logger.info('achievements lazy-created user=%s', userId);
  return { record: rec, created: true };
}

/**
 * Result envelope returned by `claimAchievement`. The caller (RPC) uses
 * `definition.reward` to drive `grantAchievementReward`.
 */
export interface ClaimAchievementResult {
  record: AchievementsRecord;
  definition: AchievementDefinition;
  reward: MissionReward;
}

/**
 * Mark an achievement as `claimed` for the player. Validates:
 *   - achievementId is in the catalog                  → NOT_FOUND
 *   - record exists (player called achievements_get)   → NOT_FOUND
 *   - progress[id] >= target                           → INVALID_RESULT
 *   - claimed[id] === false                            → CONFLICT
 *
 * On success the record's `claimed[id]` flips to `true` via a CAS
 * write with up to `CLAIM_MAX_CAS_RETRIES` attempts. The reward grant
 * is the caller's job (`grantAchievementReward`) so this helper stays
 * pure storage logic.
 */
export function claimAchievement(
  nk: INakama,
  logger: ILogger,
  userId: string,
  achievementId: string,
  catalog: ReadonlyArray<AchievementDefinition>,
): Resp<ClaimAchievementResult> {
  const definition = catalog.find((d) => d.id === achievementId);
  if (definition === undefined) {
    return err('NOT_FOUND', `achievement not in catalog: ${achievementId}`);
  }

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
    const writeObj: IStorageObject = {
      collection,
      key,
      userId,
      value: next as unknown as Record<string, unknown>,
      permissionRead: SERVER_OWNED_READ,
      permissionWrite: SERVER_OWNED_WRITE,
      version,
    };
    try {
      nk.storageWrite([writeObj]);
      logger.info(
        'achievement claimed user=%s id=%s attempt=%d',
        userId, achievementId, attempt + 1,
      );
      return ok({ record: next, definition, reward: definition.reward });
    } catch (e) {
      logger.warn(
        'claimAchievement CAS conflict user=%s id=%s attempt=%d: %s',
        userId, achievementId, attempt + 1,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return err('CONFLICT', `claim CAS retries exhausted for ${achievementId}`);
}