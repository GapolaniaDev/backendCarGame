// Phase 7 Chunk 5 — Weekly state storage for clubs.
//
// Two collections:
//
//   1. clubs_week_meta/{clubId}
//      Per-club weekly meta — tracks which ISO week we're currently
//      scoring so a fresh `club_get` can fire the lazy reset when the
//      week rolls. The leaderboard itself is reset by Nakama's cron
//      schedule; we only need the storage-layer view because the
//      `clubs_metadata.weeklyPoints` field + per-member
//      `clubs_members/{clubId}/{userId}.weeklyContribution` field do
//      NOT auto-reset.
//
//      {
//        schemaVersion: 1,
//        clubId,
//        currentWeek,  // 'YYYY-Www'
//        lastResetAt,  // epoch-ms
//      }
//
//   2. clubs_week_reset/{weekUtc}
//      Global weekly-reset marker — exactly one row per (weekUtc,)
//      so a fan-out of `club_get` calls across multiple clubs can't
//      double-send the weekly reward. The first lazy reset to land
//      per week owns the marker; every other club just zeros their
//      own metadata + members and returns.
//
//      {
//        schemaVersion: 1,
//        weekUtc,
//        resetAt,
//        winnerClubId | null,
//        rewardedUserIds: string[],
//      }
//
// Both collections are server-owned (Write=1).

import type { INakama, IStorageObject } from '../nkruntime';
import { utcWeek, serverNowMs } from '../core/time';

export const CLUBS_WEEK_META_COLLECTION = 'clubs_week_meta';
export const CLUBS_WEEK_RESET_COLLECTION = 'clubs_week_reset';

/** Per-club weekly meta. */
export interface ClubWeekMeta {
  schemaVersion: 1;
  clubId: string;
  currentWeek: string;
  lastResetAt: number;
}

/** Global weekly-reset marker (one per weekUtc). */
export interface ClubWeekResetMarker {
  schemaVersion: 1;
  weekUtc: string;
  resetAt: number;
  winnerClubId: string | null;
  rewardedUserIds: string[];
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * Read a club's weekly meta row. Returns `null` when absent (the club
 * has never been scored in a week — fresh clubs).
 */
export function readClubWeekMeta(
  nk: INakama,
  clubId: string,
): { record: ClubWeekMeta; version: string } | null {
  const objs = nk.storageRead([
    { collection: CLUBS_WEEK_META_COLLECTION, key: clubId, userId: clubId },
  ]);
  const obj = objs[0];
  if (obj === undefined) return null;
  const v = obj.value as Partial<ClubWeekMeta>;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.clubId !== 'string' || typeof v.currentWeek !== 'string' ||
    typeof v.lastResetAt !== 'number'
  ) {
    return null;
  }
  return { record: v as ClubWeekMeta, version: obj.version ?? '' };
}

/**
 * Read the global reset marker for a given weekUtc. Returns `null` when
 * absent — i.e. nobody has fired the reset for that week yet.
 */
export function readClubWeekResetMarker(
  nk: INakama,
  weekUtc: string,
): { record: ClubWeekResetMarker; version: string } | null {
  const objs = nk.storageRead([
    {
      collection: CLUBS_WEEK_RESET_COLLECTION,
      key: weekUtc,
      userId: weekUtc,
    },
  ]);
  const obj = objs[0];
  if (obj === undefined) return null;
  const v = obj.value as Partial<ClubWeekResetMarker>;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.weekUtc !== 'string' ||
    typeof v.resetAt !== 'number' ||
    typeof v.winnerClubId !== 'string' && v.winnerClubId !== null ||
    !Array.isArray(v.rewardedUserIds)
  ) {
    return null;
  }
  return { record: v as ClubWeekResetMarker, version: obj.version ?? '' };
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Upsert a club's weekly meta — first write uses create (no version),
 * later writes use CAS update.
 */
export function writeClubWeekMetaCreate(
  nk: INakama,
  rec: ClubWeekMeta,
): string {
  const objs = nk.storageWrite([
    {
      collection: CLUBS_WEEK_META_COLLECTION,
      key: rec.clubId,
      userId: rec.clubId,
      value: rec as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 1,
    },
  ]);
  const first = (objs as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

export function writeClubWeekMetaUpdate(
  nk: INakama,
  rec: ClubWeekMeta,
  version: string,
): string {
  const objs = nk.storageWrite([
    {
      collection: CLUBS_WEEK_META_COLLECTION,
      key: rec.clubId,
      userId: rec.clubId,
      value: rec as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 1,
      version,
    },
  ]);
  const first = (objs as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * Create the global reset marker for a weekUtc. Caller MUST pre-check
 * that the row doesn't exist — we don't accept a `version` because the
 * row is created exactly once per week.
 */
export function writeClubWeekResetMarker(
  nk: INakama,
  rec: ClubWeekResetMarker,
): void {
  const obj: IStorageObject = {
    collection: CLUBS_WEEK_RESET_COLLECTION,
    key: rec.weekUtc,
    userId: rec.weekUtc,
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 1,
  };
  nk.storageWrite([obj]);
}

// ─── Convenience helpers ────────────────────────────────────────────────────

/**
 * Resolve the current ISO week string at server time. Centralised so
 * the subscriber and the reset hook always agree.
 */
export function currentWeekUtc(nowMs?: number): string {
  return utcWeek(nowMs ?? serverNowMs());
}