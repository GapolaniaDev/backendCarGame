// Phase 6 — write-side storage helpers for daily/weekly mission records.
//
// CAS-safe per Phase 4/5 convention. The shape of the record is owned
// by the catalog + assignment helpers; this module persists them.
//
// Permission bits: `SERVER_OWNED_READ=1`, `SERVER_OWNED_WRITE=1` per
// the Phase 4/5 server-only convention.
//
// Special cases:
//   - `ensureDailyMissions` resets `rerollsLeftToday` to 1 and clears
//     `lastRerollAt` when the stored record's `dateUtc` is older than
//     today's UTC date (D12).
//   - `ensureWeeklyMissions` re-creates assignments when `weekUtc` changes.
//   - `claimDailyMission` validates: instance.completed === true,
//     instance.claimed === false; flips claimed=true; returns the reward.
//   - `rerollDailyMission` decrements `rerollsLeftToday` OR charges 50
//     gems via `wallet.spend` (the RPC layer does the spend AFTER the
//     repo returns the cost).

import type { IStorageObject, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import type {
  AchievementsRecord,
  DailyMissions,
  MissionDefinition,
  MissionReward,
  WeeklyMissions,
} from './types';
import {
  achievementsKey,
  dailyMissionsKey,
  weeklyMissionsKey,
  ACHIEVEMENTS_COLLECTION,
  MISSIONS_DAILY_COLLECTION,
  MISSIONS_WEEKLY_COLLECTION,
  SERVER_OWNED_READ,
  SERVER_OWNED_WRITE,
} from './counter_repo';
import {
  buildMissionInstances,
  dailyAssignmentsFor,
  weeklyAssignmentsFor,
  rerollSingleMission,
} from './assignment';

const MAX_CAS_RETRIES = 3;

/** Cost (in gems) of a paid reroll after the free one is used up. D4 = 50. */
export const PAID_REROLL_COST_GEMS = 50;

// ─── CAS helpers ─────────────────────────────────────────────────────────────

interface CasWriteResult {
  version: string;
}

function casWrite(
  nk: INakama,
  obj: IStorageObject,
): CasWriteResult {
  const ack = nk.storageWrite([obj]);
  const first = ack[0];
  if (!first) {
    throw new Error('storageWrite returned empty ack');
  }
  return { version: first.version };
}

function buildWriteObject(
  collection: string,
  key: string,
  userId: string,
  value: unknown,
  version: string | undefined,
): IStorageObject {
  const base: IStorageObject = {
    collection,
    key,
    userId,
    value: value as Record<string, unknown>,
    permissionRead: SERVER_OWNED_READ,
    permissionWrite: SERVER_OWNED_WRITE,
  };
  if (version !== undefined) base.version = version;
  return base;
}

function readRecord(
  nk: INakama,
  collection: string,
  key: string,
  userId: string,
): { value: unknown; version: string } | null {
  const objs = nk.storageRead([{ collection, key, userId }]);
  const obj = objs[0];
  if (!obj) return null;
  return { value: obj.value, version: obj.version ?? '' };
}

// ─── ensureDailyMissions ─────────────────────────────────────────────────────

export interface EnsureResult {
  record: DailyMissions;
  created: boolean;
  justReset: boolean;
}

export function ensureDailyMissions(
  nk: INakama,
  logger: ILogger,
  userId: string,
  dateUtc: string,
  _playerLevel: number,
  dailyCatalog: MissionDefinition[],
): EnsureResult {
  const collection = MISSIONS_DAILY_COLLECTION;
  const key = dailyMissionsKey(userId, dateUtc);
  const existing = readRecord(nk, collection, key, userId);
  if (existing !== null) {
    const rec = existing.value as DailyMissions;
    if (rec.dateUtc === dateUtc) {
      return { record: rec, created: false, justReset: false };
    }
  }

  const definitions = dailyAssignmentsFor(userId, dateUtc, dailyCatalog, nk);
  const rec: DailyMissions = {
    schemaVersion: 1,
    userId,
    dateUtc,
    assignedAt: Date.now(),
    rerollsLeftToday: 1,
    missions: buildMissionInstances(definitions, dateUtc),
  };

  if (existing === null) {
    const obj = buildWriteObject(collection, key, userId, rec, undefined);
    casWrite(nk, obj);
    logger.info('daily missions created user=%s date=%s', userId, dateUtc);
    return { record: rec, created: true, justReset: false };
  }

  // Daily reset (D12) — CAS update.
  const obj = buildWriteObject(collection, key, userId, rec, existing.version);
  try {
    casWrite(nk, obj);
    logger.info('daily missions reset user=%s date=%s', userId, dateUtc);
    return { record: rec, created: false, justReset: true };
  } catch (e) {
    logger.error('daily missions reset CAS failed: %s', JSON.stringify(e));
    throw new Error(`daily reset CAS failed: ${JSON.stringify(e)}`);
  }
}

// ─── ensureWeeklyMissions ────────────────────────────────────────────────────

export interface EnsureWeeklyResult {
  record: WeeklyMissions;
  created: boolean;
  justReset: boolean;
}

export function ensureWeeklyMissions(
  nk: INakama,
  logger: ILogger,
  userId: string,
  weekUtc: string,
  _playerLevel: number,
  weeklyCatalog: MissionDefinition[],
): EnsureWeeklyResult {
  const collection = MISSIONS_WEEKLY_COLLECTION;
  const key = weeklyMissionsKey(userId, weekUtc);
  const existing = readRecord(nk, collection, key, userId);
  if (existing !== null) {
    const rec = existing.value as WeeklyMissions;
    if (rec.weekUtc === weekUtc) {
      return { record: rec, created: false, justReset: false };
    }
  }

  const definitions = weeklyAssignmentsFor(userId, weekUtc, weeklyCatalog, nk);
  const rec: WeeklyMissions = {
    schemaVersion: 1,
    userId,
    weekUtc,
    assignedAt: Date.now(),
    rerollsLeftToday: 1,
    missions: buildMissionInstances(definitions, weekUtc),
  };

  if (existing === null) {
    const obj = buildWriteObject(collection, key, userId, rec, undefined);
    casWrite(nk, obj);
    logger.info('weekly missions created user=%s week=%s', userId, weekUtc);
    return { record: rec, created: true, justReset: false };
  }

  const obj = buildWriteObject(collection, key, userId, rec, existing.version);
  try {
    casWrite(nk, obj);
    logger.info('weekly missions reset user=%s week=%s', userId, weekUtc);
    return { record: rec, created: false, justReset: true };
  } catch (e) {
    logger.error('weekly missions reset CAS failed: %s', JSON.stringify(e));
    throw new Error(`weekly reset CAS failed: ${JSON.stringify(e)}`);
  }
}

// ─── claimDailyMission ──────────────────────────────────────────────────────

export interface ClaimResult {
  record: DailyMissions;
  definition: MissionDefinition;
  reward: MissionReward;
}

export function claimDailyMission(
  nk: INakama,
  logger: ILogger,
  userId: string,
  dateUtc: string,
  missionId: string,
  catalog: MissionDefinition[],
): Resp<ClaimResult> {
  const collection = MISSIONS_DAILY_COLLECTION;
  const key = dailyMissionsKey(userId, dateUtc);
  const definition = catalog.find((d) => d.id === missionId);
  if (definition === undefined) {
    return err('NOT_FOUND', `mission not in catalog: ${missionId}`);
  }

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const existing = readRecord(nk, collection, key, userId);
    if (existing === null) {
      return err('NOT_FOUND', `daily missions not assigned for ${userId}/${dateUtc}`);
    }
    const rec = existing.value as DailyMissions;
    const instance = rec.missions.find((m) => m.missionId === missionId);
    if (instance === undefined) {
      return err('NOT_FOUND', `mission not in assignment: ${missionId}`);
    }
    if (!instance.completed) {
      return err('INVALID_RESULT', `mission not completed: ${missionId}`);
    }
    if (instance.claimed) {
      return err('CONFLICT', `mission already claimed: ${missionId}`);
    }

    const next: DailyMissions = {
      ...rec,
      missions: rec.missions.map((m) =>
        m.missionId === missionId ? { ...m, claimed: true } : m,
      ),
    };
    const obj = buildWriteObject(collection, key, userId, next, existing.version);
    try {
      casWrite(nk, obj);
      return ok({ record: next, definition, reward: definition.reward });
    } catch (e) {
      logger.warn('claimDailyMission CAS conflict attempt %d: %s', attempt + 1, JSON.stringify(e));
    }
  }
  return err('CONFLICT', `claim CAS retries exhausted for ${missionId}`);
}

// ─── claimWeeklyMission ─────────────────────────────────────────────────────

export function claimWeeklyMission(
  nk: INakama,
  logger: ILogger,
  userId: string,
  weekUtc: string,
  missionId: string,
  catalog: MissionDefinition[],
): Resp<{ record: WeeklyMissions; definition: MissionDefinition; reward: MissionReward }> {
  const collection = MISSIONS_WEEKLY_COLLECTION;
  const key = weeklyMissionsKey(userId, weekUtc);
  const definition = catalog.find((d) => d.id === missionId);
  if (definition === undefined) {
    return err('NOT_FOUND', `mission not in catalog: ${missionId}`);
  }

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const existing = readRecord(nk, collection, key, userId);
    if (existing === null) {
      return err('NOT_FOUND', `weekly missions not assigned for ${userId}/${weekUtc}`);
    }
    const rec = existing.value as WeeklyMissions;
    const instance = rec.missions.find((m) => m.missionId === missionId);
    if (instance === undefined) {
      return err('NOT_FOUND', `mission not in assignment: ${missionId}`);
    }
    if (!instance.completed) {
      return err('INVALID_RESULT', `mission not completed: ${missionId}`);
    }
    if (instance.claimed) {
      return err('CONFLICT', `mission already claimed: ${missionId}`);
    }

    const next: WeeklyMissions = {
      ...rec,
      missions: rec.missions.map((m) =>
        m.missionId === missionId ? { ...m, claimed: true } : m,
      ),
    };
    const obj = buildWriteObject(collection, key, userId, next, existing.version);
    try {
      casWrite(nk, obj);
      return ok({ record: next, definition, reward: definition.reward });
    } catch (e) {
      logger.warn('claimWeeklyMission CAS conflict attempt %d: %s', attempt + 1, JSON.stringify(e));
    }
  }
  return err('CONFLICT', `claim CAS retries exhausted for ${missionId}`);
}

// ─── rerollDailyMission ─────────────────────────────────────────────────────

export interface RerollResult {
  record: DailyMissions;
  newDefinition: MissionDefinition;
  costGems: number;
}

export interface ConsumeRerollResult {
  /** New rerollsLeftToday value AFTER the consume. */
  rerollsLeftToday: number;
  /** Cost in gems (0 if a free reroll was used). */
  costGems: number;
}

/**
 * Pure helper: decide whether to consume a free reroll or charge
 * `PAID_REROLL_COST_GEMS`. Returns the cost the caller should debit.
 */
export function consumeReroll(
  dailyRecord: DailyMissions,
  useGems: boolean,
): ConsumeRerollResult {
  if (dailyRecord.rerollsLeftToday > 0 && !useGems) {
    return { rerollsLeftToday: dailyRecord.rerollsLeftToday - 1, costGems: 0 };
  }
  return { rerollsLeftToday: dailyRecord.rerollsLeftToday, costGems: PAID_REROLL_COST_GEMS };
}

export function rerollDailyMission(
  nk: INakama,
  logger: ILogger,
  userId: string,
  dateUtc: string,
  missionId: string,
  useGems: boolean,
  catalog: MissionDefinition[],
): Resp<RerollResult> {
  const collection = MISSIONS_DAILY_COLLECTION;
  const key = dailyMissionsKey(userId, dateUtc);
  const definition = catalog.find((d) => d.id === missionId);
  if (definition === undefined) {
    return err('NOT_FOUND', `mission not in catalog: ${missionId}`);
  }

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const existing = readRecord(nk, collection, key, userId);
    if (existing === null) {
      return err('NOT_FOUND', `daily missions not assigned for ${userId}/${dateUtc}`);
    }
    const rec = existing.value as DailyMissions;
    const instance = rec.missions.find((m) => m.missionId === missionId);
    if (instance === undefined) {
      return err('NOT_FOUND', `mission not in assignment: ${missionId}`);
    }
    if (instance.completed || instance.claimed) {
      return err('CONFLICT', `cannot reroll completed/claimed mission: ${missionId}`);
    }

    const consumed = consumeReroll(rec, useGems);
    if (consumed.costGems > 0 && rec.rerollsLeftToday === 0 && !useGems) {
      return err('INSUFFICIENT_FUNDS',
        `reroll costs ${PAID_REROLL_COST_GEMS} gems but useGems=false`);
    }

    const excludeIds = new Set<string>(
      rec.missions.filter((m) => m.missionId !== missionId).map((m) => m.missionId),
    );
    const replacement = rerollSingleMission(
      userId, dateUtc, catalog, excludeIds, attempt, nk,
    );
    if (replacement === null) {
      return err('INTERNAL', 'reroll: no replacement available');
    }

    const lastRerollAt = Date.now();

    const missionsReplaced = rec.missions.map((m) =>
      m.missionId !== missionId ? m : {
        instanceId: `daily:${replacement.id}@${rec.dateUtc}`,
        missionId: replacement.id,
        progress: 0,
        completed: false,
        claimed: false,
      },
    );

    const next: DailyMissions = {
      ...rec,
      rerollsLeftToday: consumed.rerollsLeftToday,
      missions: missionsReplaced,
      ...(lastRerollAt > 0 ? { lastRerollAt } : {}),
    };

    const obj = buildWriteObject(collection, key, userId, next, existing.version);
    try {
      casWrite(nk, obj);
      return ok({
        record: next,
        newDefinition: replacement,
        costGems: consumed.costGems,
      });
    } catch (e) {
      logger.warn('rerollDailyMission CAS conflict attempt %d: %s', attempt + 1, JSON.stringify(e));
    }
  }
  return err('CONFLICT', `reroll CAS retries exhausted for ${missionId}`);
}

// ─── Subscriber CAS write helpers (Chunk 4) ─────────────────────────────────
//
// Pattern: re-read → apply pure delta → write with version. On conflict,
// re-read + re-apply the same delta + retry up to MAX_CAS_RETRIES times. On
// exhaustion, log error + return false (caller can continue with the next
// player). The subscriber must NEVER throw on storage churn.

const SUBSCRIBER_MAX_CAS_RETRIES = 3;

/**
 * CAS-write a daily missions update. Returns `true` when the write
 * succeeded (possibly after retries), `false` when retries were
 * exhausted (subscriber should continue with the next user).
 */
export function writeDailyMissionsCAS(
  nk: INakama,
  logger: ILogger,
  userId: string,
  dateUtc: string,
  next: DailyMissions,
): boolean {
  const collection = MISSIONS_DAILY_COLLECTION;
  const key = dailyMissionsKey(userId, dateUtc);
  for (let attempt = 0; attempt < SUBSCRIBER_MAX_CAS_RETRIES; attempt++) {
    const existing = readRecord(nk, collection, key, userId);
    if (existing === null) {
      // Storage row vanished (likely a race with `ensureDailyMissions`
      // creating the very first row). Recreate it without a version.
      const obj = buildWriteObject(collection, key, userId, next, undefined);
      try {
        casWrite(nk, obj);
        return true;
      } catch (e) {
        logger.warn(
          'writeDailyMissionsCAS initial write attempt %d user=%s: %s',
          attempt + 1, userId,
          e instanceof Error ? e.message : String(e),
        );
        continue;
      }
    }
    const obj = buildWriteObject(collection, key, userId, next, existing.version);
    try {
      casWrite(nk, obj);
      return true;
    } catch (e) {
      logger.warn(
        'writeDailyMissionsCAS conflict attempt %d user=%s: %s',
        attempt + 1, userId,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  logger.error(
    'writeDailyMissionsCAS retries exhausted user=%s date=%s',
    userId, dateUtc,
  );
  return false;
}

/**
 * CAS-write a weekly missions update. Same retry semantics as
 * `writeDailyMissionsCAS`.
 */
export function writeWeeklyMissionsCAS(
  nk: INakama,
  logger: ILogger,
  userId: string,
  weekUtc: string,
  next: WeeklyMissions,
): boolean {
  const collection = MISSIONS_WEEKLY_COLLECTION;
  const key = weeklyMissionsKey(userId, weekUtc);
  for (let attempt = 0; attempt < SUBSCRIBER_MAX_CAS_RETRIES; attempt++) {
    const existing = readRecord(nk, collection, key, userId);
    if (existing === null) {
      const obj = buildWriteObject(collection, key, userId, next, undefined);
      try {
        casWrite(nk, obj);
        return true;
      } catch (e) {
        logger.warn(
          'writeWeeklyMissionsCAS initial write attempt %d user=%s: %s',
          attempt + 1, userId,
          e instanceof Error ? e.message : String(e),
        );
        continue;
      }
    }
    const obj = buildWriteObject(collection, key, userId, next, existing.version);
    try {
      casWrite(nk, obj);
      return true;
    } catch (e) {
      logger.warn(
        'writeWeeklyMissionsCAS conflict attempt %d user=%s: %s',
        attempt + 1, userId,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  logger.error(
    'writeWeeklyMissionsCAS retries exhausted user=%s week=%s',
    userId, weekUtc,
  );
  return false;
}

/**
 * CAS-write an achievements update. Same retry semantics as
 * `writeDailyMissionsCAS`.
 */
export function writeAchievementsCAS(
  nk: INakama,
  logger: ILogger,
  userId: string,
  next: AchievementsRecord,
): boolean {
  const collection = ACHIEVEMENTS_COLLECTION;
  const key = achievementsKey(userId);
  for (let attempt = 0; attempt < SUBSCRIBER_MAX_CAS_RETRIES; attempt++) {
    const existing = readRecord(nk, collection, key, userId);
    if (existing === null) {
      const obj = buildWriteObject(collection, key, userId, next, undefined);
      try {
        casWrite(nk, obj);
        return true;
      } catch (e) {
        logger.warn(
          'writeAchievementsCAS initial write attempt %d user=%s: %s',
          attempt + 1, userId,
          e instanceof Error ? e.message : String(e),
        );
        continue;
      }
    }
    const obj = buildWriteObject(collection, key, userId, next, existing.version);
    try {
      casWrite(nk, obj);
      return true;
    } catch (e) {
      logger.warn(
        'writeAchievementsCAS conflict attempt %d user=%s: %s',
        attempt + 1, userId,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  logger.error('writeAchievementsCAS retries exhausted user=%s', userId);
  return false;
}