// E2E tests for the Phase 2 leaderboard boot path:
//   - InitModule loads the catalog, ensures tables, drops race_score
//   - registerLeaderboardWriteGuard rejects un-tokenized writes
//
// Note on VM isolation: the bundle's InitModule runs in `vm.runInContext`
// so the catalog's module-level state lives in a SEPARATE goja VM from
// the test. To exercise the catalog + ensure helpers from the test's
// own VM context, we call `loadLeaderboardsCatalog` again against the
// test's own `env.fakeNakama`. This is intentional duplication: the
// production bundle populates the runtime's `nk`, the test populates the
// test's `nk`. They are not shared.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadBundleForTest,
  SYSTEM_USER_ID,
} from './_stubs';
import {
  loadLeaderboardsCatalog,
} from '../../modules/src/leaderboards/catalog';
import { ensureLeaderboards } from '../../modules/src/leaderboards/ensure';
import {
  hasServerToken,
  registerLeaderboardWriteGuard,
  stampServerToken,
} from '../../modules/src/leaderboards/hooks';
import type { ILeaderboardRecordEnvelope } from '../../modules/src/nkruntime';
import leaderboardsJson from '../../modules/src/catalogs/leaderboards.json';

const TRACKS = 6;
const CLASSES = 5;
const PATTERNS = 3; // tt_all, tt_week, lap_all
/** Catalog tables (wins_week + track×class×pattern). Excludes club_week. */
const EXPECTED_CATALOG_TABLES = 1 /* wins_week */ + TRACKS * CLASSES * PATTERNS; // = 91
/** Catalog tables + the standalone club_week table (Phase 7 Chunk 5). */
const EXPECTED_TOTAL_TABLES = EXPECTED_CATALOG_TABLES + 1 /* club_week */; // = 92

describe('leaderboards boot (Chunk 11)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('creates every authoritative table from the expanded catalog (91) + club_week', () => {
    // InitModule populated env.fakeNakama.leaderboards (the bundle's nk
    // is the same FakeNakama instance). Confirm the count + a few
    // representative ids.
    const created = env.fakeNakama.leaderboards;
    expect(created.size).toBe(EXPECTED_TOTAL_TABLES);
    expect(created.has('wins_week')).toBe(true);
    expect(created.has('tt_neon_blvd_B_all')).toBe(true);
    expect(created.has('tt_neon_blvd_B_week')).toBe(true);
    expect(created.has('lap_factory_loop_S_all')).toBe(true);
    // Phase 7 Chunk 5: the standalone club_week leaderboard.
    expect(created.has('club_week')).toBe(true);
    // Every created table must be authoritative.
    for (const lb of created.values()) {
      expect(lb.authoritative).toBe(true);
    }
  });

  it('is a no-op when re-ensured (INSERT-IF-NOT-EXISTS)', () => {
    // Re-load + re-ensure against the same fakeNakama: every catalog
    // table is already there, so the catalog-summary reports
    // `existing: 91` and `created: 0`. The club_week table is wired
    // via a separate helper, so the total table count is 92.
    loadLeaderboardsCatalog(
      env.fakeLogger,
      leaderboardsJson as unknown as Parameters<typeof loadLeaderboardsCatalog>[1],
      env.nak,
    );
    const summary = ensureLeaderboards(env.fakeLogger, env.nak);
    expect(summary.total).toBe(EXPECTED_CATALOG_TABLES);
    expect(summary.created).toBe(0);
    expect(summary.existing).toBe(EXPECTED_CATALOG_TABLES);
    expect(env.fakeNakama.leaderboards.size).toBe(EXPECTED_TOTAL_TABLES);
  });

  it('drop-races the deprecated race_score table when it pre-exists', () => {
    // Pre-seed race_score so ensureLeaderboards' delete call succeeds.
    env.nak.leaderboardCreate(
      'race_score',
      /* authoritative */ false,
      'desc',
      'set',
      '',
      { legacy: true },
      /* enableRanks */ false,
    );
    expect(env.fakeNakama.leaderboards.has('race_score')).toBe(true);
    // Re-run InitModule via loadBundleForTest is heavy; instead call
    // ensure directly which also runs the delete.
    loadLeaderboardsCatalog(
      env.fakeLogger,
      leaderboardsJson as unknown as Parameters<typeof loadLeaderboardsCatalog>[1],
      env.nak,
    );
    ensureLeaderboards(env.fakeLogger, env.nak);
    expect(env.fakeNakama.leaderboards.has('race_score')).toBe(false);
    expect(env.fakeNakama.deletedLeaderboards.has('race_score')).toBe(true);
  });

  it('marks the catalog as having race_score in its deprecated list', () => {
    expect(leaderboardsJson.deprecated.some((d) => d.id === 'race_score')).toBe(true);
  });

  it('registers a before-hook for leaderboard writes', () => {
    expect(env.fakeInitializer.beforeLeaderboardRecordWrites.length).toBe(1);
  });

  it('before-hook rejects writes without the server token', () => {
    const hook = env.fakeInitializer.beforeLeaderboardRecordWrites[0];
    expect(hook).toBeDefined();
    if (!hook) return;
    const lb = env.fakeNakama.leaderboards.get('tt_neon_blvd_B_all');
    expect(lb).toBeDefined();
    if (!lb) return;
    const envelope = {
      leaderboardId: 'tt_neon_blvd_B_all',
      leaderboard: lb,
      record: null,
      update: {
        prevRank: null,
        prevScore: null,
        prevSubscore: null,
        prevMetadata: null,
        rank: null,
        score: 120_000,
        subscore: Date.now(),
        metadata: { car: 'coupe', platform: 'ios' }, // NO server token
        operator: 'best',
      },
    } as unknown as ILeaderboardRecordEnvelope;
    expect(() => hook(null, env.fakeLogger, env.nak, envelope)).toThrow(/rejected/);
  });

  it('before-hook accepts writes that carry the server token', () => {
    const hook = env.fakeInitializer.beforeLeaderboardRecordWrites[0];
    expect(hook).toBeDefined();
    if (!hook) return;
    const lb = env.fakeNakama.leaderboards.get('tt_neon_blvd_B_all');
    expect(lb).toBeDefined();
    if (!lb) return;
    const envelope = {
      leaderboardId: 'tt_neon_blvd_B_all',
      leaderboard: lb,
      record: null,
      update: {
        prevRank: null,
        prevScore: null,
        prevSubscore: null,
        prevMetadata: null,
        rank: null,
        score: 120_000,
        subscore: Date.now(),
        metadata: stampServerToken({ car: 'coupe', platform: 'ios' }),
        operator: 'best',
      },
    } as unknown as ILeaderboardRecordEnvelope;
    expect(() => hook(null, env.fakeLogger, env.nak, envelope)).not.toThrow();
  });

  it('hasServerToken + stampServerToken are inverse functions', () => {
    expect(hasServerToken(stampServerToken({ foo: 'bar' }))).toBe(true);
    expect(hasServerToken({ foo: 'bar' })).toBe(false);
    expect(hasServerToken(null)).toBe(false);
  });

  it('keeps the system_user_id sentinel available for storage operations', () => {
    expect(SYSTEM_USER_ID).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('registerLeaderboardWriteGuard can be re-installed safely', () => {
    // Calling it again from the test layer just adds another hook entry;
    // production code only calls it once. The point of the test is to
    // assert the helper doesn't throw on a second registration.
    expect(() =>
      registerLeaderboardWriteGuard(env.fakeInitializer.initializer),
    ).not.toThrow();
    expect(env.fakeInitializer.beforeLeaderboardRecordWrites.length).toBe(2);
  });

  it('returns well-formed LeaderboardTableEntry objects', () => {
    loadLeaderboardsCatalog(
      env.fakeLogger,
      leaderboardsJson as unknown as Parameters<typeof loadLeaderboardsCatalog>[1],
      env.nak,
    );
    // Re-derive the catalog in the test VM by re-calling the loader.
    // (We don't expose getLeaderboardTables here to keep this test
    // local; the catalog helpers are exercised in the unit suite.)
    const lb = env.fakeNakama.leaderboards.get('tt_neon_blvd_B_week');
    expect(lb?.operator).toBe('best');
    expect(lb?.sortOrder).toBe('asc');
    expect(lb?.resetSchedule).toBe('0 0 * * 1');
    expect((lb?.metadata as { source?: string } | undefined)?.source).toBe('tt_week');
  });
});