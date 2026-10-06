// Phase 4 Chunk 6 unit tests for the pure season helpers and the
// lazy-close path (which talks to `nk` via the test stubs).
//
// Covers:
//   - tierForRank / payloadForTier (pure)
//   - computeSeasonRewards with N=0, N=10, ties, out-of-tier ranks
//   - nextSeasonId (season_N → season_(N+1), arbitrary → arbitrary-now)
//   - daysLeftInSeason (boundary, past, future)
//   - lazyCloseSeason via the FakeNakama stub:
//       * missing meta → no-op
//       * closed meta → no-op
//       * active + endsAt in the future → no-op
//       * active + endsAt in the past → closes + writes inbox +
//         spins up next meta + returns rewards
//       * idempotent re-call → second call returns no-op
//
// The lazy-close tests poke the FakeNakama directly (no InitModule)
// so we can control the meta + leaderboard state without going
// through the RPC handler.

import { describe, it, expect } from 'vitest';
import {
  computeSeasonRewards,
  daysLeftInSeason,
  lazyCloseSeason,
  nextSeasonId,
  payloadForTier,
  tierForRank,
  DEFAULT_SEASON_LENGTH_MS,
} from '../../modules/src/ranked/season';
import { INBOX_COLLECTION } from '../../modules/src/liveops/inbox';
import {
  RANKED_COLLECTION,
  SEASON_META_COLLECTION,
  createSeasonMeta,
} from '../../modules/src/ranked/ranked_repo';
import { SYSTEM_USER_ID } from '../../modules/src/race/constants';
import type { FakeNakama } from '../e2e/_stubs';
import { FakeNakama as FakeNakamaClass } from '../e2e/_stubs';
import type { SeasonMeta, SeasonStandingRow } from '../../modules/src/ranked/types';

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

function makeNakama(): FakeNakama {
  return new FakeNakamaClass();
}

/**
 * Create the ranked leaderboard for `seasonId` so the stub accepts
 * `leaderboardRecordWrite` calls. The real runtime does this lazily
 * inside the subscriber on the first race; the stub is stricter.
 */
function ensureRankedLeaderboard(nak: FakeNakama, seasonId: string): void {
  nak.nakama.leaderboardCreate(
    `ranked_${seasonId}`,
    /* authoritative */ true,
    /* sortOrder */ 'asc',
    /* operator */ 'best',
    /* resetSchedule */ '',
    /* metadata */ {},
    /* enableRanks */ true,
  );
}

function seedMeta(
  nak: FakeNakama,
  meta: SeasonMeta,
): void {
  createSeasonMeta(nak.nakama, meta);
}

function readMeta(nak: FakeNakama, seasonId: string): SeasonMeta | null {
  const stored = nak.store.get(`${SEASON_META_COLLECTION}/${seasonId}/${SYSTEM_USER_ID}`);
  if (!stored) return null;
  return stored.value as SeasonMeta;
}

function readInbox(nak: FakeNakama, userId: string, rewardId: string): unknown {
  const obj = nak.store.get(`${INBOX_COLLECTION}/${userId}/${rewardId}/${userId}`);
  return obj === undefined ? undefined : obj.value;
}

describe('season (Phase 4 Chunk 6) — tierForRank + payloadForTier (pure)', () => {
  it('rank 1 → gold', () => {
    expect(tierForRank(1)).toBe('gold');
  });

  it('rank 2-3 → silver', () => {
    expect(tierForRank(2)).toBe('silver');
    expect(tierForRank(3)).toBe('silver');
  });

  it('rank 4-10 → bronze', () => {
    expect(tierForRank(4)).toBe('bronze');
    expect(tierForRank(10)).toBe('bronze');
  });

  it('rank ≥ 11 → null', () => {
    expect(tierForRank(11)).toBeNull();
    expect(tierForRank(100)).toBeNull();
  });

  it('rank 0 or negative → null', () => {
    expect(tierForRank(0)).toBeNull();
    expect(tierForRank(-1)).toBeNull();
  });

  it('payloadForTier assigns expected rewards', () => {
    expect(payloadForTier('gold').type).toBe('season_gold');
    expect(payloadForTier('gold').payload.coins).toBe(5000);
    expect(payloadForTier('gold').payload.cosmetics.length).toBe(1);
    expect(payloadForTier('silver').type).toBe('season_silver');
    expect(payloadForTier('silver').payload.coins).toBe(2500);
    expect(payloadForTier('bronze').type).toBe('season_bronze');
    expect(payloadForTier('bronze').payload.coins).toBe(1000);
  });
});

describe('season (Phase 4 Chunk 6) — computeSeasonRewards (pure)', () => {
  it('N=10 standings → 1 gold + 2 silver + 7 bronze = 10 grants', () => {
    const standings: SeasonStandingRow[] = Array.from({ length: 10 }, (_, i) => ({
      userId: `u${i + 1}`,
      rating: 2000 - i * 50,
      rank: i + 1,
    }));
    const grants = computeSeasonRewards('season_1', standings);
    expect(grants).toHaveLength(10);
    expect(grants[0]?.type).toBe('season_gold');
    expect(grants[0]?.rank).toBe(1);
    expect(grants[1]?.type).toBe('season_silver');
    expect(grants[2]?.type).toBe('season_silver');
    expect(grants[3]?.type).toBe('season_bronze');
    expect(grants[9]?.type).toBe('season_bronze');
  });

  it('N=0 → empty grant list', () => {
    expect(computeSeasonRewards('season_1', [])).toEqual([]);
  });

  it('rank 11 → no grant', () => {
    const standings: SeasonStandingRow[] = [{ userId: 'u1', rating: 1000, rank: 11 }];
    const grants = computeSeasonRewards('season_1', standings);
    expect(grants).toEqual([]);
  });

  it('sorts input defensively when ranks arrive out of order', () => {
    const standings: SeasonStandingRow[] = [
      { userId: 'u3', rating: 1500, rank: 3 },
      { userId: 'u1', rating: 1700, rank: 1 },
      { userId: 'u2', rating: 1600, rank: 2 },
    ];
    const grants = computeSeasonRewards('season_1', standings);
    expect(grants.map((g) => g.rank)).toEqual([1, 2, 3]);
  });
});

describe('season (Phase 4 Chunk 6) — nextSeasonId + daysLeftInSeason (pure)', () => {
  it('season_N → season_(N+1)', () => {
    expect(nextSeasonId('season_1', NOW)).toBe('season_2');
    expect(nextSeasonId('season_42', NOW)).toBe('season_43');
  });

  it('arbitrary id → id + nowMs suffix', () => {
    const id = nextSeasonId('custom', 123456);
    expect(id).toBe('custom-123456');
  });

  it('daysLeftInSeason: future → ceil((end - now)/day)', () => {
    expect(daysLeftInSeason(NOW + 5 * DAY_MS, NOW)).toBe(5);
    expect(daysLeftInSeason(NOW + 1, NOW)).toBe(1); // < 1 day → ceil = 1
    expect(daysLeftInSeason(NOW, NOW)).toBe(0);
    expect(daysLeftInSeason(NOW - 1, NOW)).toBe(0); // past → 0
  });

  it('DEFAULT_SEASON_LENGTH_MS = 28 days', () => {
    expect(DEFAULT_SEASON_LENGTH_MS).toBe(28 * DAY_MS);
  });
});

describe('season (Phase 4 Chunk 6) — lazyCloseSeason (NK stub)', () => {
  it('returns no-op when meta is missing', () => {
    const nak = makeNakama();
    const r = lazyCloseSeason(nak.nakama, NOW, 'season_1');
    expect(r.closed).toBe(false);
    expect(r.seasonId).toBeNull();
    expect(r.nextSeasonId).toBeNull();
    expect(r.rewards).toEqual([]);
  });

  it('returns no-op when meta is already closed', () => {
    const nak = makeNakama();
    seedMeta(nak, {
      schemaVersion: 1,
      seasonId: 'season_1',
      startedAt: NOW - 30 * DAY_MS,
      endsAt: NOW - 1,
      status: 'closed',
      rewardsDistributed: true,
    });
    const r = lazyCloseSeason(nak.nakama, NOW, 'season_1');
    expect(r.closed).toBe(false);
    expect(r.rewards).toEqual([]);
  });

  it('returns no-op when active season still has time left', () => {
    const nak = makeNakama();
    seedMeta(nak, {
      schemaVersion: 1,
      seasonId: 'season_1',
      startedAt: NOW,
      endsAt: NOW + 14 * DAY_MS,
      status: 'active',
      rewardsDistributed: false,
    });
    const r = lazyCloseSeason(nak.nakama, NOW, 'season_1');
    expect(r.closed).toBe(false);
    expect(r.rewards).toEqual([]);
    // Meta still active.
    const meta = readMeta(nak, 'season_1');
    expect(meta?.status).toBe('active');
  });

  it('closes + writes inbox + spins up next season when endsAt is in the past', () => {
    const nak = makeNakama();
    seedMeta(nak, {
      schemaVersion: 1,
      seasonId: 'season_1',
      startedAt: NOW - 30 * DAY_MS,
      endsAt: NOW - 1,
      status: 'active',
      rewardsDistributed: false,
    });

    // Seed the leaderboard with 10 standings via the public surface
    // (write per-user records so leaderboardRecordsList picks them up).
    ensureRankedLeaderboard(nak, 'season_1');
    for (let i = 0; i < 10; i += 1) {
      const score = 2000 - i * 50;
      nak.nakama.leaderboardRecordWrite(
        'ranked_season_1',
        `u${i + 1}`,
        `u${i + 1}`,
        score,
        NOW - 30 * DAY_MS,
        {},
      );
    }

    const r = lazyCloseSeason(nak.nakama, NOW, 'season_1');
    expect(r.closed).toBe(true);
    expect(r.seasonId).toBe('season_1');
    expect(r.nextSeasonId).toBe('season_2');
    expect(r.rewards).toHaveLength(10);
    expect(r.rewards[0]?.type).toBe('season_gold');

    // Meta is now closed + rewardsDistributed.
    const meta = readMeta(nak, 'season_1');
    expect(meta?.status).toBe('closed');
    expect(meta?.rewardsDistributed).toBe(true);

    // New season meta exists with the expected window.
    const next = readMeta(nak, 'season_2');
    expect(next).not.toBeNull();
    expect(next?.status).toBe('active');
    expect(next?.rewardsDistributed).toBe(false);
    expect(next?.startedAt).toBe(NOW);
    expect(next?.endsAt).toBe(NOW + DEFAULT_SEASON_LENGTH_MS);

    // Every grant landed in the inbox (one storage write per user).
    // The leaderboard is sorted ASCENDING by score: lowest score (u10,
    // score=1550) is rank 1, highest score (u1, score=2000) is rank 10.
    for (let i = 0; i < 10; i += 1) {
      const rank = i + 1;
      const userId = `u${10 - i}`; // u10 = rank 1, u9 = rank 2, ..., u1 = rank 10
      const rewardId = `season_1-rank-${rank}`;
      const entry = readInbox(nak, userId, rewardId);
      expect(entry).toBeDefined();
    }

    // The gold reward (rank 1) goes to u10 (fastest score 1550).
    const gold = readInbox(nak, 'u10', 'season_1-rank-1') as { payload: { coins: number; cosmetics: string[] } };
    expect(gold.payload.coins).toBe(5000);
    expect(gold.payload.cosmetics.length).toBe(1);

    // Bronze tier (rank 10) goes to u1 (slowest score 2000).
    const bronze = readInbox(nak, 'u1', 'season_1-rank-10') as { payload: { coins: number; cosmetics: string[] } };
    expect(bronze.payload.coins).toBe(1000);
    expect(bronze.payload.cosmetics.length).toBe(0);
  });

  it('second call is a no-op (idempotent)', () => {
    const nak = makeNakama();
    seedMeta(nak, {
      schemaVersion: 1,
      seasonId: 'season_1',
      startedAt: NOW - 30 * DAY_MS,
      endsAt: NOW - 1,
      status: 'active',
      rewardsDistributed: false,
    });
    ensureRankedLeaderboard(nak, 'season_1');
    nak.nakama.leaderboardRecordWrite('ranked_season_1', 'u1', 'u1', 1500, NOW, {});
    const r1 = lazyCloseSeason(nak.nakama, NOW, 'season_1');
    expect(r1.closed).toBe(true);
    const r2 = lazyCloseSeason(nak.nakama, NOW + 1000, 'season_1');
    expect(r2.closed).toBe(false);
    expect(r2.rewards).toEqual([]);
    // No double-inbox: the second call must not overwrite anything.
    const gold = readInbox(nak, 'u1', 'season_1-rank-1');
    expect(gold).toBeDefined();
  });

  it('skips rewards when leaderboard is empty (no users played)', () => {
    const nak = makeNakama();
    seedMeta(nak, {
      schemaVersion: 1,
      seasonId: 'season_1',
      startedAt: NOW - 30 * DAY_MS,
      endsAt: NOW - 1,
      status: 'active',
      rewardsDistributed: false,
    });
    const r = lazyCloseSeason(nak.nakama, NOW, 'season_1');
    expect(r.closed).toBe(true);
    expect(r.rewards).toEqual([]);
    const next = readMeta(nak, 'season_2');
    expect(next?.status).toBe('active');
  });

  it('reward ids are deterministic (same seasonId + rank)', () => {
    const nak = makeNakama();
    seedMeta(nak, {
      schemaVersion: 1,
      seasonId: 'season_1',
      startedAt: NOW - 30 * DAY_MS,
      endsAt: NOW - 1,
      status: 'active',
      rewardsDistributed: false,
    });
    ensureRankedLeaderboard(nak, 'season_1');
    nak.nakama.leaderboardRecordWrite('ranked_season_1', 'u1', 'u1', 1500, NOW, {});
    const r = lazyCloseSeason(nak.nakama, NOW, 'season_1');
    expect(r.rewards[0]?.rank).toBe(1);
    // The reward id used in storage derives from rewardIdForRank.
    const entry = readInbox(nak, 'u1', 'season_1-rank-1');
    expect(entry).toBeDefined();
  });
});

describe('season (Phase 4 Chunk 6) — RANKED_COLLECTION constant', () => {
  it('matches the documented collection name', () => {
    expect(RANKED_COLLECTION).toBe('ranked');
  });
});