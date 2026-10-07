// Phase 6 Chunk 7 — race XP grant via the subscriber.
//
// Drives `handleRaceCompletedForMissions` directly with synthetic
// RaceCompletedEvents (one human winner per race) and asserts:
//   - PassRecord gets the correct XP delta per mode (D7 multipliers)
//   - Multiple races accumulate
//   - Abandoned players get 0 XP

import { describe, it, expect, beforeEach } from 'vitest';
import { loadBundleForTest } from './_stubs';
import type { LoadedBundle } from './_stubs';
import { EventBus } from '../../modules/src/core/event_bus';
import { handleRaceCompletedForMissions } from '../../modules/src/missions/subscriber';
import type { RaceCompletedEvent } from '../../modules/src/race/types';
import {
  loadPassCatalog,
  _resetPassCatalogForTests,
  type RawPassFile,
} from '../../modules/src/pass/catalog';
import {
  ensurePassRecord,
  PASS_COLLECTION,
  passRecordKey,
} from '../../modules/src/pass/pass_repo';
import {
  loadMissionsDailyCatalog,
  loadMissionsWeeklyCatalog,
  loadAchievementsCatalog,
  _resetMissionsCatalogsForTests,
} from '../../modules/src/missions/catalog';
import missionsDailyRaw from '../../modules/src/catalogs/missions_daily.json';
import missionsWeeklyRaw from '../../modules/src/catalogs/missions_weekly.json';
import achievementsRaw from '../../modules/src/catalogs/achievements.json';
import type { ILogger } from '../../modules/src/nkruntime';
import {
  RACE_XP_BASE,
  raceXPFor,
} from '../../modules/src/pass/xp_engine';

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as unknown as ILogger;

const USER = 'race-xp-grant-user';

/** Build a synthetic 40-level pass catalog with 100 XP per level. */
function buildPassRaw(): RawPassFile {
  const out: RawPassFile = {
    version: 1,
    seasonId: 'e2e-s1',
    startUtc: '2026-01-01T00:00:00Z',
    endUtc: '2027-12-31T00:00:00Z',
    maxLevel: 40,
    premiumPriceGems: 800,
    levels: [],
  };
  for (let i = 1; i <= 40; i += 1) {
    out.levels.push({
      level: i,
      xpRequired: i === 1 ? 0 : (i - 1) * 100,
      freeReward: { coins: 100 },
      premiumReward: { coins: 200 },
    });
  }
  return out;
}

function seedSession(
  env: LoadedBundle,
  sessionId: string,
  mode: RaceCompletedEvent['mode'],
  roster: Array<{ userId: string; classId?: string; isBot?: boolean }>,
  closedAt: number,
): void {
  env.fakeNakama.store.set(`race_sessions/${sessionId}/00000000-0000-0000-0000-000000000000`, {
    collection: 'race_sessions',
    key: sessionId,
    userId: '00000000-0000-0000-0000-000000000000',
    value: {
      id: sessionId,
      mode,
      trackId: 'stadium_today',
      size: roster.length as 2 | 4 | 6,
      roster: roster.map((r) => ({
        userId: r.userId,
        loadout: { classId: r.classId ?? 'C', bodyId: `body-${r.userId}` },
        isBot: r.isBot === true,
      })),
      host: roster[0]!.userId,
      hostSuccession: [roster[0]!.userId],
      state: 'closed',
      startedAt: closedAt - 60_000,
      version: 1,
    },
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(closedAt).toISOString(),
    expiresAt: null,
  });
}

function fireRace(
  env: LoadedBundle,
  bus: EventBus,
  logger: ILogger,
  event: RaceCompletedEvent,
): void {
  handleRaceCompletedForMissions(
    { logger, nk: env.nak, bus },
    event,
  );
}

function getPassXp(env: LoadedBundle, userId: string): number {
  const obj = env.fakeNakama.store.get(`${PASS_COLLECTION}/${passRecordKey(userId)}/${userId}`);
  if (!obj) return 0;
  return (obj.value as { xp: number }).xp;
}

describe('race XP grant via subscriber (Phase 6 Chunk 7)', () => {
  let env: LoadedBundle;
  let bus: EventBus;

  beforeEach(() => {
    env = loadBundleForTest();
    bus = new EventBus(env.logger);
    _resetMissionsCatalogsForTests();
    loadMissionsDailyCatalog(env.logger, missionsDailyRaw as never);
    loadMissionsWeeklyCatalog(env.logger, missionsWeeklyRaw as never);
    loadAchievementsCatalog(env.logger, achievementsRaw as never);
    _resetPassCatalogForTests();
    loadPassCatalog(silentLogger, buildPassRaw());
    // Lazy-create a pass row so the subscriber writes XP into it.
    ensurePassRecord(env.nak, env.logger, USER);
  });

  it('quick race → +20 XP', () => {
    const ts = Date.now();
    seedSession(env, 's-quick', 'quick', [{ userId: USER, rank: 1 }], ts);
    fireRace(env, bus, env.logger, {
      schemaVersion: 1, sessionId: 's-quick', mode: 'quick',
      trackId: 't', size: 2,
      results: [{ rank: 1, userId: USER, isBot: false, totalMs: 60_000, abandoned: false }],
      flags: { needsReview: false }, closedAt: ts,
    });
    expect(getPassXp(env, USER)).toBe(raceXPFor('quick'));
    expect(getPassXp(env, USER)).toBe(RACE_XP_BASE);
  });

  it('ranked race → +25 XP (floor(20 × 1.25))', () => {
    const ts = Date.now();
    seedSession(env, 's-ranked', 'ranked', [{ userId: USER, rank: 1 }], ts);
    fireRace(env, bus, env.logger, {
      schemaVersion: 1, sessionId: 's-ranked', mode: 'ranked',
      trackId: 't', size: 2,
      results: [{ rank: 1, userId: USER, isBot: false, totalMs: 60_000, abandoned: false }],
      flags: { needsReview: false }, closedAt: ts,
    });
    expect(getPassXp(env, USER)).toBe(raceXPFor('ranked'));
    expect(getPassXp(env, USER)).toBe(25);
  });

  it('private race → +5 XP', () => {
    const ts = Date.now();
    seedSession(env, 's-private', 'private', [{ userId: USER, rank: 1 }], ts);
    fireRace(env, bus, env.logger, {
      schemaVersion: 1, sessionId: 's-private', mode: 'private',
      trackId: 't', size: 2,
      results: [{ rank: 1, userId: USER, isBot: false, totalMs: 60_000, abandoned: false }],
      flags: { needsReview: false }, closedAt: ts,
    });
    expect(getPassXp(env, USER)).toBe(5);
  });

  it('time_trial race → +10 XP', () => {
    const ts = Date.now();
    seedSession(env, 's-tt', 'time_trial', [{ userId: USER, rank: 1 }], ts);
    fireRace(env, bus, env.logger, {
      schemaVersion: 1, sessionId: 's-tt', mode: 'time_trial',
      trackId: 't', size: 2,
      results: [{ rank: 1, userId: USER, isBot: false, totalMs: 60_000, abandoned: false }],
      flags: { needsReview: false }, closedAt: ts,
    });
    expect(getPassXp(env, USER)).toBe(10);
  });

  it('multiple races in different sessions accumulate', () => {
    const ts0 = Date.now();
    seedSession(env, 's-q', 'quick', [{ userId: USER, rank: 1 }], ts0);
    fireRace(env, bus, env.logger, {
      schemaVersion: 1, sessionId: 's-q', mode: 'quick',
      trackId: 't', size: 2,
      results: [{ rank: 1, userId: USER, isBot: false, totalMs: 60_000, abandoned: false }],
      flags: { needsReview: false }, closedAt: ts0,
    });

    const ts1 = ts0 + 1000;
    seedSession(env, 's-r', 'ranked', [{ userId: USER, rank: 1 }], ts1);
    fireRace(env, bus, env.logger, {
      schemaVersion: 1, sessionId: 's-r', mode: 'ranked',
      trackId: 't', size: 2,
      results: [{ rank: 1, userId: USER, isBot: false, totalMs: 60_000, abandoned: false }],
      flags: { needsReview: false }, closedAt: ts1,
    });

    expect(getPassXp(env, USER)).toBe(20 + 25);
  });

  it('abandoned player gets 0 XP', () => {
    const ts = Date.now();
    seedSession(env, 's-ab', 'quick', [{ userId: USER }], ts);
    fireRace(env, bus, env.logger, {
      schemaVersion: 1, sessionId: 's-ab', mode: 'quick',
      trackId: 't', size: 2,
      results: [{ rank: 0, userId: USER, isBot: false, totalMs: 0, abandoned: true }],
      flags: { needsReview: false }, closedAt: ts,
    });
    expect(getPassXp(env, USER)).toBe(0);
  });
});