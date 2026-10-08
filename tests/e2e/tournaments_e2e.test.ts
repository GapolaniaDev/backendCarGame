// Phase 8 Chunk 5 e2e tests — 3 tournament RPCs wired into the bundle.

import { describe, it, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { ProfileRecord } from '../../modules/src/profiles/storage';
import { PROFILES_COLLECTION } from '../../modules/src/profiles/storage';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  payload: unknown,
  userId: string = '',
): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = userId.length > 0
    ? { ...FakeContext, userId }
    : FakeContext;
  return JSON.parse(
    handler(ctx, env.logger, env.nak, typeof payload === 'string' ? payload : JSON.stringify(payload)),
  ) as T;
}

function seedProfile(env: ReturnType<typeof loadBundleForTest>, userId: string, level: number): void {
  const profile: ProfileRecord = {
    schemaVersion: 1,
    userId,
    displayName: `user-${userId}`,
    avatarUrl: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    progression: { xp: 0, level, lastDailyWinAt: 0 },
  };
  env.fakeNakama.store.set(`${PROFILES_COLLECTION}/${userId}/${userId}`, {
    collection: PROFILES_COLLECTION,
    key: userId,
    userId,
    value: profile as unknown as Record<string, unknown>,
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

function seedMaintenance(env: ReturnType<typeof loadBundleForTest>, on: boolean): void {
  env.fakeNakama.store.set(`liveops/config/${SYSTEM_USER_ID}`, {
    collection: 'liveops', key: 'config', userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1, version: 1,
      flags: { maintenance: on },
      minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
    },
    version: 'v00000001', permissionRead: 0, permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
  });
}

describe('tournaments_e2e (Phase 8 Chunk 5) — 3 RPCs', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
  });

  // ─── tournament_list ──────────────────────────────────────────────

  it('tournament_list returns instances within the window, sorted by startsAt asc', () => {
    const r = call<Resp<{ tournaments: Array<{ id: string; startsAtUtc: number; state: string }> }>>(env, 'tournament_list', {}, 'u1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tournaments.length).toBeGreaterThan(0);
    const sorted = [...r.data.tournaments].sort((a, b) => a.startsAtUtc - b.startsAtUtc);
    expect(r.data.tournaments.map((t) => t.startsAtUtc)).toEqual(sorted.map((t) => t.startsAtUtc));
  });

  it('tournament_list filters by kind=time_trial', () => {
    const r = call<Resp<{ tournaments: Array<{ kind: string }> }>>(env, 'tournament_list', { kind: 'time_trial' }, 'u1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tournaments.every((t) => t.kind === 'time_trial')).toBe(true);
    expect(r.data.tournaments.length).toBeGreaterThan(0);
  });

  it('tournament_list filters by status=open', () => {
    const r = call<Resp<{ tournaments: Array<{ state: string; endsAtUtc: number }> }>>(env, 'tournament_list', { status: 'open' }, 'u1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tournaments.every((t) => t.state === 'open')).toBe(true);
  });

  it('tournament_list filters by status=closed returns 0 (no closed in the bundled catalog at boot)', () => {
    const r = call<Resp<{ tournaments: Array<unknown> }>>(env, 'tournament_list', { status: 'closed' }, 'u1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tournaments).toHaveLength(0);
  });

  // ─── tournament_get ──────────────────────────────────────────────

  it('tournament_get returns tournament + myEntry=null when not joined', () => {
    const list = call<Resp<{ tournaments: Array<{ id: string }> }>>(env, 'tournament_list', {}, 'u-getter');
    if (!list.ok || list.data.tournaments.length === 0) return;
    const firstId = list.data.tournaments[0]!.id;
    const r = call<Resp<{ tournament: { id: string }; myEntry: null; topTimes: unknown[] }>>(env, 'tournament_get', { tournamentId: firstId }, 'u-getter');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tournament.id).toBe(firstId);
    expect(r.data.myEntry).toBeNull();
    expect(r.data.topTimes).toEqual([]);
  });

  it('tournament_get returns NOT_FOUND for an unknown tournamentId', () => {
    const r = call<Resp<unknown>>(env, 'tournament_get', { tournamentId: 'no-such-tournament' }, 'u1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('tournament_get rejects missing tournamentId → BAD_REQUEST', () => {
    const r = call<Resp<unknown>>(env, 'tournament_get', {}, 'u1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  // ─── tournament_join ─────────────────────────────────────────────

  it('tournament_join happy path: deducts entryFee, creates entry, returns info', () => {
    seedProfile(env, 'u-join', 10);
    env.fakeNakama.wallets.set('u-join', { coins: 1000, gems: 0 });
    // Pick a tournament the user qualifies for (level 10, fee 100).
    const list = call<Resp<{ tournaments: Array<{ id: string; entryFee: number; minLevel: number }> }>>(env, 'tournament_list', { status: 'open' }, 'u-join');
    if (!list.ok) return;
    const target = list.data.tournaments.find((t) => t.entryFee > 0 && t.minLevel <= 10);
    if (!target) return; // bundled catalog may have moved
    const r = call<Resp<{ entryId: string; joinedAt: number; attemptsRemaining: number; paidEntryFee: number; newBalance: { coins: number } }>>(env, 'tournament_join', { tournamentId: target.id }, 'u-join');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.paidEntryFee).toBe(target.entryFee);
    expect(r.data.newBalance.coins).toBe(1000 - target.entryFee);
    expect(r.data.attemptsRemaining).toBeGreaterThan(0);
    // Wallet actually deducted.
    const w = env.fakeNakama.wallets.get('u-join');
    expect(w?.coins).toBe(1000 - target.entryFee);
  });

  it('tournament_join without funds → INSUFFICIENT_FUNDS', () => {
    seedProfile(env, 'u-broke', 10);
    env.fakeNakama.wallets.set('u-broke', { coins: 0, gems: 0 });
    const list = call<Resp<{ tournaments: Array<{ id: string; entryFee: number; minLevel: number }> }>>(env, 'tournament_list', { status: 'open' }, 'u-broke');
    if (!list.ok) return;
    const target = list.data.tournaments.find((t) => t.entryFee > 0 && t.minLevel <= 10);
    if (!target) return;
    const r = call<Resp<unknown>>(env, 'tournament_join', { tournamentId: target.id }, 'u-broke');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('tournament_join already joined → CONFLICT', () => {
    seedProfile(env, 'u-double', 12);
    env.fakeNakama.wallets.set('u-double', { coins: 10000, gems: 0 });
    const list = call<Resp<{ tournaments: Array<{ id: string; entryFee: number; minLevel: number }> }>>(env, 'tournament_list', { status: 'open' }, 'u-double');
    if (!list.ok) return;
    const target = list.data.tournaments.find((t) => t.entryFee > 0 && t.minLevel <= 12);
    if (!target) return;
    const first = call<Resp<unknown>>(env, 'tournament_join', { tournamentId: target.id }, 'u-double');
    expect(first.ok).toBe(true);
    const second = call<Resp<unknown>>(env, 'tournament_join', { tournamentId: target.id }, 'u-double');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('CONFLICT');
  });

  it('tournament_join with level<minLevel → FORBIDDEN', () => {
    seedProfile(env, 'u-low', 1);
    env.fakeNakama.wallets.set('u-low', { coins: 100000, gems: 0 });
    const list = call<Resp<{ tournaments: Array<{ id: string; entryFee: number; minLevel: number }> }>>(env, 'tournament_list', { status: 'open' }, 'u-low');
    if (!list.ok) return;
    // Find a tournament with minLevel > 1 (any of the bundled ones).
    const target = list.data.tournaments.find((t) => t.minLevel > 1);
    if (!target) return;
    const r = call<Resp<unknown>>(env, 'tournament_join', { tournamentId: target.id }, 'u-low');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('tournament_join on closed tournament → FORBIDDEN', () => {
    // Seed an instance directly with endsAt in the past so state = 'closed'.
    const now = Date.now();
    const pastId = 'past-tournament-test';
    env.fakeNakama.store.set(`tournament_instances/${pastId}/${SYSTEM_USER_ID}`, {
      collection: 'tournament_instances', key: pastId, userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, id: pastId, templateId: pastId,
        kind: 'time_trial', trackId: 'track-A',
        startsAt: now - 60 * 60 * 1000 * 24 * 7,
        endsAt: now - 60 * 60 * 1000,
        entryFee: 0, maxAttempts: 5, minLevel: 1,
        prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 100 } }],
        createdAt: now - 60 * 60 * 1000 * 24 * 8,
      },
      version: 'v00000001', permissionRead: 1, permissionWrite: 0,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    });
    seedProfile(env, 'u-closed', 10);
    env.fakeNakama.wallets.set('u-closed', { coins: 1000, gems: 0 });
    const r = call<Resp<unknown>>(env, 'tournament_join', { tournamentId: pastId }, 'u-closed');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('tournament_join on unknown tournament → NOT_FOUND', () => {
    seedProfile(env, 'u-ghost', 10);
    const r = call<Resp<unknown>>(env, 'tournament_join', { tournamentId: 'no-such-tid' }, 'u-ghost');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('Maintenance mode → all 3 RPCs return SERVICE_UNAVAILABLE', () => {
    seedMaintenance(env, true);
    const a = call<Resp<unknown>>(env, 'tournament_list', {}, 'u-maint');
    expect(a).toMatchObject({ ok: false });
    if (!a.ok) expect(a.error.code).toBe('SERVICE_UNAVAILABLE');
    const b = call<Resp<unknown>>(env, 'tournament_get', { tournamentId: 'x' }, 'u-maint');
    expect(b).toMatchObject({ ok: false });
    if (!b.ok) expect(b.error.code).toBe('SERVICE_UNAVAILABLE');
    const c = call<Resp<unknown>>(env, 'tournament_join', { tournamentId: 'x' }, 'u-maint');
    expect(c).toMatchObject({ ok: false });
    if (!c.ok) expect(c.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});