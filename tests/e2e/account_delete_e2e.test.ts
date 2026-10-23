// account_delete over the bundle (plan T-16, audit 06 f13): every
// collection of the registry ends with 0 objects of the user, the
// system rows keyed by them and the references other players hold are
// gone, and the user leaves every leaderboard.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest } from './_stubs';
import { COLLECTIONS } from '../../modules/src/core/collections';
import type { ILeaderboard, ILeaderboardRecord } from '../../modules/src/nkruntime';

const A = 'user-delete-e2e';
const B = 'user-friend-b';
const C = 'user-other-c';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface Summary {
  storageDeleted: number;
  collectionsAffected: string[];
  referencesRemoved: number;
  boardsDeleted: number;
  boardsAffected: string[];
  unlinkedAuths: string[];
  wasClubLeaderOf: string[];
  abandonedFromRaces: number;
}

function call<T>(env: ReturnType<typeof loadBundleForTest>, rpc: string, caller: string, payload: unknown): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  return JSON.parse(handler({ ...FakeContext, userId: caller }, env.logger, env.nak, JSON.stringify(payload))) as T;
}

function put(env: ReturnType<typeof loadBundleForTest>, collection: string, key: string, userId: string, value: Record<string, unknown>): void {
  env.fakeNakama.store.set(`${collection}/${key}/${userId}`, {
    collection, key, userId, value, version: `v-${collection}-${key}`,
    permissionRead: 0, permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
  });
}

function objectsOf(env: ReturnType<typeof loadBundleForTest>, collection: string, userId: string): number {
  return env.nak.storageList(userId, collection, 100, null).objects.length;
}

function seedBoard(env: ReturnType<typeof loadBundleForTest>, id: string, owners: string[]): void {
  env.fakeNakama.leaderboards.set(id, {
    id, authoritative: true, sortOrder: 'desc', operator: 'best', resetSchedule: '', metadata: {},
  } as unknown as ILeaderboard);
  env.fakeNakama.leaderboardRecords.set(id, new Map(owners.map((o, i) => [o, {
    leaderboardId: id, ownerId: o, username: o, score: 100 - i, subscore: 0, numScore: 1, metadata: {},
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiryTime: null, rank: i + 1, maxNumScore: 1,
  } as unknown as ILeaderboardRecord])));
}

describe('account_delete — full purge through the collection registry', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => { env = loadBundleForTest(); });

  it('confirmText !== DELETE → BAD_REQUEST, nothing deleted', () => {
    call<Resp<unknown>>(env, 'garage_get', A, {});
    const r = call<Resp<unknown>>(env, 'account_delete', A, { confirmText: 'delete' });
    expect(r.ok ? 'ok' : r.error.code).toBe('BAD_REQUEST');
    expect(objectsOf(env, 'garage', A)).toBe(1);
  });

  it('0 objects of the user in every registered collection, references removed, out of the boards', () => {
    // Data the user owns, created through the RPCs and seeded per collection.
    call<Resp<unknown>>(env, 'garage_get', A, {});
    call<Resp<unknown>>(env, 'profile_get', A, {});
    for (const spec of COLLECTIONS) put(env, spec.name, `owned-${spec.name}`, A, { schemaVersion: 1, userId: A });
    env.fakeNakama.linkIdentity(A, 'googleId', 'g-a');
    put(env, 'clubs_created', A, A, { schemaVersion: 1, userId: A, clubId: 'club-1', createdAt: 1 });

    // System rows keyed by the user.
    put(env, 'race_active', A, SYSTEM, { sessionId: 's1' });
    put(env, 'race_presence', `s1/${A}`, SYSTEM, { lastSeenMs: 1 });
    put(env, 'race_presence', `s1/${C}`, SYSTEM, { lastSeenMs: 1 });
    put(env, 'race_sessions', `last_closed/${A}`, SYSTEM, { sessionId: 's0' });
    put(env, 'anti_cheat_marks', A, SYSTEM, { marks: [] });
    put(env, 'chat_history', 'dm/m1', SYSTEM, { senderUserId: A, content: 'hi' });
    put(env, 'chat_history', 'dm/m2', SYSTEM, { senderUserId: B, content: 'hey' });
    put(env, 'tournament_leaderboard', 't1', SYSTEM, { schemaVersion: 1, entries: [{ userId: A }, { userId: C }] });
    put(env, 'account_link_conflict', 'tok', SYSTEM, { schemaVersion: 2, targetUserId: A });

    // What other players hold about the user.
    put(env, 'friends_edge', B, A, { userId: A, friendId: B });
    put(env, 'friends_edge', A, B, { userId: B, friendId: A });
    put(env, 'friends_edge', C, B, { userId: B, friendId: C });
    put(env, 'blocks', A, C, { ownerId: C, targetUserId: A });
    put(env, 'invites', 'inv-1', B, { fromUserId: A, targetUserId: B });
    put(env, 'recent_rivals', B, B, { schemaVersion: 1, userId: B, entries: [{ userId: A }, { userId: C }] });

    seedBoard(env, 'wins_week', [A, B]);
    seedBoard(env, 'lap_neon_blvd', [B]);

    const r = call<Resp<{ deletedAt: string; summary: Summary }>>(env, 'account_delete', A, { confirmText: 'DELETE' });
    if (!r.ok) throw new Error(`account_delete failed: ${JSON.stringify(r.error)}`);
    const s = r.data.summary;

    for (const spec of COLLECTIONS) expect(objectsOf(env, spec.name, A), spec.name).toBe(0);
    for (const key of ['race_active/' + A, `race_presence/s1/${A}`, `race_sessions/last_closed/${A}`, 'anti_cheat_marks/' + A, 'chat_history/dm/m1', 'account_link_conflict/tok']) {
      expect(env.fakeNakama.store.has(`${key}/${SYSTEM}`), key).toBe(false);
    }
    expect(env.fakeNakama.store.has(`race_presence/s1/${C}/${SYSTEM}`)).toBe(true);
    expect(env.fakeNakama.store.has(`chat_history/dm/m2/${SYSTEM}`)).toBe(true);
    expect((env.fakeNakama.store.get(`tournament_leaderboard/t1/${SYSTEM}`)?.value as { entries: unknown[] }).entries)
      .toEqual([{ userId: C }]);

    expect(env.fakeNakama.store.has(`friends_edge/${A}/${B}`)).toBe(false);
    expect(env.fakeNakama.store.has(`friends_edge/${C}/${B}`)).toBe(true);
    expect(env.fakeNakama.store.has(`blocks/${A}/${C}`)).toBe(false);
    expect(env.fakeNakama.store.has(`invites/inv-1/${B}`)).toBe(false);
    expect((env.fakeNakama.store.get(`recent_rivals/${B}/${B}`)?.value as { entries: unknown[] }).entries)
      .toEqual([{ userId: C }]);

    expect(env.fakeNakama.leaderboardRecords.get('wins_week')?.has(A)).toBe(false);
    expect(env.fakeNakama.leaderboardRecords.get('wins_week')?.has(B)).toBe(true);
    expect(s.boardsAffected).toEqual(['wins_week']);
    expect(s.boardsDeleted).toBe(1);

    expect(s.storageDeleted).toBeGreaterThanOrEqual(COLLECTIONS.length + 5);
    expect(s.referencesRemoved).toBeGreaterThanOrEqual(6);
    expect(s.unlinkedAuths).toEqual(['google']);
    expect(s.wasClubLeaderOf).toEqual(['club-1']);
    expect(env.fakeNakama.deletedAccounts.has(A)).toBe(true);
    expect(env.fakeNakama.findIdentityOwner('googleId', 'g-a')).toBeNull();
  });
});
