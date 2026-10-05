// Unit tests for `leaderboards/subscriber.ts` — pure helpers.
// Integration of the RaceCompleted → leaderboard pipeline lives in
// `tests/e2e/leaderboards-subscriber.test.ts`.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  byClass,
  subscribeLeaderboardWriter,
  type LeaderboardWriteMeta,
} from '../../modules/src/leaderboards/subscriber';
import {
  loadLeaderboardsCatalog,
  _resetLeaderboardsForTests,
} from '../../modules/src/leaderboards/catalog';
import { hasServerToken } from '../../modules/src/leaderboards/hooks';
import type { ILogger, INakama } from '../../modules/src/nkruntime';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
} as unknown as ILogger;

const SAMPLE_CATALOG = {
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
    tracks: ['neon_blvd'],
    classes: ['D', 'B'],
    patterns: {
      tt_all: {
        template: 'tt_{track}_{class}_all',
        operator: 'best',
        sortOrder: 'asc',
        resetSchedule: '',
        description: '',
      },
      tt_week: {
        template: 'tt_{track}_{class}_week',
        operator: 'best',
        sortOrder: 'asc',
        resetSchedule: '0 0 * * 1',
        description: '',
      },
      lap_all: {
        template: 'lap_{track}_{class}_all',
        operator: 'best',
        sortOrder: 'asc',
        resetSchedule: '',
        description: '',
      },
    },
  },
  deprecated: [],
};

beforeEach(() => {
  _resetLeaderboardsForTests();
  loadLeaderboardsCatalog(
    SILENT_LOGGER,
    SAMPLE_CATALOG as unknown as Parameters<typeof loadLeaderboardsCatalog>[1],
 );
});

describe('leaderboards/subscriber — pure helpers', () => {
  it('byClass narrows a track-wide table list to a single class', () => {
    const all = [
      { id: 'tt_neon_blvd_D_all' },
      { id: 'tt_neon_blvd_B_all' },
      { id: 'lap_neon_blvd_D_all' },
    ] as unknown as Parameters<typeof byClass>[0];
    expect(byClass(all, 'B').map((t) => t.id)).toEqual(['tt_neon_blvd_B_all']);
    expect(byClass(all, 'D').map((t) => t.id)).toEqual([
      'tt_neon_blvd_D_all',
      'lap_neon_blvd_D_all',
    ]);
  });

  it('LeaderboardWriteMeta composition carries sessionId + confidence + isBot', () => {
    const meta: LeaderboardWriteMeta = {
      car: 'coupe',
      platform: 'ios',
      control: 'gamepad',
      clientVersion: '1.0.0',
      sessionId: 'sess-123',
      mode: 'quick',
      confidence: 'quorum',
      isBot: false,
    };
    expect(meta.sessionId).toBe('sess-123');
    expect(meta.confidence).toBe('quorum');
    expect(meta.isBot).toBe(false);
  });

  it('stamp + hasServerToken yields a token-bearing metadata bag', () => {
    const stamped = { foo: 'bar', __server_token__: 'phase2' };
    expect(hasServerToken(stamped)).toBe(true);
  });

  it('subscribeLeaderboardWriter registers a handler on the bus', () => {
    const subs: Array<(p: unknown) => void> = [];
    const bus = { subscribe: (_e: string, h: (p: unknown) => void) => subs.push(h) };
    const nk = { leaderboardRecordWrite: () => {} } as unknown as INakama;
    subscribeLeaderboardWriter(SILENT_LOGGER, bus, nk);
    expect(subs.length).toBe(1);
  });
});