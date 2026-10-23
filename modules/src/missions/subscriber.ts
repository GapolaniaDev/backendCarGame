// Phase 6 Chunk 4 — RaceCompleted → missions / achievements subscriber.
//
// Subscribes to the in-process `RaceCompleted` event. For every closed
// session, walks the humans, evaluates the counter engine against
// their daily/weekly/achievement assignments, sums the increments,
// marks completion when target is reached, and CAS-persists.
//
// Subscriber never grants rewards — that's `mission_claim` /
// `achievement_claim`. The subscriber only advances counters and
// stamps `completed=true`. Per spec:
//
//   1. Stamp firstWinOfDay for every human winner (executed BEFORE
//      counter evaluation so the map is populated when the counter
//      runs).
//   2. For each human finisher, for the daily, weekly and achievements
//      records (plan T-20; HT Prog-4, Prog-10):
//      a. Read the record; a missing one is created with the day's /
//         week's deterministic assignment (the same as `missions_get`),
//         so a race finished before the first `*_get` still counts.
//      b. Evaluate increments via counter.ts, apply the pure progress
//         writers and mark completion.
//      c. Write with the version read; on a lost CAS, re-read and
//         re-apply b. (Before T-20 the retry wrote the stale record with
//         a fresh version, undoing a claim made in between: the mission
//         could be claimed twice.)
//   3. Emit `mission_completed` / `achievement_unlocked` analytics.
//
// Idempotency: Phase 4's ranked subscriber uses a `ranked_progress`
// marker by sessionId. We don't replicate that here yet — the spec
// flags it as future work (next race will over-count by one tick if
// `race_submit_result` ever fires twice). This is acceptable per
// the spec; we don't crash, we just over-count once. Chunk 9 (XP
// grant) will revisit.
//
// Wired from `main.ts` via `subscribeMissionsProgress(deps)`.
// Testable: `handleRaceCompletedForMissions(deps, event)` is exported.

import type { ILogger, INakama } from '../nkruntime';
import type { EventBus } from '../core/event_bus';
import type { RaceCompletedEvent as RaceCompletedEventFromRace } from '../race/types';
import { RACE_EVENT_RACE_COMPLETED } from '../race/constants';
import { SYSTEM_USER_ID } from '../race/constants';
import {
  updateDailyMissions,
  updateWeeklyMissions,
  updateAchievements,
} from './missions_repo';
import { evaluateIncrement } from './counter';
import { extractHumanResults } from './event';
import {
  bridgeToMissionEvent,
  type BridgeContext,
} from './event_bridge';
import {
  stampFirstWinOfDayForAll,
} from './event_bridge_extensions';
import {
  applyIncrementsToMissions,
  applyIncrementsToAchievements,
  markCompletedIfReached,
  newlyCompleted,
  newlyCompletedAchievements,
} from './progress_writer';
import {
  getAchievementsCatalog,
  getMissionsDailyCatalog,
  getMissionsWeeklyCatalog,
} from './catalog';
import { utcDate, utcWeek } from '../core/time';
import { emit } from '../core/admin/analytics';
import type { DailyMissions, WeeklyMissions, AchievementsRecord } from './types';
import { addPassXp } from '../pass/pass_repo';
import {
  passXPSourceForRace,
  raceXPFor,
  type PassXPSource,
} from '../pass/xp_engine';

export interface MissionsSubscriberDeps {
  logger: ILogger;
  nk: INakama;
  bus: EventBus;
}

export interface MissionsSubscriberOutcome {
  /** `false` when the race was skipped (empty/confidence). */
  processed: boolean;
  /** Per-human side-effect summary (empty when not processed). */
  humans: Array<{
    userId: string;
    dailyWritten: boolean;
    weeklyWritten: boolean;
    achievementsWritten: boolean;
    dailyCompletedIds: string[];
    weeklyCompletedIds: string[];
    achievementCompletedIds: string[];
  }>;
  /** Reason string for skip outcomes (helps debugging tests). */
  reason: string;
}

const SKIP: MissionsSubscriberOutcome = {
  processed: false,
  humans: [],
  reason: 'unknown',
};

/**
 * Bus subscriber entry point. Wrapped in try/catch so a thrown error
 * in this handler doesn't kill the rest of the bus subscribers.
 */
export function subscribeMissionsProgress(deps: MissionsSubscriberDeps): void {
  deps.bus.subscribe(RACE_EVENT_RACE_COMPLETED, (payload) => {
    try {
      const event = payload as RaceCompletedEventFromRace;
      handleRaceCompletedForMissions(deps, event);
    } catch (e) {
      deps.logger.error(
        'missions subscriber failed: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
  });
}

/**
 * Apply a closed race to missions + achievements. Public so unit
 * tests can drive it with synthetic events.
 */
export function handleRaceCompletedForMissions(
  deps: MissionsSubscriberDeps,
  raceEvent: RaceCompletedEventFromRace,
): MissionsSubscriberOutcome {
  const { logger, nk } = deps;

  // 1. Build the bridge context — read the session for per-user
  //    loadout (classId / bodyId).
  const ctx = loadBridgeContext(nk, raceEvent.sessionId);
  if (ctx === null) {
    logger.warn(
      'missions subscriber dropped sid=%s — session storage row missing',
      raceEvent.sessionId,
    );
    return { ...SKIP, reason: 'session_missing' };
  }

  // 2. Bridge → Phase 6 event.
  const missionEvent = bridgeToMissionEvent(raceEvent, ctx);

  // 3. Stamp firstWinOfDay BEFORE evaluation so the counter sees the map.
  const firstWinMap = stampFirstWinOfDayForAll(nk, logger, missionEvent);
  if (Object.keys(firstWinMap).length > 0) {
    missionEvent.firstWinOfDayFor = firstWinMap;
  }

  // 4. Empty results → nothing to do (shouldn't happen, but defensive).
  const humans = extractHumanResults(missionEvent);
  if (humans.length === 0) {
    return { ...SKIP, reason: 'no_humans' };
  }

  // 5. Catalog + date keys (single load; reused across all humans).
  const dailyDefs = getMissionsDailyCatalog();
  const weeklyDefs = getMissionsWeeklyCatalog();
  const achievementDefs = getAchievementsCatalog();
  const dateUtc = utcDate(missionEvent.timestampMs);
  const weekUtc = utcWeek(missionEvent.timestampMs);

  const outcomes: MissionsSubscriberOutcome['humans'] = [];
  for (const r of humans) {
    const userId = r.userId;
    if (!r.finishedRace) continue;

    // 5f. Phase 6 Chunk 7 — grant pass XP for the race FIRST so even
    //     users who have no mission/achievement storage yet (brand-new
    //     players, never-opened-missions-tab players) still get pass XP
    //     for the race. Idempotent on (userId, mode, sessionId).
    const xpAmount = raceXPFor(missionEvent.mode);
    if (xpAmount > 0) {
      const source: PassXPSource = passXPSourceForRace(missionEvent.mode);
      const xpResult = addPassXp(
        nk, logger, userId, xpAmount,
        { source, id: missionEvent.sessionId },
      );
      if (xpResult !== null && xpResult.applied) {
        emit(nk, logger, 'pass_xp_gained', {
          userId,
          source,
          amount: xpAmount,
          sessionId: missionEvent.sessionId,
          newLevel: xpResult.newLevel,
          levelUps: xpResult.levelUps,
        });
      }
    }

    // 5a. Daily missions (created on the fly when missing).
    let dailyCompletedIds: string[] = [];
    const daily = updateDailyMissions(nk, logger, userId, dateUtc, [...dailyDefs], (row) => {
      const deltas = computeDeltas(missionEvent, userId, row, dailyDefs);
      if (deltas.size === 0) return null;
      const after = markCompletedIfReached(applyIncrementsToMissions(row.missions, dailyDefs, deltas), dailyDefs);
      dailyCompletedIds = newlyCompleted(row.missions, after);
      return { ...row, missions: after } satisfies DailyMissions;
    });
    const dailyWritten = daily !== null && daily !== false;
    if (!dailyWritten) dailyCompletedIds = [];

    // 5b. Weekly missions.
    let weeklyCompletedIds: string[] = [];
    const weekly = updateWeeklyMissions(nk, logger, userId, weekUtc, [...weeklyDefs], (row) => {
      const deltas = computeDeltas(missionEvent, userId, row, weeklyDefs);
      if (deltas.size === 0) return null;
      const after = markCompletedIfReached(applyIncrementsToMissions(row.missions, weeklyDefs, deltas), weeklyDefs);
      weeklyCompletedIds = newlyCompleted(row.missions, after);
      return { ...row, missions: after } satisfies WeeklyMissions;
    });
    const weeklyWritten = weekly !== null && weekly !== false;
    if (!weeklyWritten) weeklyCompletedIds = [];

    // 5c. Achievements: report only the ones this race completed.
    let achievementCompletedIds: string[] = [];
    const achv = updateAchievements(nk, logger, userId, (row) => {
      const deltas = computeAchievementDeltas(missionEvent, userId, row, achievementDefs);
      if (deltas.size === 0) return null;
      const next: AchievementsRecord = applyIncrementsToAchievements(row, achievementDefs, deltas);
      const before = new Set(newlyCompletedAchievements(row, achievementDefs));
      achievementCompletedIds = newlyCompletedAchievements(next, achievementDefs).filter((id) => !before.has(id));
      return next;
    });
    const achievementsWritten = achv !== null && achv !== false;
    if (!achievementsWritten) achievementCompletedIds = [];

    outcomes.push({
      userId,
      dailyWritten,
      weeklyWritten,
      achievementsWritten,
      dailyCompletedIds,
      weeklyCompletedIds,
      achievementCompletedIds,
    });

    // 5e. Emit per-completion analytics.
    if (dailyCompletedIds.length > 0) {
      emit(nk, logger, 'mission_completed', {
        userId, missionIds: dailyCompletedIds, kind: 'daily',
        sessionId: raceEvent.sessionId,
      });
    }
    if (weeklyCompletedIds.length > 0) {
      emit(nk, logger, 'mission_completed', {
        userId, missionIds: weeklyCompletedIds, kind: 'weekly',
        sessionId: raceEvent.sessionId,
      });
    }
    if (achievementCompletedIds.length > 0) {
      emit(nk, logger, 'achievement_unlocked', {
        userId, achievementIds: achievementCompletedIds,
        sessionId: raceEvent.sessionId,
      });
    }
  }

  logger.info(
    'missions subscriber applied sid=%s humans=%d daily=%d weekly=%d achv=%d',
    raceEvent.sessionId,
    outcomes.length,
    outcomes.filter((o) => o.dailyWritten).length,
    outcomes.filter((o) => o.weeklyWritten).length,
    outcomes.filter((o) => o.achievementsWritten).length,
  );

  return {
    processed: true,
    humans: outcomes,
    reason: 'ok',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeDeltas(
  event: import('./event').RaceCompletedEvent,
  userId: string,
  record: { missions: ReadonlyArray<import('./types').MissionInstance> },
  defs: ReadonlyArray<import('./types').MissionDefinition>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const inst of record.missions) {
    const def = defs.find((d) => d.id === inst.missionId);
    if (def === undefined) continue;
    const inc = evaluateIncrement(event, def, userId);
    if (inc > 0) out.set(inst.instanceId, (out.get(inst.instanceId) ?? 0) + inc);
  }
  return out;
}

function computeAchievementDeltas(
  event: import('./event').RaceCompletedEvent,
  userId: string,
  _record: AchievementsRecord,
  defs: ReadonlyArray<import('./types').AchievementDefinition>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const def of defs) {
    const inc = evaluateIncrement(event, def, userId);
    if (inc > 0) out.set(def.id, (out.get(def.id) ?? 0) + inc);
  }
  return out;
}

/**
 * Read the race session from storage and project a per-user loadout
 * map. Returns `null` when the session row is missing (the bus fired
 * for a session that was never persisted — should never happen, but
 * defensive).
 */
function loadBridgeContext(
  nk: INakama,
  sessionId: string,
): BridgeContext | null {
  const objs = nk.storageRead([
    { collection: 'race_sessions', key: sessionId, userId: SYSTEM_USER_ID },
  ]);
  const session = objs[0];
  if (session === undefined || session.value === undefined) return null;
  const v = session.value as {
    roster?: ReadonlyArray<{
      userId?: string;
      isBot?: boolean;
      loadout?: { classId?: string; bodyId?: string };
    }>;
    startedAt?: number | null;
  };
  const classes = new Map<string, import('./event').MissionCarClass>();
  const cars = new Map<string, string>();
  for (const entry of v.roster ?? []) {
    if (entry.isBot === true) continue;
    if (typeof entry.userId !== 'string' || entry.userId.length === 0) continue;
    const classId = entry.loadout?.classId;
    if (classId === 'D' || classId === 'C' || classId === 'B'
        || classId === 'A' || classId === 'S') {
      classes.set(entry.userId, classId);
    }
    if (typeof entry.loadout?.bodyId === 'string') {
      cars.set(entry.userId, entry.loadout.bodyId);
    }
  }
  return {
    classes,
    cars,
    startedAt: typeof v.startedAt === 'number' ? v.startedAt : 0,
  };
}