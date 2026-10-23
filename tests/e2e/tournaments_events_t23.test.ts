// Plan T-23 — tournaments and events (Soc-5, Soc-7, Soc-10; audit 07 f9-f11).
//
//   - tournament_join charges and writes the entry in one transaction:
//     without funds there is no entry;
//   - tournament_get returns the real top times (with usernames) and the
//     caller's rank;
//   - events have one source: event_list and the liveops calendar both
//     come from events.json.

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import { PROFILES_COLLECTION, type ProfileRecord } from '../../modules/src/profiles/storage';
import type { Tournament } from '../../modules/src/tournaments/types';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

const P1 = 'user-p1';
const P2 = 'user-p2';
const TID = 'tt_t23_test';

function call<T>(env: LoadedBundle, rpc: string, caller: string, payload: unknown): Resp<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  return JSON.parse(handler({ ...FakeContext, userId: caller }, env.logger, env.nak, JSON.stringify(payload))) as Resp<T>;
}

function seedProfile(env: LoadedBundle, userId: string, level: number): void {
  const p: ProfileRecord = {
    schemaVersion: 1, userId, displayName: userId, avatarUrl: null, createdAt: 1, updatedAt: 1,
    progression: { xp: 0, level, lastDailyWinAt: 0 },
  };
  env.fakeNakama.store.set(`${PROFILES_COLLECTION}/${userId}/${userId}`, {
    collection: PROFILES_COLLECTION, key: userId, userId, value: p as unknown as Record<string, unknown>,
    version: 'v1', permissionRead: 0, permissionWrite: 0,
    createTime: new Date(0).toISOString(), updateTime: new Date(0).toISOString(), expiresAt: null,
  });
}

function seedTournament(env: LoadedBundle, entryFee: number): void {
  const now = Date.now();
  const t: Tournament = {
    schemaVersion: 1, id: TID, templateId: TID, kind: 'time_trial', trackId: 'neon_blvd',
    startsAt: now - 3_600_000, endsAt: now + 86_400_000, entryFee, maxAttempts: 3, minLevel: 1,
    prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 1000 } }], createdAt: now - 3_600_000,
  };
  env.fakeNakama.store.set(`tournament_instances/${TID}/${SYSTEM_USER_ID}`, {
    collection: 'tournament_instances', key: TID, userId: SYSTEM_USER_ID,
    value: t as unknown as Record<string, unknown>, version: 'v1', permissionRead: 1, permissionWrite: 0,
    createTime: new Date(0).toISOString(), updateTime: new Date(0).toISOString(), expiresAt: null,
  });
}

function hasEntry(env: LoadedBundle, userId: string): boolean {
  return env.fakeNakama.store.has(`tournament_entries/${TID}/${userId}`);
}

describe('tournaments and events (plan T-23)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
    seedProfile(env, P1, 20);
    seedProfile(env, P2, 20);
  });

  it('tournament_join without funds → INSUFFICIENT_FUNDS and no entry', () => {
    seedTournament(env, 500);
    env.fakeNakama.wallets.set(P1, { coins: 100, gems: 0 });
    const r = call<unknown>(env, 'tournament_join', P1, { tournamentId: TID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(hasEntry(env, P1)).toBe(false);
    expect(env.fakeNakama.wallets.get(P1)?.coins).toBe(100);
  });

  it('tournament_join with funds writes the entry and charges once', () => {
    seedTournament(env, 500);
    env.fakeNakama.wallets.set(P1, { coins: 1000, gems: 0 });
    const r = call<{ paidEntryFee: number; newBalance: { coins: number } }>(env, 'tournament_join', P1, { tournamentId: TID });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.newBalance.coins).toBe(500);
    expect(hasEntry(env, P1)).toBe(true);
    const again = call<unknown>(env, 'tournament_join', P1, { tournamentId: TID });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('CONFLICT');
    expect(env.fakeNakama.wallets.get(P1)?.coins).toBe(500);
  });

  it('a lost entry write charges nothing (one transaction)', () => {
    seedTournament(env, 500);
    env.fakeNakama.wallets.set(P1, { coins: 1000, gems: 0 });
    // A concurrent join wrote the entry after this RPC read "not joined":
    // plant the row and hide it from the RPC's reads, so only the
    // create-only write inside the wallet transaction can notice.
    env.fakeNakama.store.set(`tournament_entries/${TID}/${P1}`, {
      collection: 'tournament_entries', key: TID, userId: P1,
      value: { schemaVersion: 1, tournamentId: TID, userId: P1, attemptsRemaining: 3, bestTimeMs: null, checkpoints: [], createdAt: 1, updatedAt: 1, paidEntryFee: 500 },
      version: 'v1', permissionRead: 1, permissionWrite: 0,
      createTime: new Date(0).toISOString(), updateTime: new Date(0).toISOString(), expiresAt: null,
    });
    const nk = env.nak as unknown as { storageRead: (keys: Array<{ collection: string }>) => unknown[] };
    const read = nk.storageRead.bind(nk);
    nk.storageRead = (keys) => (keys.some((k) => k.collection === 'tournament_entries') ? [] : read(keys));
    const r = call<unknown>(env, 'tournament_join', P1, { tournamentId: TID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONFLICT');
    expect(env.fakeNakama.wallets.get(P1)?.coins).toBe(1000);
  });

  it('tournament_get returns the top times with usernames and my rank', () => {
    seedTournament(env, 0);
    env.fakeNakama.users.set(P2, {
      userId: P2, username: 'speedy', createTime: '', updateTime: '', disableTime: null, metadata: {},
    } as never);
    env.fakeNakama.store.set(`tournament_leaderboard/${TID}/${SYSTEM_USER_ID}`, {
      collection: 'tournament_leaderboard', key: TID, userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, tournamentId: TID, updatedAt: 1,
        entries: [
          { userId: P1, bestTimeMs: 61_000, recordedAt: 1 },
          { userId: P2, bestTimeMs: 59_000, recordedAt: 2 },
        ],
      },
      version: 'v1', permissionRead: 1, permissionWrite: 0,
      createTime: new Date(0).toISOString(), updateTime: new Date(0).toISOString(), expiresAt: null,
    });
    const r = call<{ topTimes: Array<{ userId: string; bestTimeMs: number; position: number; username: string }>; myRank: number | null }>(
      env, 'tournament_get', P1, { tournamentId: TID },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.topTimes).toEqual([
      { userId: P2, bestTimeMs: 59_000, position: 1, username: 'speedy' },
      { userId: P1, bestTimeMs: 61_000, position: 2, username: `name-${P1}` },
    ]);
    expect(r.data.myRank).toBe(2);
  });

  it('event_list is not empty and the liveops calendar comes from events.json', () => {
    const events = call<{ events: Array<{ id: string; endsAtUtc: string }> }>(env, 'event_list', P1, {});
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.data.events.length).toBeGreaterThan(0);

    const cfg = call<{ calendar: Array<{ id: string; type: string; endUtc: string; kind?: string }> }>(env, 'liveops_config_get', P1, {});
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) return;
    const notEnded = events.data.events.filter((e) => Date.parse(e.endsAtUtc) >= Date.now()).map((e) => e.id).sort();
    expect(cfg.data.calendar.filter((c) => c.type === 'event').map((c) => c.id).sort()).toEqual(notEnded);
    for (const c of cfg.data.calendar) {
      if (c.type === 'event') expect(typeof c.kind).toBe('string');
    }
  });
});
