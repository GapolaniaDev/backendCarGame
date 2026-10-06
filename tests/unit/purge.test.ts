// Phase 5 Chunk 5 unit tests for purge + account delete helpers.
//
// Covers the 10 spec cases:
//   1. purgeUserStorage happy — deletes all collections of the userId
//   2. purgeUserStorage pagination — user with 250 entries → 3 batches of 100
//   3. purgeUserStorage user with no storage → no-op, returns 0
//   4. unlinkAllCustomAuths with 2 linked auths → both unlinked
//   5. unlinkAllCustomAuths with no auths → no-op
//   6. account_delete flow happy — pre-checks pass, full purge
//   7. account_delete with confirmText !== 'DELETE' → BAD_REQUEST
//   8. account_delete skips 'abandons'/'pc-account' (derived caches)
//   9. account_delete abandons active race_sessions
//   10. account_delete removes the user from leaderboards

import { describe, it, expect } from 'vitest';
import { FakeNakama, FakeLogger } from '../e2e/_stubs';
import { purgeUserStorage } from '../../modules/src/account/purge';
import { unlinkAllCustomAuths } from '../../modules/src/account/linking';
import { account_delete_impl } from '../../modules/src/account/rpcs';
import { linkAccount } from '../../modules/src/account/linking';
import { mintTestToken } from '../e2e/_test_tokens';
import { FakeContext } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';

const USER = 'user-purge';
const OTHER = 'user-other';

function makeEnv(): {
  nakama: FakeNakama['nakama'];
  logger: FakeLogger;
  fakeNakama: FakeNakama;
} {
  const fakeNakama = new FakeNakama();
  return { nakama: fakeNakama.nakama, logger: new FakeLogger(), fakeNakama };
}

function writeGarage(env: { fakeNakama: FakeNakama }, userId: string, carId: string): void {
  env.fakeNakama.store.set(`garage/${userId}/${userId}`, {
    collection: 'garage',
    key: userId,
    userId,
    value: { userId, cars: [{ carId }] },
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z',
    updateTime: '2026-01-01T00:00:00',
    expiresAt: null,
  });
}

describe('purge (Phase 5 Chunk 5) — purgeUserStorage', () => {
  it('1. happy — deletes all collections of the userId', () => {
    const env = makeEnv();
    writeGarage(env, USER, 'starter_viper');
    env.fakeNakama.store.set(`profiles/${USER}/${USER}`, {
      collection: 'profiles', key: USER, userId: USER,
      value: { userId: USER, displayName: 'A' },
      version: 'v00000001', permissionRead: 0, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    });
    // A row that belongs to someone else — must NOT be touched.
    writeGarage(env, OTHER, 'starter_viper');

    const result = purgeUserStorage(env.nakama, USER);
    expect(result.storageDeleted).toBeGreaterThanOrEqual(2);
    expect(result.collectionsAffected).toContain('garage');
    expect(result.collectionsAffected).toContain('profiles');
    // Other user untouched.
    const other = env.fakeNakama.store.get(`garage/${OTHER}/${OTHER}`);
    expect(other).toBeDefined();
  });

  it('2. pagination — 250 entries across one collection → 3 pages', () => {
    const env = makeEnv();
    // Storage map key is `${collection}/${key}/${userId}` — with userId
    // constant, multiple keys means multiple objects in the same collection.
    for (let i = 0; i < 250; i++) {
      env.fakeNakama.store.set(`profiles/${USER}/slot-${i}`, {
        collection: 'profiles', key: `slot-${i}`, userId: USER,
        value: { userId: USER, slot: i },
        version: 'v00000001', permissionRead: 0, permissionWrite: 0,
        createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
      });
    }
    const result = purgeUserStorage(env.nakama, USER);
    expect(result.storageDeleted).toBe(250);
  });

  it('3. user with no storage → no-op', () => {
    const env = makeEnv();
    const result = purgeUserStorage(env.nakama, USER);
    expect(result.storageDeleted).toBe(0);
    expect(result.collectionsAffected).toEqual([]);
  });

  it('8. skips derived caches (abandons, pc-account)', () => {
    const env = makeEnv();
    env.fakeNakama.store.set(`abandons/${USER}/${USER}`, {
      collection: 'abandons', key: USER, userId: USER,
      value: { count: 5 }, version: 'v00000001',
      permissionRead: 0, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    });
    env.fakeNakama.store.set(`pc-account/${USER}/${USER}`, {
      collection: 'pc-account', key: USER, userId: USER,
      value: { lastLogin: 1 }, version: 'v00000001',
      permissionRead: 0, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    });
    const result = purgeUserStorage(env.nakama, USER);
    expect(result.storageDeleted).toBe(0);
    // Both still present.
    expect(env.fakeNakama.store.has(`abandons/${USER}/${USER}`)).toBe(true);
    expect(env.fakeNakama.store.has(`pc-account/${USER}/${USER}`)).toBe(true);
  });
});

describe('purge (Phase 5 Chunk 5) — unlinkAllCustomAuths', () => {
  it('4. two linked auths → both unlinked', () => {
    const env = makeEnv();
    const t1 = mintTestToken('email', 'a@x.com', 60);
    const t2 = mintTestToken('apple', 'apple-sub', 60);
    linkAccount(env.nakama, env.logger, USER, 'email', t1, Date.now());
    linkAccount(env.nakama, env.logger, USER, 'apple', t2, Date.now());
    expect(env.fakeNakama.links.has('email:a@x.com')).toBe(true);
    expect(env.fakeNakama.links.has('apple:apple-sub')).toBe(true);

    const result = unlinkAllCustomAuths(env.nakama, env.logger, USER);
    expect(result.unlinked.sort()).toEqual(['apple', 'email']);
    expect(env.fakeNakama.links.has('email:a@x.com')).toBe(false);
    expect(env.fakeNakama.links.has('apple:apple-sub')).toBe(false);
  });

  it('5. no auths → no-op', () => {
    const env = makeEnv();
    const result = unlinkAllCustomAuths(env.nakama, env.logger, USER);
    expect(result.unlinked).toEqual([]);
  });
});

describe('purge (Phase 5 Chunk 5) — account_delete RPC', () => {
  it('6. happy — pre-checks pass, full purge', () => {
    const env = makeEnv();
    writeGarage(env, USER, 'starter_viper');
    // Link a custom auth.
    const t = mintTestToken('email', 'happy@example.com', 60);
    linkAccount(env.nakama, env.logger, USER, 'email', t, Date.now());

    // Set up a leaderboard + record.
    env.fakeNakama.leaderboards.set('race_score', {
      id: 'race_score', authoritative: true, sortOrder: 'asc',
      operator: 'best', resetSchedule: '', metadata: {},
    } as unknown as import('../../modules/src/nkruntime').ILeaderboard);
    env.fakeNakama.leaderboardRecords.set('race_score', new Map([
      [USER, {
        leaderboardId: 'race_score', ownerId: USER, username: 'A',
        score: 1000, subscore: 0, numScore: 1, metadata: {},
        createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00',
        expiryTime: null, rank: 1, maxNumScore: 1,
      } as unknown as import('../../modules/src/nkruntime').ILeaderboardRecord],
    ]));

    const ctx = { ...FakeContext, userId: USER };
    const body = JSON.stringify({
      callerUserId: USER, confirmText: 'DELETE', clientVersion: '1.0.0', platform: 'ios',
    });
    const result = account_delete_impl(ctx, env.logger, env.nakama, body);
    const resp = JSON.parse(result);
    expect(resp.ok).toBe(true);
    expect(resp.data.summary.storageDeleted).toBeGreaterThan(0);
    expect(resp.data.summary.unlinkedAuths).toContain('email');
    expect(resp.data.summary.boardsDeleted).toBeGreaterThanOrEqual(1);
    // Garage row gone, link gone, leaderboard record gone.
    expect(env.fakeNakama.store.has(`garage/${USER}/${USER}`)).toBe(false);
    expect(env.fakeNakama.links.has('email:happy@example.com')).toBe(false);
    expect(env.fakeNakama.leaderboardRecords.get('race_score')?.has(USER)).toBeFalsy();
  });

  it('7. confirmText !== DELETE → BAD_REQUEST', () => {
    const env = makeEnv();
    const ctx = { ...FakeContext, userId: USER };
    const body = JSON.stringify({ callerUserId: USER, confirmText: 'delete' });
    const result = account_delete_impl(ctx, env.logger, env.nakama, body);
    const resp = JSON.parse(result);
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe('BAD_REQUEST');
    expect(resp.error.message).toContain('DELETE');
  });

  it('9. abandons active race_sessions', () => {
    const env = makeEnv();
    // Write a race session with the user in the roster.
    env.fakeNakama.store.set(`race_sessions/sess-1/${'00000000-0000-0000-0000-000000000000'}`, {
      collection: 'race_sessions', key: 'sess-1', userId: '00000000-0000-0000-0000-000000000000',
      value: {
        schemaVersion: 1, id: 'sess-1', matchId: 'm1', mode: 'quick',
        trackId: 't1', size: 2, roster: [{ userId: USER, loadout: {} as any, isBot: false }],
        host: USER, hostSuccession: [USER], startedAt: 1000,
        results: [], flags: { needsReview: false }, version: 1, state: 'started',
      },
      version: 'v00000001', permissionRead: 0, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    });

    const ctx = { ...FakeContext, userId: USER };
    const body = JSON.stringify({ callerUserId: USER, confirmText: 'DELETE' });
    const result = account_delete_impl(ctx, env.logger, env.nakama, body);
    const resp = JSON.parse(result);
    expect(resp.ok).toBe(true);
    expect(resp.data.summary.abandonedFromRaces).toBe(1);
  });

  it('10. removes user from every leaderboard they recorded on', () => {
    const env = makeEnv();
    for (const lbId of ['race_score', 'race_wins', 'best_lap']) {
      env.fakeNakama.leaderboards.set(lbId, {
        id: lbId, authoritative: true, sortOrder: 'asc',
        operator: 'best', resetSchedule: '', metadata: {},
      } as unknown as import('../../modules/src/nkruntime').ILeaderboard);
      const map = new Map<string, unknown>();
      map.set(USER, {
        leaderboardId: lbId, ownerId: USER, username: 'A',
        score: 100, subscore: 0, numScore: 1, metadata: {},
        createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00',
        expiryTime: null, rank: 1, maxNumScore: 1,
      });
      env.fakeNakama.leaderboardRecords.set(lbId, map as unknown as Map<string, import('../../modules/src/nkruntime').ILeaderboardRecord>);
    }

    const ctx = { ...FakeContext, userId: USER };
    const body = JSON.stringify({ callerUserId: USER, confirmText: 'DELETE' });
    const result = account_delete_impl(ctx, env.logger, env.nakama, body);
    const resp = JSON.parse(result);
    expect(resp.ok).toBe(true);
    expect(resp.data.summary.boardsDeleted).toBe(3);
    expect(resp.data.summary.boardsAffected.sort()).toEqual(['best_lap', 'race_score', 'race_wins']);
  });
});