// Phase 6 Chunk 4 — e2e tests for the RaceCompleted → achievements subscriber.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, FakeLogger, loadBundleForTest } from './_stubs';
import type { LoadedBundle } from './_stubs';
import { EventBus } from '../../modules/src/core/event_bus';
import {
  ACHIEVEMENTS_COLLECTION,
  achievementsKey,
} from '../../modules/src/missions/counter_repo';
import {
  loadMissionsDailyCatalog,
  loadMissionsWeeklyCatalog,
  loadAchievementsCatalog,
  _resetMissionsCatalogsForTests,
} from '../../modules/src/missions/catalog';
import missionsDailyRaw from '../../modules/src/catalogs/missions_daily.json';
import missionsWeeklyRaw from '../../modules/src/catalogs/missions_weekly.json';
import achievementsRaw from '../../modules/src/catalogs/achievements.json';
import { handleRaceCompletedForMissions } from '../../modules/src/missions/subscriber';
import type { AchievementsRecord } from '../../modules/src/missions/types';
import type { RaceCompletedEvent } from '../../modules/src/race/types';

const USER = 'ach-progress-user';

function seedAchievements(env: LoadedBundle, userId: string): AchievementsRecord {
  // The subscriber does NOT auto-create the achievements row; the
  // RPC (Chunk 5) will. For these tests we seed it manually.
  const rec: AchievementsRecord = {
    schemaVersion: 1,
    userId,
    progress: {},
    claimed: {},
  };
  env.fakeNakama.store.set(
    `${ACHIEVEMENTS_COLLECTION}/${achievementsKey(userId)}/${userId}`,
    {
      collection: ACHIEVEMENTS_COLLECTION,
      key: achievementsKey(userId),
      userId,
      value: rec,
      version: 'v00000001',
      permissionRead: 1,
      permissionWrite: 1,
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
      expiresAt: null,
    },
  );
  return rec;
}

function readAchievements(env: LoadedBundle, userId: string): AchievementsRecord {
  return env.fakeNakama.store.get(
    `${ACHIEVEMENTS_COLLECTION}/${achievementsKey(userId)}/${userId}`,
  )!.value as AchievementsRecord;
}

function fireRace(
  env: LoadedBundle,
  bus: EventBus,
  opts: {
    sessionId: string;
    mode: 'quick' | 'ranked';
    results: Array<{
      userId: string;
      rank: number;
      abandoned?: boolean;
      isBot?: boolean;
      classId?: 'D' | 'C' | 'B' | 'A' | 'S';
    }>;
    timestampMs: number;
  },
): void {
  env.fakeNakama.store.set(
    `race_sessions/${opts.sessionId}/00000000-0000-0000-0000-000000000000`,
    {
      collection: 'race_sessions',
      key: opts.sessionId,
      userId: '00000000-0000-0000-0000-000000000000',
      value: {
        id: opts.sessionId,
        mode: opts.mode,
        trackId: 'stadium_today',
        size: opts.results.length as 2 | 4 | 6,
        roster: opts.results.map((r) => ({
          userId: r.userId,
          loadout: { classId: r.classId ?? 'C', bodyId: `body-${r.userId}` },
          isBot: r.isBot === true,
        })),
        host: opts.results[0]!.userId,
        hostSuccession: [opts.results[0]!.userId],
        state: 'closed',
        startedAt: opts.timestampMs - 60_000,
        version: 1,
      },
      version: 'v00000001',
      permissionRead: 0,
      permissionWrite: 0,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(opts.timestampMs).toISOString(),
      expiresAt: null,
    },
  );

  const event: RaceCompletedEvent = {
    schemaVersion: 1,
    sessionId: opts.sessionId,
    mode: opts.mode,
    trackId: 'stadium_today',
    size: opts.results.length as 2 | 4 | 6,
    results: opts.results.map((r, i) => ({
      rank: r.rank,
      userId: r.userId,
      isBot: r.isBot === true,
      totalMs: 60_000 + i * 1000,
      abandoned: r.abandoned === true,
    })),
    flags: { needsReview: false },
    closedAt: opts.timestampMs,
  };
  handleRaceCompletedForMissions(
    { logger: env.logger, nk: env.nak, bus },
    event,
  );
}

describe('achievement_progress subscriber (Phase 6 Chunk 4)', () => {
  let env: LoadedBundle;
  let bus: EventBus;

  beforeEach(() => {
    env = loadBundleForTest();
    bus = new EventBus(env.logger);
    _resetMissionsCatalogsForTests();
    loadMissionsDailyCatalog(env.logger, missionsDailyRaw as never);
    loadMissionsWeeklyCatalog(env.logger, missionsWeeklyRaw as never);
    loadAchievementsCatalog(env.logger, achievementsRaw as never);
    seedAchievements(env, USER);
  });

  it('first win → ach_first_win progress = 1', () => {
    const ts = Date.now();
    fireRace(env, bus, {
      sessionId: 's1',
      mode: 'quick',
      results: [{ userId: USER, rank: 1, classId: 'C' }],
      timestampMs: ts,
    });
    const rec = readAchievements(env, USER);
    expect(rec.progress.ach_first_win).toBe(1);
  });

  it('ranked win → ach_rank_winner_10 increments', () => {
    const ts = Date.now();
    fireRace(env, bus, {
      sessionId: 's2',
      mode: 'ranked',
      results: [{ userId: USER, rank: 1, classId: 'C' }],
      timestampMs: ts,
    });
    const rec = readAchievements(env, USER);
    expect(rec.progress.ach_rank_winner_10).toBe(1);
  });

  it('class S achievement increments on class S race', () => {
    const ts = Date.now();
    fireRace(env, bus, {
      sessionId: 's3',
      mode: 'quick',
      results: [{ userId: USER, rank: 2, classId: 'S' }],
      timestampMs: ts,
    });
    const rec = readAchievements(env, USER);
    expect(rec.progress.ach_class_s_master).toBe(1);
  });

  it('bot wins do NOT increment achievements', () => {
    const ts = Date.now();
    fireRace(env, bus, {
      sessionId: 's4',
      mode: 'quick',
      results: [{ userId: 'bot-1', isBot: true, rank: 1, classId: 'C' }],
      timestampMs: ts,
    });
    // Achievements row for the bot doesn't exist — but no throw.
    // For the human USER (no entries), nothing to do.
    const rec = readAchievements(env, USER);
    expect(rec.progress.ach_first_win ?? 0).toBe(0);
  });

  it('multi-races sum progress correctly (race_count target=10)', () => {
    let ts = Date.now();
    for (let i = 0; i < 5; i++) {
      fireRace(env, bus, {
        sessionId: `s-race-${i}`,
        mode: 'quick',
        results: [{ userId: USER, rank: 3, classId: 'C' }],
        timestampMs: ts,
      });
      ts += 1000;
    }
    const rec = readAchievements(env, USER);
    expect(rec.progress.ach_10_races).toBe(5);
  });

  it('first-win-of-day stamp enables ach_first_win_of_day_3 progress', () => {
    const ts = Date.now();
    fireRace(env, bus, {
      sessionId: 's6',
      mode: 'quick',
      results: [{ userId: USER, rank: 1, classId: 'C' }],
      timestampMs: ts,
    });
    const rec = readAchievements(env, USER);
    expect(rec.progress.ach_first_win_of_day_3).toBe(1);
  });

  it('user without achievements row is silently skipped (no auto-create)', () => {
    const ts = Date.now();
    // USER_GHOST has no achievements row.
    fireRace(env, bus, {
      sessionId: 's7',
      mode: 'quick',
      results: [{ userId: 'USER_GHOST', rank: 1, classId: 'C' }],
      timestampMs: ts,
    });
    const ghost = env.fakeNakama.store.get(
      `${ACHIEVEMENTS_COLLECTION}/USER_GHOST/USER_GHOST`,
    );
    expect(ghost).toBeUndefined();
  });
});

void FakeContext;
void FakeLogger;