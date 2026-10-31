// Unit tests for `leaderboards/subscriber.ts` — pure helpers.
// Integration of the RaceCompleted → leaderboard pipeline lives in
// `tests/e2e/leaderboards-subscriber.test.ts`.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyRaceCompletedToLeaderboards,
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
import type { RaceCompletedEvent, RaceModeId } from '../../modules/src/race/types';
import type { PersistedSession } from '../../modules/src/race/session_repo';
import leaderboardsJson from '../../modules/src/catalogs/leaderboards.json';

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
  seasonScoped: {
    ranked: {
      template: 'ranked_{season}',
      operator: 'set',
      sortOrder: 'desc',
      resetSchedule: '',
      description: 'Ranked rating per season',
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

describe('leaderboards/subscriber — time tables are time-trial only (plan B2, D-08)', () => {
  const SESSION_ID = 'sess-tt';
  const USER_ID = 'user-1';

  function makeSession(trackId: string, mode: RaceModeId): PersistedSession {
    return {
      schemaVersion: 1,
      id: SESSION_ID,
      trackId,
      mode,
      roster: [
        {
          userId: USER_ID,
          loadout: { classId: 'B', bodyId: 'coupe' },
          isBot: false,
          totalMs: 90_000,
          laps: [30_000, 28_000, 32_000],
        },
      ],
    } as unknown as PersistedSession;
  }

  function makeEvent(
    trackId: string,
    mode: RaceModeId,
    confidence: 'quorum' | 'client' | 'server',
  ): RaceCompletedEvent {
    return {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      mode,
      trackId,
      size: 1,
      results: [{ rank: 1, userId: USER_ID, isBot: false, totalMs: 90_000, abandoned: false }],
      flags: { needsReview: confidence === 'client' },
      confidence,
      closedAt: 1,
    };
  }

  /** Runs the writer against a fake runtime and returns the ids written to. */
  async function writtenTables(event: RaceCompletedEvent, session: PersistedSession): Promise<string[]> {
    const written: string[] = [];
    const nk = {
      storageRead: () => [{ value: session, version: 'v1' }],
      usersGetId: () => [{ userId: USER_ID, username: 'name-1' }],
      leaderboardRecordWrite: (id: string) => {
        written.push(id);
      },
    } as unknown as INakama;
    await applyRaceCompletedToLeaderboards(SILENT_LOGGER, nk, event);
    return written;
  }

  beforeEach(() => {
    _resetLeaderboardsForTests();
    loadLeaderboardsCatalog(
      SILENT_LOGGER,
      leaderboardsJson as unknown as Parameters<typeof loadLeaderboardsCatalog>[1],
    );
  });

  it('a quick race with server confidence writes lap_ and wins_week but no tt_ table', async () => {
    const written = await writtenTables(
      makeEvent('neon_blvd', 'quick', 'server'),
      makeSession('neon_blvd', 'quick'),
    );
    expect(written.filter((id) => id.startsWith('tt_'))).toEqual([]);
    expect(written).toContain('lap_neon_blvd_B_all');
    expect(written).toContain('wins_week');
  });

  it('a time trial with client confidence writes tt_all and tt_week', async () => {
    const written = await writtenTables(
      makeEvent('neon_blvd', 'time_trial', 'client'),
      makeSession('neon_blvd', 'time_trial'),
    );
    expect(written).toContain('tt_neon_blvd_B_all');
    expect(written).toContain('tt_neon_blvd_B_week');
    expect(written).toContain('lap_neon_blvd_B_all');
    expect(written).not.toContain('wins_week');
  });

  it('a time trial on stadium_today writes tt_stadium_today_<class>_all', async () => {
    const written = await writtenTables(
      makeEvent('stadium_today', 'time_trial', 'quorum'),
      makeSession('stadium_today', 'time_trial'),
    );
    expect(written).toContain('tt_stadium_today_B_all');
    expect(written).toContain('tt_stadium_today_B_week');
  });
});