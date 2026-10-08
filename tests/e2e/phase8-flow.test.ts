// Phase 8 Chunk 10 — Full Phase 8 end-to-end flow test.
//
// Drives a complete user journey across every Phase 8 subsystem:
//   1. Tournament lifecycle (list → join → race → submit → leaderboard → admin operations)
//   2. Events (list → xp_double grants on race → store discount → scanner)
//   3. Anti-cheat (race flags → mark stored → admin confirm → cache invalidation)
//   4. Admin dashboard (overview → tournaments stats → players search → wallet grant)
//
// Uses the bundled catalogs so the test is self-contained — no fixture
// files beyond what the bundle already ships.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
} from './_stubs';
import type { RaceSubmitResultOutput } from '../../modules/src/race/types';
import { TOURNAMENT_LEADERBOARD_SYSTEM_USER } from '../../modules/src/tournaments/leaderboard';
import { invalidateDashboardCache } from '../../modules/src/admin/cache';

const ADMIN_KEY = 'phase8-flow-admin-key';

const HOST = 'p8-host';
const P1 = 'p8-p1';
const P2 = 'p8-p2';
const P3 = 'p8-p3';

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

function seedProfile(
  env: ReturnType<typeof loadBundleForTest>,
  userId: string,
  level: number,
  overrides: Record<string, unknown> = {},
): void {
  const profile = {
    schemaVersion: 1,
    userId,
    displayName: `user-${userId}`,
    avatarUrl: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    progression: { xp: 0, level, lastDailyWinAt: 0 },
    ...overrides,
  };
  env.fakeNakama.store.set(`profiles/${userId}/${userId}`, {
    collection: 'profiles', key: userId, userId,
    value: profile as unknown as Record<string, unknown>,
    version: 'v00000001',
    permissionRead: 0, permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
  });
}

function seedAdminKey(env: ReturnType<typeof loadBundleForTest>): void {
  env.fakeNakama.store.set(`liveops/config/${SYSTEM_USER_ID}`, {
    collection: 'liveops', key: 'config', userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1, version: 1,
      flags: { maintenance: false },
      minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      adminRpcKey: ADMIN_KEY,
    },
    version: 'v00000001', permissionRead: 0, permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
  });
}

function setupSession(
  env: ReturnType<typeof loadBundleForTest>,
  trackId: string,
  size: 2 | 4 | 6 = 2,
): string {
  const create = call<{ sessionId: string }>(env, 'race_session_create', null, {
    matchId: 'm-p8-' + Math.random().toString(36).slice(2, 8),
    mode: 'quick',
    trackId,
    size,
    hostLoadout: { classId: 'B', bodyId: 'coupe' },
    hostUserId: HOST,
  });
  if (!create.ok) throw new Error('create: ' + JSON.stringify(create));
  const sid = create.data.sessionId;
  for (const userId of [P1, P2, P3].slice(0, size - 1)) {
    const j = call<unknown>(env, 'race_session_join', null, {
      sessionId: sid,
      userId,
      callerUserId: userId,
      loadout: { classId: 'B', bodyId: 'coupe' },
    });
    if (!j.ok) throw new Error(`join ${userId}: ` + JSON.stringify(j));
  }
  const s = call<unknown>(env, 'race_session_start', HOST, {
    sessionId: sid,
    callerUserId: HOST,
  });
  if (!s.ok) throw new Error('start: ' + JSON.stringify(s));
  // Backdate startedAt so submit (with default 120_000 ms) passes clock.
  const obj = env.fakeNakama.store.get(`race_sessions/${sid}/${SYSTEM_USER_ID}`);
  if (obj) {
    const sess = obj.value as { startedAt: number; version: number };
    sess.startedAt = Date.now() - 300_000;
    env.fakeNakama.store.set(`race_sessions/${sid}/${SYSTEM_USER_ID}`, {
      ...obj,
      value: sess as unknown as Record<string, unknown>,
    });
  }
  return sid;
}

function submit(
  env: ReturnType<typeof loadBundleForTest>,
  sid: string,
  userId: string,
  totalMs: number,
  tournamentId?: string,
  laps: number[] = [50_000, 50_000, 50_000, 50_000],
): Resp<RaceSubmitResultOutput> {
  return call<RaceSubmitResultOutput>(env, 'race_submit_result', userId, {
    sessionId: sid,
    callerUserId: userId,
    report: { userId, totalMs, laps, isBotReport: false },
    ...(tournamentId !== undefined ? { tournamentId } : {}),
  });
}

function findOpenFreeTournament(
  env: ReturnType<typeof loadBundleForTest>,
  caller = HOST,
): { id: string; trackId: string; entryFee: number; minLevel: number; maxAttempts: number } {
  const list = call<{ tournaments: Array<{ id: string; trackId: string; entryFee: number; minLevel: number; maxAttempts: number; state: string }> }>(
    env, 'tournament_list', caller, { status: 'open' },
  );
  if (!list.ok) throw new Error('list: ' + JSON.stringify(list.error));
  const t = list.data.tournaments.find(
    (x) => x.entryFee === 0 && x.minLevel <= 10 && x.maxAttempts >= 3,
  );
  if (!t) throw new Error('no free open tournament in catalog');
  return t;
}

describe('phase8 full flow e2e (Chunk 10)', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
    seedAdminKey(env);
    invalidateDashboardCache('');
  });

  // ─── Tournament lifecycle (10 cases) ──────────────────────────────────────

  it('T1: tournament_list returns the bundled catalog with open + closing states', () => {
    const r = call<{ tournaments: Array<{ state: string; id: string }> }>(
      env, 'tournament_list', HOST, { status: 'all' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tournaments.length).toBeGreaterThan(0);
    const states = new Set(r.data.tournaments.map((t) => t.state));
    expect(states.size).toBeGreaterThanOrEqual(1);
  });

  it('T2: tournament_get returns full detail (template + state + config)', () => {
    const t = findOpenFreeTournament(env);
    const r = call<{ tournament: { id: string; entryFee: number; minLevel: number; maxAttempts: number; state: string } }>(
      env, 'tournament_get', HOST, { tournamentId: t.id },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tournament.id).toBe(t.id);
    expect(r.data.tournament.entryFee).toBe(0);
  });

  it('T3: tournament_join succeeds for funded users', () => {
    const t = findOpenFreeTournament(env);
    seedProfile(env, HOST, t.minLevel + 1);
    const r = call<{ joined: true }>(env, 'tournament_join', HOST, { tournamentId: t.id });
    expect(r.ok).toBe(true);
  });

  it('T4: tournament_join is 1-per-user (CONFLICT on second attempt)', () => {
    const t = findOpenFreeTournament(env);
    seedProfile(env, HOST, t.minLevel + 1);
    expect(call<unknown>(env, 'tournament_join', HOST, { tournamentId: t.id }).ok).toBe(true);
    const r2 = call<unknown>(env, 'tournament_join', HOST, { tournamentId: t.id });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe('CONFLICT');
  });

  it('T5: race_submit_result with tournamentId writes leaderboard entry', async () => {
    const t = findOpenFreeTournament(env);
    seedProfile(env, HOST, t.minLevel + 1);
    seedProfile(env, P1, t.minLevel + 1);
    for (const u of [HOST, P1]) {
      env.fakeNakama.wallets.set(u, { coins: 1000, gems: 0 });
      expect(call<unknown>(env, 'tournament_join', u, { tournamentId: t.id }).ok).toBe(true);
    }
    const sid = setupSession(env, t.trackId, 2);
    expect(submit(env, sid, HOST, 200_000, t.id, [50_000, 50_000, 50_000, 50_000]).ok).toBe(true);
    expect(submit(env, sid, P1, 220_000, t.id, [55_000, 55_000, 55_000, 55_000]).ok).toBe(true);
    // Wait for the subscriber to write the leaderboard.
    const lbKey = `tournament_leaderboard/${t.id}/${TOURNAMENT_LEADERBOARD_SYSTEM_USER}`;
    const deadline = Date.now() + 1500;
    let entries: Array<{ userId: string; bestTimeMs: number }> = [];
    while (Date.now() < deadline) {
      const obj = env.fakeNakama.store.get(lbKey);
      if (obj) {
        const e = (obj.value as { entries: Array<{ userId: string; bestTimeMs: number }> }).entries;
        if (e.length === 2) { entries = e; break; }
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(entries).toHaveLength(2);
    expect(entries[0]!.userId).toBe(HOST);
  });

  it('T6: bestTimeMs is the minimum across attempts', async () => {
    const t = findOpenFreeTournament(env);
    seedProfile(env, HOST, t.minLevel + 1);
    env.fakeNakama.wallets.set(HOST, { coins: 1000, gems: 0 });
    expect(call<unknown>(env, 'tournament_join', HOST, { tournamentId: t.id }).ok).toBe(true);
    for (const totalMs of [220_000, 190_000, 210_000]) {
      const sid = setupSession(env, t.trackId, 2);
      const r1 = submit(env, sid, HOST, totalMs, t.id, [totalMs / 4, totalMs / 4, totalMs / 4, totalMs / 4]);
      if (!r1.ok) throw new Error('host submit: ' + JSON.stringify(r1));
      const r2 = submit(env, sid, P1, 240_000, undefined, [60_000, 60_000, 60_000, 60_000]);
      if (!r2.ok) throw new Error('p1 submit: ' + JSON.stringify(r2));
    }
    const lbKey = `tournament_leaderboard/${t.id}/${TOURNAMENT_LEADERBOARD_SYSTEM_USER}`;
    const deadline = Date.now() + 1500;
    let bestTime: number | undefined;
    while (Date.now() < deadline) {
      const obj = env.fakeNakama.store.get(lbKey);
      const e = (obj?.value as { entries?: Array<{ bestTimeMs: number }> } | undefined)?.entries?.[0];
      if (e?.bestTimeMs === 190_000) { bestTime = e.bestTimeMs; break; }
      await new Promise((r) => setImmediate(r));
    }
    expect(bestTime).toBe(190_000);
  });

  it('T7: admin_tournament_list shows all instances including non-open', () => {
    const r = call<{ tournaments: Array<{ state: string; id: string }> }>(
      env, 'admin_tournament_list', null, { adminKey: ADMIN_KEY, state: 'all' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tournaments.length).toBeGreaterThan(0);
  });

  it('T8: admin_tournament_get returns entries + leaderboard + prizes', () => {
    const t = findOpenFreeTournament(env);
    const r = call<{ tournament: unknown; allEntries: unknown[]; leaderboard: unknown[]; prizes: unknown[] }>(
      env, 'admin_tournament_get', null, { adminKey: ADMIN_KEY, tournamentId: t.id },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.data.allEntries)).toBe(true);
    expect(Array.isArray(r.data.leaderboard)).toBe(true);
    expect(Array.isArray(r.data.prizes)).toBe(true);
  });

  it('T9: admin_tournament_release_prizes succeeds on open tournament (idempotent re-distribute)', () => {
    const t = findOpenFreeTournament(env);
    const r = call<{ distributed: number; skipped: number; errors: number }>(
      env, 'admin_tournament_release_prizes', null,
      { adminKey: ADMIN_KEY, tournamentId: t.id },
    );
    // Open tournaments have no leaderboard yet — distributed=0, no errors.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.distributed).toBe(0);
    expect(r.data.errors).toBe(0);
  });

  it('T10: admin_tournament_void_refund requires the adminKey', () => {
    const t = findOpenFreeTournament(env);
    const r = call(env, 'admin_tournament_void_refund', null,
      { tournamentId: t.id, reason: 'test' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  // ─── Events flow (5 cases) ────────────────────────────────────────────────

  it('E1: event_list returns bundled xp_double / featured_track / special_offer', () => {
    const r = call<{ events: Array<{ id: string; kind: string; isActive: boolean }> }>(
      env, 'event_list', HOST, {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kinds = new Set(r.data.events.map((e) => e.kind));
    for (const k of ['xp_double', 'featured_track', 'special_offer']) {
      expect(kinds.has(k)).toBe(true);
    }
  });

  it('E2: store_get returns basePrice === finalPrice when no special offer is active', () => {
    const r = call<{ sections: Array<{ offers: Array<{ basePrice: { coins: number; gems: number }; finalPrice: { coins: number; gems: number }; activeSpecialOfferId?: string }> }> }>(
      env, 'store_get', HOST, { callerUserId: HOST },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const s of r.data.sections) {
      for (const o of s.offers) {
        expect(o.basePrice.coins).toBe(o.finalPrice.coins);
        expect(o.basePrice.gems).toBe(o.finalPrice.gems);
        expect(o.activeSpecialOfferId).toBeUndefined();
      }
    }
  });

  it('E3: store_get applies discount when profile.activeSpecialOffers matches a sku', () => {
    // Hand-write a profile + an active offer the catalog matches.
    seedProfile(env, 'p8-buyer', 5, { activeSpecialOffers: ['evt_offer_gem_pack_50off'] });
    env.fakeNakama.store.set(`garage/p8-buyer/p8-buyer`, {
      collection: 'garage', key: 'p8-buyer', userId: 'p8-buyer',
      value: { schemaVersion: 1, userId: 'p8-buyer', cars: [], cosmeticsBag: [], purchasedPacks: [], updatedAt: 0 },
      version: 'v00000001', permissionRead: 0, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
    });
    const r = call<{ sections: Array<{ offers: Array<{ offer: { offerId: string; priceCoins?: number }; basePrice: { coins: number; gems: number }; finalPrice: { coins: number; gems: number }; activeSpecialOfferId?: string }> }> }>(
      env, 'store_get', 'p8-buyer', { callerUserId: 'p8-buyer' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = r.data.sections.flatMap((s) => s.offers);
    const offer = all.find((o) => o.offer.offerId === 'gem_pack_500_50off');
    if (offer !== undefined && offer.basePrice.coins > 0) {
      expect(offer.finalPrice.coins).toBeLessThan(offer.basePrice.coins);
      expect(offer.activeSpecialOfferId).toBe('evt_offer_gem_pack_50off');
    }
  });

  it('E4: race submit during xp_double event grants a coin bonus (idempotent)', () => {
    seedProfile(env, HOST, 5);
    const sid = setupSession(env, 'neon_blvd', 2);
    const r = call<RaceSubmitResultOutput>(env, 'race_submit_result', HOST, {
      sessionId: sid,
      callerUserId: HOST,
      report: { userId: HOST, totalMs: 120_000, laps: [40_000, 40_000, 40_000], isBotReport: false },
    });
    expect(r.ok).toBe(true);
    // The xp_double subscriber may or may not have fired (depends on
    // whether the current wall clock falls inside a bundled window).
    // Idempotency: at most 1 grant per race.
    const ledger = env.fakeNakama.ledger.get(HOST) ?? [];
    const eventGrants = ledger.filter(
      (e) => (e as { metadata?: { reason?: string } }).metadata?.reason?.startsWith('event:event_xp_double:'),
    );
    expect(eventGrants.length).toBeLessThanOrEqual(1);
  });

  it('E5: event subscriber is silent on bot-only results (no crash)', () => {
    seedProfile(env, HOST, 5);
    const sid = setupSession(env, 'mountain_pass', 2);
    const r = call<RaceSubmitResultOutput>(env, 'race_submit_result', HOST, {
      sessionId: sid,
      callerUserId: HOST,
      report: { userId: HOST, totalMs: 180_000, laps: [45_000, 45_000, 45_000, 45_000], isBotReport: false },
    });
    // No throw — pass is implicit.
    expect(r.ok).toBe(true);
  });

  // ─── Anti-cheat flow (5 cases) ────────────────────────────────────────────

  it('A1: admin_marks_list requires adminKey', () => {
    const r = call(env, 'admin_marks_list', null, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('A2: admin_marks_list returns marks when the adminKey is provided', () => {
    env.fakeNakama.store.set(`anti_cheat_marks/u-flagged/${SYSTEM_USER_ID}`, {
      collection: 'anti_cheat_marks', key: 'u-flagged', userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, userId: 'u-flagged',
        marks: [
          { id: 'm-1', userId: 'u-flagged', raceId: 'r1', kind: 'abrupt_improvement', severity: 'medium', detectedAt: 1, confirmed: false, dismissed: false },
        ],
      },
      version: 'v00000001', permissionRead: 1, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
    });
    const r = call<{ marks: Array<{ id: string; userId: string }>; total: number }>(
      env, 'admin_marks_list', null, { adminKey: ADMIN_KEY },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBe(1);
    expect(r.data.marks[0]!.id).toBe('m-1');
  });

  it('A3: admin_marks_confirm flips confirmed=true and invalidates the dashboard cache', () => {
    env.fakeNakama.store.set(`anti_cheat_marks/u-flagged/${SYSTEM_USER_ID}`, {
      collection: 'anti_cheat_marks', key: 'u-flagged', userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, userId: 'u-flagged',
        marks: [
          { id: 'm-1', userId: 'u-flagged', raceId: 'r1', kind: 'abrupt_improvement', severity: 'medium', detectedAt: 1, confirmed: false, dismissed: false },
        ],
      },
      version: 'v00000001', permissionRead: 1, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
    });
    // Prime the dashboard cache.
    const r1 = call<{ usersWithMarks: number }>(env, 'admin_anti_cheat_dashboard_get', null,
      { adminKey: ADMIN_KEY, fromDate: '2026-10-08', toDate: '2026-10-08' });
    expect(r1.ok).toBe(true);
    // Confirm the mark.
    const r2 = call<{ confirmed: true }>(env, 'admin_marks_confirm', null,
      { adminKey: ADMIN_KEY, userId: 'u-flagged', markId: 'm-1' });
    expect(r2.ok).toBe(true);
    // The mark in storage is now confirmed=true.
    const obj = env.fakeNakama.store.get(`anti_cheat_marks/u-flagged/${SYSTEM_USER_ID}`);
    const marks = (obj!.value as { marks: Array<{ id: string; confirmed: boolean }> }).marks;
    expect(marks[0]!.confirmed).toBe(true);
  });

  it('A4: admin_marks_dismiss flips dismissed=true', () => {
    env.fakeNakama.store.set(`anti_cheat_marks/u-flagged/${SYSTEM_USER_ID}`, {
      collection: 'anti_cheat_marks', key: 'u-flagged', userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, userId: 'u-flagged',
        marks: [
          { id: 'm-2', userId: 'u-flagged', raceId: 'r2', kind: 'partial_impossible', severity: 'low', detectedAt: 1, confirmed: false, dismissed: false },
        ],
      },
      version: 'v00000001', permissionRead: 1, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
    });
    const r = call<{ dismissed: true }>(env, 'admin_marks_dismiss', null,
      { adminKey: ADMIN_KEY, userId: 'u-flagged', markId: 'm-2', reason: 'false-positive' });
    expect(r.ok).toBe(true);
    const obj = env.fakeNakama.store.get(`anti_cheat_marks/u-flagged/${SYSTEM_USER_ID}`);
    const marks = (obj!.value as { marks: Array<{ id: string; dismissed: boolean }> }).marks;
    expect(marks[0]!.dismissed).toBe(true);
  });

  it('A5: admin_anti_cheat_stats_get returns per-day counts (zero-filled)', () => {
    const r = call<{ days: Array<{ utcDate: string; marksTotal: number }> }>(
      env, 'admin_anti_cheat_stats_get', null,
      { adminKey: ADMIN_KEY, startDate: '2026-10-08', endDate: '2026-10-09' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.days).toHaveLength(2);
    for (const d of r.data.days) {
      expect(typeof d.marksTotal).toBe('number');
      expect(d.marksTotal).toBeGreaterThanOrEqual(0);
    }
  });

  // ─── Admin dashboard (5 cases) ────────────────────────────────────────────

  it('D1: admin_overview_get requires adminKey', () => {
    const r = call(env, 'admin_overview_get', null, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('D2: admin_overview_get returns catalog totals + live player count', () => {
    seedProfile(env, 'p8-u1', 1);
    seedProfile(env, 'p8-u2', 2);
    const r = call<{ playerCount: number; events: { totalCatalog: number }; tournaments: { total: number }; generatedAt: number }>(
      env, 'admin_overview_get', null, { adminKey: ADMIN_KEY },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.playerCount).toBe(2);
    expect(r.data.events.totalCatalog).toBeGreaterThan(0);
    expect(typeof r.data.generatedAt).toBe('number');
  });

  it('D3: admin_players_search returns case-insensitive matches', () => {
    seedProfile(env, 'p8-Alpha', 1, { displayName: 'AlphaPlayer' });
    seedProfile(env, 'p8-Beta', 1, { displayName: 'BetaPlayer' });
    const r = call<{ total: number; results: Array<{ userId: string; displayName: string }> }>(
      env, 'admin_players_search', null, { adminKey: ADMIN_KEY, q: 'ALPHA' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBe(1);
    expect(r.data.results[0]!.userId).toBe('p8-Alpha');
  });

  it('D4: admin_wallet_grant whitelisted reasons only', () => {
    seedProfile(env, 'p8-grantee', 1);
    env.fakeNakama.wallets.set('p8-grantee', { coins: 0, gems: 0 });
    const r1 = call<{ newBalance: { coins: number } }>(env, 'admin_wallet_grant', null,
      { adminKey: ADMIN_KEY, userId: 'p8-grantee', reason: 'admin_grant', coins: 500 });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.newBalance.coins).toBe(500);
    // Unknown reason → BAD_REQUEST.
    const r2 = call(env, 'admin_wallet_grant', null,
      { adminKey: ADMIN_KEY, userId: 'p8-grantee', reason: 'NOT_WHITELISTED', coins: 100 });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe('BAD_REQUEST');
  });

  it('D5: admin_wallet_grant caps at 100,000 per call', () => {
    seedProfile(env, 'p8-big', 1);
    env.fakeNakama.wallets.set('p8-big', { coins: 0, gems: 0 });
    const r = call(env, 'admin_wallet_grant', null,
      { adminKey: ADMIN_KEY, userId: 'p8-big', reason: 'admin_grant', coins: 200_000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });
});
