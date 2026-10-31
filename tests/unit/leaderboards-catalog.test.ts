// Unit tests for `leaderboards/catalog.ts` — pure expansion and validation.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLeaderboardTable,
  getLeaderboardTables,
  getLapAllTables,
  getRankedTable,
  resolveLeaderboardTable,
  getTtAllTables,
  getTtWeekTables,
  getWinsWeekTable,
  loadLeaderboardsCatalog,
  _resetLeaderboardsForTests,
  type LeaderboardTableEntry,
} from '../../modules/src/leaderboards/catalog';
import type { ILogger, INakama } from '../../modules/src/nkruntime';

const LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => LOGGER,
  withFields: () => LOGGER,
} as unknown as ILogger;

const FAKE_NK = {
  localcachePut: () => {},
  localcacheGet: () => '',
} as unknown as INakama;

const SAMPLE = {
  version: 1,
  tables: [
    {
      id: 'wins_week',
      operator: 'incr',
      sortOrder: 'desc',
      resetSchedule: '0 0 * * 1',
      description: 'Weekly wins',
    },
  ],
  trackScoped: {
    tracks: ['neon_blvd', 'reef_run'],
    classes: ['D', 'B'],
    patterns: {
      tt_all: {
        template: 'tt_{track}_{class}_all',
        operator: 'best',
        sortOrder: 'asc',
        resetSchedule: '',
        description: 'Best time per (track, class)',
      },
      tt_week: {
        template: 'tt_{track}_{class}_week',
        operator: 'best',
        sortOrder: 'asc',
        resetSchedule: '0 0 * * 1',
        description: 'Best time per (track, class), weekly',
      },
      lap_all: {
        template: 'lap_{track}_{class}_all',
        operator: 'best',
        sortOrder: 'asc',
        resetSchedule: '',
        description: 'Best lap per (track, class)',
      },
    },
  },
  seasonScoped: {
    ranked: {
      template: 'ranked_{season}',
      operator: 'set',
      sortOrder: 'desc',
      resetSchedule: '',
      description: 'Ranked rating per season',
    },
  },
  deprecated: [{ id: 'race_score', reason: 'replaced' }],
};

beforeEach(() => {
  _resetLeaderboardsForTests();
});

describe('leaderboards catalog', () => {
  it('expands track×class cartesian product (2 tracks × 2 classes × 3 patterns = 12)', () => {
    loadLeaderboardsCatalog(LOGGER, SAMPLE, FAKE_NK);
    const all = getLeaderboardTables();
    expect(all.length).toBe(1 /* wins_week */ + 12);
    expect(all.every((t) => t.ownerKind === 'user')).toBe(true);
    expect(getWinsWeekTable()).toBeDefined();
    expect(getLeaderboardTable('wins_week')?.operator).toBe('incr');
    expect(getLeaderboardTable('tt_neon_blvd_D_all')?.operator).toBe('best');
    expect(getLeaderboardTable('lap_reef_run_B_all')?.resetSchedule).toBe('');
    expect(getLeaderboardTable('tt_neon_blvd_B_week')?.resetSchedule).toBe('0 0 * * 1');
  });

  it('filters helpers return only the expected pattern', () => {
    loadLeaderboardsCatalog(LOGGER, SAMPLE, FAKE_NK);
    expect(getTtAllTables('neon_blvd').map((t: LeaderboardTableEntry) => t.id).sort()).toEqual([
      'tt_neon_blvd_B_all',
      'tt_neon_blvd_D_all',
    ]);
    expect(getTtWeekTables('reef_run').map((t: LeaderboardTableEntry) => t.id).sort()).toEqual([
      'tt_reef_run_B_week',
      'tt_reef_run_D_week',
    ]);
    expect(getLapAllTables('neon_blvd').map((t: LeaderboardTableEntry) => t.id).sort()).toEqual([
      'lap_neon_blvd_B_all',
      'lap_neon_blvd_D_all',
    ]);
  });

  it('rejects an invalid operator', () => {
    expect(() =>
      loadLeaderboardsCatalog(LOGGER, {
        ...SAMPLE,
        tables: [
          {
            id: 'bad',
            operator: 'unknown' as unknown as 'best',
            sortOrder: 'asc',
            resetSchedule: '',
            description: '',
          },
        ],
      }, FAKE_NK),
    ).toThrow(/operator invalid/);
  });

  it('rejects a non-1 version', () => {
    expect(() =>
      loadLeaderboardsCatalog(LOGGER, { ...SAMPLE, version: 2 }, FAKE_NK),
    ).toThrow(/version must be 1/);
  });

  it('rejects an invalid id pattern', () => {
    expect(() =>
      loadLeaderboardsCatalog(LOGGER, {
        ...SAMPLE,
        tables: [
          {
            id: 'Bad-ID!',
            operator: 'best',
            sortOrder: 'asc',
            resetSchedule: '',
            description: '',
          },
        ],
      }, FAKE_NK),
    ).toThrow(/table id must match/);
  });

  it('season-scoped ranked table: id, desc order and set operator come from the catalog (T-13)', () => {
    loadLeaderboardsCatalog(LOGGER, SAMPLE, FAKE_NK);
    const t = getRankedTable('season_2');
    expect(t.id).toBe('ranked_season_2');
    expect(t.sortOrder).toBe('desc');
    expect(t.operator).toBe('set');
    // Season tables are resolved on demand, never expanded at boot.
    expect(getLeaderboardTables().some((x) => x.id.startsWith('ranked_'))).toBe(false);
    expect(() => getRankedTable('Bad Season!')).toThrow(/invalid season id/);
  });

  it('resolveLeaderboardTable accepts catalog tables and season tables only', () => {
    loadLeaderboardsCatalog(LOGGER, SAMPLE, FAKE_NK);
    expect(resolveLeaderboardTable('wins_week')?.sortOrder).toBe('desc');
    expect(resolveLeaderboardTable('ranked_season_3')?.source).toBe('ranked');
    expect(resolveLeaderboardTable('ranked_')).toBeUndefined();
    expect(resolveLeaderboardTable('does_not_exist')).toBeUndefined();
  });

  it('rejects a catalog without the ranked season pattern', () => {
    expect(() =>
      loadLeaderboardsCatalog(LOGGER, { ...SAMPLE, seasonScoped: {} }, FAKE_NK),
    ).toThrow(/seasonScoped.ranked is required/);
  });

  it('the bundled catalog sorts wins_week and the ranked table descending (T-13)', async () => {
    const bundled = (await import('../../modules/src/catalogs/leaderboards.json')).default;
    loadLeaderboardsCatalog(LOGGER, bundled as never, FAKE_NK);
    expect(getLeaderboardTable('wins_week')?.sortOrder).toBe('desc');
    expect(getRankedTable('season_2').sortOrder).toBe('desc');
    expect(getLeaderboardTable('tt_neon_blvd_D_all')?.sortOrder).toBe('asc');
  });

  it('ownerKind defaults to user when absent and accepts club', () => {
    const club = {
      id: 'club_week',
      operator: 'incr' as const,
      sortOrder: 'desc' as const,
      resetSchedule: '0 0 * * 1',
      description: 'club points',
      ownerKind: 'club' as const,
    };
    loadLeaderboardsCatalog(LOGGER, { ...SAMPLE, tables: [...SAMPLE.tables, club] }, FAKE_NK);
    expect(getLeaderboardTable('wins_week')?.ownerKind).toBe('user');
    expect(getLeaderboardTable('club_week')?.ownerKind).toBe('club');
    expect(getLeaderboardTable('tt_neon_blvd_D_all')?.ownerKind).toBe('user');
    expect(getRankedTable('season_2').ownerKind).toBe('user');
    expect(resolveLeaderboardTable('ranked_season_3')?.ownerKind).toBe('user');
  });

  it('rejects an unknown ownerKind', () => {
    expect(() =>
      loadLeaderboardsCatalog(LOGGER, {
        ...SAMPLE,
        tables: [
          {
            id: 'team_week',
            operator: 'incr',
            sortOrder: 'desc',
            resetSchedule: '',
            description: '',
            ownerKind: 'team' as unknown as 'club',
          },
        ],
      }, FAKE_NK),
    ).toThrow(/ownerKind invalid/);
  });

  it('throws when getLeaderboardTables is called before load', () => {
    expect(() => getLeaderboardTables()).toThrow(/not loaded/);
  });
});