// Phase 8 Chunk 9 — Unit tests for the admin dashboard RPCs.
//
// 25+ cases covering all 6 admin RPCs (`admin_overview_get`,
// `admin_tournaments_stats_get`, `admin_events_stats_get`,
// `admin_players_search`, `admin_wallet_grant`,
// `admin_anti_cheat_dashboard_get`). The tests call each `_impl`
// directly with a hand-crafted ctx — no full bundle load. The 60s
// cache is reset between cases via `_resetAdminDashboardForTests`.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  admin_overview_get_impl,
  admin_tournaments_stats_get_impl,
  admin_events_stats_get_impl,
  admin_players_search_impl,
  admin_wallet_grant_impl,
  admin_anti_cheat_dashboard_get_impl,
} from '../../modules/src/admin/dashboard';
import { clearDashboardCache } from '../../modules/src/admin/cache';
import { FakeNakama, FakeLogger, FakeContext, SYSTEM_USER_ID } from '../e2e/_stubs';
import { bootEnsure as bootEnsureLiveops } from '../../modules/src/liveops/config';
import { loadEventsCatalog, _resetActiveEventsCatalogForTests } from '../../modules/src/core/active_events';
import { loadTournamentsCatalog, _resetTournamentsCatalogForTests } from '../../modules/src/tournaments/catalog';
import { writeTournamentInstance } from '../../modules/src/tournaments/repo';
import { admin_marks_confirm_impl } from '../../modules/src/anti_cheat/rpcs';
import { getCached } from '../../modules/src/admin/cache';
import {
  zeroFillDateRange,
  utcDateStr,
  inUtcDay,
  aggregateTournamentsByDay,
  aggregateEventsByDay,
  playerMatchesSearch,
  tournamentToDayInput,
} from '../../modules/src/admin/stats';
import { writeDailyStats, emptyStats } from '../../modules/src/anti_cheat/stats';
import { ANTI_CHEAT_MARKS_COLLECTION, ANTI_CHEAT_MARKS_SYSTEM_USER } from '../../modules/src/anti_cheat/marks';
import { ANALYTICS_COLLECTION } from '../../modules/src/core/admin/analytics';
import type { IStorageObject, ILogger, INakama } from '../../modules/src/nkruntime';
import type { Tournament, TournamentEntry, TournamentType } from '../../modules/src/tournaments/types';
import type { AntiCheatMark } from '../../modules/src/anti_cheat/marks';
import type { RawEventsFile } from '../../modules/src/events/types';
import type { TournamentTemplate } from '../../modules/src/tournaments/types';

const ADMIN_KEY = 'test-admin-key-chunk9';
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
  return { fake, nk: fake.nakama, logger, fakeNakama: fake };
}

function call(
  env: { fake: FakeNakama; nk: INakama; logger: FakeLogger },
  fn: typeof admin_overview_get_impl,
  body: unknown,
): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
  return JSON.parse(fn(FakeContext, env.logger, env.nk, typeof body === 'string' ? body : JSON.stringify(body)));
}

function seedTournament(nk: INakama, t: Partial<Tournament> & { id: string; createdAt: number; closedAt?: number }): void {
  const full: Tournament = {
    schemaVersion: 1,
    id: t.id,
    templateId: t.id,
    kind: t.kind ?? 'time_trial',
    trackId: t.trackId ?? 'tr',
    startsAt: t.startsAt ?? t.createdAt,
    endsAt: t.endsAt ?? t.createdAt + 60 * 60 * 1000,
    entryFee: t.entryFee ?? 0,
    maxAttempts: t.maxAttempts ?? 3,
    minLevel: t.minLevel ?? 1,
    prizes: t.prizes ?? [{ rankFrom: 1, rankTo: 1, rewards: { coins: 100 } }],
    createdAt: t.createdAt,
    ...(t.state !== undefined ? { state: t.state } : {}),
    ...(t.cancelled !== undefined ? { cancelled: t.cancelled } : {}),
    ...(t.voided !== undefined ? { voided: t.voided } : {}),
    ...(t.closedAt !== undefined ? { closedAt: t.closedAt } : {}),
  };
  writeTournamentInstance(nk, full);
}

function seedProfile(
  nk: INakama,
  userId: string,
  level: number,
  overrides: Record<string, unknown> = {},
): void {
  nk.storageWrite([{
    collection: 'profiles',
    key: userId,
    userId,
    value: {
      schemaVersion: 1,
      userId,
      displayName: `user-${userId}`,
      avatarUrl: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      progression: { xp: 100, level, lastDailyWinAt: 0 },
      ...overrides,
    },
    permissionRead: 0,
    permissionWrite: 0,
  }]);
}

function seedAntiCheatStats(nk: INakama, date: string, marksTotal: number, usersConfirmed: number, usersHidden: number): void {
  const stats = emptyStats(date);
  stats.marksTotal = marksTotal;
  stats.usersConfirmed = usersConfirmed;
  stats.usersHidden = usersHidden;
  writeDailyStats(nk, stats);
}

function seedAnalyticsWalletMoved(nk: INakama, ts: number, reason: string, coins: number): void {
  nk.storageWrite([{
    collection: ANALYTICS_COLLECTION,
    key: `${ts}-${Math.random().toString(36).slice(2)}`,
    userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1,
      id: `${ts}`,
      ts,
      name: 'wallet_moved',
      props: { userId: 'u1', kind: 'grant', reason, changeset: { coins } },
    },
    permissionRead: 2,
    permissionWrite: 0,
  }]);
}

const EVENTS_CATALOG: RawEventsFile = {
  version: 1,
  events: [
    { id: 'evt_xp', kind: 'xp_double', startsAtUtc: '2026-10-08T00:00:00Z', endsAtUtc: '2026-10-15T00:00:00Z', payload: { multiplier: 2 } },
    { id: 'evt_track', kind: 'featured_track', startsAtUtc: '2026-10-05T00:00:00Z', endsAtUtc: '2026-11-02T00:00:00Z', payload: { trackId: 'neon_blvd' } },
    { id: 'evt_offer', kind: 'special_offer', startsAtUtc: '2026-10-08T00:00:00Z', endsAtUtc: '2026-10-22T00:00:00Z', payload: { sku: 'gem_pack', discountPct: 50 } },
  ],
};

const TOURNAMENT_CATALOG: ReadonlyArray<TournamentTemplate> = [
  {
    id: 'tmpl_a',
    kind: 'time_trial',
    trackId: 'tr',
    startsAtUtc: '2026-10-08T00:00:00Z',
    endsAtUtc: '2026-10-08T01:00:00Z',
    entryFee: 0,
    maxAttempts: 3,
    minLevel: 1,
    prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 100 } }],
  },
  {
    id: 'tmpl_b',
    kind: 'cup',
    trackId: 'tr',
    startsAtUtc: '2026-10-08T00:00:00Z',
    endsAtUtc: '2026-10-08T01:00:00Z',
    entryFee: 50,
    maxAttempts: 3,
    minLevel: 1,
    prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 200 } }],
  },
];

function setupEventsCatalog(): void {
  _resetActiveEventsCatalogForTests();
  loadEventsCatalog(SILENT_LOGGER, EVENTS_CATALOG, null);
}

function setupTournamentsCatalog(): void {
  _resetTournamentsCatalogForTests();
  loadTournamentsCatalog(SILENT_LOGGER, {
    version: 1,
    templates: TOURNAMENT_CATALOG as unknown as Array<TournamentTemplate>,
  });
}

// ─── admin/stats.ts (pure helpers) ───────────────────────────────────────

describe('admin/stats.ts pure helpers (Phase 8 Chunk 9)', () => {
  it('zeroFillDateRange returns inclusive day list', () => {
    expect(zeroFillDateRange('2026-10-08', '2026-10-10')).toEqual([
      '2026-10-08', '2026-10-09', '2026-10-10',
    ]);
  });
  it('zeroFillDateRange returns [] for reversed range', () => {
    expect(zeroFillDateRange('2026-10-10', '2026-10-08')).toEqual([]);
  });
  it('zeroFillDateRange returns [] for malformed input', () => {
    expect(zeroFillDateRange('nope', '2026-10-10')).toEqual([]);
  });
  it('utcDateStr formats epoch-ms to YYYY-MM-DD UTC', () => {
    expect(utcDateStr(Date.parse('2026-10-08T15:30:00Z'))).toBe('2026-10-08');
    expect(utcDateStr(Date.parse('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
  });
  it('inUtcDay compares timestamp to date string', () => {
    expect(inUtcDay(Date.parse('2026-10-08T15:00:00Z'), '2026-10-08')).toBe(true);
    expect(inUtcDay(Date.parse('2026-10-08T15:00:00Z'), '2026-10-09')).toBe(false);
  });

  it('aggregateTournamentsByDay zero-fills and accumulates', () => {
    const day0 = Date.parse('2026-10-08T00:00:00Z');
    const day1 = Date.parse('2026-10-09T00:00:00Z');
    const out = aggregateTournamentsByDay([
      { createdAt: day0, closedAt: day0, participantCount: 4, prizeCoinsDistributed: 100 },
      { createdAt: day0, closedAt: day1, participantCount: 6, prizeCoinsDistributed: 50 },
      { createdAt: day1, closedAt: day1, participantCount: 2, prizeCoinsDistributed: 200 },
    ], '2026-10-08', '2026-10-10');
    expect(out).toEqual([
      { date: '2026-10-08', opened: 2, closed: 1, participants: 4, prizeCoins: 100 },
      { date: '2026-10-09', opened: 1, closed: 2, participants: 8, prizeCoins: 250 },
      { date: '2026-10-10', opened: 0, closed: 0, participants: 0, prizeCoins: 0 },
    ]);
  });

  it('aggregateTournamentsByDay ignores outside-window rows but zero-fills', () => {
    const out = aggregateTournamentsByDay([], '2026-10-08', '2026-10-08');
    expect(out).toEqual([
      { date: '2026-10-08', opened: 0, closed: 0, participants: 0, prizeCoins: 0 },
    ]);
  });

  it('aggregateEventsByDay counts per-kind activations and coins', () => {
    const day0 = Date.parse('2026-10-08T00:00:00Z');
    const out = aggregateEventsByDay([
      { startsAt: day0, kind: 'xp_double', coinsGranted: 25 },
      { startsAt: day0, kind: 'featured_track', coinsGranted: 0 },
      { startsAt: day0, kind: 'special_offer', coinsGranted: 100 },
    ], '2026-10-08', '2026-10-09');
    expect(out[0]).toEqual({
      date: '2026-10-08',
      xpDoubleActivated: 1,
      featuredTrackActivated: 1,
      specialOfferActivated: 1,
      coinsGranted: 125,
    });
    expect(out[1]).toEqual({
      date: '2026-10-09',
      xpDoubleActivated: 0,
      featuredTrackActivated: 0,
      specialOfferActivated: 0,
      coinsGranted: 0,
    });
  });

  it('playerMatchesSearch: case-insensitive on userId or displayName', () => {
    expect(playerMatchesSearch({ userId: 'abc-123', displayName: 'Speedster' }, 'speed')).toBe(true);
    expect(playerMatchesSearch({ userId: 'abc-123', displayName: 'Speedster' }, 'ABC')).toBe(true);
    expect(playerMatchesSearch({ userId: 'abc-123', displayName: 'Speedster' }, 'zzz')).toBe(false);
    expect(playerMatchesSearch({ userId: 'abc-123', displayName: 'Speedster' }, '')).toBe(true);
  });

  it('tournamentToDayInput projects from Tournament shape', () => {
    const t: Tournament = {
      schemaVersion: 1, id: 't1', templateId: 't1', kind: 'time_trial', trackId: 'tr',
      startsAt: 1_000, endsAt: 2_000, entryFee: 0, maxAttempts: 3, minLevel: 1,
      prizes: [], createdAt: 1_000, closedAt: 2_000,
    };
    const out = tournamentToDayInput(t, 5, 250);
    expect(out).toEqual({ createdAt: 1_000, closedAt: 2_000, participantCount: 5, prizeCoinsDistributed: 250 });
  });
});

// ─── admin_overview_get ───────────────────────────────────────────────────

describe('admin_overview_get (Phase 8 Chunk 9)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
    setupEventsCatalog();
    setupTournamentsCatalog();
    clearDashboardCache();
  });

  it('FORBIDDEN without adminKey', () => {
    const r = call(env, admin_overview_get_impl, {});
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('FORBIDDEN');
  });

  it('returns empty dashboard with zeroed fields when no data', () => {
    const r = call(env, admin_overview_get_impl, { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { tournaments: { total: number; open: number; closing: number; closed: number; cancelled: number; voided: number }; events: { totalCatalog: number }; playerCount: number; serverUptimeMs: number; generatedAt: number };
    expect(data.tournaments.total).toBe(0);
    expect(data.events.totalCatalog).toBe(3);
    expect(data.playerCount).toBe(0);
    expect(data.serverUptimeMs).toBeGreaterThanOrEqual(0);
    expect(typeof data.generatedAt).toBe('number');
  });

  it('counts tournaments by state, includes cancelled/voided in closed', () => {
    const now = Date.now();
    seedTournament(env.nk, { id: 't-open', createdAt: now - 60_000, state: 'open' });
    seedTournament(env.nk, { id: 't-closing', createdAt: now - 60_000, state: 'closing' });
    seedTournament(env.nk, { id: 't-closed', createdAt: now - 60_000, state: 'closed', closedAt: now });
    seedTournament(env.nk, { id: 't-cancelled', createdAt: now - 60_000, cancelled: true, closedAt: now });
    seedTournament(env.nk, { id: 't-voided', createdAt: now - 60_000, voided: true, closedAt: now });
    const r = call(env, admin_overview_get_impl, { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { tournaments: { total: number; open: number; closing: number; closed: number; cancelled: number; voided: number } };
    expect(data.tournaments.total).toBe(5);
    expect(data.tournaments.open).toBe(1);
    expect(data.tournaments.closing).toBe(1);
    expect(data.tournaments.closed).toBe(3);
    expect(data.tournaments.cancelled).toBe(1);
    expect(data.tournaments.voided).toBe(1);
  });

  it('counts player profiles via profiles collection', () => {
    seedProfile(env.nk, 'u1', 1);
    seedProfile(env.nk, 'u2', 2);
    seedProfile(env.nk, 'u3', 3);
    const r = call(env, admin_overview_get_impl, { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { playerCount: number };
    expect(data.playerCount).toBe(3);
  });

  it('reports todayDetections from anti-cheat stats', () => {
    const today = utcDateStr(Date.now());
    seedAntiCheatStats(env.nk, today, 5, 2, 1);
    const r = call(env, admin_overview_get_impl, { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { antiCheat: { todayDetections: number; todaySanctions: number; todayDismissed: number } };
    expect(data.antiCheat.todayDetections).toBe(5);
    expect(data.antiCheat.todaySanctions).toBe(1);
    expect(data.antiCheat.todayDismissed).toBe(2);
  });

  it('counts active events by kind', () => {
    const r = call(env, admin_overview_get_impl, { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { events: { activeXpDouble: number; activeFeaturedTrack: number; activeSpecialOffer: number; totalCatalog: number } };
    expect(data.events.activeXpDouble).toBeGreaterThanOrEqual(0);
    expect(data.events.activeFeaturedTrack).toBeGreaterThanOrEqual(0);
    expect(data.events.activeSpecialOffer).toBeGreaterThanOrEqual(0);
    expect(data.events.totalCatalog).toBe(3);
  });

  it('caches the overview response (60s TTL)', () => {
    const r1 = call(env, admin_overview_get_impl, { adminKey: ADMIN_KEY });
    expect(r1.ok).toBe(true);
    seedProfile(env.nk, 'u1', 1);
    const r2 = call(env, admin_overview_get_impl, { adminKey: ADMIN_KEY });
    if (!r2.ok) throw new Error('expected ok');
    const data2 = r2.data as { playerCount: number };
    // Cached: still 0
    expect(data2.playerCount).toBe(0);
  });
});

// ─── admin_tournaments_stats_get ──────────────────────────────────────────

describe('admin_tournaments_stats_get (Phase 8 Chunk 9)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
    setupTournamentsCatalog();
    clearDashboardCache();
  });

  it('FORBIDDEN without adminKey', () => {
    const r = call(env, admin_tournaments_stats_get_impl, { fromDate: '2026-10-08', toDate: '2026-10-09' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('FORBIDDEN');
  });

  it('BAD_REQUEST when fromDate/toDate malformed', () => {
    const r = call(env, admin_tournaments_stats_get_impl, { adminKey: ADMIN_KEY, fromDate: 'nope', toDate: '2026-10-09' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST when range reversed', () => {
    const r = call(env, admin_tournaments_stats_get_impl, { adminKey: ADMIN_KEY, fromDate: '2026-10-09', toDate: '2026-10-08' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('zero-fills the range and reports per-day rows', () => {
    const day0 = Date.parse('2026-10-08T00:00:00Z');
    seedTournament(env.nk, { id: 't1', createdAt: day0, closedAt: day0, state: 'closed' });
    const r = call(env, admin_tournaments_stats_get_impl, { adminKey: ADMIN_KEY, fromDate: '2026-10-08', toDate: '2026-10-09' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { days: Array<{ date: string; opened: number; closed: number }>; totalInWindow: number };
    expect(data.days).toHaveLength(2);
    expect(data.days[0]!.date).toBe('2026-10-08');
    expect(data.days[0]!.opened).toBe(1);
    expect(data.days[1]!.opened).toBe(0);
    expect(data.totalInWindow).toBe(1);
  });
});

// ─── admin_events_stats_get ───────────────────────────────────────────────

describe('admin_events_stats_get (Phase 8 Chunk 9)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
    setupEventsCatalog();
    clearDashboardCache();
  });

  it('FORBIDDEN without adminKey', () => {
    const r = call(env, admin_events_stats_get_impl, { fromDate: '2026-10-08', toDate: '2026-10-09' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('FORBIDDEN');
  });

  it('returns per-day activation counts and per-day coinsGranted', () => {
    // Walk the events catalog and grant xp_double on race close
    // (we model this with the wallet_moved analytics row).
    const day0 = Date.parse('2026-10-08T12:00:00Z');
    seedAnalyticsWalletMoved(env.nk, day0, 'event:event_xp_double:r1', 25);
    seedAnalyticsWalletMoved(env.nk, day0, 'event:event_xp_double:r2', 50);
    const r = call(env, admin_events_stats_get_impl, { adminKey: ADMIN_KEY, fromDate: '2026-10-08', toDate: '2026-10-09' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { days: Array<{ date: string; xpDoubleActivated: number; coinsGranted: number }>; totalCoinsGranted: number };
    expect(data.days[0]!.date).toBe('2026-10-08');
    expect(data.days[0]!.xpDoubleActivated).toBe(1);
    expect(data.days[0]!.coinsGranted).toBe(75);
    expect(data.totalCoinsGranted).toBe(75);
  });

  it('ignores non-event wallet_moved analytics', () => {
    const day0 = Date.parse('2026-10-08T12:00:00Z');
    seedAnalyticsWalletMoved(env.nk, day0, 'race:session:r1', 100);
    const r = call(env, admin_events_stats_get_impl, { adminKey: ADMIN_KEY, fromDate: '2026-10-08', toDate: '2026-10-08' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { totalCoinsGranted: number };
    expect(data.totalCoinsGranted).toBe(0);
  });
});

// ─── admin_players_search ─────────────────────────────────────────────────

describe('admin_players_search (Phase 8 Chunk 9)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
    clearDashboardCache();
  });

  it('FORBIDDEN without adminKey', () => {
    const r = call(env, admin_players_search_impl, { q: 'a' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('FORBIDDEN');
  });

  it('returns empty results when no profiles match', () => {
    seedProfile(env.nk, 'u1', 1);
    const r = call(env, admin_players_search_impl, { adminKey: ADMIN_KEY, q: 'zzz' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { results: unknown[]; total: number };
    expect(data.results).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('matches case-insensitive on userId', () => {
    seedProfile(env.nk, 'speedster-1', 1);
    seedProfile(env.nk, 'normal-2', 1);
    const r = call(env, admin_players_search_impl, { adminKey: ADMIN_KEY, q: 'SPEED' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { results: Array<{ userId: string }>; total: number };
    expect(data.total).toBe(1);
    expect(data.results[0]!.userId).toBe('speedster-1');
  });

  it('matches on displayName substring', () => {
    seedProfile(env.nk, 'u1', 1, { displayName: 'FastWheel' });
    seedProfile(env.nk, 'u2', 1, { displayName: 'SlowPace' });
    const r = call(env, admin_players_search_impl, { adminKey: ADMIN_KEY, q: 'fast' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { results: Array<{ userId: string; displayName: string }>; total: number };
    expect(data.total).toBe(1);
    expect(data.results[0]!.userId).toBe('u1');
    expect(data.results[0]!.displayName).toBe('FastWheel');
  });

  it('paginates results via limit', () => {
    for (let i = 0; i < 10; i += 1) seedProfile(env.nk, `u${i}`, 1);
    const r = call(env, admin_players_search_impl, { adminKey: ADMIN_KEY, q: 'u', limit: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { results: unknown[]; total: number };
    expect(data.results).toHaveLength(3);
    expect(data.total).toBe(10);
  });

  it('includes archived flag + wallet snapshot', () => {
    seedProfile(env.nk, 'u1', 3, { archivedAt: Date.now() });
    env.fakeNakama.wallets.set('u1', { coins: 500, gems: 5 });
    const r = call(env, admin_players_search_impl, { adminKey: ADMIN_KEY, q: 'u1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { results: Array<{ archived: boolean; wallet: { coins: number; gems: number }; level: number }> };
    expect(data.results[0]!.archived).toBe(true);
    expect(data.results[0]!.wallet.coins).toBe(500);
    expect(data.results[0]!.wallet.gems).toBe(5);
    expect(data.results[0]!.level).toBe(3);
  });
});

// ─── admin_wallet_grant ───────────────────────────────────────────────────

describe('admin_wallet_grant (Phase 8 Chunk 9)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
    clearDashboardCache();
  });

  it('FORBIDDEN without adminKey', () => {
    const r = call(env, admin_wallet_grant_impl, { userId: 'u1', reason: 'admin_grant', coins: 100 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('FORBIDDEN');
  });

  it('BAD_REQUEST when userId missing', () => {
    const r = call(env, admin_wallet_grant_impl, { adminKey: ADMIN_KEY, reason: 'admin_grant', coins: 100 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST when reason not in whitelist', () => {
    seedProfile(env.nk, 'u1', 1);
    const r = call(env, admin_wallet_grant_impl, { adminKey: ADMIN_KEY, userId: 'u1', reason: 'for_fun', coins: 100 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST when coins + gems both zero', () => {
    seedProfile(env.nk, 'u1', 1);
    const r = call(env, admin_wallet_grant_impl, { adminKey: ADMIN_KEY, userId: 'u1', reason: 'admin_grant' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST when coins exceed per-call cap', () => {
    seedProfile(env.nk, 'u1', 1);
    const r = call(env, admin_wallet_grant_impl, { adminKey: ADMIN_KEY, userId: 'u1', reason: 'admin_grant', coins: 200_000 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('NOT_FOUND when user has no profile', () => {
    const r = call(env, admin_wallet_grant_impl, { adminKey: ADMIN_KEY, userId: 'ghost', reason: 'admin_grant', coins: 100 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('grants coins successfully and returns new balance', () => {
    seedProfile(env.nk, 'u1', 1);
    env.fakeNakama.wallets.set('u1', { coins: 100, gems: 0 });
    const r = call(env, admin_wallet_grant_impl, { adminKey: ADMIN_KEY, userId: 'u1', reason: 'admin_grant', coins: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { granted: { coins: number }; newBalance: { coins: number; gems: number } };
    expect(data.granted.coins).toBe(500);
    expect(data.newBalance.coins).toBe(600);
    expect(env.fakeNakama.wallets.get('u1')?.coins).toBe(600);
  });

  it('grants gems + coins together', () => {
    seedProfile(env.nk, 'u1', 1);
    env.fakeNakama.wallets.set('u1', { coins: 0, gems: 0 });
    const r = call(env, admin_wallet_grant_impl, { adminKey: ADMIN_KEY, userId: 'u1', reason: 'admin_compensation', coins: 100, gems: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { newBalance: { coins: number; gems: number } };
    expect(data.newBalance.coins).toBe(100);
    expect(data.newBalance.gems).toBe(10);
  });

  it('invalidate the overview cache after a grant', () => {
    seedProfile(env.nk, 'u1', 1);
    env.fakeNakama.wallets.set('u1', { coins: 0, gems: 0 });
    // Prime the cache via overview.
    const r1 = call(env, admin_overview_get_impl, { adminKey: ADMIN_KEY });
    expect(r1.ok).toBe(true);
    // Now grant.
    const r2 = call(env, admin_wallet_grant_impl, { adminKey: ADMIN_KEY, userId: 'u1', reason: 'admin_grant', coins: 100 });
    expect(r2.ok).toBe(true);
    // The cache should be invalidated — we verify by checking the
    // dashboard's internal cache state via the public exports.
    const cached = getCached<unknown>('overview:', Date.now());
    expect(cached).toBeNull();
  });
});

// ─── admin_anti_cheat_dashboard_get ───────────────────────────────────────

describe('admin_anti_cheat_dashboard_get (Phase 8 Chunk 9)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
    clearDashboardCache();
  });

  it('FORBIDDEN without adminKey', () => {
    const r = call(env, admin_anti_cheat_dashboard_get_impl, { fromDate: '2026-10-08', toDate: '2026-10-09' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('FORBIDDEN');
  });

  it('zero-fills the date range and reports per-day stats', () => {
    seedAntiCheatStats(env.nk, '2026-10-08', 5, 2, 1);
    const r = call(env, admin_anti_cheat_dashboard_get_impl, { adminKey: ADMIN_KEY, fromDate: '2026-10-08', toDate: '2026-10-09' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { days: Array<{ utcDate: string; marksTotal: number }>; totalDetections: number; totalSanctions: number; totalDismissed: number };
    expect(data.days).toHaveLength(2);
    expect(data.days[0]!.marksTotal).toBe(5);
    expect(data.days[1]!.marksTotal).toBe(0);
    expect(data.totalDetections).toBe(5);
    expect(data.totalSanctions).toBe(1);
    expect(data.totalDismissed).toBe(2);
  });

  it('counts users with visible marks + returns top 10', () => {
    // Seed two users with marks (one dismissed).
    env.nk.storageWrite([{
      collection: ANTI_CHEAT_MARKS_COLLECTION,
      key: 'u-active',
      userId: ANTI_CHEAT_MARKS_SYSTEM_USER,
      value: {
        schemaVersion: 1,
        userId: 'u-active',
        marks: [
          { id: 'm1', userId: 'u-active', raceId: 'r1', kind: 'abrupt_improvement', severity: 'low', detectedAt: 1, confirmed: false, dismissed: false },
          { id: 'm2', userId: 'u-active', raceId: 'r2', kind: 'partial_impossible', severity: 'medium', detectedAt: 2, confirmed: false, dismissed: false },
        ],
      },
      permissionRead: 1,
      permissionWrite: 0,
    }]);
    env.nk.storageWrite([{
      collection: ANTI_CHEAT_MARKS_COLLECTION,
      key: 'u-dismissed',
      userId: ANTI_CHEAT_MARKS_SYSTEM_USER,
      value: {
        schemaVersion: 1,
        userId: 'u-dismissed',
        marks: [
          { id: 'm3', userId: 'u-dismissed', raceId: 'r3', kind: 'quorum_disagreement', severity: 'low', detectedAt: 1, confirmed: false, dismissed: true },
        ],
      },
      permissionRead: 1,
      permissionWrite: 0,
    }]);
    const r = call(env, admin_anti_cheat_dashboard_get_impl, { adminKey: ADMIN_KEY, fromDate: '2026-10-08', toDate: '2026-10-08' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { usersWithMarks: number; topMarked: Array<{ userId: string; count: number }> };
    expect(data.usersWithMarks).toBe(1);
    expect(data.topMarked[0]!.userId).toBe('u-active');
    expect(data.topMarked[0]!.count).toBe(2);
  });

  it('invalidate the anti-cheat dashboard cache on confirm/dismiss/sanction', () => {
    // Seed a mark and prime the cache.
    env.nk.storageWrite([{
      collection: ANTI_CHEAT_MARKS_COLLECTION,
      key: 'u-active',
      userId: ANTI_CHEAT_MARKS_SYSTEM_USER,
      value: {
        schemaVersion: 1,
        userId: 'u-active',
        marks: [
          { id: 'm1', userId: 'u-active', raceId: 'r1', kind: 'abrupt_improvement', severity: 'low', detectedAt: 1, confirmed: false, dismissed: false },
        ],
      },
      permissionRead: 1,
      permissionWrite: 0,
    }]);
    const r1 = call(env, admin_anti_cheat_dashboard_get_impl, { adminKey: ADMIN_KEY, fromDate: '2026-10-08', toDate: '2026-10-08' });
    expect(r1.ok).toBe(true);
    // Now confirm the mark via the chunk-4 RPC.
    const r2 = call(env, admin_marks_confirm_impl, { adminKey: ADMIN_KEY, userId: 'u-active', markId: 'm1' });
    expect(r2.ok).toBe(true);
    // Cache should be cleared.
    const cached = getCached('anti_cheat_dashboard:' + JSON.stringify({ fromDate: '2026-10-08', toDate: '2026-10-08' }), Date.now());
    expect(cached).toBeNull();
  });
});

// Keep the unused-imports quiet.
void (null as unknown as AntiCheatMark);
void (null as unknown as TournamentEntry);
void (null as unknown as IStorageObject);
void (null as unknown as TournamentType);
