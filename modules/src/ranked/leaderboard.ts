// Ranked rating table per season (`ranked_{seasonId}`), plan T-13.
//
// Order and operator come from `leaderboards.json` (`seasonScoped.ranked`:
// `desc` + `set`), so rank 1 is the best rating (audit 06 f4: the table
// used to be created `asc`). The active season's table is ensured at
// boot (recreated there if its order differs, plan R-02); a season
// minted later by a lazy close gets its table on the first ranked write.
//
// Reads never assume the table exists: `ranked_get` used to answer
// HTTP 500 because `leaderboardRecordsList` throws "leaderboard not
// found" before the first ranked race of a season.

import type { ILeaderboardRecord, ILogger, INakama } from '../nkruntime';
import { getRankedTable } from '../leaderboards/catalog';
import type { LeaderboardTableEntry } from '../leaderboards/catalog';
import { ensureLeaderboardTable } from '../leaderboards/ensure';
import { findActiveSeason, getSeasonsCatalog } from './seasons';

/** `ranked_{seasonId}`. */
export function rankedTableId(seasonId: string): string {
  return getRankedTable(seasonId).id;
}

/** The ranked table of the catalog season active at `nowMs` (none between seasons). */
export function activeRankedTables(nowMs: number): LeaderboardTableEntry[] {
  const active = findActiveSeason(getSeasonsCatalog(), nowMs);
  return active === null ? [] : [getRankedTable(active.id)];
}

/** Create the season's table when missing; never recreates outside boot. */
export function ensureRankedTable(logger: ILogger, nk: INakama, seasonId: string): void {
  ensureLeaderboardTable(logger, nk, getRankedTable(seasonId), { recreateOnMismatch: false });
}

function tableExists(nk: INakama, id: string): boolean {
  return (nk.leaderboardsGetId([id]) ?? []).length > 0;
}

/** Global rank of `userId` (1 = best rating), or null without a record or table. */
export function rankedRankOf(nk: INakama, seasonId: string, userId: string): number | null {
  const id = rankedTableId(seasonId);
  if (!tableExists(nk, id)) return null;
  const owner = nk.leaderboardRecordsList(id, [userId], 0).ownerRecords
    .find((r) => r.ownerId === userId);
  return owner !== undefined && typeof owner.rank === 'number' && owner.rank > 0 ? owner.rank : null;
}

/** The season's records in table order (best rating first); empty without a table. */
export function rankedStandings(nk: INakama, seasonId: string, limit: number): ILeaderboardRecord[] {
  const id = rankedTableId(seasonId);
  if (!tableExists(nk, id)) return [];
  return nk.leaderboardRecordsList(id, [], limit).records;
}
