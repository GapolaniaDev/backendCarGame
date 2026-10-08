// Phase 8 Chunk 6 — Pure prize distribution tests.

import { describe, it, expect } from 'vitest';

import {
  distributePrizes,
  rankLeaderboard,
} from '../../modules/src/tournaments/prizes';
import type { Tournament } from '../../modules/src/tournaments/types';

function mkTournament(prizes: Tournament['prizes']): Tournament {
  return {
    schemaVersion: 1,
    id: 't',
    templateId: 't',
    kind: 'time_trial',
    trackId: 'tr',
    startsAt: 0,
    endsAt: 1,
    entryFee: 0,
    maxAttempts: 5,
    minLevel: 1,
    prizes,
    createdAt: 0,
  };
}

describe('tournaments prizes (Phase 8 Chunk 6)', () => {
  describe('rankLeaderboard', () => {
    it('returns [] for empty leaderboard', () => {
      expect(rankLeaderboard([])).toEqual([]);
    });

    it('sorts ascending by bestTimeMs and assigns 1-indexed ranks', () => {
      const r = rankLeaderboard([
        { userId: 'slow', bestTimeMs: 50000 },
        { userId: 'fast', bestTimeMs: 30000 },
        { userId: 'mid', bestTimeMs: 40000 },
      ]);
      expect(r.map((x) => x.userId)).toEqual(['fast', 'mid', 'slow']);
      expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
    });
  });

  describe('distributePrizes', () => {
    it('returns [] for empty leaderboard', () => {
      const t = mkTournament([{ rankFrom: 1, rankTo: 1, rewards: { coins: 100 } }]);
      expect(distributePrizes(t, [], 0)).toEqual([]);
    });

    it('no prize tiers → []', () => {
      const t = mkTournament([]);
      const out = distributePrizes(t, [
        { userId: 'a', bestTimeMs: 100 },
      ], 0);
      expect(out).toEqual([]);
    });

    it('tier 1..3 grants top 3', () => {
      const t = mkTournament([{ rankFrom: 1, rankTo: 3, rewards: { coins: 500 } }]);
      const out = distributePrizes(t, [
        { userId: 'a', bestTimeMs: 100 },
        { userId: 'b', bestTimeMs: 200 },
        { userId: 'c', bestTimeMs: 300 },
        { userId: 'd', bestTimeMs: 400 },
      ], 0);
      expect(out.map((o) => o.userId)).toEqual(['a', 'b', 'c']);
      expect(out.map((o) => o.rank)).toEqual([1, 2, 3]);
      expect(out[0]?.rewards.coins).toBe(500);
    });

    it('tier 4..10 grants positions 4-10', () => {
      const t = mkTournament([{ rankFrom: 4, rankTo: 10, rewards: { coins: 50 } }]);
      const lb = Array.from({ length: 12 }, (_, i) => ({
        userId: `u${i + 1}`,
        bestTimeMs: 1000 + i * 100,
      }));
      const out = distributePrizes(t, lb, 0);
      expect(out).toHaveLength(7);
      expect(out[0]?.userId).toBe('u4');
      expect(out[6]?.userId).toBe('u10');
    });

    it('multi-tier (1-3 + 4-10) covers 1-10', () => {
      const t = mkTournament([
        { rankFrom: 1, rankTo: 3, rewards: { coins: 500 } },
        { rankFrom: 4, rankTo: 10, rewards: { coins: 50 } },
      ]);
      const lb = Array.from({ length: 12 }, (_, i) => ({
        userId: `u${i + 1}`,
        bestTimeMs: 1000 + i * 100,
      }));
      const out = distributePrizes(t, lb, 0);
      expect(out).toHaveLength(10);
      const byUser = new Map(out.map((o) => [o.userId, o]));
      for (let rank = 1; rank <= 3; rank += 1) {
        expect(byUser.get(`u${rank}`)?.rewards.coins).toBe(500);
      }
      for (let rank = 4; rank <= 10; rank += 1) {
        expect(byUser.get(`u${rank}`)?.rewards.coins).toBe(50);
      }
    });

    it('rewards include coins/xp/cosmeticId when present', () => {
      const t = mkTournament([
        {
          rankFrom: 1, rankTo: 1,
          rewards: { coins: 100, gems: 5, cosmeticId: 'gold-trophy' },
        },
      ]);
      const out = distributePrizes(t, [{ userId: 'a', bestTimeMs: 1000 }], 0);
      expect(out).toHaveLength(1);
      expect(out[0]?.rewards).toEqual({
        coins: 100, gems: 5, cosmeticId: 'gold-trophy',
      });
    });

    it('empty leaderboard but tiered → []', () => {
      const t = mkTournament([{ rankFrom: 1, rankTo: 3, rewards: { coins: 100 } }]);
      expect(distributePrizes(t, [], 0)).toEqual([]);
    });

    it('tier partially covers leaderboard', () => {
      const t = mkTournament([{ rankFrom: 1, rankTo: 5, rewards: { coins: 100 } }]);
      const lb = Array.from({ length: 3 }, (_, i) => ({
        userId: `u${i + 1}`,
        bestTimeMs: 1000 + i * 100,
      }));
      const out = distributePrizes(t, lb, 0);
      expect(out).toHaveLength(3);
    });

    it('tiers with no overlap sort output by rank', () => {
      const t = mkTournament([
        { rankFrom: 5, rankTo: 10, rewards: { coins: 10 } },
        { rankFrom: 1, rankTo: 1, rewards: { coins: 1000 } },
      ]);
      const lb = [
        { userId: 'a', bestTimeMs: 100 },
        { userId: 'b', bestTimeMs: 200 },
        { userId: 'c', bestTimeMs: 300 },
        { userId: 'd', bestTimeMs: 400 },
        { userId: 'e', bestTimeMs: 500 },
      ];
      const out = distributePrizes(t, lb, 0);
      expect(out.map((o) => o.rank)).toEqual([1, 5]);
      expect(out[0]?.userId).toBe('a');
      expect(out[1]?.userId).toBe('e');
    });
  });
});
