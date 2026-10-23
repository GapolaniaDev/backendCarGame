// Phase 8 Chunk 6 — scanner tick tests (pure orchestrator).
//
// The scanner tick is best-effort and module-internal. The tests
// seed a fake store, drive `runScannerTick`, and assert the side
// effects (state transitions, prize grants, deletes).

import { describe, it, expect, beforeEach } from 'vitest';
import { runScannerTick, TOURNAMENT_RETENTION_MS } from '../../modules/src/tournaments/scanner';
import { loadTournamentsCatalog, _resetTournamentsCatalogForTests } from '../../modules/src/tournaments/catalog';
import { upsertBestTime } from '../../modules/src/tournaments/leaderboard';
import { readTournamentInstance } from '../../modules/src/tournaments/repo';
import { FakeNakama } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';
import type { Tournament, RawTournamentsFile } from '../../modules/src/tournaments/types';

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
  getFields: () => ({}),
} as unknown as Parameters<typeof loadTournamentsCatalog>[0];

function seedInstance(nk: INakama, t: Tournament): void {
  const obj: import('../../modules/src/nkruntime').IStorageObject = {
    collection: 'tournament_instances',
    key: t.id,
    userId: '00000000-0000-0000-0000-000000000000',
    value: t as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  };
  nk.storageWrite([obj]);
}

describe('tournament scanner (Phase 8 Chunk 6)', () => {
  let fake: FakeNakama;
  let nk: INakama;

  beforeEach(() => {
    _resetTournamentsCatalogForTests();
    // Use an empty catalog so the scanner tick only sees the
    // instances we seed in each test.
    loadTournamentsCatalog(SILENT_LOGGER, {
      version: 1,
      templates: [],
    } as RawTournamentsFile);
    fake = new FakeNakama();
    nk = fake.nakama;
  });

  it('no instances → empty tick', () => {
    const r = runScannerTick({ logger: SILENT_LOGGER, nk });
    expect(r.scanned).toBe(0);
    expect(r.closed).toBe(0);
    expect(r.transitions).toBe(0);
    expect(r.deleted).toBe(0);
  });

  it('instance in the future → no transitions', () => {
    const t: Tournament = {
      schemaVersion: 1,
      id: 'future-x',
      templateId: 'future-x',
      kind: 'time_trial',
      trackId: 'tr',
      startsAt: Date.now() + 60 * 60 * 1000,
      endsAt: Date.now() + 2 * 60 * 60 * 1000,
      entryFee: 0, maxAttempts: 5, minLevel: 1,
      prizes: [],
      createdAt: Date.now(),
    };
    seedInstance(nk, t);
    const r = runScannerTick({ logger: SILENT_LOGGER, nk });
    expect(r.scanned).toBe(1);
    expect(r.closed).toBe(0);
    expect(r.transitions).toBe(0);
  });

  it('instance past endsAt → closes + grants prizes to entrants', () => {
    const t: Tournament = {
      schemaVersion: 1,
      id: 'closing-x',
      templateId: 'closing-x',
      kind: 'time_trial',
      trackId: 'tr',
      startsAt: Date.now() - 3 * 60 * 60 * 1000,
      endsAt: Date.now() - 60 * 1000,
      entryFee: 0, maxAttempts: 5, minLevel: 1,
      prizes: [
        { rankFrom: 1, rankTo: 1, rewards: { coins: 1000 } },
        { rankFrom: 2, rankTo: 3, rewards: { coins: 100 } },
      ],
      createdAt: Date.now() - 4 * 60 * 60 * 1000,
    };
    seedInstance(nk, t);
    upsertBestTime(nk, t.id, 'a', 30000, 1);
    upsertBestTime(nk, t.id, 'b', 35000, 2);
    upsertBestTime(nk, t.id, 'c', 40000, 3);

    fake.wallets.set('a', { coins: 0, gems: 0 });
    fake.wallets.set('b', { coins: 0, gems: 0 });
    fake.wallets.set('c', { coins: 0, gems: 0 });

    const r = runScannerTick({ logger: SILENT_LOGGER, nk });
    expect(r.scanned).toBe(1);
    expect(r.closed).toBe(1);

    // Plan T-23: the prizes are claimable rewards in the single inbox;
    // nothing is paid until inbox_claim.
    expect(fake.wallets.get('a')?.coins).toBe(0);
    const rewards: Array<{ userId: string; coins?: number }> = [];
    fake.store.forEach((v, k) => {
      if (!k.startsWith('inbox/')) return;
      const m = v.value as { kind: string; reward?: { coins?: number }; userId: string };
      expect(m.kind).toBe('reward');
      rewards.push({ userId: m.userId, coins: m.reward?.coins });
    });
    expect(rewards.sort((x, y) => x.userId.localeCompare(y.userId))).toEqual([
      { userId: 'a', coins: 1000 }, { userId: 'b', coins: 100 }, { userId: 'c', coins: 100 },
    ]);
  });

  it('a closed tournament closes once: closedAt stays and nothing is resent', () => {
    const t: Tournament = {
      schemaVersion: 1,
      id: 'once-x',
      templateId: 'once-x',
      kind: 'time_trial',
      trackId: 'tr',
      startsAt: Date.now() - 3 * 60 * 60 * 1000,
      endsAt: Date.now() - 60 * 1000,
      entryFee: 0, maxAttempts: 5, minLevel: 1,
      prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 1000 } }],
      createdAt: Date.now() - 4 * 60 * 60 * 1000,
    };
    seedInstance(nk, t);
    upsertBestTime(nk, t.id, 'a', 30000, 1);
    expect(runScannerTick({ logger: SILENT_LOGGER, nk }).closed).toBe(1);
    const first = readTournamentInstance(nk, t.id)!;
    expect(first.state).toBe('closed');
    expect(first.rewardsDistributed).toBe(true);
    const firstVersion = fake.store.get(`tournament_instances/${t.id}/00000000-0000-0000-0000-000000000000`)?.version;

    const second = runScannerTick({ logger: SILENT_LOGGER, nk });
    expect(second.closed).toBe(0);
    expect(readTournamentInstance(nk, t.id)!.closedAt).toBe(first.closedAt);
    expect(fake.store.get(`tournament_instances/${t.id}/00000000-0000-0000-0000-000000000000`)?.version).toBe(firstVersion);
  });

  it('a cancelled tournament closes without prizes', () => {
    const t: Tournament = {
      schemaVersion: 1,
      id: 'cancel-x',
      templateId: 'cancel-x',
      kind: 'time_trial',
      trackId: 'tr',
      startsAt: Date.now() - 3 * 60 * 60 * 1000,
      endsAt: Date.now() - 60 * 1000,
      entryFee: 0, maxAttempts: 5, minLevel: 1,
      prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 1000 } }],
      createdAt: Date.now() - 4 * 60 * 60 * 1000,
      cancelled: true,
    };
    seedInstance(nk, t);
    upsertBestTime(nk, t.id, 'a', 30000, 1);
    runScannerTick({ logger: SILENT_LOGGER, nk });
    let inbox = 0;
    fake.store.forEach((_v, k) => { if (k.startsWith('inbox/')) inbox += 1; });
    expect(inbox).toBe(0);
    expect(readTournamentInstance(nk, t.id)!.rewardsDistributed).toBe(true);
  });

  it('instance past retention (24h) → deletes the row + leaderboard', () => {
    const t: Tournament = {
      schemaVersion: 1,
      id: 'old-x',
      templateId: 'old-x',
      kind: 'time_trial',
      trackId: 'tr',
      startsAt: Date.now() - 2 * TOURNAMENT_RETENTION_MS,
      endsAt: Date.now() - TOURNAMENT_RETENTION_MS - 1000,
      entryFee: 0, maxAttempts: 5, minLevel: 1,
      prizes: [],
      createdAt: Date.now() - 2 * TOURNAMENT_RETENTION_MS,
    };
    seedInstance(nk, t);
    upsertBestTime(nk, t.id, 'a', 30000, 1);

    const r = runScannerTick({ logger: SILENT_LOGGER, nk });
    expect(r.deleted).toBe(1);
    expect(fake.store.has(`tournament_instances/${t.id}/00000000-0000-0000-0000-000000000000`)).toBe(false);
    expect(fake.store.has(`tournament_leaderboard/${t.id}/00000000-0000-0000-0000-000000000000`)).toBe(false);
  });

});
