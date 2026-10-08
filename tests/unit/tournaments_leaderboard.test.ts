// Phase 8 Chunk 6 — tournament leaderboard storage tests.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  upsertBestTime,
  readTournamentLeaderboard,
  topN,
  deleteLeaderboard,
  TOURNAMENT_LEADERBOARD_CAP,
  TOURNAMENT_LEADERBOARD_COLLECTION,
  TOURNAMENT_LEADERBOARD_SYSTEM_USER,
} from '../../modules/src/tournaments/leaderboard';
import { FakeNakama } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';

const TID = 't-A';

function makeKey(tid: string): string {
  return `${TOURNAMENT_LEADERBOARD_COLLECTION}/${tid}/${TOURNAMENT_LEADERBOARD_SYSTEM_USER}`;
}

describe('tournament leaderboard (Phase 8 Chunk 6)', () => {
  let fake: FakeNakama;
  let nk: INakama;
  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
  });

  it('readTournamentLeaderboard returns null when absent', () => {
    expect(readTournamentLeaderboard(nk, TID)).toBeNull();
  });

  it('upsertBestTime creates the row on first write', () => {
    const row = upsertBestTime(nk, TID, 'u1', 30000, 1000);
    expect(row.entries).toHaveLength(1);
    expect(row.entries[0]?.userId).toBe('u1');
    expect(row.entries[0]?.bestTimeMs).toBe(30000);
    expect(fake.store.has(makeKey(TID))).toBe(true);
  });

  it('upsertBestTime replaces existing user entry with the new (better) time', () => {
    upsertBestTime(nk, TID, 'u1', 30000, 1000);
    const row = upsertBestTime(nk, TID, 'u1', 25000, 2000);
    expect(row.entries).toHaveLength(1);
    expect(row.entries[0]?.bestTimeMs).toBe(25000);
    expect(row.entries[0]?.recordedAt).toBe(2000);
  });

  it('upsertBestTime on multiple users sorts ascending and updates updatedAt', () => {
    upsertBestTime(nk, TID, 'a', 30000, 1000);
    upsertBestTime(nk, TID, 'b', 20000, 2000);
    upsertBestTime(nk, TID, 'c', 25000, 3000);
    const row = readTournamentLeaderboard(nk, TID)!;
    expect(row.entries.map((e) => e.userId)).toEqual(['b', 'c', 'a']);
    expect(row.updatedAt).toBe(3000);
  });

  it('upsertBestTime caps entries at TOURNAMENT_LEADERBOARD_CAP', () => {
    for (let i = 0; i < TOURNAMENT_LEADERBOARD_CAP + 5; i += 1) {
      upsertBestTime(nk, TID, `u${i}`, 1000 + i, 1000 + i);
    }
    const row = readTournamentLeaderboard(nk, TID)!;
    expect(row.entries).toHaveLength(TOURNAMENT_LEADERBOARD_CAP);
    // The 5 slowest were truncated; the fastest remain.
    expect(row.entries[0]?.userId).toBe('u0');
    expect(row.entries[TOURNAMENT_LEADERBOARD_CAP - 1]?.userId).toBe(`u${TOURNAMENT_LEADERBOARD_CAP - 1}`);
  });

  it('upsertBestTime keeps an existing user\'s best (lower) time when new is worse', () => {
    upsertBestTime(nk, TID, 'a', 1000, 1);
    upsertBestTime(nk, TID, 'b', 2000, 2);
    const row = upsertBestTime(nk, TID, 'a', 5000, 3);
    // 'a' was kept (not appended a second time) with the original (better) time.
    const a = row.entries.find((e) => e.userId === 'a');
    expect(a?.bestTimeMs).toBe(1000);
    expect(row.entries.filter((e) => e.userId === 'a')).toHaveLength(1);
  });

  it('topN returns up to N entries, sorted asc', () => {
    upsertBestTime(nk, TID, 'a', 3000, 1);
    upsertBestTime(nk, TID, 'b', 1000, 2);
    upsertBestTime(nk, TID, 'c', 2000, 3);
    const top = topN(nk, TID, 2);
    expect(top.map((e) => e.userId)).toEqual(['b', 'c']);
  });

  it('topN returns [] when absent', () => {
    expect(topN(nk, TID, 10)).toEqual([]);
  });

  it('topN with N=0 returns []', () => {
    upsertBestTime(nk, TID, 'a', 1000, 1);
    expect(topN(nk, TID, 0)).toEqual([]);
  });

  it('deleteLeaderboard removes the row', () => {
    upsertBestTime(nk, TID, 'a', 1000, 1);
    expect(readTournamentLeaderboard(nk, TID)).not.toBeNull();
    deleteLeaderboard(nk, TID);
    expect(readTournamentLeaderboard(nk, TID)).toBeNull();
  });

  it('deleteLeaderboard is idempotent (no throw when absent)', () => {
    expect(() => deleteLeaderboard(nk, TID)).not.toThrow();
  });
});
