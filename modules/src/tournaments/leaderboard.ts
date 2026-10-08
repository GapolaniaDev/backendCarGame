// Phase 8 Chunk 6 — tournament leaderboard storage.
//
// One row per tournament at `tournament_leaderboard/{tournamentId}`.
// System-owned (R=1 / W=0). Stores the top 100 entries (sorted by
// `bestTimeMs` ascending — lower is better). The subscriber appends
// to this on every successful race submission; `tournament_get` reads
// the top 10 to surface as `topTimes`.
//
// CAS-retry (`MAX_CAS_RETRIES=3`) handles concurrent writers.

import type { IStorageObject, INakama } from '../nkruntime';
import { MAX_CAS_RETRIES } from '../anti_cheat/_reset_for_tests';

export const TOURNAMENT_LEADERBOARD_COLLECTION = 'tournament_leaderboard';
export const TOURNAMENT_LEADERBOARD_SYSTEM_USER =
  '00000000-0000-0000-0000-000000000000';
export const TOURNAMENT_LEADERBOARD_CAP = 100;

export interface TournamentLeaderboardEntry {
  userId: string;
  bestTimeMs: number;
  recordedAt: number;
}

export interface TournamentLeaderboardRow {
  schemaVersion: 1;
  tournamentId: string;
  entries: TournamentLeaderboardEntry[];
  updatedAt: number;
}

interface LeaderboardReadResult {
  row: TournamentLeaderboardRow;
  version: string;
}

function readLeaderboardRow(
  nk: INakama,
  tournamentId: string,
): LeaderboardReadResult | null {
  const objs = nk.storageRead([
    {
      collection: TOURNAMENT_LEADERBOARD_COLLECTION,
      key: tournamentId,
      userId: TOURNAMENT_LEADERBOARD_SYSTEM_USER,
    },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<TournamentLeaderboardRow>;
  if (
    !v ||
    typeof v !== 'object' ||
    v.schemaVersion !== 1 ||
    typeof v.tournamentId !== 'string' ||
    !Array.isArray(v.entries)
  ) {
    return null;
  }
  return { row: v as TournamentLeaderboardRow, version: obj.version ?? '' };
}

/** Read the leaderboard for a tournament. Returns null when absent. */
export function readTournamentLeaderboard(
  nk: INakama,
  tournamentId: string,
): TournamentLeaderboardRow | null {
  const r = readLeaderboardRow(nk, tournamentId);
  return r === null ? null : r.row;
}

/** Top N entries (sorted by bestTimeMs asc). Empty when no row. */
export function topN(
  nk: INakama,
  tournamentId: string,
  n: number,
): TournamentLeaderboardEntry[] {
  const row = readTournamentLeaderboard(nk, tournamentId);
  if (row === null) return [];
  return row.entries.slice(0, Math.max(0, n));
}

/**
 * Upsert a user's best time. If `userId` already has an entry, keep
 * the existing `bestTimeMs` when it's strictly lower (i.e. better);
 * only replace when the new attempt is faster. If new, append. Cap
 * the result to `TOURNAMENT_LEADERBOARD_CAP` entries (sort asc,
 * truncate).
 *
 * Returns the final leaderboard row.
 */
export function upsertBestTime(
  nk: INakama,
  tournamentId: string,
  userId: string,
  bestTimeMs: number,
  nowUtc: number,
): TournamentLeaderboardRow {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readLeaderboardRow(nk, tournamentId);
    const prev = existing === null ? [] : existing.row.entries;
    const prior = prev.find((e) => e.userId === userId);
    const effectiveTime = prior !== undefined && prior.bestTimeMs < bestTimeMs
      ? prior.bestTimeMs
      : bestTimeMs;
    const effectiveRecorded = prior !== undefined && prior.bestTimeMs < bestTimeMs
      ? prior.recordedAt
      : nowUtc;
    const others = prev.filter((e) => e.userId !== userId);
    const next: TournamentLeaderboardEntry[] = [
      ...others,
      { userId, bestTimeMs: effectiveTime, recordedAt: effectiveRecorded },
    ].sort((a, b) => a.bestTimeMs - b.bestTimeMs)
      .slice(0, TOURNAMENT_LEADERBOARD_CAP);
    const row: TournamentLeaderboardRow = {
      schemaVersion: 1,
      tournamentId,
      entries: next,
      updatedAt: nowUtc,
    };
    const obj: IStorageObject = {
      collection: TOURNAMENT_LEADERBOARD_COLLECTION,
      key: tournamentId,
      userId: TOURNAMENT_LEADERBOARD_SYSTEM_USER,
      value: row as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 0,
    };
    if (existing !== null) {
      (obj as unknown as { version: string }).version = existing.version;
    }
    try {
      nk.storageWrite([obj]);
      return row;
    } catch {
      if (attempt === MAX_CAS_RETRIES - 1) {
        throw new Error('upsertBestTime: CAS retries exhausted');
      }
    }
  }
  throw new Error('upsertBestTime: unreachable');
}

/** Delete a tournament's leaderboard row. Idempotent. */
export function deleteLeaderboard(nk: INakama, tournamentId: string): void {
  const existing = readLeaderboardRow(nk, tournamentId);
  if (existing === null) return;
  nk.storageDelete([
    {
      collection: TOURNAMENT_LEADERBOARD_COLLECTION,
      key: tournamentId,
      userId: TOURNAMENT_LEADERBOARD_SYSTEM_USER,
    },
  ]);
}
