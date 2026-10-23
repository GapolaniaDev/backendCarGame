// Phase 6 — write-side storage helpers for daily/weekly mission records.
//
// Permission bits: `SERVER_OWNED_READ=1` (owner), `SERVER_OWNED_WRITE=0`
// (server-only, plan T-18 / D-10).
//
// Concurrency (plan T-20; HT Prog-4, 7, 8, 9, 10):
//   - every write is a CAS on the version just read; a retry re-reads the
//     record and re-applies its change (`updateWithCas`), so the race
//     subscriber can no longer overwrite a claim made in between (the old
//     retry wrote its stale record with a fresh version: a claimed
//     mission came back unclaimed and paid again);
//   - a claim commits the `claimed` flag, its coins/gems and its pass XP
//     in ONE wallet movement (`moveWallet`, durable key with the period):
//     a failed payout writes nothing and the mission stays claimable;
//   - a paid reroll commits the gem charge and the new mission together:
//     without gems the mission does not change;
//   - rows are created with version `*` (`newDailyRecord` /
//     `newWeeklyRecord` are the same deterministic assignment the RPC and
//     the subscriber use), so a race finished before the first
//     `missions_get` creates the day's row and its progress is kept.
//
// Special cases:
//   - `ensureDailyMissions` resets `rerollsLeftToday` to 1 when a stored
//     record's `dateUtc` is older than the requested day (D12).
//   - `ensureWeeklyMissions` re-creates assignments when `weekUtc` changes.

import type { IStorageObject, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { moveWallet, type WalletMove } from '../economy/wallet';
import { planPassXp } from '../pass/pass_repo';
import { missionXPFor } from '../pass/xp_engine';
import type {
  AchievementsRecord,
  DailyMissions,
  MissionDefinition,
  MissionInstance,
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

/**
 * Read → `mutate(current)` → write at the version read (`*` when absent);
 * on a lost CAS, read again and re-apply. `mutate` returns the next value,
 * or null for "nothing to write". Returns the value written (or null when
 * nothing was written); `false` when the retries ran out.
 */
export function updateWithCas<T>(
  nk: INakama,
  logger: ILogger,
  collection: string,
  key: string,
  userId: string,
  mutate: (current: T | null) => T | null,
): T | null | false {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const existing = readRecord(nk, collection, key, userId);
    const next = mutate(existing === null ? null : existing.value as T);
    if (next === null) return null;
    try {
      nk.storageWrite([buildWriteObject(collection, key, userId, next, existing?.version ?? '*')]);
      return next;
    } catch (e) {
      logger.warn(
        'CAS conflict %s/%s attempt %d: %s',
        collection, key, attempt + 1, e instanceof Error ? e.message : String(e),
      );
    }
  }
  logger.error('CAS retries exhausted %s/%s', collection, key);
  return false;
}

// ─── New records (deterministic assignment) ──────────────────────────────────

/** Today's daily assignment for `userId` (sha256 of user and date: D1/D2). */
export function newDailyRecord(
  nk: INakama,
  userId: string,
  dateUtc: string,
  dailyCatalog: MissionDefinition[],
  nowMs: number = Date.now(),
): DailyMissions {
  return {
    schemaVersion: 1,
    userId,
    dateUtc,
    assignedAt: nowMs,
    rerollsLeftToday: 1,
    missions: buildMissionInstances(dailyAssignmentsFor(userId, dateUtc, dailyCatalog, nk), dateUtc),
  };
}

/** This week's assignment for `userId`. */
export function newWeeklyRecord(
  nk: INakama,
  userId: string,
  weekUtc: string,
  weeklyCatalog: MissionDefinition[],
  nowMs: number = Date.now(),
): WeeklyMissions {
  return {
    schemaVersion: 1,
    userId,
    weekUtc,
    assignedAt: nowMs,
    rerollsLeftToday: 1,
    missions: buildMissionInstances(weeklyAssignmentsFor(userId, weekUtc, weeklyCatalog, nk), weekUtc),
  };
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
  const key = dailyMissionsKey(userId, dateUtc);
  let created = false;
  let justReset = false;
  const written = updateWithCas<DailyMissions>(nk, logger, MISSIONS_DAILY_COLLECTION, key, userId, (cur) => {
    if (cur !== null && cur.dateUtc === dateUtc) return null;
    created = cur === null;
    justReset = cur !== null;
    return newDailyRecord(nk, userId, dateUtc, dailyCatalog);
  });
  if (written === false) throw new Error(`daily missions for ${userId}/${dateUtc} could not be written`);
  if (written === null) {
    // Already assigned (by an earlier call or the race subscriber).
    const rec = readRecord(nk, MISSIONS_DAILY_COLLECTION, key, userId);
    return { record: rec?.value as DailyMissions, created: false, justReset: false };
  }
  logger.info('daily missions %s user=%s date=%s', created ? 'created' : 'reset', userId, dateUtc);
  return { record: written, created, justReset };
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
  const key = weeklyMissionsKey(userId, weekUtc);
  let created = false;
  let justReset = false;
  const written = updateWithCas<WeeklyMissions>(nk, logger, MISSIONS_WEEKLY_COLLECTION, key, userId, (cur) => {
    if (cur !== null && cur.weekUtc === weekUtc) return null;
    created = cur === null;
    justReset = cur !== null;
    return newWeeklyRecord(nk, userId, weekUtc, weeklyCatalog);
  });
  if (written === false) throw new Error(`weekly missions for ${userId}/${weekUtc} could not be written`);
  if (written === null) {
    const rec = readRecord(nk, MISSIONS_WEEKLY_COLLECTION, key, userId);
    return { record: rec?.value as WeeklyMissions, created: false, justReset: false };
  }
  logger.info('weekly missions %s user=%s week=%s', created ? 'created' : 'reset', userId, weekUtc);
  return { record: written, created, justReset };
}

// ─── Claims ──────────────────────────────────────────────────────────────────

export interface ClaimResult {
  record: DailyMissions;
  definition: MissionDefinition;
  reward: MissionReward;
  /** Wallet after the claim. */
  balance: { coins: number; gems: number };
  /** Pass XP added with the claim (0 when the reward has none). */
  xpGranted: number;
  passLevel: number;
  levelUps: number[];
}

/** Durable wallet key of a mission claim: the period is in it (a mission id comes back on later days). */
export function missionClaimKey(kind: 'daily' | 'weekly', period: string, missionId: string, userId: string): string {
  return `mission:${kind}:${period}:${missionId}:${userId}`;
}

/** The claim of one mission of a daily or weekly record, in one transaction. */
function claimInRecord<R extends { missions: MissionInstance[] }>(
  nk: INakama,
  logger: ILogger,
  userId: string,
  kind: 'daily' | 'weekly',
  period: string,
  missionId: string,
  catalog: MissionDefinition[],
): Resp<Omit<ClaimResult, 'record'> & { record: R }> {
  const collection = kind === 'daily' ? MISSIONS_DAILY_COLLECTION : MISSIONS_WEEKLY_COLLECTION;
  const key = kind === 'daily' ? dailyMissionsKey(userId, period) : weeklyMissionsKey(userId, period);
  const definition = catalog.find((d) => d.id === missionId);
  if (definition === undefined) {
    return err('NOT_FOUND', `mission not in catalog: ${missionId}`);
  }
  const reward = definition.reward;

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const existing = readRecord(nk, collection, key, userId);
    if (existing === null) {
      return err('NOT_FOUND', `${kind} missions not assigned for ${userId}/${period}`);
    }
    const rec = existing.value as R;
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

    const next: R = {
      ...rec,
      missions: rec.missions.map((m) => (m.missionId === missionId ? { ...m, claimed: true } : m)),
    };
    const writes: IStorageObject[] = [buildWriteObject(collection, key, userId, next, existing.version)];
    const xp = planPassXp(nk, logger, userId, missionXPFor(reward));
    if (xp !== null) writes.push(xp.write);
    const changeset: Record<string, number> = {};
    if ((reward.coins ?? 0) > 0) changeset['coins'] = reward.coins as number;
    if ((reward.gems ?? 0) > 0) changeset['gems'] = reward.gems as number;
    const moves: WalletMove[] = Object.keys(changeset).length > 0
      ? [{ changeset, metadata: { reason: 'mission', sourceId: 'mission_claim' } }]
      : [];

    const moved = moveWallet(nk, userId, missionClaimKey(kind, period, missionId, userId), moves, { extraWrites: writes });
    if (moved.ok) {
      if (moved.data.replayed) return err('CONFLICT', `mission already claimed: ${missionId}`);
      return ok({
        record: next,
        definition,
        reward,
        balance: moved.data.balance,
        xpGranted: xp?.amount ?? 0,
        passLevel: xp?.newLevel ?? 0,
        levelUps: xp?.levelUps ?? [],
      });
    }
    if (moved.error.code !== 'CONFLICT') {
      // Nothing was written: the mission stays claimable.
      return moved;
    }
    logger.warn('claim %s mission CAS conflict user=%s mission=%s attempt %d', kind, userId, missionId, attempt + 1);
  }
  return err('CONFLICT', `claim CAS retries exhausted for ${missionId}; nothing was paid, please retry`);
}

export function claimDailyMission(
  nk: INakama,
  logger: ILogger,
  userId: string,
  dateUtc: string,
  missionId: string,
  catalog: MissionDefinition[],
): Resp<ClaimResult> {
  return claimInRecord<DailyMissions>(nk, logger, userId, 'daily', dateUtc, missionId, catalog);
}

export function claimWeeklyMission(
  nk: INakama,
  logger: ILogger,
  userId: string,
  weekUtc: string,
  missionId: string,
  catalog: MissionDefinition[],
): Resp<Omit<ClaimResult, 'record'> & { record: WeeklyMissions }> {
  return claimInRecord<WeeklyMissions>(nk, logger, userId, 'weekly', weekUtc, missionId, catalog);
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

/**
 * Durable wallet key of a paid reroll: the day and the number of rerolls
 * already made that day, so each paid reroll has its own key (the
 * replaced mission id alone repeats when a mission comes back).
 */
export function missionRerollKey(userId: string, dateUtc: string, rerollCount: number): string {
  return `mission_reroll:${userId}:${dateUtc}:${rerollCount}`;
}

/**
 * Replace one daily mission. A free reroll is a CAS write; a paid one
 * commits the gem charge and the new mission in one transaction, so
 * without gems (INSUFFICIENT_FUNDS) the mission does not change.
 */
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

    const rerollCount = rec.rerollCount ?? 0;
    const next: DailyMissions = {
      ...rec,
      rerollsLeftToday: consumed.rerollsLeftToday,
      rerollCount: rerollCount + 1,
      lastRerollAt: Date.now(),
      missions: rec.missions.map((m) =>
        m.missionId !== missionId ? m : {
          instanceId: `daily:${replacement.id}@${rec.dateUtc}`,
          missionId: replacement.id,
          progress: 0,
          completed: false,
          claimed: false,
        },
      ),
    };
    const write = buildWriteObject(collection, key, userId, next, existing.version);
    const result = { record: next, newDefinition: replacement, costGems: consumed.costGems };

    if (consumed.costGems === 0) {
      try {
        nk.storageWrite([write]);
        return ok(result);
      } catch (e) {
        logger.warn('rerollDailyMission CAS conflict attempt %d: %s', attempt + 1, e instanceof Error ? e.message : String(e));
        continue;
      }
    }
    const moved = moveWallet(nk, userId, missionRerollKey(userId, dateUtc, rerollCount), [{
      changeset: { gems: -consumed.costGems },
      metadata: { reason: 'mission', sourceId: 'mission_reroll' },
    }], { extraWrites: [write] });
    if (moved.ok && !moved.data.replayed) return ok(result);
    if (!moved.ok && moved.error.code !== 'CONFLICT') return moved; // e.g. INSUFFICIENT_FUNDS: nothing changed
    logger.warn('rerollDailyMission paid CAS conflict attempt %d', attempt + 1);
  }
  return err('CONFLICT', `reroll CAS retries exhausted for ${missionId}; nothing was charged`);
}

// ─── Subscriber updates (plan T-20) ──────────────────────────────────────────
//
// The race subscriber passes a change function; it is re-applied to the
// record read on every attempt (never a record read before), and a
// missing row is created with the day's assignment so progress made
// before the first `missions_get` / `achievements_get` is kept.

/** Apply `change` to today's daily record (created when missing). False when retries ran out. */
export function updateDailyMissions(
  nk: INakama,
  logger: ILogger,
  userId: string,
  dateUtc: string,
  catalog: MissionDefinition[],
  change: (rec: DailyMissions) => DailyMissions | null,
): DailyMissions | null | false {
  return updateWithCas<DailyMissions>(
    nk, logger, MISSIONS_DAILY_COLLECTION, dailyMissionsKey(userId, dateUtc), userId,
    (cur) => change(cur ?? newDailyRecord(nk, userId, dateUtc, catalog)),
  );
}

/** Apply `change` to this week's record (created when missing). */
export function updateWeeklyMissions(
  nk: INakama,
  logger: ILogger,
  userId: string,
  weekUtc: string,
  catalog: MissionDefinition[],
  change: (rec: WeeklyMissions) => WeeklyMissions | null,
): WeeklyMissions | null | false {
  return updateWithCas<WeeklyMissions>(
    nk, logger, MISSIONS_WEEKLY_COLLECTION, weeklyMissionsKey(userId, weekUtc), userId,
    (cur) => change(cur ?? newWeeklyRecord(nk, userId, weekUtc, catalog)),
  );
}

/** Apply `change` to the achievements record (created empty when missing). */
export function updateAchievements(
  nk: INakama,
  logger: ILogger,
  userId: string,
  change: (rec: AchievementsRecord) => AchievementsRecord | null,
): AchievementsRecord | null | false {
  return updateWithCas<AchievementsRecord>(
    nk, logger, ACHIEVEMENTS_COLLECTION, achievementsKey(userId), userId,
    (cur) => change(cur ?? { schemaVersion: 1, userId, progress: {}, claimed: {} }),
  );
}
