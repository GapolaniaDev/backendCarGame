// Plan T-20 (HT Prog-4, 7, 8, 9, 10): missions under concurrency.
//   - the race subscriber re-applies its progress to the record it just
//     read: a claim made between its read and its write survives (before,
//     the retry wrote the stale record and the mission could be claimed
//     again);
//   - mission_claim pays once under concurrency and a failed payout leaves
//     the mission claimable;
//   - a race finished before the first missions_get counts;
//   - mission_reroll without gems changes nothing; each paid reroll has
//     its own wallet key.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, SYSTEM_USER_ID, loadBundleForTest } from './_stubs';
import type { LoadedBundle } from './_stubs';
import { EventBus } from '../../modules/src/core/event_bus';
import {
  loadMissionsDailyCatalog,
  loadMissionsWeeklyCatalog,
  loadAchievementsCatalog,
  _resetMissionsCatalogsForTests,
  getMissionsDailyCatalog,
} from '../../modules/src/missions/catalog';
import missionsDailyRaw from '../../modules/src/catalogs/missions_daily.json';
import missionsWeeklyRaw from '../../modules/src/catalogs/missions_weekly.json';
import achievementsRaw from '../../modules/src/catalogs/achievements.json';
import { handleRaceCompletedForMissions } from '../../modules/src/missions/subscriber';
import { newDailyRecord } from '../../modules/src/missions/missions_repo';
import { dailyMissionsKey } from '../../modules/src/missions/counter_repo';
import { utcDate } from '../../modules/src/core/time';
import type { DailyMissions, MissionInstance } from '../../modules/src/missions/types';
import type { RaceCompletedEvent } from '../../modules/src/race/types';

type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
type AnyFn = (...args: unknown[]) => unknown;

const USER = 'mission-t20-user';

function call<T>(env: LoadedBundle, rpc: string, caller: string, payload: Record<string, unknown>): Resp<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  return JSON.parse(handler({ ...FakeContext, userId: caller }, env.logger, env.nak, JSON.stringify(payload))) as Resp<T>;
}

function wrap(env: LoadedBundle, name: string, make: (original: AnyFn) => AnyFn): () => void {
  const target = env.nak as unknown as Record<string, AnyFn>;
  const original = target[name] as AnyFn;
  target[name] = make(original.bind(env.nak));
  return () => { target[name] = original; };
}

function inst(missionId: string, date: string, progress: number, completed: boolean): MissionInstance {
  return { instanceId: `daily:${missionId}@${date}`, missionId, progress, completed, claimed: false };
}

function seedDaily(env: LoadedBundle, userId: string, missions: MissionInstance[]): void {
  const date = utcDate(Date.now());
  const rec: DailyMissions = { schemaVersion: 1, userId, dateUtc: date, assignedAt: 0, rerollsLeftToday: 1, missions };
  env.nak.storageWrite([{
    collection: 'missions_daily', key: dailyMissionsKey(userId, date), userId,
    value: rec, permissionRead: 1, permissionWrite: 0,
  }]);
}

function daily(env: LoadedBundle, userId: string): DailyMissions | undefined {
  return env.fakeNakama.store.get(`missions_daily/${dailyMissionsKey(userId, utcDate(Date.now()))}/${userId}`)?.value as DailyMissions | undefined;
}

function coins(env: LoadedBundle, userId: string): number {
  return env.fakeNakama.wallets.get(userId)?.['coins'] ?? 0;
}

/** A quick 1-player race closed now, through the source subscriber. */
function fireRace(env: LoadedBundle, bus: EventBus, sessionId: string, userId: string): void {
  const ts = Date.now();
  env.fakeNakama.store.set(`race_sessions/${sessionId}/${SYSTEM_USER_ID}`, {
    collection: 'race_sessions', key: sessionId, userId: SYSTEM_USER_ID,
    value: {
      id: sessionId, mode: 'quick', trackId: 'stadium_today', size: 2,
      roster: [{ userId, loadout: { classId: 'C', bodyId: 'body' }, isBot: false }],
      host: userId, hostSuccession: [userId], state: 'closed', startedAt: ts - 60_000, version: 1,
    },
    version: 'v-race', permissionRead: 0, permissionWrite: 0,
    createTime: new Date(0).toISOString(), updateTime: new Date(ts).toISOString(), expiresAt: null,
  });
  const event = {
    sessionId, mode: 'quick', trackId: 'stadium_today', size: 2,
    results: [{ rank: 1, userId, isBot: false, totalMs: 60_000, abandoned: false }],
    flags: { needsReview: false },
    closedAt: ts,
  } as unknown as RaceCompletedEvent;
  handleRaceCompletedForMissions({ logger: env.logger, nk: env.nak, bus }, event);
}

describe('T-20 missions', () => {
  let env: LoadedBundle;
  let bus: EventBus;
  let date: string;

  beforeEach(() => {
    env = loadBundleForTest();
    bus = new EventBus(env.logger);
    _resetMissionsCatalogsForTests();
    loadMissionsDailyCatalog(env.logger, missionsDailyRaw as never);
    loadMissionsWeeklyCatalog(env.logger, missionsWeeklyRaw as never);
    loadAchievementsCatalog(env.logger, achievementsRaw as never);
    date = utcDate(Date.now());
  });

  it('a claim made while the subscriber writes is not undone (no lost update, Prog-4)', () => {
    seedDaily(env, USER, [
      inst('daily_race_5', date, 5, true), // claimable (100 coins)
      inst('daily_race_quick_5', date, 0, false), // the race advances this one
    ]);
    let claimedMidWrite = false;
    wrap(env, 'storageWrite', (original) => (...args: unknown[]) => {
      const objs = (args[0] as Array<{ collection: string }>) ?? [];
      if (!claimedMidWrite && objs.some((o) => o.collection === 'missions_daily')) {
        claimedMidWrite = true;
        expect(call(env, 'mission_claim', USER, { missionId: 'daily_race_5', kind: 'daily' }).ok).toBe(true);
      }
      return original(...args);
    });
    fireRace(env, bus, 'race-lu', USER);

    expect(claimedMidWrite).toBe(true);
    const rec = daily(env, USER);
    expect(rec?.missions.find((m) => m.missionId === 'daily_race_5')?.claimed).toBe(true);
    expect(rec?.missions.find((m) => m.missionId === 'daily_race_quick_5')?.progress).toBe(1);
    const again = call(env, 'mission_claim', USER, { missionId: 'daily_race_5', kind: 'daily' });
    expect(!again.ok && again.error.code).toBe('CONFLICT');
    expect(coins(env, USER)).toBe(100);
  });

  it('two racing mission_claim pay once (Prog-7)', () => {
    seedDaily(env, USER, [inst('daily_race_5', date, 5, true)]);
    const answers: Array<Resp<unknown>> = [];
    let raced = false;
    wrap(env, 'multiUpdate', (original) => (...args: unknown[]) => {
      if (!raced) {
        raced = true;
        answers.push(call(env, 'mission_claim', USER, { missionId: 'daily_race_5', kind: 'daily' }));
      }
      return original(...args);
    });
    answers.push(call(env, 'mission_claim', USER, { missionId: 'daily_race_5', kind: 'daily' }));
    expect(answers.map((a) => (a.ok ? 'ok' : a.error.code)).sort()).toEqual(['CONFLICT', 'ok']);
    expect(coins(env, USER)).toBe(100);
    expect(env.fakeNakama.ledger.get(USER) ?? []).toHaveLength(1);
    const key = (env.fakeNakama.ledger.get(USER)?.[0]?.['metadata'] as { idempotencyKey?: string })?.idempotencyKey;
    expect(key).toBe(`mission:daily:${date}:daily_race_5:${USER}`); // the period is in the key (Prog-9)
  });

  it('a failed payout leaves the mission claimable (Prog-7)', () => {
    seedDaily(env, USER, [inst('daily_race_5', date, 5, true)]);
    const restore = wrap(env, 'multiUpdate', () => () => {
      throw new Error('error running multi update: database unavailable');
    });
    expect(call(env, 'mission_claim', USER, { missionId: 'daily_race_5', kind: 'daily' }).ok).toBe(false);
    expect(daily(env, USER)?.missions[0]?.claimed).toBe(false);
    restore();
    expect(call(env, 'mission_claim', USER, { missionId: 'daily_race_5', kind: 'daily' }).ok).toBe(true);
    expect(coins(env, USER)).toBe(100);
  });

  it('a race before the first missions_get counts (Prog-10)', () => {
    // A user whose deterministic assignment has a mission any quick win advances.
    const advanced = new Set(['daily_race_5', 'daily_race_quick_5', 'daily_top_1', 'daily_position_3', 'daily_race_class_c']);
    let uid = '';
    for (let i = 0; i < 200 && uid === ''; i++) {
      const candidate = `fresh-${i}`;
      const rec = newDailyRecord(env.nak, candidate, date, [...getMissionsDailyCatalog()]);
      if (rec.missions.some((m) => advanced.has(m.missionId))) uid = candidate;
    }
    expect(uid).not.toBe('');
    expect(daily(env, uid)).toBeUndefined();

    fireRace(env, bus, 'race-early', uid);
    const created = daily(env, uid);
    expect(created).toBeDefined();
    const total = created!.missions.reduce((n, m) => n + m.progress, 0);
    expect(total).toBeGreaterThan(0);

    const got = call<{ daily: { missions: Array<{ missionId: string; progress: number }> } }>(env, 'missions_get', uid, {});
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data.daily.missions.reduce((n, m) => n + m.progress, 0)).toBe(total);
  });

  it('mission_reroll without gems changes nothing (Prog-8)', () => {
    seedDaily(env, USER, [inst('daily_race_5', date, 0, false), inst('daily_race_quick_5', date, 0, false)]);
    env.fakeNakama.wallets.set(USER, { coins: 0, gems: 0 });
    const before = JSON.stringify(daily(env, USER));
    const r = call(env, 'mission_reroll', USER, { missionId: 'daily_race_5', useGems: true });
    expect(!r.ok && r.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(JSON.stringify(daily(env, USER))).toBe(before);
  });

  it('every paid reroll is charged, even when a mission id comes back', () => {
    seedDaily(env, USER, [inst('daily_race_5', date, 0, false)]);
    env.fakeNakama.wallets.set(USER, { coins: 0, gems: 1000 });
    let current = 'daily_race_5';
    for (let i = 0; i < 3; i++) {
      const r = call<{ newMission: { id: string } }>(env, 'mission_reroll', USER, { missionId: current, useGems: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      current = r.data.newMission.id;
    }
    expect(env.fakeNakama.wallets.get(USER)?.['gems']).toBe(1000 - 3 * 50);
    expect(daily(env, USER)?.rerollCount).toBe(3);
  });
});
