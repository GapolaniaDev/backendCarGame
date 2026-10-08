// Phase 8 Chunk 7 — admin tournament RPCs unit tests.
//
// 25+ cases covering all 6 admin RPCs (`admin_tournament_list`,
// `admin_tournament_get`, `admin_tournament_release_prizes`,
// `admin_tournament_void_refund`, `admin_tournament_cancel`,
// `admin_tournament_extend`). Each test seeds the fake store via
// direct `storageWrite` calls so we don't have to drive the full
// tournament lifecycle (catalog, scanner, etc.) — the unit tests
// cover the admin decision logic in isolation.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  admin_tournament_list_impl,
  admin_tournament_get_impl,
  admin_tournament_release_prizes_impl,
  admin_tournament_void_refund_impl,
  admin_tournament_cancel_impl,
  admin_tournament_extend_impl,
} from '../../modules/src/tournaments/admin';
import { FakeNakama, FakeLogger, FakeContext, SYSTEM_USER_ID } from '../e2e/_stubs';
import { bootEnsure as bootEnsureLiveops } from '../../modules/src/liveops/config';
import type { INakama, IStorageObject, ILogger } from '../../modules/src/nkruntime';
import type { Tournament, TournamentEntryRow } from '../../modules/src/tournaments/types';

const ADMIN_KEY = 'test-admin-key-chunk7';

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
  getFields: () => ({}),
} as unknown as ILogger;

function makeEnv(): { fake: FakeNakama; nk: INakama; logger: FakeLogger } {
  const fake = new FakeNakama();
  const logger = new FakeLogger();
  bootEnsureLiveops(fake.nakama, logger);
  fake.nakama.storageWrite([{
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
  return { fake, nk: fake.nakama, logger };
}

function seedTournament(nk: INakama, t: Partial<Tournament> & { id: string }): Tournament {
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
  nk.storageWrite([obj]);
  return full;
}

function seedEntry(nk: INakama, e: TournamentEntryRow): void {
  nk.storageWrite([{
    collection: 'tournament_entries',
    key: e.tournamentId,
    userId: e.userId,
    value: e as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  }]);
}

function call(
  env: { fake: FakeNakama; nk: INakama; logger: FakeLogger },
  fn: typeof admin_tournament_list_impl,
  body: unknown,
): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
  return JSON.parse(fn(FakeContext, env.logger, env.nk, typeof body === 'string' ? body : JSON.stringify(body)));
}

// ─── admin_tournament_list ────────────────────────────────────────────────

describe('admin_tournament_list (Phase 8 Chunk 7)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('returns all when state=all (no filter)', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', startsAt: now - 1000, endsAt: now + 3600_000 });
    seedTournament(env.nk, { id: 'b', startsAt: now - 1000, endsAt: now - 100, state: 'closed' });
    const r = call(env, admin_tournament_list_impl, { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { tournaments: Array<{ id: string }> };
    expect(d.tournaments.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('filter state=open returns only open', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', startsAt: now - 1000, endsAt: now + 2 * 3600_000 });
    seedTournament(env.nk, { id: 'b', endsAt: now - 100, state: 'closed' });
    const r = call(env, admin_tournament_list_impl, { adminKey: ADMIN_KEY, state: 'open' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { tournaments: Array<{ id: string }> };
    expect(d.tournaments.map((t) => t.id)).toEqual(['a']);
  });

  it('filter state=closed returns only closed', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now + 3600_000 });
    seedTournament(env.nk, { id: 'b', endsAt: now - 100, state: 'closed' });
    const r = call(env, admin_tournament_list_impl, { adminKey: ADMIN_KEY, state: 'closed' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { tournaments: Array<{ id: string }> };
    expect(d.tournaments.map((t) => t.id)).toEqual(['b']);
  });

  it('filter kind=time_trial returns only time_trial', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', kind: 'time_trial', endsAt: now + 3600_000 });
    seedTournament(env.nk, { id: 'b', kind: 'cup', endsAt: now + 3600_000 });
    const r = call(env, admin_tournament_list_impl, { adminKey: ADMIN_KEY, kind: 'time_trial' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { tournaments: Array<{ id: string; kind: string }> };
    expect(d.tournaments).toHaveLength(1);
    expect(d.tournaments[0]?.id).toBe('a');
  });

  it('participantCount reflects seeded entries', () => {
    const now = Date.now();
    const t = seedTournament(env.nk, { id: 'a', endsAt: now + 3600_000 });
    for (const uid of ['u1', 'u2', 'u3']) {
      seedEntry(env.nk, {
        schemaVersion: 1, tournamentId: t.id, userId: uid,
        attemptsRemaining: 3, bestTimeMs: 100, checkpoints: [],
        createdAt: 0, updatedAt: 0, paidEntryFee: 0,
      });
    }
    const r = call(env, admin_tournament_list_impl, { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { tournaments: Array<{ id: string; participantCount: number }> };
    expect(d.tournaments[0]?.participantCount).toBe(3);
  });

  it('empty result returns []', () => {
    const r = call(env, admin_tournament_list_impl, { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { tournaments: unknown[] };
    expect(d.tournaments).toEqual([]);
  });
});

// ─── admin_tournament_get ─────────────────────────────────────────────────

describe('admin_tournament_get (Phase 8 Chunk 7)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('returns tournament + all entries', () => {
    const now = Date.now();
    const t = seedTournament(env.nk, { id: 'a', endsAt: now + 3600_000 });
    seedEntry(env.nk, {
      schemaVersion: 1, tournamentId: t.id, userId: 'u1',
      attemptsRemaining: 3, bestTimeMs: 100, checkpoints: [],
      createdAt: 1, updatedAt: 2, paidEntryFee: 50,
    });
    const r = call(env, admin_tournament_get_impl, { adminKey: ADMIN_KEY, tournamentId: 'a' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { tournament: { id: string }; allEntries: Array<{ userId: string; paidEntryFee: number }> };
    expect(d.tournament.id).toBe('a');
    expect(d.allEntries).toHaveLength(1);
    expect(d.allEntries[0]?.paidEntryFee).toBe(50);
  });

  it('returns prize distribution computed from leaderboard', () => {
    const now = Date.now();
    const t = seedTournament(env.nk, { id: 'a', endsAt: now + 3600_000 });
    // Seed leaderboard: 3 users with times
    env.nk.storageWrite([{
      collection: 'tournament_leaderboard',
      key: 'a',
      userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1,
        tournamentId: 'a',
        entries: [
          { userId: 'fast', bestTimeMs: 100, recordedAt: 1 },
          { userId: 'mid', bestTimeMs: 200, recordedAt: 2 },
          { userId: 'slow', bestTimeMs: 300, recordedAt: 3 },
        ],
        updatedAt: 3,
      },
      permissionRead: 1, permissionWrite: 0,
    }]);
    const r = call(env, admin_tournament_get_impl, { adminKey: ADMIN_KEY, tournamentId: 'a' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { prizes: Array<{ userId: string; rank: number }>; leaderboard: unknown[] };
    expect(d.leaderboard).toHaveLength(3);
    expect(d.prizes.map((p) => `${p.rank}=${p.userId}`)).toEqual(['1=fast', '2=mid', '3=slow']);
  });

  it('NOT_FOUND for missing tournament', () => {
    const r = call(env, admin_tournament_get_impl, { adminKey: ADMIN_KEY, tournamentId: 'nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('missing tournamentId → BAD_REQUEST', () => {
    const r = call(env, admin_tournament_get_impl, { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('cancelled/voided state surfaces in tournament.state', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now + 3600_000, cancelled: true, state: 'closed' });
    const r = call(env, admin_tournament_get_impl, { adminKey: ADMIN_KEY, tournamentId: 'a' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { tournament: { state: string; cancelled: boolean; voided: boolean } };
    expect(d.tournament.state).toBe('closed');
    expect(d.tournament.cancelled).toBe(true);
  });
});

// ─── admin_tournament_release_prizes ──────────────────────────────────────

describe('admin_tournament_release_prizes (Phase 8 Chunk 7)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('happy: 3 users, 3 prizes distributed', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now + 3600_000 });
    env.nk.storageWrite([{
      collection: 'tournament_leaderboard',
      key: 'a',
      userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, tournamentId: 'a',
        entries: [
          { userId: 'fast', bestTimeMs: 100, recordedAt: 1 },
          { userId: 'mid', bestTimeMs: 200, recordedAt: 2 },
          { userId: 'slow', bestTimeMs: 300, recordedAt: 3 },
        ],
        updatedAt: 3,
      },
      permissionRead: 1, permissionWrite: 0,
    }]);
    const r = call(env, admin_tournament_release_prizes_impl, { adminKey: ADMIN_KEY, tournamentId: 'a' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { distributed: number; skipped: number; errors: number };
    expect(d.distributed).toBe(3);
    expect(d.errors).toBe(0);
  });

  it('CONFLICT on closed without force', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now - 100, state: 'closed', closedAt: now - 100 });
    const r = call(env, admin_tournament_release_prizes_impl, { adminKey: ADMIN_KEY, tournamentId: 'a' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('CONFLICT');
  });

  it('force=true on closed re-distributes (idempotent)', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now - 100, state: 'closed', closedAt: now - 100 });
    env.nk.storageWrite([{
      collection: 'tournament_leaderboard',
      key: 'a',
      userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, tournamentId: 'a',
        entries: [{ userId: 'fast', bestTimeMs: 100, recordedAt: 1 }],
        updatedAt: 1,
      },
      permissionRead: 1, permissionWrite: 0,
    }]);
    const r = call(env, admin_tournament_release_prizes_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', force: true });
    expect(r.ok).toBe(true);
  });

  it('NOT_FOUND for missing', () => {
    const r = call(env, admin_tournament_release_prizes_impl, { adminKey: ADMIN_KEY, tournamentId: 'nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('inbox contains rank + rewards', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now + 3600_000 });
    env.nk.storageWrite([{
      collection: 'tournament_leaderboard',
      key: 'a',
      userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, tournamentId: 'a',
        entries: [{ userId: 'fast', bestTimeMs: 100, recordedAt: 1 }],
        updatedAt: 1,
      },
      permissionRead: 1, permissionWrite: 0,
    }]);
    call(env, admin_tournament_release_prizes_impl, { adminKey: ADMIN_KEY, tournamentId: 'a' });
    const inbox = env.fake.store.get('liveops_inbox/fast/tournament:a:prize:fast:1/fast');
    expect(inbox).toBeDefined();
    const v = inbox?.value as { payload: { coins?: number; note?: string } };
    expect(v.payload.coins).toBe(100);
    expect(v.payload.note).toContain('rank 1');
  });
});

// ─── admin_tournament_void_refund ─────────────────────────────────────────

describe('admin_tournament_void_refund (Phase 8 Chunk 7)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('5 participants × 100 → totalAmount=500, refunded=5', () => {
    const now = Date.now();
    const t = seedTournament(env.nk, { id: 'a', entryFee: 100, endsAt: now + 3600_000 });
    for (let i = 0; i < 5; i += 1) {
      seedEntry(env.nk, {
        schemaVersion: 1, tournamentId: t.id, userId: `u${i}`,
        attemptsRemaining: 3, bestTimeMs: null, checkpoints: [],
        createdAt: 0, updatedAt: 0, paidEntryFee: 100,
      });
    }
    const r = call(env, admin_tournament_void_refund_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'bug' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { refunded: number; totalAmount: number };
    expect(d.refunded).toBe(5);
    expect(d.totalAmount).toBe(500);
  });

  it('grant (not spend) — wallet increases by paidEntryFee', () => {
    const now = Date.now();
    const t = seedTournament(env.nk, { id: 'a', entryFee: 100, endsAt: now + 3600_000 });
    env.fake.wallets.set('u1', { coins: 50, gems: 0 });
    seedEntry(env.nk, {
      schemaVersion: 1, tournamentId: t.id, userId: 'u1',
      attemptsRemaining: 3, bestTimeMs: null, checkpoints: [],
      createdAt: 0, updatedAt: 0, paidEntryFee: 100,
    });
    call(env, admin_tournament_void_refund_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'bug' });
    const wallet = env.fake.wallets.get('u1');
    expect(wallet?.coins).toBe(150);
  });

  it('inbox tournament_voided sent per participant', () => {
    const now = Date.now();
    const t = seedTournament(env.nk, { id: 'a', entryFee: 100, endsAt: now + 3600_000 });
    seedEntry(env.nk, {
      schemaVersion: 1, tournamentId: t.id, userId: 'u1',
      attemptsRemaining: 3, bestTimeMs: null, checkpoints: [],
      createdAt: 0, updatedAt: 0, paidEntryFee: 100,
    });
    call(env, admin_tournament_void_refund_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'duplicate' });
    const inbox = env.fake.store.get('liveops_inbox/u1/tournament:a:void:u1/u1');
    expect(inbox).toBeDefined();
    const v = inbox?.value as { type: string; payload: { coins: number; note: string } };
    expect(v.type).toBe('tournament_voided');
    expect(v.payload.coins).toBe(100);
    expect(v.payload.note).toContain('duplicate');
  });

  it('marks tournament voided=true, state=closed', () => {
    const now = Date.now();
    const t = seedTournament(env.nk, { id: 'a', entryFee: 100, endsAt: now + 3600_000 });
    seedEntry(env.nk, {
      schemaVersion: 1, tournamentId: t.id, userId: 'u1',
      attemptsRemaining: 3, bestTimeMs: null, checkpoints: [],
      createdAt: 0, updatedAt: 0, paidEntryFee: 100,
    });
    call(env, admin_tournament_void_refund_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'r' });
    const updated = env.fake.store.get(`tournament_instances/a/${SYSTEM_USER_ID}`);
    const v = updated?.value as { voided: boolean; state: string; closedAt: number };
    expect(v.voided).toBe(true);
    expect(v.state).toBe('closed');
    expect(v.closedAt).toBeGreaterThan(0);
  });

  it('CONFLICT on already voided', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', entryFee: 100, endsAt: now + 3600_000, voided: true, state: 'closed' });
    const r = call(env, admin_tournament_void_refund_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'r' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('CONFLICT');
  });

  it('empty reason → BAD_REQUEST', () => {
    const r = call(env, admin_tournament_void_refund_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', reason: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('NOT_FOUND for missing', () => {
    const r = call(env, admin_tournament_void_refund_impl, { adminKey: ADMIN_KEY, tournamentId: 'nope', reason: 'r' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('NOT_FOUND');
  });
});

// ─── admin_tournament_cancel ──────────────────────────────────────────────

describe('admin_tournament_cancel (Phase 8 Chunk 7)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('sets state=closed + cancelled=true', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now + 3600_000 });
    const r = call(env, admin_tournament_cancel_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'test' });
    expect(r.ok).toBe(true);
    const v = env.fake.store.get(`tournament_instances/a/${SYSTEM_USER_ID}`)?.value as { cancelled: boolean; state: string };
    expect(v.cancelled).toBe(true);
    expect(v.state).toBe('closed');
  });

  it('NO prize distribution (no inbox row)', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now + 3600_000 });
    call(env, admin_tournament_cancel_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'r' });
    const inbox = Array.from(env.fake.store.keys()).filter((k) => k.startsWith('liveops_inbox/'));
    expect(inbox).toEqual([]);
  });

  it('NO refund (wallet unchanged)', () => {
    const now = Date.now();
    const t = seedTournament(env.nk, { id: 'a', entryFee: 100, endsAt: now + 3600_000 });
    env.fake.wallets.set('u1', { coins: 0, gems: 0 });
    seedEntry(env.nk, {
      schemaVersion: 1, tournamentId: t.id, userId: 'u1',
      attemptsRemaining: 3, bestTimeMs: null, checkpoints: [],
      createdAt: 0, updatedAt: 0, paidEntryFee: 100,
    });
    call(env, admin_tournament_cancel_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'r' });
    const wallet = env.fake.wallets.get('u1');
    expect(wallet?.coins).toBe(0);
  });

  it('empty reason → BAD_REQUEST', () => {
    const r = call(env, admin_tournament_cancel_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', reason: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('CONFLICT on already closed', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now - 100, state: 'closed', closedAt: now - 100 });
    const r = call(env, admin_tournament_cancel_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', reason: 'r' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('CONFLICT');
  });
});

// ─── admin_tournament_extend ──────────────────────────────────────────────

describe('admin_tournament_extend (Phase 8 Chunk 7)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('updates endsAtUtc on open tournament', () => {
    const now = Date.now();
    const oldEnds = now + 30 * 60_000;
    seedTournament(env.nk, { id: 'a', endsAt: oldEnds });
    const newEnds = now + 3 * 3600_000;
    const r = call(env, admin_tournament_extend_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', newEndsAtUtc: newEnds, reason: 'low turnout' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { oldEndsAtUtc: number; newEndsAtUtc: number };
    expect(d.oldEndsAtUtc).toBe(oldEnds);
    expect(d.newEndsAtUtc).toBe(newEnds);
    const v = env.fake.store.get(`tournament_instances/a/${SYSTEM_USER_ID}`)?.value as { endsAt: number; state: string };
    expect(v.endsAt).toBe(newEnds);
    expect(v.state).toBe('open');
  });

  it('CONFLICT on closed tournament', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now - 100, state: 'closed', closedAt: now - 100 });
    const r = call(env, admin_tournament_extend_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', newEndsAtUtc: now + 3600_000, reason: 'r' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('CONFLICT');
  });

  it('BAD_REQUEST when newEndsAtUtc < now', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now + 3600_000 });
    const r = call(env, admin_tournament_extend_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', newEndsAtUtc: now - 1, reason: 'r' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('empty reason → BAD_REQUEST', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now + 3600_000 });
    const r = call(env, admin_tournament_extend_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', newEndsAtUtc: now + 7200_000, reason: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('NOT_FOUND for missing', () => {
    const r = call(env, admin_tournament_extend_impl, { adminKey: ADMIN_KEY, tournamentId: 'nope', newEndsAtUtc: Date.now() + 3600_000, reason: 'r' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('extension flips state back to open when new window > 1h from now', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 'a', endsAt: now + 30 * 60_000, state: 'closing' });
    const r = call(env, admin_tournament_extend_impl, { adminKey: ADMIN_KEY, tournamentId: 'a', newEndsAtUtc: now + 3 * 3600_000, reason: 'r' });
    expect(r.ok).toBe(true);
    const v = env.fake.store.get(`tournament_instances/a/${SYSTEM_USER_ID}`)?.value as { state: string };
    expect(v.state).toBe('open');
  });
});

// ─── auth + maintenance bypass ────────────────────────────────────────────

describe('admin tournament RPCs — auth + maintenance', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('missing adminKey → FORBIDDEN', () => {
    const r = call(env, admin_tournament_list_impl, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('FORBIDDEN');
  });

  it('wrong adminKey → FORBIDDEN', () => {
    const r = call(env, admin_tournament_list_impl, { adminKey: 'wrong' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('FORBIDDEN');
  });

  it('no adminRpcKey configured → SERVICE_UNAVAILABLE', () => {
    // Wipe the liveops config (full storage key includes the system userId).
    env.fake.store.delete('liveops/config/00000000-0000-0000-0000-000000000000');
    const r = call(env, admin_tournament_list_impl, { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('SERVICE_UNAVAILABLE');
  });
});
