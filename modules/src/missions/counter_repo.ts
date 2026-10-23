// Phase 6 — read-side storage helpers for daily/weekly missions and
// achievements records. NO writes in this module — Chunk 8 subscriber
// owns write paths.
//
// Storage layout:
//   - daily:    collection `missions_daily`,    key `${userId}/${dateUtc}`
//   - weekly:   collection `missions_weekly`,   key `${userId}/${weekUtc}`
//   - achv:     collection `achievements`,      key `${userId}`
//
// Permissions: owner read, server-only write (PermissionRead=1,
// PermissionWrite=0, plan T-18 / D-10).
//
// Note: schema-version migrators are NOT wired here because Phase 6
// storage is brand new (no migration history yet). When v2 lands, the
// Chunk-8 subscriber must add migrators before bumping the schema.

import type { INakama } from '../nkruntime';
import type { DailyMissions, WeeklyMissions, AchievementsRecord } from './types';

export const MISSIONS_DAILY_COLLECTION = 'missions_daily';
export const MISSIONS_WEEKLY_COLLECTION = 'missions_weekly';
export const ACHIEVEMENTS_COLLECTION = 'achievements';

/** Owner may read, only the server writes (plan T-18, D-10: a client write is rejected). */
export const SERVER_OWNED_READ = 1;
export const SERVER_OWNED_WRITE = 0;

export function dailyMissionsKey(userId: string, dateUtc: string): string {
  return `${userId}/${dateUtc}`;
}

export function weeklyMissionsKey(userId: string, weekUtc: string): string {
  return `${userId}/${weekUtc}`;
}

export function achievementsKey(userId: string): string {
  return userId;
}

/** Reads a daily-missions record. Returns null when the storage row is absent. */
export function readDailyMissions(
  nk: INakama,
  userId: string,
  dateUtc: string,
): DailyMissions | null {
  const objs = nk.storageRead([{
    collection: MISSIONS_DAILY_COLLECTION,
    key: dailyMissionsKey(userId, dateUtc),
    userId,
  }]);
  const first = objs[0];
  if (!first) return null;
  return first.value as DailyMissions;
}

/** Reads a weekly-missions record. Returns null when absent. */
export function readWeeklyMissions(
  nk: INakama,
  userId: string,
  weekUtc: string,
): WeeklyMissions | null {
  const objs = nk.storageRead([{
    collection: MISSIONS_WEEKLY_COLLECTION,
    key: weeklyMissionsKey(userId, weekUtc),
    userId,
  }]);
  const first = objs[0];
  if (!first) return null;
  return first.value as WeeklyMissions;
}

/** Reads an achievements record. Returns null when absent. */
export function readAchievements(
  nk: INakama,
  userId: string,
): AchievementsRecord | null {
  const objs = nk.storageRead([{
    collection: ACHIEVEMENTS_COLLECTION,
    key: achievementsKey(userId),
    userId,
  }]);
  const first = objs[0];
  if (!first) return null;
  return first.value as AchievementsRecord;
}