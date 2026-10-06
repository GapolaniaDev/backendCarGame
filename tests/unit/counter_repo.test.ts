// Phase 6 Chunk 2 — read-side storage helpers (counter_repo) tests.

import { describe, it, expect } from 'vitest';
import { FakeNakama } from '../e2e/_stubs';
import {
  dailyMissionsKey,
  weeklyMissionsKey,
  achievementsKey,
  readDailyMissions,
  readWeeklyMissions,
  readAchievements,
  MISSIONS_DAILY_COLLECTION,
  MISSIONS_WEEKLY_COLLECTION,
  ACHIEVEMENTS_COLLECTION,
  SERVER_OWNED_READ,
  SERVER_OWNED_WRITE,
} from '../../modules/src/missions/counter_repo';

const USER = 'user-counter-repo';
const DATE = '2026-01-15';
const WEEK = '2026-W03';

function storageKeyStr(collection: string, key: string, userId: string): string {
  return `${collection}/${key}/${userId}`;
}

describe('counter_repo: key builders', () => {
  it('dailyMissionsKey returns `${userId}/${dateUtc}`', () => {
    expect(dailyMissionsKey(USER, DATE)).toBe(`${USER}/${DATE}`);
  });

  it('weeklyMissionsKey returns `${userId}/${weekUtc}`', () => {
    expect(weeklyMissionsKey(USER, WEEK)).toBe(`${USER}/${WEEK}`);
  });

  it('achievementsKey returns the userId', () => {
    expect(achievementsKey(USER)).toBe(USER);
  });
});

describe('counter_repo: readDailyMissions', () => {
  it('returns null when storage is empty', () => {
    const fakeNakama = new FakeNakama();
    const result = readDailyMissions(fakeNakama.nakama, USER, DATE);
    expect(result).toBeNull();
  });

  it('returns the parsed record when storage is populated', () => {
    const fakeNakama = new FakeNakama();
    const stored = {
      schemaVersion: 1,
      userId: USER,
      dateUtc: DATE,
      assignedAt: 1_700_000_000_000,
      rerollsLeftToday: 1,
      missions: [
        { instanceId: `daily:daily_3_races@${DATE}`, missionId: 'daily_3_races',
          progress: 1, completed: false, claimed: false },
      ],
    };
    fakeNakama.store.set(storageKeyStr(MISSIONS_DAILY_COLLECTION, dailyMissionsKey(USER, DATE), USER), {
      collection: MISSIONS_DAILY_COLLECTION,
      key: dailyMissionsKey(USER, DATE),
      userId: USER,
      value: stored,
      version: 'v00000001',
      permissionRead: SERVER_OWNED_READ,
      permissionWrite: SERVER_OWNED_WRITE,
      createTime: '2026-01-15T00:00:00Z',
      updateTime: '2026-01-15T00:00:00Z',
      expiresAt: null,
    });

    const result = readDailyMissions(fakeNakama.nakama, USER, DATE);
    expect(result).not.toBeNull();
    expect(result?.schemaVersion).toBe(1);
    expect(result?.userId).toBe(USER);
    expect(result?.dateUtc).toBe(DATE);
    expect(result?.missions.length).toBe(1);
  });

  it('returns null when key does not match', () => {
    const fakeNakama = new FakeNakama();
    const result = readDailyMissions(fakeNakama.nakama, 'unknown-user', DATE);
    expect(result).toBeNull();
  });
});

describe('counter_repo: readWeeklyMissions', () => {
  it('returns null when storage is empty', () => {
    const fakeNakama = new FakeNakama();
    expect(readWeeklyMissions(fakeNakama.nakama, USER, WEEK)).toBeNull();
  });

  it('returns the parsed record when populated', () => {
    const fakeNakama = new FakeNakama();
    const stored = {
      schemaVersion: 1,
      userId: USER,
      weekUtc: WEEK,
      assignedAt: 1_700_000_000_000,
      rerollsLeftToday: 1,
      missions: [
        { instanceId: `weekly:weekly_5_races@${WEEK}`, missionId: 'weekly_5_races',
          progress: 0, completed: false, claimed: false },
      ],
    };
    fakeNakama.store.set(storageKeyStr(MISSIONS_WEEKLY_COLLECTION, weeklyMissionsKey(USER, WEEK), USER), {
      collection: MISSIONS_WEEKLY_COLLECTION,
      key: weeklyMissionsKey(USER, WEEK),
      userId: USER,
      value: stored,
      version: 'v00000001',
      permissionRead: SERVER_OWNED_READ,
      permissionWrite: SERVER_OWNED_WRITE,
      createTime: '2026-01-12T00:00:00Z',
      updateTime: '2026-01-12T00:00:00Z',
      expiresAt: null,
    });
    const result = readWeeklyMissions(fakeNakama.nakama, USER, WEEK);
    expect(result?.weekUtc).toBe(WEEK);
    expect(result?.missions.length).toBe(1);
  });
});

describe('counter_repo: readAchievements', () => {
  it('returns null when storage is empty', () => {
    const fakeNakama = new FakeNakama();
    expect(readAchievements(fakeNakama.nakama, USER)).toBeNull();
  });

  it('returns the parsed record when populated', () => {
    const fakeNakama = new FakeNakama();
    const stored = {
      schemaVersion: 1,
      userId: USER,
      progress: { ach_first_race: 1, ach_first_podium: 0 },
      claimed: { ach_first_race: false },
    };
    fakeNakama.store.set(storageKeyStr(ACHIEVEMENTS_COLLECTION, achievementsKey(USER), USER), {
      collection: ACHIEVEMENTS_COLLECTION,
      key: achievementsKey(USER),
      userId: USER,
      value: stored,
      version: 'v00000001',
      permissionRead: SERVER_OWNED_READ,
      permissionWrite: SERVER_OWNED_WRITE,
      createTime: '2026-01-15T00:00:00Z',
      updateTime: '2026-01-15T00:00:00Z',
      expiresAt: null,
    });
    const result = readAchievements(fakeNakama.nakama, USER);
    expect(result?.progress['ach_first_race']).toBe(1);
    expect(result?.claimed['ach_first_race']).toBe(false);
  });
});

describe('counter_repo: permissions', () => {
  it('server-owned read/write bits = 1 (Phase 4/5 convention)', () => {
    expect(SERVER_OWNED_READ).toBe(1);
    expect(SERVER_OWNED_WRITE).toBe(1);
  });
});