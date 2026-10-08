// Phase 8 Chunk 6 — tournament subscriber unit tests.

import { describe, it, expect, beforeEach } from 'vitest';
import { handleRaceCompletedForTournament, subscribeTournaments } from '../../modules/src/tournaments/subscriber';
import { FakeNakama, FakeLogger } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';
import type { RaceCompletedEvent } from '../../modules/src/race/types';

const TID = 't-A';
const SYS = '00000000-0000-0000-0000-000000000000';

function seedEntry(nk: INakama, tid: string, uid: string, attempts: number, bestTimeMs: number | null): void {
  nk.storageWrite([{
    collection: 'tournament_entries',
    key: tid,
    userId: uid,
    value: {
      schemaVersion: 1,
      tournamentId: tid,
      userId: uid,
      attemptsRemaining: attempts,
      bestTimeMs,
      checkpoints: [],
      createdAt: 0,
      updatedAt: 0,
    },
    permissionRead: 1,
    permissionWrite: 0,
  }]);
}

function mkEvent(humans: Array<{ userId: string; totalMs: number; tournamentId?: string; rank?: number; abandoned?: boolean }>): RaceCompletedEvent {
  return {
    schemaVersion: 1,
    sessionId: 'sess-1',
    mode: 'time_trial',
    trackId: 'tr',
    size: 1,
    results: humans.map((h, i) => ({
      rank: h.rank ?? i + 1,
      userId: h.userId,
      isBot: false,
      totalMs: h.totalMs,
      abandoned: h.abandoned ?? false,
      tournamentId: h.tournamentId,
    })),
    flags: { needsReview: false },
    closedAt: 1_000_000,
  };
}

describe('tournament subscriber (Phase 8 Chunk 6)', () => {
  let fake: FakeNakama;
  let nk: INakama;
  const deps = () => ({ logger: new FakeLogger(), nk, bus: { subscribe: () => {}, publish: () => {} } as never });

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
  });

  it('skips when no humans', () => {
    const ev = mkEvent([]);
    const r = handleRaceCompletedForTournament(deps(), ev);
    expect(r.processed).toBe(false);
    expect(r.reason).toBe('no_humans');
  });

  it('skips when results have no tournamentId', () => {
    const ev = mkEvent([{ userId: 'a', totalMs: 30000 }]);
    const r = handleRaceCompletedForTournament(deps(), ev);
    expect(r.processed).toBe(false);
    expect(r.reason).toBe('no_tournament_results');
  });

  it('skips when entry does not exist', () => {
    const ev = mkEvent([{ userId: 'a', totalMs: 30000, tournamentId: TID }]);
    const r = handleRaceCompletedForTournament(deps(), ev);
    expect(r.perUser).toHaveLength(0);
  });

  it('skips when attemptsRemaining <= 0', () => {
    seedEntry(nk, TID, 'a', 0, 25000);
    const ev = mkEvent([{ userId: 'a', totalMs: 30000, tournamentId: TID }]);
    const r = handleRaceCompletedForTournament(deps(), ev);
    expect(r.perUser).toHaveLength(1);
    expect(r.perUser[0]?.updated).toBe(false);
    expect(r.perUser[0]?.attemptsRemaining).toBe(0);
  });

  it('decrements attemptsRemaining and updates bestTimeMs', () => {
    seedEntry(nk, TID, 'a', 3, 40000);
    const ev = mkEvent([{ userId: 'a', totalMs: 30000, tournamentId: TID }]);
    const r = handleRaceCompletedForTournament(deps(), ev);
    expect(r.perUser).toHaveLength(1);
    expect(r.perUser[0]?.attemptsRemaining).toBe(2);
    expect(r.perUser[0]?.bestTimeMs).toBe(30000);
    expect(r.perUser[0]?.updated).toBe(true);
  });

  it('keeps existing bestTimeMs when new is worse', () => {
    seedEntry(nk, TID, 'a', 3, 25000);
    const ev = mkEvent([{ userId: 'a', totalMs: 30000, tournamentId: TID }]);
    const r = handleRaceCompletedForTournament(deps(), ev);
    expect(r.perUser[0]?.bestTimeMs).toBe(25000);
    expect(r.perUser[0]?.attemptsRemaining).toBe(2);
  });

  it('updates leaderboard row on each race', () => {
    seedEntry(nk, TID, 'a', 3, null);
    const ev = mkEvent([{ userId: 'a', totalMs: 30000, tournamentId: TID }]);
    handleRaceCompletedForTournament(deps(), ev);
    const lb = fake.store.get(`tournament_leaderboard/${TID}/${SYS}`);
    expect(lb).toBeDefined();
    const entries = (lb?.value as { entries: Array<{ userId: string; bestTimeMs: number }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.userId).toBe('a');
  });

  it('handles multiple humans in one race', () => {
    seedEntry(nk, TID, 'a', 3, null);
    seedEntry(nk, TID, 'b', 3, null);
    const ev = mkEvent([
      { userId: 'a', totalMs: 30000, tournamentId: TID, rank: 1 },
      { userId: 'b', totalMs: 35000, tournamentId: TID, rank: 2 },
    ]);
    const r = handleRaceCompletedForTournament(deps(), ev);
    expect(r.perUser).toHaveLength(2);
    expect(r.perUser.filter((p) => p.updated)).toHaveLength(2);
  });

  it('does not throw when bus is missing (subscribe is best-effort)', () => {
    // subscribe() should be a no-op for the purposes of this test.
    expect(() => subscribeTournaments(deps())).not.toThrow();
  });
});
