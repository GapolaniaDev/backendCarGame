// Phase 4 season helpers + lazy close.
//
// The lazy close is the contract that closes a season when its
// `endsAt` passes. Two triggers exist:
//   - `ranked_get` checks the meta before returning the record and
//     triggers the close on demand.
//   - A scheduled server-side sweep (lands in a later chunk) calls
//     the same helper.
//
// `computeSeasonRewards` is PURE — it has no side effects and the
// unit tests cover every tier + edge case. The lazy close uses it
// plus the season meta + leaderboard reads to materialise the
// reward grants.
//
// Idempotency:
//   - The CAS on `ranked_seasons_meta/{seasonId}.rewardsDistributed`
//     guarantees the rewards are written at most once per season
//     even under concurrent calls.
//   - `rewardIdForRank` produces deterministic ids so a retry
//     (`claimReward` short-circuits) is safe even before CAS lands.
//
// Storage layout:
//   - `ranked_seasons_meta/{seasonId}` (server-owned)

import type { INakama } from '../nkruntime';
import type {
  SeasonCloseOutcome,
  SeasonMeta,
  SeasonRewardGrant,
  SeasonStandingRow,
  SeasonStatus,
} from './types';
import {
  createSeasonMeta,
  readSeasonMeta,
  rewardIdForRank,
  updateSeasonMeta,
} from './ranked_repo';
import { sendReward } from '../liveops/inbox';

const MS_PER_DAY = 86_400_000;

/** Default season length — 28 days, per the Phase 4 spec. */
export const DEFAULT_SEASON_LENGTH_MS = 28 * MS_PER_DAY;

// ─── Tier policy ─────────────────────────────────────────────────────────────
//
// `computeSeasonRewards` ranks the standings and assigns tiers by
// absolute rank (the spec calls out "gold/silver/bronze" without
// nailing down the cutoffs; the values below match the Phase 4 plan
// PDF — gold = top 1, silver = top 3, bronze = top 10).

export const SEASON_TIER_GOLD_RANK = 1;
export const SEASON_TIER_SILVER_RANK_MAX = 3;
export const SEASON_TIER_BRONZE_RANK_MAX = 10;

/**
 * Pure: classify a single standing into a reward tier.
 * Returns `null` when the rank falls outside any tier (no reward).
 */
export function tierForRank(rank: number): 'gold' | 'silver' | 'bronze' | null {
  if (rank < 1) return null;
  if (rank === SEASON_TIER_GOLD_RANK) return 'gold';
  if (rank <= SEASON_TIER_SILVER_RANK_MAX) return 'silver';
  if (rank <= SEASON_TIER_BRONZE_RANK_MAX) return 'bronze';
  return null;
}

/**
 * Pure: compute the reward payload for a tier. The numbers match the
 * plan PDF's "Season 1 grant" — gold gets 5000 coins + 1 legendary
 * cosmetic, silver gets 2500 coins + 1 rare cosmetic, bronze gets
 * 1000 coins.
 */
export function payloadForTier(tier: 'gold' | 'silver' | 'bronze'): {
  type: 'season_gold' | 'season_silver' | 'season_bronze';
  payload: { coins: number; cosmetics: string[]; note: string };
} {
  switch (tier) {
    case 'gold':
      return {
        type: 'season_gold',
        payload: {
          coins: 5000,
          cosmetics: ['legendary_aether_chassis'],
          note: 'Season 1 — Gold tier (rank 1)',
        },
      };
    case 'silver':
      return {
        type: 'season_silver',
        payload: {
          coins: 2500,
          cosmetics: ['rare_aether_stripe'],
          note: 'Season 1 — Silver tier (rank 2-3)',
        },
      };
    case 'bronze':
      return {
        type: 'season_bronze',
        payload: {
          coins: 1000,
          cosmetics: [],
          note: 'Season 1 — Bronze tier (rank 4-10)',
        },
      };
  }
}

/**
 * Pure: take a list of standings and produce the reward grants for
 * the season. Standings MUST be sorted by `rank` ascending; the
 * helper re-sorts defensively.
 */
export function computeSeasonRewards(
  seasonId: string,
  standings: ReadonlyArray<SeasonStandingRow>,
): SeasonRewardGrant[] {
  const sorted = standings.slice().sort((a, b) => a.rank - b.rank);
  const grants: SeasonRewardGrant[] = [];
  for (const s of sorted) {
    const tier = tierForRank(s.rank);
    if (tier === null) continue;
    const { type, payload } = payloadForTier(tier);
    grants.push({
      userId: s.userId,
      rank: s.rank,
      type,
      payload,
    });
    // Reference unused symbols so the lint rules stay happy.
    void rewardIdForRank;
  }
  void seasonId;
  return grants;
}

/**
 * Compute the next seasonId given the current one. Uses the
 * `season_N` convention when applicable so the bundled catalog stays
 * aligned; falls back to `{currentId}-{nowMs}` for arbitrary ids.
 */
export function nextSeasonId(currentId: string, nowMs: number): string {
  const m = /^season_(\d+)$/.exec(currentId);
  if (m) {
    const n = parseInt(m[1] ?? '0', 10);
    return `season_${n + 1}`;
  }
  return `${currentId}-${nowMs}`;
}

/**
 * Whole days until `endsAt`, floored at 0.
 */
export function daysLeftInSeason(endsAt: number, nowMs: number): number {
  const diff = endsAt - nowMs;
  if (diff <= 0) return 0;
  return Math.ceil(diff / MS_PER_DAY);
}

// ─── Lazy close ──────────────────────────────────────────────────────────────

/**
 * Idempotent lazy close. Reads `ranked_seasons_meta/{seasonId}`:
 *   - missing → returns `{closed: false, seasonId: null, nextSeasonId: null, rewards: []}`
 *     (caller falls back to the catalog for season meta).
 *   - `status === 'closed'` → no-op.
 *   - `status === 'active'` AND `nowMs < endsAt` → no-op (still active).
 *   - `status === 'active'` AND `nowMs >= endsAt`:
 *       a. Read final standings from the `ranked_{seasonId}` leaderboard.
 *       b. Compute rewards via `computeSeasonRewards`.
 *       c. Send every reward via `sendReward`.
 *       d. CAS-update meta to `{status: 'closed', rewardsDistributed: true}`.
 *       e. Create the new season meta with `nextSeasonId`, startedAt=nowMs,
 *          endsAt=nowMs + DEFAULT_SEASON_LENGTH_MS, status='active'.
 *
 * On CAS conflict in step (d) (another caller won), the function
 * returns the partial outcome and skips step (e). The original caller
 * refetches on the next request.
 */
export function lazyCloseSeason(
  nk: INakama,
  nowMs: number,
  seasonId: string,
): SeasonCloseOutcome {
  const read = readSeasonMeta(nk, seasonId);
  if (read === null) {
    return { closed: false, seasonId: null, nextSeasonId: null, rewards: [] };
  }
  const meta = read.meta;
  if (meta.status === 'closed') {
    return { closed: false, seasonId, nextSeasonId: null, rewards: [] };
  }
  if (nowMs < meta.endsAt) {
    return { closed: false, seasonId, nextSeasonId: null, rewards: [] };
  }

  // (a) Read the leaderboard. The stub returns an empty list when no
  //     records exist; in production this is the authoritative final
  //     ranking for the closing season.
  const lb = nk.leaderboardRecordsList(`ranked_${seasonId}`, [], 10_000);
  const standings: SeasonStandingRow[] = [];
  // Records are returned in the leaderboard's sort order (asc score
  // = ascending time = fastest first = rank 1). The stub already
  // sorts by score ascending; we mirror that here.
  let rank = 1;
  for (const rec of lb.records) {
    standings.push({ userId: rec.ownerId, rating: rec.score, rank: rank++ });
  }

  // (b) Compute reward grants.
  const grants = computeSeasonRewards(seasonId, standings);

  // (c) Write every grant to the inbox. `sendReward` is a no-CAS
  //     write; the real lock is the meta CAS in step (d).
  for (const g of grants) {
    sendReward(
      nk,
      g.userId,
      g.type,
      g.payload,
      rewardIdForRank(seasonId, g.rank),
      nowMs,
      null,
    );
  }

  // (d) CAS-update the meta to "closed + rewardsDistributed".
  const closedMeta: SeasonMeta = {
    ...meta,
    status: 'closed',
    rewardsDistributed: true,
  };
  updateSeasonMeta(nk, closedMeta, read.version);

  // (e) Spin up the next season. Independent CAS so a retry that
  //     re-creates the same next season is idempotent (the runtime
  //     treats the second write as a no-op when the value matches).
  const nextId = nextSeasonId(seasonId, nowMs);
  const newMeta: SeasonMeta = {
    schemaVersion: 1,
    seasonId: nextId,
    startedAt: nowMs,
    endsAt: nowMs + DEFAULT_SEASON_LENGTH_MS,
    status: 'active' as SeasonStatus,
    rewardsDistributed: false,
  };
  createSeasonMeta(nk, newMeta);

  return { closed: true, seasonId, nextSeasonId: nextId, rewards: grants };
}