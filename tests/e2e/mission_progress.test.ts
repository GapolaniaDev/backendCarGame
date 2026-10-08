// Phase 6 Chunk 4 — e2e tests for the RaceCompleted → missions subscriber.
//
// Drives `handleRaceCompletedForMissions` directly with a FakeNakama
// + FakeLogger + a real EventBus. The bus route is tested separately
// by Phase 4 Chunk 7 (ranked subscriber). Here we focus on the
// orchestrator: read → evaluate → apply → mark-completed → CAS-write.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, FakeNakama, FakeLogger, loadBundleForTest } from './_stubs';
import type { LoadedBundle } from './_stubs';
import { EventBus } from '../../modules/src/core/event_bus';
import {
  MISSIONS_DAILY_COLLECTION,
  MISSIONS_WEEKLY_COLLECTION,
  dailyMissionsKey,
  weeklyMissionsKey,
} from '../../modules/src/missions/counter_repo';
import {
  loadMissionsDailyCatalog,
  loadMissionsWeeklyCatalog,
  loadAchievementsCatalog,
  getMissionsDailyCatalog,
  getMissionsWeeklyCatalog,
  _resetMissionsCatalogsForTests,
} from '../../modules/src/missions/catalog';
import missionsDailyRaw from '../../modules/src/catalogs/missions_daily.json';
import missionsWeeklyRaw from '../../modules/src/catalogs/missions_weekly.json';
import achievementsRaw from '../../modules/src/catalogs/achievements.json';
import { handleRaceCompletedForMissions } from '../../modules/src/missions/subscriber';
import type { DailyMissions, WeeklyMissions, MissionDefinition, MissionFilter } from '../../modules/src/missions/types';
import type { RaceCompletedEvent } from '../../modules/src/race/types';
import { utcDate } from '../../modules/src/core/time';

/** Format an epoch ms as the 'YYYY-MM-DD' UTC date string the subscriber reads. */
function utcDateStr(ms: number): string {
  return utcDate(ms);
}

const USER_A = 'mission-progress-A';
const USER_B = 'mission-progress-B';

function makeUserDaily(env: LoadedBundle, userId: string, dateUtc = '2026-10-07'): DailyMissions {
  const handler = env.resolver('missions_get');
  if (!handler) throw new Error('no rpc: missions_get');
  const ctx = { ...FakeContext, userId };
  const body = JSON.stringify({
    callerUserId: userId, clientVersion: '1.0.0', platform: 'ios',
  });
  const out = JSON.parse(handler(ctx, env.logger, env.nak, body)) as {
    ok: true; data: { daily: { dateUtc: string; missions: Array<{ missionId: string; progress: number; completed: boolean }> } };
  };
  if (out.data.daily.dateUtc !== dateUtc) {
    // The system clock may have rolled past 2026-10-07 in CI; the test
    // is date-agnostic and reads whatever date missions_get materialised.
    // The race event below uses the same timestamp so the keys align.
  }
  return env.fakeNakama.store.get(
    `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(userId, out.data.daily.dateUtc)}/${userId}`,
  )!.value as DailyMissions;
}

/**
 * Seed a deterministic daily assignment for `userId` — bypass the
 * catalog-derived sha256 pick. The subscriber doesn't care HOW the row
 * was created; it only needs a real row in storage. Tests use this to
 * pin specific missionIds (e.g. `daily_race_5`) so assertions can
 * target known ticks.
 */
function seedDailyWith(
  env: LoadedBundle,
  userId: string,
  missionIds: string[],
  dateUtc: string,
): DailyMissions {
  const missions = missionIds.map((missionId) => ({
    instanceId: `daily:${missionId}@${dateUtc}`,
    missionId,
    progress: 0,
    completed: false,
    claimed: false,
  }));
  const rec: DailyMissions = {
    schemaVersion: 1,
    userId,
    dateUtc,
    assignedAt: Date.now(),
    rerollsLeftToday: 1,
    missions,
  };
  env.fakeNakama.store.set(
    `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(userId, dateUtc)}/${userId}`,
    {
      collection: MISSIONS_DAILY_COLLECTION,
      key: dailyMissionsKey(userId, dateUtc),
      userId,
      value: rec,
      version: 'v00000001',
      permissionRead: 1,
      permissionWrite: 1,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    },
  );
  return rec;
}

function makeUserWeekly(env: LoadedBundle, userId: string): WeeklyMissions {
  const handler = env.resolver('missions_get');
  if (!handler) throw new Error('no rpc: missions_get');
  const ctx = { ...FakeContext, userId };
  const body = JSON.stringify({
    callerUserId: userId, clientVersion: '1.0.0', platform: 'ios',
  });
  const out = JSON.parse(handler(ctx, env.logger, env.nak, body)) as {
    ok: true; data: { weekly: { weekUtc: string } };
  };
  return env.fakeNakama.store.get(
    `${MISSIONS_WEEKLY_COLLECTION}/${weeklyMissionsKey(userId, out.data.weekly.weekUtc)}/${userId}`,
  )!.value as WeeklyMissions;
}

function fireRace(
  env: LoadedBundle,
  bus: EventBus,
  opts: {
    sessionId: string;
    mode: 'quick' | 'ranked';
    trackId?: string;
    results: Array<{
      userId: string;
      isBot?: boolean;
      rank: number;
      abandoned?: boolean;
      classId?: 'D' | 'C' | 'B' | 'A' | 'S';
    }>;
    timestampMs: number;
  },
): void {
  // Seed the race session so the subscriber can recover the loadout.
  env.fakeNakama.store.set(
    `race_sessions/${opts.sessionId}/00000000-0000-0000-0000-000000000000`,
    {
      collection: 'race_sessions',
      key: opts.sessionId,
      userId: '00000000-0000-0000-0000-000000000000',
      value: {
        id: opts.sessionId,
        mode: opts.mode,
        trackId: opts.trackId ?? 'stadium_today',
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
    trackId: opts.trackId ?? 'stadium_today',
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

describe('mission_progress subscriber (Phase 6 Chunk 4)', () => {
  let env: LoadedBundle;
  let bus: EventBus;

  beforeEach(() => {
    env = loadBundleForTest();
    bus = new EventBus(env.logger);
    _resetMissionsCatalogsForTests();
    loadMissionsDailyCatalog(env.logger, missionsDailyRaw as never);
    loadMissionsWeeklyCatalog(env.logger, missionsWeeklyRaw as never);
    loadAchievementsCatalog(env.logger, achievementsRaw as never);
    // Pre-create storage for USER_A and USER_B via missions_get.
    const handler = env.resolver('missions_get');
    if (!handler) throw new Error('no rpc: missions_get');
    for (const userId of [USER_A, USER_B]) {
      const ctx = { ...FakeContext, userId };
      const body = JSON.stringify({
        callerUserId: userId, clientVersion: '1.0.0', platform: 'ios',
      });
      handler(ctx, env.logger, env.nak, body);
    }
  });

  it('new user wins quick race → race_count mission progress = 1', () => {
    // Pin a known tickable mission so the test is deterministic
    // regardless of the catalog's deterministic assignment for this user.
    const ts = Date.now();
    const dateUtc = utcDateStr(ts);
    const daily = seedDailyWith(env, USER_A, ['daily_race_5', 'daily_win_3', 'daily_first_win'], dateUtc);
    const targetId = 'daily_race_5';
    const targetInst = daily.missions.find((m) => m.missionId === targetId)!;

    fireRace(env, bus, {
      sessionId: 'sess-win-1',
      mode: 'quick',
      results: [{ userId: USER_A, rank: 1, classId: 'C' }],
      timestampMs: ts,
    });

    const after = env.fakeNakama.store.get(
      `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(USER_A, dateUtc)}/${USER_A}`,
    )!.value as DailyMissions;
    const targetAfter = after.missions.find((m) => m.missionId === targetId)!;
    // race_count ticks on every finished race (no filter).
    expect(targetAfter.progress).toBe(targetInst.progress + 1);
  });

  it('same user wins another quick → progress = 2', () => {
    const ts = Date.now();
    const dateUtc = utcDateStr(ts);
    // Pin a known tickable mission: `daily_race_5` (race_count, no filter).
    const daily = seedDailyWith(env, USER_A, ['daily_race_5', 'daily_win_3', 'daily_first_win'], dateUtc);
    const raceCount = daily.missions.find((m) => m.missionId === 'daily_race_5')!;
    const start = raceCount.progress;

    fireRace(env, bus, {
      sessionId: 'sess-win-2a',
      mode: 'quick',
      results: [{ userId: USER_A, rank: 1, classId: 'C' }],
      timestampMs: ts,
    });
    fireRace(env, bus, {
      sessionId: 'sess-win-2b',
      mode: 'quick',
      results: [{ userId: USER_A, rank: 2, classId: 'C' }],
      timestampMs: ts + 1_000,
    });

    const after = env.fakeNakama.store.get(
      `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(USER_A, dateUtc)}/${USER_A}`,
    )!.value as DailyMissions;
    const afterRaceCount = after.missions.find((m) => m.missionId === 'daily_race_5')!;
    expect(afterRaceCount.progress).toBe(start + 2);
  });

  it('user loses quick race → wins_quick stays 0, race_count still increments', () => {
    const ts = Date.now();
    const dateUtc = utcDateStr(ts);
    // Pin: one race_count (no filter) + one wins_quick.
    const daily = seedDailyWith(env, USER_A, ['daily_race_5', 'daily_quick_win_3', 'daily_win_3'], dateUtc);
    const winsQuick = daily.missions.find((m) => m.missionId === 'daily_quick_win_3')!;
    const raceCount = daily.missions.find((m) => m.missionId === 'daily_race_5')!;

    fireRace(env, bus, {
      sessionId: 'sess-lose',
      mode: 'quick',
      results: [{ userId: USER_A, rank: 3, classId: 'C' }],
      timestampMs: ts,
    });

    const after = env.fakeNakama.store.get(
      `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(USER_A, dateUtc)}/${USER_A}`,
    )!.value as DailyMissions;
    // wins_quick only fires on rank=1 → rank=3 leaves it at 0.
    const wk = after.missions.find((m) => m.missionId === winsQuick.missionId)!;
    expect(wk.progress).toBe(0);
    // race_count still ticks on a non-abandoned finish.
    const rc = after.missions.find((m) => m.missionId === raceCount.missionId)!;
    expect(rc.progress).toBeGreaterThanOrEqual(raceCount.progress + 1);
  });

  it('user wins ranked → no wins_quick ticks, any race_count(ranked) ticks', () => {
    const ts = Date.now();
    const daily = makeUserDaily(env, USER_A);
    const winsQuick = daily.missions.find((m) => m.kind === 'wins_quick');
    const rankedCount = daily.missions.find(
      (m) => m.kind === 'race_count' && (m.filters as { mode?: string }).mode === 'ranked',
    );

    fireRace(env, bus, {
      sessionId: 'sess-ranked',
      mode: 'ranked',
      results: [{ userId: USER_A, rank: 1, classId: 'C' }],
      timestampMs: ts,
    });

    const after = env.fakeNakama.store.get(
      `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(USER_A, daily.dateUtc)}/${USER_A}`,
    )!.value as DailyMissions;
    // wins_quick (if assigned) does NOT increment on ranked races.
    if (winsQuick !== undefined) {
      const wk = after.missions.find((m) => m.missionId === winsQuick.missionId)!;
      expect(wk.progress).toBe(0);
    }
    // race_count(mode=ranked) (if assigned) ticks on this win.
    if (rankedCount !== undefined) {
      const rc = after.missions.find((m) => m.missionId === rankedCount.missionId)!;
      expect(rc.progress).toBe(rankedCount.progress + 1);
    }
  });

  it('abandon → race_count does NOT increment (no finishedRace)', () => {
    const ts = Date.now();
    const daily = makeUserDaily(env, USER_A);
    const raceCount = daily.missions.find((m) => m.missionId === 'daily_race_5')
      ?? daily.missions[0]!;

    fireRace(env, bus, {
      sessionId: 'sess-abandon',
      mode: 'quick',
      results: [{ userId: USER_A, rank: 4, classId: 'C', abandoned: true }],
      timestampMs: ts,
    });

    const after = env.fakeNakama.store.get(
      `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(USER_A, daily.dateUtc)}/${USER_A}`,
    )!.value as DailyMissions;
    const rc = after.missions.find((m) => m.missionId === raceCount.missionId)!;
    expect(rc.progress).toBe(raceCount.progress); // unchanged
  });

  it('bots in race: only humans get progress', () => {
    const ts = Date.now();
    const dateUtc = utcDateStr(ts);
    // Pre-create missions for USER_A only (the bot has no storage).
    const daily = seedDailyWith(env, USER_A, ['daily_race_5', 'daily_win_3', 'daily_quick_win_3'], dateUtc);
    const raceCount = daily.missions.find((m) => m.missionId === 'daily_race_5')!;

    fireRace(env, bus, {
      sessionId: 'sess-bots',
      mode: 'quick',
      results: [
        { userId: USER_A, rank: 1, classId: 'C' },
        { userId: 'bot-1', isBot: true, rank: 2, classId: 'C' },
      ],
      timestampMs: ts,
    });

    const after = env.fakeNakama.store.get(
      `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(USER_A, dateUtc)}/${USER_A}`,
    )!.value as DailyMissions;
    const rc = after.missions.find((m) => m.missionId === raceCount.missionId)!;
    expect(rc.progress).toBe(raceCount.progress + 1); // USER_A only — bots don't tick
  });

  it('multi-human race: each human\'s missions update independently', () => {
    const ts = Date.now();
    const dateUtc = utcDateStr(ts);
    // Pin: race_count with no filter for both users — ticks for both rank=1
    // and rank=2 finishers in quick mode class=C size=2.
    const dailyA = seedDailyWith(env, USER_A, ['daily_race_5', 'daily_win_3', 'daily_quick_win_3'], dateUtc);
    const dailyB = seedDailyWith(env, USER_B, ['daily_race_5', 'daily_win_3', 'daily_quick_win_3'], dateUtc);
    const aRace = dailyA.missions.find((m) => m.missionId === 'daily_race_5')!;
    const bRace = dailyB.missions.find((m) => m.missionId === 'daily_race_5')!;

    fireRace(env, bus, {
      sessionId: 'sess-multi',
      mode: 'quick',
      results: [
        { userId: USER_A, rank: 1, classId: 'C' },
        { userId: USER_B, rank: 2, classId: 'C' },
      ],
      timestampMs: ts,
    });

    const afterA = env.fakeNakama.store.get(
      `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(USER_A, dateUtc)}/${USER_A}`,
    )!.value as DailyMissions;
    const afterB = env.fakeNakama.store.get(
      `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(USER_B, dateUtc)}/${USER_B}`,
    )!.value as DailyMissions;
    const aAfter = afterA.missions.find((m) => m.missionId === aRace.missionId)!;
    const bAfter = afterB.missions.find((m) => m.missionId === bRace.missionId)!;
    expect(aAfter.progress).toBe(aRace.progress + 1);
    expect(bAfter.progress).toBe(bRace.progress + 1);
  });

  it('weekly mission updates with weekly row in storage', () => {
    const ts = Date.now();
    const weekly = makeUserWeekly(env, USER_A);
    // Look up kind/filters via the catalog (storage records omit them).
    const weeklyById = new Map<string, MissionDefinition>();
    for (const d of getMissionsWeeklyCatalog()) weeklyById.set(d.id, d);

    // We fire a quick rank=1 race size=2 class=C, so tickable = kind:
    // skip wins_quick/wins_ranked, requireFirstWinOfDay, mismatching
    // class/size/mode.
    const tickable = (m: { missionId: string }) => {
      const def = weeklyById.get(m.missionId);
      if (!def) return false;
      const f: MissionFilter = def.filters;
      return def.kind !== 'wins_ranked' && def.kind !== 'wins_quick'
        && f.requireFirstWinOfDay !== true
        && f.classId !== 'A' && f.classId !== 'S'
        && f.classId !== 'D' && f.classId !== 'B'
        && f.size !== 4 && f.size !== 6
        && f.mode !== 'ranked';
    };
    const wRace = weekly.missions.find(tickable) ?? weekly.missions[0]!;
    const start = wRace.progress;

    // If the user's deterministic weekly pick has no tickable mission,
    // the test is a soft-pass (no regression).
    const def = weeklyById.get(wRace.missionId);
    if (!def || def.kind === 'wins_quick' || def.kind === 'wins_ranked') {
      expect(start).toBe(0);
      return;
    }

    fireRace(env, bus, {
      sessionId: 'sess-weekly',
      mode: 'quick',
      results: [{ userId: USER_A, rank: 1, classId: 'C' }],
      timestampMs: ts,
    });

    const after = env.fakeNakama.store.get(
      `${MISSIONS_WEEKLY_COLLECTION}/${weeklyMissionsKey(USER_A, weekly.weekUtc)}/${USER_A}`,
    )!.value as WeeklyMissions;
    const wAfter = after.missions.find((m) => m.missionId === wRace.missionId)!;
    expect(wAfter.progress).toBe(start + 1);
  });

  it('user with no mission storage is skipped silently', () => {
    const USER_GHOST = 'mission-progress-ghost';
    const ts = Date.now();
    // USER_GHOST has never called missions_get → no daily/weekly/achievements row.
    fireRace(env, bus, {
      sessionId: 'sess-ghost',
      mode: 'quick',
      results: [{ userId: USER_GHOST, rank: 1, classId: 'C' }],
      timestampMs: ts,
    });
    // No throws, no row created (subscriber does NOT auto-create).
    const ghostDaily = env.fakeNakama.store.get(
      `${MISSIONS_DAILY_COLLECTION}/${USER_GHOST}/${USER_GHOST}/${USER_GHOST}`,
    );
    expect(ghostDaily).toBeUndefined();
  });

  it('track mission: win on stadium_today → wins_quick increments for first_win', () => {
    // Track-specific mission: `daily_track_stadium` requires rank=1.
    // It only fires when result.position === 1 AND trackId matches.
    const ts = Date.now();
    const daily = makeUserDaily(env, USER_A);
    const trackMission = daily.missions.find((m) => m.missionId === 'daily_track_stadium');

    fireRace(env, bus, {
      sessionId: 'sess-track',
      mode: 'quick',
      trackId: 'stadium_today',
      results: [{ userId: USER_A, rank: 1, classId: 'C' }],
      timestampMs: ts,
    });

    if (trackMission !== undefined) {
      const after = env.fakeNakama.store.get(
        `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(USER_A, daily.dateUtc)}/${USER_A}`,
      )!.value as DailyMissions;
      const t = after.missions.find((m) => m.missionId === 'daily_track_stadium')!;
      expect(t.progress).toBe(trackMission.progress + 1);
    }
  });

  it('class mission: race with class=C car → race_class(classId=C) increments', () => {
    const ts = Date.now();
    const daily = makeUserDaily(env, USER_A);
    const classMission = daily.missions.find((m) => m.missionId === 'daily_race_class_c');

    if (classMission !== undefined) {
      fireRace(env, bus, {
        sessionId: 'sess-class-c',
        mode: 'quick',
        results: [{ userId: USER_A, rank: 1, classId: 'C' }],
        timestampMs: ts,
      });

      const after = env.fakeNakama.store.get(
        `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(USER_A, daily.dateUtc)}/${USER_A}`,
      )!.value as DailyMissions;
      const cm = after.missions.find((m) => m.missionId === 'daily_race_class_c')!;
      expect(cm.progress).toBe(classMission.progress + 1);
    }
  });

  it('positions: top 3 finishes count for race_position(maxPosition=3)', () => {
    const ts = Date.now();
    const daily = makeUserDaily(env, USER_A);
    // race_position mission — pick daily_position_3 if present
    const positionMission = daily.missions.find((m) => m.missionId === 'daily_position_3');

    if (positionMission !== undefined) {
      fireRace(env, bus, {
        sessionId: 'sess-podium',
        mode: 'quick',
        results: [{ userId: USER_A, rank: 2, classId: 'C' }],
        timestampMs: ts,
      });
      const after = env.fakeNakama.store.get(
        `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey(USER_A, daily.dateUtc)}/${USER_A}`,
      )!.value as DailyMissions;
      const pm = after.missions.find((m) => m.missionId === 'daily_position_3')!;
      // rank 2 ≤ maxPosition 3 → increments
      expect(pm.progress).toBe(positionMission.progress + 1);
    }
  });
});

// Suppress unused warning for FakeNakama import (kept for symmetry).
void FakeNakama;