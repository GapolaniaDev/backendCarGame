// Phase 8 Chunk 9 — Admin dashboard RPCs (6).
//
// All 6 share the same preamble as `admin/rpcs.ts`:
//   - `parseInput` → `assertAdminKey` (Phase 5 D7) → service call
//   - Bypass the maintenance gate (admin ops continue during pause)
//   - Each RPC emits `admin_action` analytics (audit trail)
//   - Each RPC is registered with a top-level `registerRpc` call in
//     `main.ts` (Nakama goja AST scanner requires top-level expr)
//
// Cache: 60s in-memory TTL per RPC (see `./cache`). The cache is keyed
// by RPC + a stable signature of the inputs (e.g. `fromDate/toDate`).
// Manual mutations (anti-cheat confirm/dismiss/sanction, wallet grant)
// call `invalidateDashboardCache` to drop matching entries.
//
// Pattern matches the rest of the admin surface: each handler exports
// both `<name>_impl: RpcHandler` (testable) and a bare
// `export const <name>: RpcHandler` for the goja scanner.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { assertAdminKey, withoutAdminKey } from './auth';
import { emitAdminAction } from '../core/admin/analytics';
import { serverNowMs, utcDate } from '../core/time';
import { grant, walletGet } from '../economy/wallet';
import { activeEvents, getEventsCatalog } from '../core/active_events';
import {
  aggregateTournamentsByDay,
  aggregateEventsByDay,
  playerMatchesSearch,
  tournamentToDayInput,
  zeroFillDateRange,
  type TournamentDayInput,
  type EventDayInput,
} from './stats';
import { getCached, setCached, buildCacheKey, invalidateDashboardCache } from './cache';
import {
  listAllInstances,
} from '../tournaments/scanner';
import {
  listAllEntries,
} from '../tournaments/repo';
import { distributePrizes, type PrizeDistributionRow } from '../tournaments/prizes';
import { topN } from '../tournaments/leaderboard';
import { type AntiCheatMark } from '../anti_cheat/marks';
import {
  readDailyStats,
  ANTI_CHEAT_STATS_SYSTEM_USER,
  type DailyAntiCheatStats,
} from '../anti_cheat/stats';
import { ANALYTICS_COLLECTION, type AnalyticsEvent } from '../core/admin/analytics';
import { getTournamentTemplates } from '../tournaments/catalog';
import type { Tournament, TournamentType } from '../tournaments/types';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

const ERR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
  'RATE_LIMITED', 'INVALID_RESULT', 'INTERNAL', 'CATALOG_INVALID',
  'INSUFFICIENT_FUNDS', 'SERVICE_UNAVAILABLE', 'UPGRADE_REQUIRED',
  'NOT_IMPLEMENTED',
]);
function asCode(code: string | undefined): ErrorCode {
  if (code !== undefined && (ERR_CODES as Set<string>).has(code)) return code as ErrorCode;
  return 'INTERNAL';
}

const ADMIN_WALLET_GRANT_REASONS: ReadonlySet<string> = new Set([
  'admin_grant',
  'admin_compensation',
  'admin_tournament_refund',
  'admin_event_compensation',
  'admin_other',
]);

const ANTI_CHEAT_DASHBOARD_CACHE_PREFIX = 'anti_cheat_dashboard:';
const OVERVIEW_CACHE_PREFIX = 'overview:';
const TOURNAMENT_STATS_CACHE_PREFIX = 'tournament_stats:';
const EVENTS_STATS_CACHE_PREFIX = 'events_stats:';
const PLAYERS_SEARCH_CACHE_PREFIX = 'players_search:';

const WALLET_GRANT_MAX_PER_CALL = 100_000;

function readString(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  return typeof v === 'string' ? v : '';
}
function readNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function adminPrelude(
  _ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
):
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string } {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed;
  const raw = parsed.raw;
  const auth = assertAdminKey(logger, nk, raw);
  if (!auth.ok) return auth;
  return { ok: true, raw };
}

function parseDateRange(
  raw: Record<string, unknown>,
): { ok: true; fromDate: string; toDate: string } | { ok: false; error: string } {
  const fromRaw = raw['fromDate'];
  const toRaw = raw['toDate'];
  if (typeof fromRaw !== 'string' || typeof toRaw !== 'string') {
    return { ok: false, error: JSON.stringify(err('BAD_REQUEST', 'fromDate and toDate are required (YYYY-MM-DD)')) };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(toRaw)) {
    return { ok: false, error: JSON.stringify(err('BAD_REQUEST', 'fromDate/toDate must be YYYY-MM-DD')) };
  }
  const days = zeroFillDateRange(fromRaw, toRaw);
  if (days.length === 0) {
    return { ok: false, error: JSON.stringify(err('BAD_REQUEST', 'invalid date range (toDate < fromDate)')) };
  }
  if (days.length > 366) {
    return { ok: false, error: JSON.stringify(err('BAD_REQUEST', 'range too large (max 366 days)')) };
  }
  return { ok: true, fromDate: fromRaw, toDate: toRaw };
}

// ─── admin_overview_get ───────────────────────────────────────────────────

export interface AdminOverviewGetInput {
  adminKey: string;
}

export interface AdminOverviewTournamentsRow {
  total: number;
  open: number;
  closing: number;
  closed: number;
  cancelled: number;
  voided: number;
}

export interface AdminOverviewEventsRow {
  activeXpDouble: number;
  activeFeaturedTrack: number;
  activeSpecialOffer: number;
  totalCatalog: number;
}

export interface AdminOverviewAntiCheatRow {
  /** Aggregate count of all marks across all users (sampled via storageList). */
  totalMarks: number;
  /** Sum of today's stats, when today is in the anti-cheat stats table. */
  todayDetections: number;
  todaySanctions: number;
  todayDismissed: number;
}

export interface AdminOverviewGetOutput {
  generatedAt: number;
  serverUptimeMs: number;
  tournaments: AdminOverviewTournamentsRow;
  events: AdminOverviewEventsRow;
  antiCheat: AdminOverviewAntiCheatRow;
  /** Number of unique users with a `profiles/{userId}` row. */
  playerCount: number;
  /** Live tournament templates from the bundled catalog. */
  tournamentTemplates: number;
}

export const admin_overview_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  withoutAdminKey(pre.raw);
  const nowUtc = serverNowMs();
  const cacheKey = `${OVERVIEW_CACHE_PREFIX}${buildCacheKey([])}`;
  const cached = getCached<AdminOverviewGetOutput>(cacheKey, nowUtc);
  if (cached !== null) {
    return JSON.stringify(ok(cached));
  }

  // Tournaments: count by state across all instances.
  const instances = listAllInstances(nk);
  let openCount = 0, closingCount = 0, closedCount = 0;
  let cancelledCount = 0, voidedCount = 0;
  for (const t of instances) {
    if (t.cancelled === true) {
      cancelledCount += 1;
      closedCount += 1;
      continue;
    }
    if (t.voided === true) {
      voidedCount += 1;
      closedCount += 1;
      continue;
    }
    const st = t.state;
    if (st === 'open') openCount += 1;
    else if (st === 'closing') closingCount += 1;
    else closedCount += 1;
  }

  // Events: count active windows + total catalog entries.
  const live = activeEvents(nowUtc);
  let activeXp = 0, activeFt = 0, activeSo = 0;
  for (const e of live) {
    if (e.kind === 'xp_double') activeXp += 1;
    else if (e.kind === 'featured_track') activeFt += 1;
    else if (e.kind === 'special_offer') activeSo += 1;
  }
  const totalCatalog = getEventsCatalog().length;

  // Anti-cheat: today's stats row from the daily stats collection.
  const todayDate = utcDate(nowUtc);
  const todayStats: DailyAntiCheatStats = readDailyStats(nk, todayDate);
  let totalMarks = 0;
  // Sample the marks collection once to count all marks.
  try {
    const objs = nk.storageList({
      collection: 'anti_cheat_marks',
      userId: '00000000-0000-0000-0000-000000000000',
      limit: 5000,
    });
    for (const o of objs.objects) {
      const v = o.value as { marks?: unknown };
      if (v && Array.isArray(v.marks)) totalMarks += v.marks.length;
    }
  } catch (e) {
    logger.error('admin_overview_get: anti-cheat marks list failed: %s', e instanceof Error ? e.message : String(e));
  }

  // Player count: storageList on profiles, owner=userId. Cheap because
  // most users have a profile; the per-user ownership is the index.
  let playerCount = 0;
  try {
    const objs = nk.storageList({ collection: 'profiles', limit: 5000 });
    playerCount = objs.objects.length;
  } catch (e) {
    logger.error('admin_overview_get: profiles list failed: %s', e instanceof Error ? e.message : String(e));
  }

  // Server uptime: derive from analytics events first observed.
  const uptime = computeUptimeMs(nk, nowUtc);

  // Tournament templates: count cached entries.
  let tplCount = 0;
  try {
    tplCount = getTournamentTemplates().length;
  } catch {
    tplCount = 0;
  }

  const payload: AdminOverviewGetOutput = {
    generatedAt: nowUtc,
    serverUptimeMs: uptime,
    tournaments: {
      total: instances.length,
      open: openCount,
      closing: closingCount,
      closed: closedCount,
      cancelled: cancelledCount,
      voided: voidedCount,
    },
    events: {
      activeXpDouble: activeXp,
      activeFeaturedTrack: activeFt,
      activeSpecialOffer: activeSo,
      totalCatalog,
    },
    antiCheat: {
      totalMarks,
      todayDetections: todayStats.marksTotal,
      todaySanctions: todayStats.usersHidden,
      todayDismissed: todayStats.usersConfirmed,
    },
    playerCount,
    tournamentTemplates: tplCount,
  };
  setCached(cacheKey, payload, nowUtc);

  emitAdminAction(nk, logger, 'admin_overview_get', {
    tournaments: instances.length,
    playerCount,
  });
  return JSON.stringify(ok(payload));
};
export const admin_overview_get: RpcHandler = admin_overview_get_impl;

/**
 * Compute server uptime by reading the oldest analytics event row.
 * Falls back to `nowUtc` when no events have been recorded yet
 * (uptime = 0 on a freshly-booted server).
 */
function computeUptimeMs(nk: INakama, nowUtc: number): number {
  try {
    const objs = nk.storageList({
      collection: ANALYTICS_COLLECTION,
      limit: 5000,
    });
    let oldest = nowUtc;
    for (const o of objs.objects) {
      const v = o.value as Partial<AnalyticsEvent>;
      if (typeof v?.ts === 'number' && v.ts > 0 && v.ts < oldest) {
        oldest = v.ts;
      }
    }
    return Math.max(0, nowUtc - oldest);
  } catch {
    return 0;
  }
}

// ─── admin_tournaments_stats_get ──────────────────────────────────────────

export interface AdminTournamentsStatsGetInput {
  adminKey: string;
  fromDate: string;
  toDate: string;
}

export interface AdminTournamentsStatsGetOutput {
  fromDate: string;
  toDate: string;
  days: ReturnType<typeof aggregateTournamentsByDay>;
  /** Number of instances that were materialised in the window. */
  totalInWindow: number;
}

export const admin_tournaments_stats_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const dr = parseDateRange(raw);
  if (!dr.ok) return dr.error;
  const nowUtc = serverNowMs();
  const cacheKey = `${TOURNAMENT_STATS_CACHE_PREFIX}${buildCacheKey([dr.fromDate, dr.toDate])}`;
  const cached = getCached<AdminTournamentsStatsGetOutput>(cacheKey, nowUtc);
  if (cached !== null) {
    return JSON.stringify(ok(cached));
  }

  // Walk every instance; for each, compute participant count + coins
  // distributed. This is O(N) in the number of instances; for a chunk
  // 5/6/7 deployment that's at most a few hundred. The 60s cache
  // keeps this off the hot path.
  const instances = listAllInstances(nk);
  const fromMs = Date.parse(`${dr.fromDate}T00:00:00.000Z`);
  const toMs = Date.parse(`${dr.toDate}T23:59:59.999Z`);
  const dayInputs: TournamentDayInput[] = [];
  let totalInWindow = 0;
  for (const t of instances) {
    if (t.createdAt < fromMs || t.createdAt > toMs + DAY_MS) {
      // Outside window — skip. We keep `closedAt` rows in by reading
      // the closedAt bucket later in the aggregator.
    }
    const participants = listAllEntries(nk, t.id).length;
    const coins = tournamentCoinsDistributed(nk, t);
    dayInputs.push(tournamentToDayInput(t, participants, coins));
    if (t.createdAt >= fromMs && t.createdAt <= toMs + DAY_MS) {
      totalInWindow += 1;
    }
  }
  // Include closed-day data even when createdAt is outside the window.
  const days = aggregateTournamentsByDay(dayInputs, dr.fromDate, dr.toDate);

  const payload: AdminTournamentsStatsGetOutput = {
    fromDate: dr.fromDate,
    toDate: dr.toDate,
    days,
    totalInWindow,
  };
  setCached(cacheKey, payload, nowUtc);

  emitAdminAction(nk, logger, 'admin_tournaments_stats_get', {
    fromDate: dr.fromDate, toDate: dr.toDate, instances: instances.length,
  });
  return JSON.stringify(ok(payload));
};
export const admin_tournaments_stats_get: RpcHandler = admin_tournaments_stats_get_impl;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sum of `coins` rewards across all distributed prize tiers for the
 * supplied instance. The chunk-6 scanner re-runs the distribution
 * math to keep the helper side-effect-free; it does NOT re-issue
 * grants (idempotency keys would short-circuit anyway).
 */
function tournamentCoinsDistributed(nk: INakama, t: Tournament): number {
  if (typeof t.closedAt !== 'number') return 0;
  try {
    const entries = topN(nk, t.id, 100);
    const distributions = distributePrizes(t, entries, t.closedAt);
    let total = 0;
    for (const d of distributions) {
      if (typeof d.rewards.coins === 'number') total += d.rewards.coins;
    }
    return total;
  } catch {
    return 0;
  }
}

// ─── admin_events_stats_get ───────────────────────────────────────────────

export interface AdminEventsStatsGetInput {
  adminKey: string;
  fromDate: string;
  toDate: string;
}

export interface AdminEventsStatsGetOutput {
  fromDate: string;
  toDate: string;
  days: ReturnType<typeof aggregateEventsByDay>;
  /** Sum of `bonusCoins` paid by the events subscriber in the window. */
  totalCoinsGranted: number;
}

export const admin_events_stats_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const dr = parseDateRange(raw);
  if (!dr.ok) return dr.error;
  const nowUtc = serverNowMs();
  const cacheKey = `${EVENTS_STATS_CACHE_PREFIX}${buildCacheKey([dr.fromDate, dr.toDate])}`;
  const cached = getCached<AdminEventsStatsGetOutput>(cacheKey, nowUtc);
  if (cached !== null) {
    return JSON.stringify(ok(cached));
  }

  // Walk the bundled catalog and project to day inputs.
  const events = getEventsCatalog();
  const dayInputs: EventDayInput[] = [];
  for (const e of events) {
    const startsAt = Date.parse(e.startsAtUtc);
    if (!Number.isFinite(startsAt)) continue;
    dayInputs.push({
      startsAt,
      kind: e.kind,
      coinsGranted: 0,
    });
  }
  // Sum `bonusCoins` from `wallet_moved` analytics events with
  // `reason` containing the event_xp_double sourceId. The events
  // subscriber calls `grant(reason: 'event', sourceId: 'event_xp_double:<sessionId>')`,
  // which produces a `wallet_moved` analytics row (emitted by
  // `economy/wallet.ts` on every successful grant). The dashboard
  // walks those rows and tallies coins per UTC day.
  let totalCoinsGranted = 0;
  try {
    const objs = nk.storageList({
      collection: ANALYTICS_COLLECTION,
      limit: 5000,
    });
    const fromMs = Date.parse(`${dr.fromDate}T00:00:00.000Z`);
    const toMs = Date.parse(`${dr.toDate}T23:59:59.999Z`);
    for (const o of objs.objects) {
      const v = o.value as Partial<AnalyticsEvent>;
      if (v?.name !== 'wallet_moved') continue;
      if (typeof v.ts !== 'number') continue;
      if (v.ts < fromMs || v.ts > toMs + DAY_MS) continue;
      const reason = typeof v.props?.['reason'] === 'string' ? (v.props['reason'] as string) : '';
      if (!reason.startsWith('event:event_xp_double:')) continue;
      const coins: number = (typeof v.props?.['changeset'] === 'object' && v.props?.['changeset'] !== null
        && typeof (v.props['changeset'] as Record<string, unknown>)['coins'] === 'number')
        ? (v.props['changeset'] as Record<string, number>)['coins'] as number
        : 0;
      if (coins <= 0) continue;
      const dayKey = utcDate(v.ts);
      // Attribute the bonus to the day the event window STARTED —
      // closest correlation to "the event is live today". When no
      // matching event is in the catalog, the bonus still goes into
      // the day's total via `totalCoinsGranted`.
      const row = dayInputs.find((d) => utcDate(d.startsAt) === dayKey);
      totalCoinsGranted += coins;
      if (row !== undefined) row.coinsGranted += coins;
    }
  } catch (e) {
    logger.error('admin_events_stats_get: analytics walk failed: %s', e instanceof Error ? e.message : String(e));
  }

  const days = aggregateEventsByDay(dayInputs, dr.fromDate, dr.toDate);

  const payload: AdminEventsStatsGetOutput = {
    fromDate: dr.fromDate,
    toDate: dr.toDate,
    days,
    totalCoinsGranted,
  };
  setCached(cacheKey, payload, nowUtc);

  emitAdminAction(nk, logger, 'admin_events_stats_get', {
    fromDate: dr.fromDate, toDate: dr.toDate, events: events.length,
  });
  return JSON.stringify(ok(payload));
};
export const admin_events_stats_get: RpcHandler = admin_events_stats_get_impl;

// ─── admin_players_search ─────────────────────────────────────────────────

export interface AdminPlayersSearchInput {
  adminKey: string;
  q: string;
  limit?: number;
}

export interface AdminPlayersSearchRow {
  userId: string;
  displayName: string;
  level: number;
  xp: number;
  /** Per-user wallet snapshot (coins / gems). */
  wallet: { coins: number; gems: number };
  /** Whether the profile carries an `archivedAt` (sanctioned). */
  archived: boolean;
  /** When the profile was created (epoch-ms). */
  createdAt: number;
}

export interface AdminPlayersSearchOutput {
  q: string;
  total: number;
  results: AdminPlayersSearchRow[];
}

const PLAYERS_SEARCH_MAX_LIMIT = 200;
const PLAYERS_SEARCH_DEFAULT_LIMIT = 50;

export const admin_players_search_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const q = readString(raw, 'q');
  const limitRaw = readNumber(raw, 'limit');
  const limit = Math.min(
    PLAYERS_SEARCH_MAX_LIMIT,
    Math.max(1, limitRaw ?? PLAYERS_SEARCH_DEFAULT_LIMIT),
  );

  const nowUtc = serverNowMs();
  const cacheKey = `${PLAYERS_SEARCH_CACHE_PREFIX}${buildCacheKey([q, limit])}`;
  const cached = getCached<AdminPlayersSearchOutput>(cacheKey, nowUtc);
  if (cached !== null) {
    return JSON.stringify(ok(cached));
  }

  // Walk every profile. The dashboard tool is expected to be sparse —
  // production installs see <100k profiles. The 60s cache keeps the
  // walk off the hot path; pagination is on the input side.
  const objs = nk.storageList({ collection: 'profiles', limit: 5000 });
  const results: AdminPlayersSearchRow[] = [];
  for (const o of objs.objects) {
    const v = o.value as Record<string, unknown>;
    if (!v || typeof v !== 'object') continue;
    const userId = typeof v['userId'] === 'string' ? (v['userId'] as string) : (typeof o.userId === 'string' ? o.userId : '');
    if (userId === '') continue;
    const displayName = typeof v['displayName'] === 'string' ? (v['displayName'] as string) : userId;
    if (!playerMatchesSearch({ displayName, userId }, q)) continue;
    const prog = (v['progression'] ?? {}) as { xp?: number; level?: number };
    const xp = typeof prog.xp === 'number' ? prog.xp : 0;
    const level = typeof prog.level === 'number' ? prog.level : 1;
    const archived = typeof v['archivedAt'] === 'number';
    const createdAt = typeof v['createdAt'] === 'number' ? (v['createdAt'] as number) : 0;
    const wallet = walletGet(nk, userId);
    results.push({ userId, displayName, level, xp, wallet, archived, createdAt });
  }
  // Deterministic order: createdAt desc, then userId asc.
  results.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  const total = results.length;
  const paged = results.slice(0, limit);

  const payload: AdminPlayersSearchOutput = { q, total, results: paged };
  setCached(cacheKey, payload, nowUtc);

  emitAdminAction(nk, logger, 'admin_players_search', {
    q, total, returned: paged.length, limit,
  });
  return JSON.stringify(ok(payload));
};
export const admin_players_search: RpcHandler = admin_players_search_impl;

// ─── admin_wallet_grant ───────────────────────────────────────────────────

export interface AdminWalletGrantInput {
  adminKey: string;
  userId: string;
  coins?: number;
  gems?: number;
  reason: string;
}

export interface AdminWalletGrantOutput {
  userId: string;
  granted: { coins: number; gems: number };
  newBalance: { coins: number; gems: number };
  reason: string;
}

export const admin_wallet_grant_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const userId = readString(raw, 'userId');
  if (userId.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'userId is required'));
  }
  const reason = readString(raw, 'reason');
  if (!ADMIN_WALLET_GRANT_REASONS.has(reason)) {
    return JSON.stringify(err('BAD_REQUEST',
      `reason must be one of: ${Array.from(ADMIN_WALLET_GRANT_REASONS).join(', ')}`));
  }
  const coins = readNumber(raw, 'coins') ?? 0;
  const gems = readNumber(raw, 'gems') ?? 0;
  if (!Number.isInteger(coins) || !Number.isInteger(gems) || coins < 0 || gems < 0) {
    return JSON.stringify(err('BAD_REQUEST', 'coins/gems must be non-negative integers'));
  }
  if (coins === 0 && gems === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'at least one of coins/gems must be non-zero'));
  }
  if (coins > WALLET_GRANT_MAX_PER_CALL || gems > WALLET_GRANT_MAX_PER_CALL) {
    return JSON.stringify(err('BAD_REQUEST',
      `coins/gems exceeds max per call (${WALLET_GRANT_MAX_PER_CALL})`));
  }

  // Confirm the user has a profile. Admin grant on a non-existent
  // user is a no-op (the wallet grant would just credit a phantom
  // account).
  const profileObj = nk.storageRead([{ collection: 'profiles', key: userId, userId }])[0];
  if (profileObj === undefined) {
    return JSON.stringify(err('NOT_FOUND', `user not found: ${userId}`));
  }

  const changeset: { coins?: number; gems?: number } = {};
  if (coins > 0) changeset.coins = coins;
  if (gems > 0) changeset.gems = gems;
  const idempKey = `admin_grant:${nk.uuidv4()}`;
  const grantResp = grant(
    nk,
    userId,
    changeset,
    { reason: 'admin', sourceId: `admin_grant:${reason}:${userId}` },
    idempKey,
  );
  if (!grantResp.ok) {
    return JSON.stringify(err(asCode(grantResp.error?.code), grantResp.error?.message ?? 'unknown'));
  }

  // Invalidate the overview cache so the next read shows the new
  // total circulating currency. The cache prefix matches the one
  // admin_overview_get uses.
  invalidateDashboardCache(OVERVIEW_CACHE_PREFIX);

  const payload: AdminWalletGrantOutput = {
    userId,
    granted: { coins, gems },
    newBalance: { coins: grantResp.data?.coins ?? 0, gems: grantResp.data?.gems ?? 0 },
    reason,
  };
  emitAdminAction(nk, logger, 'admin_wallet_grant', {
    userId, coins, gems, reason, newBalance: payload.newBalance,
  });
  logger.warn('admin_wallet_grant user=%s coins=%d gems=%d reason=%s',
    userId, coins, gems, reason);
  return JSON.stringify(ok(payload));
};
export const admin_wallet_grant: RpcHandler = admin_wallet_grant_impl;

// ─── admin_anti_cheat_dashboard_get ───────────────────────────────────────

export interface AdminAntiCheatDashboardGetInput {
  adminKey: string;
  fromDate: string;
  toDate: string;
}

export interface AdminAntiCheatDashboardBreakdown {
  date: string;
  stats: DailyAntiCheatStats;
}

export interface AdminAntiCheatDashboardGetOutput {
  fromDate: string;
  toDate: string;
  days: DailyAntiCheatStats[];
  /** Sum of `detections` across the window. */
  totalDetections: number;
  /** Sum of `sanctions` across the window. */
  totalSanctions: number;
  /** Sum of `dismissed` across the window. */
  totalDismissed: number;
  /** Number of users that currently carry at least one non-dismissed mark. */
  usersWithMarks: number;
  /** Top-10 most-marked userIds (sum of visible marks, no dismissal). */
  topMarked: Array<{ userId: string; count: number }>;
}

export const admin_anti_cheat_dashboard_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const dr = parseDateRange(raw);
  if (!dr.ok) return dr.error;
  const nowUtc = serverNowMs();
  const cacheKey = `${ANTI_CHEAT_DASHBOARD_CACHE_PREFIX}${buildCacheKey([dr.fromDate, dr.toDate])}`;
  const cached = getCached<AdminAntiCheatDashboardGetOutput>(cacheKey, nowUtc);
  if (cached !== null) {
    return JSON.stringify(ok(cached));
  }

  const days = zeroFillDateRange(dr.fromDate, dr.toDate);
  const dayStats: DailyAntiCheatStats[] = [];
  let totalDetections = 0, totalSanctions = 0, totalDismissed = 0;
  for (const d of days) {
    const s = readDailyStats(nk, d);
    dayStats.push(s);
    totalDetections += s.marksTotal;
    totalSanctions += s.usersHidden;
    totalDismissed += s.usersConfirmed;
  }

  // Walk the marks collection for the top-N.
  let usersWithMarks = 0;
  const markCounts: Array<{ userId: string; count: number }> = [];
  try {
    const objs = nk.storageList({
      collection: 'anti_cheat_marks',
      userId: ANTI_CHEAT_STATS_SYSTEM_USER,
      limit: 5000,
    });
    for (const o of objs.objects) {
      const v = o.value as { marks?: unknown };
      if (!v || !Array.isArray(v.marks)) continue;
      const userId = typeof o.key === 'string' ? o.key : '';
      const marks = v.marks as AntiCheatMark[];
      const visible = marks.filter((m) => !m.dismissed).length;
      if (visible > 0) {
        usersWithMarks += 1;
        markCounts.push({ userId, count: visible });
      }
    }
    markCounts.sort((a, b) => b.count - a.count);
  } catch (e) {
    logger.error('admin_anti_cheat_dashboard_get: marks walk failed: %s', e instanceof Error ? e.message : String(e));
  }
  const topMarked = markCounts.slice(0, 10);

  const payload: AdminAntiCheatDashboardGetOutput = {
    fromDate: dr.fromDate,
    toDate: dr.toDate,
    days: dayStats,
    totalDetections,
    totalSanctions,
    totalDismissed,
    usersWithMarks,
    topMarked,
  };
  setCached(cacheKey, payload, nowUtc);

  emitAdminAction(nk, logger, 'admin_anti_cheat_dashboard_get', {
    fromDate: dr.fromDate, toDate: dr.toDate,
    usersWithMarks, topMarked: topMarked.length,
  });
  return JSON.stringify(ok(payload));
};
export const admin_anti_cheat_dashboard_get: RpcHandler = admin_anti_cheat_dashboard_get_impl;

// Type re-export used by the bundle scanner so goja sees the named
// exports of the response types.
export type { Resp };

// Side-effect: keep the constants referenced so the linter / type
// checker don't flag them in isolation.
void (null as unknown as Tournament | PrizeDistributionRow | AnalyticsEvent | TournamentType);
void (null as unknown);
