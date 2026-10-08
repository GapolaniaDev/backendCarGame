// Phase 8 Chunk 6 — scanner tick tests (pure orchestrator).
//
// The scanner tick is best-effort and module-internal. The tests
// seed a fake store, drive `runScannerTick`, and assert the side
// effects (state transitions, prize grants, deletes).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runScannerTick, startTournamentScanner, TOURNAMENT_RETENTION_MS } from '../../modules/src/tournaments/scanner';
import { stopTournamentScannerForTests } from '../../modules/src/tournaments/_reset_for_tests';
import { loadTournamentsCatalog, _resetTournamentsCatalogForTests } from '../../modules/src/tournaments/catalog';
import { upsertBestTime } from '../../modules/src/tournaments/leaderboard';
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

  afterEach(() => {
    stopTournamentScannerForTests();
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

    expect(fake.wallets.get('a')?.coins).toBe(1000);
    expect(fake.wallets.get('b')?.coins).toBe(100);
    expect(fake.wallets.get('c')?.coins).toBe(100);

    // Inbox entries created.
    const inbox = fake.store;
    let inboxCount = 0;
    inbox.forEach((_v, k) => {
      if (k.startsWith('liveops_inbox/')) inboxCount += 1;
    });
    expect(inboxCount).toBe(3);
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

  it('startTournamentScanner handle.stop() clears the interval', () => {
    const handle = startTournamentScanner({ logger: SILENT_LOGGER, nk, intervalMs: 1_000_000 });
    handle.stop();
    // After stop, a fresh start should be permitted.
    const handle2 = startTournamentScanner({ logger: SILENT_LOGGER, nk, intervalMs: 1_000_000 });
    handle2.stop();
  });
});
