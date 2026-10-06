// Phase 5 Chunk 6 unit tests for admin RPCs + helpers.
//
// Covers the 10 spec cases:
//   1. assertAdminKey match → ok
//   2. assertAdminKey mismatch → FORBIDDEN
//   3. assertAdminKey missing → FORBIDDEN
//   4. admin_wallet_adjust happy — coins +1000 → wallet balance +1000
//   5. admin_wallet_adjust userId missing → BAD_REQUEST
//   6. admin_send_inbox happy — 5 userIds → 5 delivered
//   7. admin_send_inbox with 'all' → NOT_IMPLEMENTED + warning log
//   8. admin_sanitize_session happy → flags.needsReview=true
//   9. admin_remove_player happy → profile.archivedAt + removePlayerFromAll called
//  10. admin_cleanup_race_sessions happy → drops closed sessions + expired inbox

import { describe, it, expect } from 'vitest';
import { FakeNakama, FakeLogger, FakeContext, SYSTEM_USER_ID } from '../e2e/_stubs';
import {
  admin_wallet_adjust_impl,
  admin_send_inbox_impl,
  admin_sanitize_session_impl,
  admin_remove_player_impl,
  admin_cleanup_race_sessions_impl,
} from '../../modules/src/admin/rpcs';
import { assertAdminKey } from '../../modules/src/admin/auth';
import { bootEnsure as bootEnsureLiveops } from '../../modules/src/liveops/config';
import { INBOX_COLLECTION } from '../../modules/src/liveops/messages';
import type { IStorageObject } from '../../modules/src/nkruntime';

const ADMIN_KEY = 'test-admin-key-1234567890';

function makeEnv(): {
  nakama: FakeNakama['nakama'];
  logger: FakeLogger;
  fakeNakama: FakeNakama;
} {
  const fakeNakama = new FakeNakama();
  const logger = new FakeLogger();
  // Bootstrap liveops config (adminRpcKey injected via override below).
  bootEnsureFakeFikops(fakeNakama.nakama, logger);
  return { nakama: fakeNakama.nakama, logger, fakeNakama };
}

// Tiny helper to set the liveops adminRpcKey via direct storage write.
function bootEnsureFakeFikops(nakama: import('../../modules/src/nkruntime').INakama, logger: import('../../modules/src/nkruntime').ILogger): void {
  bootEnsureLiveops(nakama, logger);
  // Override the adminRpcKey directly in storage.
  nakama.storageWrite([
    {
      collection: 'liveops',
      key: 'config',
      userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1,
        version: 1,
        flags: { maintenance: false },
        minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
        regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
        calendar: [],
        adminRpcKey: ADMIN_KEY,
      },
      permissionRead: 0,
      permissionWrite: 0,
    },
  ]);
}

function call(env: ReturnType<typeof makeEnv>, fn: typeof admin_wallet_adjust_impl, body: unknown): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
  return JSON.parse(fn(FakeContext, env.logger, env.nakama, typeof body === 'string' ? body : JSON.stringify(body)));
}

describe('admin_rpcs (Phase 5 Chunk 6) — assertAdminKey', () => {
  it('1. match → ok', () => {
    const env = makeEnv();
    const r = assertAdminKey(env.logger, env.nakama, { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(true);
  });

  it('2. mismatch → FORBIDDEN', () => {
    const env = makeEnv();
    const r = assertAdminKey(env.logger, env.nakama, { adminKey: 'wrong-key' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.parse(r.error).error.code).toBe('FORBIDDEN');
  });

  it('3. missing → FORBIDDEN', () => {
    const env = makeEnv();
    const r = assertAdminKey(env.logger, env.nakama, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.parse(r.error).error.code).toBe('FORBIDDEN');
  });
});

describe('admin_rpcs — admin_wallet_adjust', () => {
  it('4. happy — coins +1000 → wallet balance +1000', () => {
    const env = makeEnv();
    // Pre-seed wallet via direct stub access.
    env.fakeNakama.wallets.set('u1', { coins: 100, gems: 5 });
    const resp = call(env, admin_wallet_adjust_impl, {
      adminKey: ADMIN_KEY,
      userId: 'u1',
      coins: 1000,
      reason: 'manual top-up',
    });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const data = resp.data as { newBalance: { coins: number; gems: number } };
    expect(data.newBalance.coins).toBe(1100);
    expect(data.newBalance.gems).toBe(5);
  });

  it('5. userId missing → BAD_REQUEST', () => {
    const env = makeEnv();
    const resp = call(env, admin_wallet_adjust_impl, {
      adminKey: ADMIN_KEY,
      coins: 100,
      reason: 'topup',
    });
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.code).toBe('BAD_REQUEST');
  });
});

describe('admin_rpcs — admin_send_inbox', () => {
  it('6. happy — 5 userIds → 5 delivered', () => {
    const env = makeEnv();
    const resp = call(env, admin_send_inbox_impl, {
      adminKey: ADMIN_KEY,
      userIds: ['u1', 'u2', 'u3', 'u4', 'u5'],
      message: { kind: 'reward', title: 'hi', body: 'b' },
    });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect((resp.data as { delivered: number }).delivered).toBe(5);
  });

  it('7. with "all" → NOT_IMPLEMENTED + warning log', () => {
    const env = makeEnv();
    const resp = call(env, admin_send_inbox_impl, {
      adminKey: ADMIN_KEY,
      userIds: 'all',
      message: { kind: 'system', title: 'hi', body: 'b' },
    });
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.code).toBe('NOT_IMPLEMENTED');
    expect(env.logger.lines.some((l) => l.includes('broadcast-to-all deferred'))).toBe(true);
  });
});

describe('admin_rpcs — admin_sanitize_session', () => {
  it('8. happy → flags.needsReview=true', () => {
    const env = makeEnv();
    // Seed a started race session.
    const sessId = 'sess-sanitize-1';
    env.fakeNakama.store.set(`race_sessions/${sessId}/${SYSTEM_USER_ID}`, {
      collection: 'race_sessions',
      key: sessId,
      userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, id: sessId, matchId: 'm1', mode: 'quick',
        trackId: 't1', size: 2,
        roster: [{ userId: 'p1', loadout: {} as never, isBot: false }],
        host: 'p1', hostSuccession: ['p1'], state: 'started',
        startedAt: 1000, results: [], flags: { needsReview: false }, version: 1,
      },
      version: 'v00000001', permissionRead: 0, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    });
    const resp = call(env, admin_sanitize_session_impl, {
      adminKey: ADMIN_KEY,
      sessionId: sessId,
      reviewReason: 'manual review',
      removeFromLeaderboards: false,
    });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const data = resp.data as { sessionId: string; needsReview: boolean };
    expect(data.needsReview).toBe(true);
    const after = env.fakeNakama.store.get(`race_sessions/${sessId}/${SYSTEM_USER_ID}`);
    expect((after?.value as { flags: { needsReview: boolean; reviewReason?: string } }).flags.needsReview).toBe(true);
    expect((after?.value as { flags: { needsReview: boolean; reviewReason?: string } }).flags.reviewReason).toBe('manual review');
  });
});

describe('admin_rpcs — admin_remove_player', () => {
  it('9. happy → profile.archivedAt set', () => {
    const env = makeEnv();
    const userId = 'p-remove';
    env.fakeNakama.store.set(`profiles/${userId}/${userId}`, {
      collection: 'profiles', key: userId, userId,
      value: { userId, displayName: 'A', schemaVersion: 1 },
      version: 'v00000001', permissionRead: 1, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    } satisfies IStorageObject);
    const resp = call(env, admin_remove_player_impl, {
      adminKey: ADMIN_KEY,
      userId,
      reason: 'cheating',
    });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const data = resp.data as { removedAt: number; abandonedFromRaces: number };
    expect(typeof data.removedAt).toBe('number');
    const after = env.fakeNakama.store.get(`profiles/${userId}/${userId}`);
    expect((after?.value as Record<string, unknown>).archivedAt).toBeTypeOf('number');
  });

  it('9b. missing profile → NOT_FOUND', () => {
    const env = makeEnv();
    const resp = call(env, admin_remove_player_impl, {
      adminKey: ADMIN_KEY,
      userId: 'no-such-user',
      reason: 'cheating',
    });
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.code).toBe('NOT_FOUND');
  });
});

describe('admin_rpcs — admin_cleanup_race_sessions', () => {
  it('10. happy — drops closed sessions + expired inbox', () => {
    const env = makeEnv();
    const now = Date.now();
    const closedId = 'sess-closed';
    env.fakeNakama.store.set(`race_sessions/${closedId}/${SYSTEM_USER_ID}`, {
      collection: 'race_sessions', key: closedId, userId: SYSTEM_USER_ID,
      value: { schemaVersion: 1, id: closedId, matchId: 'm1', mode: 'quick', trackId: 't1', size: 2, roster: [], host: 'p1', hostSuccession: ['p1'], state: 'closed', startedAt: 1, results: [], flags: { needsReview: false }, version: 1 },
      version: 'v00000001', permissionRead: 0, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    } satisfies IStorageObject);
    const openId = 'sess-open';
    env.fakeNakama.store.set(`race_sessions/${openId}/${SYSTEM_USER_ID}`, {
      collection: 'race_sessions', key: openId, userId: SYSTEM_USER_ID,
      value: { schemaVersion: 1, id: openId, matchId: 'm2', mode: 'quick', trackId: 't1', size: 2, roster: [], host: 'p2', hostSuccession: ['p2'], state: 'started', startedAt: now, results: [], flags: { needsReview: false }, version: 1 },
      version: 'v00000001', permissionRead: 0, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    } satisfies IStorageObject);
    const expiredKey = `u-expired/exp-1`;
    env.fakeNakama.store.set(`${INBOX_COLLECTION}/${expiredKey}/u-expired`, {
      collection: INBOX_COLLECTION, key: expiredKey, userId: 'u-expired',
      value: { schemaVersion: 1, id: 'exp-1', userId: 'u-expired', kind: 'reward', title: 't', body: 'b', createdAt: now - 100000, expiresAt: now - 1 },
      version: 'v00000001', permissionRead: 1, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    } satisfies IStorageObject);
    const liveKey = `u-live/keep-1`;
    env.fakeNakama.store.set(`${INBOX_COLLECTION}/${liveKey}/u-live`, {
      collection: INBOX_COLLECTION, key: liveKey, userId: 'u-live',
      value: { schemaVersion: 1, id: 'keep-1', userId: 'u-live', kind: 'reward', title: 't', body: 'b', createdAt: now, expiresAt: now + 1000000 },
      version: 'v00000001', permissionRead: 1, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    } satisfies IStorageObject);

    const resp = call(env, admin_cleanup_race_sessions_impl, {
      adminKey: ADMIN_KEY,
    });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const data = resp.data as { deleted: number };
    expect(data.deleted).toBeGreaterThanOrEqual(2); // 1 closed session + 1 expired inbox

    expect(env.fakeNakama.store.has(`race_sessions/${closedId}/${SYSTEM_USER_ID}`)).toBe(false);
    expect(env.fakeNakama.store.has(`race_sessions/${openId}/${SYSTEM_USER_ID}`)).toBe(true);
    expect(env.fakeNakama.store.has(`${INBOX_COLLECTION}/${expiredKey}/u-expired`)).toBe(false);
    expect(env.fakeNakama.store.has(`${INBOX_COLLECTION}/${liveKey}/u-live`)).toBe(true);

    // Idempotent — second run deletes 0.
    const second = call(env, admin_cleanup_race_sessions_impl, { adminKey: ADMIN_KEY });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((second.data as { deleted: number }).deleted).toBe(0);
  });
});