// The bundled `club_week` catalog entry must match the table created by
// `clubs/leaderboard_init.ts`: if they differ, `ensureLeaderboards` would
// recreate the table and wipe the week's points (plan B2, D-05).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLeaderboardTable,
  loadLeaderboardsCatalog,
  _resetLeaderboardsForTests,
} from '../../modules/src/leaderboards/catalog';
import {
  CLUB_WEEK_LEADERBOARD_ID,
  CLUB_WEEK_RESET_SCHEDULE,
} from '../../modules/src/clubs/leaderboard_init';
import leaderboardsJson from '../../modules/src/catalogs/leaderboards.json';
import type { ILogger, INakama } from '../../modules/src/nkruntime';

const LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as ILogger;

const FAKE_NK = {
  localcachePut: () => {},
} as unknown as INakama;

describe('club_week catalog entry', () => {
  beforeEach(() => {
    _resetLeaderboardsForTests();
    loadLeaderboardsCatalog(LOGGER, leaderboardsJson as never, FAKE_NK);
  });

  it('matches the table created at boot (id, operator, order, reset, owner kind)', () => {
    const entry = getLeaderboardTable(CLUB_WEEK_LEADERBOARD_ID);
    expect(entry).toBeDefined();
    expect(entry?.id).toBe(CLUB_WEEK_LEADERBOARD_ID);
    expect(entry?.operator).toBe('incr');
    expect(entry?.sortOrder).toBe('desc');
    expect(entry?.resetSchedule).toBe(CLUB_WEEK_RESET_SCHEDULE);
    expect(entry?.ownerKind).toBe('club');
  });
});
