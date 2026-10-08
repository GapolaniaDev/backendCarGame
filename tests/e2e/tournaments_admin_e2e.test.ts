// Phase 8 Chunk 7 — Admin tournament RPCs e2e tests.
//
// 12+ cases covering all 6 admin RPCs (`admin_tournament_list`,
// `admin_tournament_get`, `admin_tournament_release_prizes`,
// `admin_tournament_void_refund`, `admin_tournament_cancel`,
// `admin_tournament_extend`) end-to-end through the bundle. Each
// test sets the liveops adminRpcKey directly in storage so the
// `assertAdminKey` helper accepts the test key.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { IStorageObject } from '../../modules/src/nkruntime';
import type { Tournament, TournamentEntryRow } from '../../modules/src/tournaments/types';

const ADMIN_KEY = 'test-admin-key-chunk7-e2e';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string | null,
  payload: unknown,
): Resp<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(handler(ctx, env.logger, env.nak, body) as string) as Resp<T>;
}

function setAdminKey(env: ReturnType<typeof loadBundleForTest>): void {
  // First make sure the liveops config exists (bootEnsure runs at
  // module init; the bundle writes the bundled default).
  env.nak.storageRead([{ collection: 'liveops', key: 'config', userId: SYSTEM_USER_ID }]);
  // Now override with our adminRpcKey.
  env.nak.storageWrite([{
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
  }]);
}

function seedTournament(
  env: ReturnType<typeof loadBundleForTest>,
  t: Partial<Tournament> & { id: string },
): Tournament {
  const full: Tournament = {
    schemaVersion: 1,
    id: t.id,
    templateId: t.id,
    kind: t.kind ?? 'time_trial',
    trackId: t.trackId ?? 'tr',
    startsAt: t.startsAt ?? Date.now() - 60_000,
    endsAt: t.endsAt ?? Date.now() + 60 * 60 * 1000,
    entryFee: t.entryFee ?? 0,
    maxAttempts: t.maxAttempts ?? 3,
    minLevel: t.minLevel ?? 1,
    prizes: t.prizes ?? [
      { rankFrom: 1, rankTo: 1, rewards: { coins: 100 } },
      { rankFrom: 2, rankTo: 3, rewards: { coins: 50 } },
    ],
    createdAt: t.createdAt ?? Date.now(),
    ...(t.state !== undefined ? { state: t.state } : {}),
    ...(t.cancelled !== undefined ? { cancelled: t.cancelled } : {}),
    ...(t.voided !== undefined ? { voided: t.voided } : {}),
    ...(t.closedAt !== undefined ? { closedAt: t.closedAt } : {}),
  };
  const obj: IStorageObject = {
    collection: 'tournament_instances',
    key: full.id,
    userId: SYSTEM_USER_ID,
    value: full as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  };
  env.nak.storageWrite([obj]);
  return full;
}

function seedEntry(
  env: ReturnType<typeof loadBundleForTest>,
  e: TournamentEntryRow,
): void {
  env.nak.storageWrite([{
    collection: 'tournament_entries',
    key: e.tournamentId,
    userId: e.userId,
    value: e as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  }]);
}

function seedLeaderboard(
  env: ReturnType<typeof loadBundleForTest>,
  tid: string,
  entries: Array<{ userId: string; bestTimeMs: number; recordedAt: number }>,
): void {
  env.nak.storageWrite([{
    collection: 'tournament_leaderboard',
    key: tid,
    userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1,
      tournamentId: tid,
      entries,
      updatedAt: Date.now(),
    },
    permissionRead: 1,
    permissionWrite: 0,
  }]);
}

describe('admin tournament RPCs e2e (Phase 8 Chunk 7)', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
    setAdminKey(env);
  });

  // ─── admin_tournament_list ────────────────────────────────────────────

  it('list returns all tournaments', () => {
    const now = Date.now();
    seedTournament(env, { id: 'a', endsAt: now + 2 * 3600_000 });
    seedTournament(env, { id: 'b', endsAt: now - 100, state: 'closed' });
    const r = call<{ tournaments: Array<{ id: string }> }>(
      env, 'admin_tournament_list', null, { adminKey: ADMIN_KEY },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.data.tournaments.map((t) => t.id).filter((id) => id === 'a' || id === 'b').sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('list filter state=open excludes closed', () => {
    const now = Date.now();
    seedTournament(env, { id: 'a', endsAt: now + 2 * 3600_000 });
    seedTournament(env, { id: 'b', endsAt: now - 100, state: 'closed' });
    const r = call<{ tournaments: Array<{ id: string }> }>(
      env, 'admin_tournament_list', null, { adminKey: ADMIN_KEY, state: 'open' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.data.tournaments.map((t) => t.id).filter((id) => id === 'a' || id === 'b');
    expect(ids).toEqual(['a']);
  });

  // ─── admin_tournament_get ─────────────────────────────────────────────

  it('get returns tournament + allEntries + leaderboard + prizes', () => {
    const now = Date.now();
    const t = seedTournament(env, { id: 'a', endsAt: now + 2 * 3600_000 });
    seedEntry(env, {
      schemaVersion: 1, tournamentId: t.id, userId: 'u1',
      attemptsRemaining: 3, bestTimeMs: 100, checkpoints: [],
      createdAt: 1, updatedAt: 2, paidEntryFee: 50,
    });
    seedLeaderboard(env, 'a', [
      { userId: 'fast', bestTimeMs: 100, recordedAt: 1 },
      { userId: 'mid', bestTimeMs: 200, recordedAt: 2 },
    ]);
    const r = call<{
      tournament: { id: string };
      allEntries: Array<{ userId: string }>;
      leaderboard: unknown[];
      prizes: Array<{ rank: number; userId: string }>;
    }>(env, 'admin_tournament_get', null, { adminKey: ADMIN_KEY, tournamentId: 'a' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tournament.id).toBe('a');
    expect(r.data.allEntries).toHaveLength(1);
    expect(r.data.leaderboard).toHaveLength(2);
    expect(r.data.prizes.map((p) => `${p.rank}=${p.userId}`)).toEqual(['1=fast', '2=mid']);
  });

  it('get NOT_FOUND for missing', () => {
    const r = call(env, 'admin_tournament_get', null, { adminKey: ADMIN_KEY, tournamentId: 'nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  // ─── admin_tournament_release_prizes ──────────────────────────────────

  it('release_prizes distributes + writes inbox', () => {
    const now = Date.now();
    seedTournament(env, { id: 'a', endsAt: now + 2 * 3600_000 });
    seedLeaderboard(env, 'a', [{ userId: 'fast', bestTimeMs: 100, recordedAt: 1 }]);
    const r = call<{ distributed: number; errors: number }>(
      env, 'admin_tournament_release_prizes', null,
      { adminKey: ADMIN_KEY, tournamentId: 'a' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.distributed).toBe(1);
    const inbox = env.fakeNakama.store.get('liveops_inbox/fast/tournament:a:prize:fast:1/fast');
    expect(inbox).toBeDefined();
  });

  it('release_prizes CONFLICT on closed without force', () => {
    const now = Date.now();
    seedTournament(env, { id: 'a', endsAt: now - 100, state: 'closed', closedAt: now - 100 });
    const r = call(env, 'admin_tournament_release_prizes', null, {
      adminKey: ADMIN_KEY, tournamentId: 'a',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
  });

  // ─── admin_tournament_void_refund ─────────────────────────────────────

  it('void_refund grants paidEntryFee back to each participant', () => {
    const now = Date.now();
    const t = seedTournament(env, { id: 'a', entryFee: 100, endsAt: now + 2 * 3600_000 });
    env.fakeNakama.wallets.set('u1', { coins: 50, gems: 0 });
    env.fakeNakama.wallets.set('u2', { coins: 0, gems: 0 });
    seedEntry(env, {
      schemaVersion: 1, tournamentId: t.id, userId: 'u1',
      attemptsRemaining: 3, bestTimeMs: null, checkpoints: [],
      createdAt: 0, updatedAt: 0, paidEntryFee: 100,
    });
    seedEntry(env, {
      schemaVersion: 1, tournamentId: t.id, userId: 'u2',
      attemptsRemaining: 3, bestTimeMs: null, checkpoints: [],
      createdAt: 0, updatedAt: 0, paidEntryFee: 100,
    });
    const r = call<{ refunded: number; totalAmount: number }>(
      env, 'admin_tournament_void_refund', null,
      { adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'duplicate entry' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.refunded).toBe(2);
    expect(r.data.totalAmount).toBe(200);
    expect(env.fakeNakama.wallets.get('u1')?.coins).toBe(150);
    expect(env.fakeNakama.wallets.get('u2')?.coins).toBe(100);
  });

  it('void_refund marks tournament voided=true', () => {
    const now = Date.now();
    seedTournament(env, { id: 'a', entryFee: 100, endsAt: now + 2 * 3600_000 });
    call(env, 'admin_tournament_void_refund', null, {
      adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'r',
    });
    const v = env.fakeNakama.store.get(`tournament_instances/a/${SYSTEM_USER_ID}`)?.value as { voided: boolean; state: string };
    expect(v.voided).toBe(true);
    expect(v.state).toBe('closed');
  });

  it('void_refund empty reason → BAD_REQUEST', () => {
    const r = call(env, 'admin_tournament_void_refund', null, {
      adminKey: ADMIN_KEY, tournamentId: 'a', reason: '',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('void_refund CONFLICT on already voided', () => {
    const now = Date.now();
    seedTournament(env, { id: 'a', entryFee: 100, endsAt: now + 2 * 3600_000, voided: true, state: 'closed' });
    const r = call(env, 'admin_tournament_void_refund', null, {
      adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'r',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
  });

  // ─── admin_tournament_cancel ──────────────────────────────────────────

  it('cancel sets cancelled=true + state=closed, no prizes, no refund', () => {
    const now = Date.now();
    const t = seedTournament(env, { id: 'a', entryFee: 100, endsAt: now + 2 * 3600_000 });
    env.fakeNakama.wallets.set('u1', { coins: 0, gems: 0 });
    seedEntry(env, {
      schemaVersion: 1, tournamentId: t.id, userId: 'u1',
      attemptsRemaining: 3, bestTimeMs: null, checkpoints: [],
      createdAt: 0, updatedAt: 0, paidEntryFee: 100,
    });
    const r = call<{ cancelled: true }>(
      env, 'admin_tournament_cancel', null,
      { adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'test' },
    );
    expect(r.ok).toBe(true);
    const v = env.fakeNakama.store.get(`tournament_instances/a/${SYSTEM_USER_ID}`)?.value as { cancelled: boolean; state: string };
    expect(v.cancelled).toBe(true);
    expect(v.state).toBe('closed');
    // No refund.
    expect(env.fakeNakama.wallets.get('u1')?.coins).toBe(0);
    // No inbox.
    const inboxKeys = Array.from(env.fakeNakama.store.keys()).filter((k) => k.startsWith('liveops_inbox/'));
    expect(inboxKeys).toEqual([]);
  });

  it('cancel CONFLICT on already closed', () => {
    const now = Date.now();
    seedTournament(env, { id: 'a', endsAt: now - 100, state: 'closed', closedAt: now - 100 });
    const r = call(env, 'admin_tournament_cancel', null, {
      adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'r',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
  });

  // ─── admin_tournament_extend ──────────────────────────────────────────

  it('extend updates endsAtUtc', () => {
    const now = Date.now();
    const oldEnds = now + 30 * 60_000;
    seedTournament(env, { id: 'a', endsAt: oldEnds });
    const newEnds = now + 3 * 3600_000;
    const r = call<{ oldEndsAtUtc: number; newEndsAtUtc: number }>(
      env, 'admin_tournament_extend', null,
      { adminKey: ADMIN_KEY, tournamentId: 'a', newEndsAtUtc: newEnds, reason: 'low turnout' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.oldEndsAtUtc).toBe(oldEnds);
    expect(r.data.newEndsAtUtc).toBe(newEnds);
    const v = env.fakeNakama.store.get(`tournament_instances/a/${SYSTEM_USER_ID}`)?.value as { endsAt: number; state: string };
    expect(v.endsAt).toBe(newEnds);
    expect(v.state).toBe('open');
  });

  it('extend CONFLICT on closed', () => {
    const now = Date.now();
    seedTournament(env, { id: 'a', endsAt: now - 100, state: 'closed', closedAt: now - 100 });
    const r = call(env, 'admin_tournament_extend', null, {
      adminKey: ADMIN_KEY, tournamentId: 'a', newEndsAtUtc: now + 3600_000, reason: 'r',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
  });

  it('extend BAD_REQUEST when newEndsAtUtc < now', () => {
    const now = Date.now();
    seedTournament(env, { id: 'a', endsAt: now + 2 * 3600_000 });
    const r = call(env, 'admin_tournament_extend', null, {
      adminKey: ADMIN_KEY, tournamentId: 'a', newEndsAtUtc: now - 1, reason: 'r',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  // ─── auth ─────────────────────────────────────────────────────────────

  it('missing adminKey → FORBIDDEN', () => {
    const r = call(env, 'admin_tournament_list', null, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('wrong adminKey → FORBIDDEN', () => {
    const r = call(env, 'admin_tournament_list', null, { adminKey: 'wrong' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });
});
