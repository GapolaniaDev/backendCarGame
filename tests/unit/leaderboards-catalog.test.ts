// Unit tests for `leaderboards/catalog.ts` — pure expansion and validation.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLeaderboardTable,
  getLeaderboardTables,
  getLapAllTables,
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

  it('throws when getLeaderboardTables is called before load', () => {
    expect(() => getLeaderboardTables()).toThrow(/not loaded/);
  });
});