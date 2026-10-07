// Phase 6 Chunk 7 — race XP idempotency via the subscriber.
//
// Drives the SAME RaceCompletedEvent through the subscriber twice.
// Pass XP should only be granted once (the second call hits the
// `pass_xp_ledger` dedupe row).

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
  PASS_XP_LEDGER_COLLECTION,
  passRecordKey,
  passXpLedgerKey,
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

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as unknown as ILogger;

const USER = 'race-xp-idempo-user';
const OTHER = 'race-xp-idempo-other';

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

function fireRace(env: LoadedBundle, bus: EventBus, logger: ILogger, event: RaceCompletedEvent): void {
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

function getLedgerRow(env: LoadedBundle, userId: string, source: string, id: string) {
  return env.fakeNakama.store.get(
    `${PASS_XP_LEDGER_COLLECTION}/${passXpLedgerKey(userId, source, id)}/${userId}`,
  );
}

describe('race XP idempotency (Phase 6 Chunk 7)', () => {
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
    ensurePassRecord(env.nak, env.logger, USER);
    ensurePassRecord(env.nak, env.logger, OTHER);
  });

  it('same race sessionId fired twice → XP applied once', () => {
    const ts = Date.now();
    seedSession(env, 'sA', 'quick', [{ userId: USER }, { userId: OTHER }], ts);
    const event: RaceCompletedEvent = {
      schemaVersion: 1, sessionId: 'sA', mode: 'quick',
      trackId: 't', size: 2,
      results: [
        { rank: 1, userId: USER, isBot: false, totalMs: 60_000, abandoned: false },
        { rank: 2, userId: OTHER, isBot: false, totalMs: 61_000, abandoned: false },
      ],
      flags: { needsReview: false }, closedAt: ts,
    };
    fireRace(env, bus, env.logger, event);
    const xpAfterFirst = getPassXp(env, USER);
    expect(xpAfterFirst).toBe(20);
    // Second invocation with the SAME sessionId → idempotent.
    fireRace(env, bus, env.logger, event);
    expect(getPassXp(env, USER)).toBe(xpAfterFirst);
    // Ledger row exists.
    expect(getLedgerRow(env, USER, 'race_quick', 'sA')).toBeDefined();
  });

  it('different sessionIds grant XP twice (no dedupe across them)', () => {
    const ts = Date.now();
    seedSession(env, 'sB', 'ranked', [{ userId: USER }, { userId: OTHER }], ts);
    fireRace(env, bus, env.logger, {
      schemaVersion: 1, sessionId: 'sB', mode: 'ranked',
      trackId: 't', size: 2,
      results: [
        { rank: 1, userId: USER, isBot: false, totalMs: 60_000, abandoned: false },
        { rank: 2, userId: OTHER, isBot: false, totalMs: 61_000, abandoned: false },
      ],
      flags: { needsReview: false }, closedAt: ts,
    });
    const afterFirst = getPassXp(env, USER);
    expect(afterFirst).toBe(25);

    seedSession(env, 'sC', 'ranked', [{ userId: USER }, { userId: OTHER }], ts + 1000);
    fireRace(env, bus, env.logger, {
      schemaVersion: 1, sessionId: 'sC', mode: 'ranked',
      trackId: 't', size: 2,
      results: [
        { rank: 1, userId: USER, isBot: false, totalMs: 60_000, abandoned: false },
        { rank: 2, userId: OTHER, isBot: false, totalMs: 61_000, abandoned: false },
      ],
      flags: { needsReview: false }, closedAt: ts + 1000,
    });
    expect(getPassXp(env, USER)).toBe(afterFirst + 25);
  });

  it('cross-user: each user gets their own XP, idempotent per user', () => {
    const ts = Date.now();
    seedSession(env, 'sD', 'quick', [{ userId: USER }, { userId: OTHER }], ts);
    const event: RaceCompletedEvent = {
      schemaVersion: 1, sessionId: 'sD', mode: 'quick',
      trackId: 't', size: 2,
      results: [
        { rank: 1, userId: USER, isBot: false, totalMs: 60_000, abandoned: false },
        { rank: 2, userId: OTHER, isBot: false, totalMs: 61_000, abandoned: false },
      ],
      flags: { needsReview: false }, closedAt: ts,
    };
    fireRace(env, bus, env.logger, event);
    expect(getPassXp(env, USER)).toBe(20);
    expect(getPassXp(env, OTHER)).toBe(20);
    // Replay → both still 20.
    fireRace(env, bus, env.logger, event);
    expect(getPassXp(env, USER)).toBe(20);
    expect(getPassXp(env, OTHER)).toBe(20);
  });
});