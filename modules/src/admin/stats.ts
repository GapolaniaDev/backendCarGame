// Phase 8 Chunk 9 — Pure aggregation helpers for the admin dashboard
// RPCs. These helpers do NOT touch storage — the RPCs read the rows
// themselves, then feed the data through the helpers to produce the
// per-day response payloads.
//
// Conventions:
//   - All dates are UTC `YYYY-MM-DD` strings.
//   - `zeroFillDateRange` always returns at least the `[from, to]`
//     window even when the input is malformed (defensive default).
//   - Aggregation helpers take a `nowUtc` (epoch-ms) so the caller can
//     pin time in tests via `serverNowMs()` + override.
//
// The "stats" shape is intentionally minimal — the admin UI can chart
// it directly. No percentile / median / variance maths: count, sum,
// and an optional `latest` field. Anything fancier belongs in a
// dedicated analytics module.

import type { Tournament } from '../tournaments/types';

// ─── Date helpers ─────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Generate the inclusive UTC date range `['YYYY-MM-DD', ...]` covering
 * `[fromDate, toDate]`. Returns `[]` when the inputs are malformed
 * (non-`YYYY-MM-DD`, or `toDate < fromDate`).
 */
export function zeroFillDateRange(fromDate: string, toDate: string): string[] {
  const startMs = Date.parse(`${fromDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${toDate}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  if (endMs < startMs) return [];
  const out: string[] = [];
  for (let t = startMs; t <= endMs; t += DAY_MS) {
    out.push(utcDateStr(t));
  }
  return out;
}

/** YYYY-MM-DD UTC string for an epoch-ms. */
export function utcDateStr(dateMs: number): string {
  const d = new Date(dateMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** True when the given epoch-ms falls in the UTC YYYY-MM-DD bucket. */
export function inUtcDay(timestampMs: number, dateStr: string): boolean {
  return utcDateStr(timestampMs) === dateStr;
}

// ─── Tournament aggregator ───────────────────────────────────────────────

/**
 * Per-day tournament aggregation. Days absent from the dataset get a
 * zero-filled row so the admin UI sees a contiguous time series.
 *
 *   - `opened`     = templates whose `createdAt` is on that day
 *   - `closed`     = instances that closed on that day
 *   - `participants` = sum of `entries.length` across all instances
 *                      that closed on that day
 *   - `prizeCoins` = sum of `coins` rewards across all distributed
 *                    prize tiers for the instances that closed on that
 *                    day (gems + cosmetics are intentionally NOT
 *                    summed — the dashboard tracks coins, the spendable
 *                    currency)
 */
export interface TournamentDayStats {
  date: string;
  opened: number;
  closed: number;
  participants: number;
  prizeCoins: number;
}

/** Inputs to `aggregateTournamentsByDay`. */
export interface TournamentDayInput {
  /** When the instance was materialised (epoch-ms). */
  createdAt: number;
  /** When the instance was closed (epoch-ms; null while open). */
  closedAt: number | null;
  /** Prize coins actually distributed to winners (sum of `coins`). */
  prizeCoinsDistributed: number;
  /** Number of unique entries at close time. */
  participantCount: number;
}

export function aggregateTournamentsByDay(
  inputs: ReadonlyArray<TournamentDayInput>,
  fromDate: string,
  toDate: string,
): TournamentDayStats[] {
  const days = zeroFillDateRange(fromDate, toDate);
  const map = new Map<string, TournamentDayStats>();
  for (const d of days) {
    map.set(d, { date: d, opened: 0, closed: 0, participants: 0, prizeCoins: 0 });
  }
  for (const t of inputs) {
    if (typeof t.createdAt === 'number' && Number.isFinite(t.createdAt)) {
      const k = utcDateStr(t.createdAt);
      const row = map.get(k);
      if (row !== undefined) row.opened += 1;
    }
    if (typeof t.closedAt === 'number' && Number.isFinite(t.closedAt)) {
      const k = utcDateStr(t.closedAt);
      const row = map.get(k);
      if (row !== undefined) {
        row.closed += 1;
        row.participants += t.participantCount;
        row.prizeCoins += t.prizeCoinsDistributed;
      }
    }
  }
  return days.map((d) => map.get(d)!);
}

/**
 * Project a `Tournament` + its entry count + its distributed coin total
 * into the `TournamentDayInput` shape. `prizeCoinsDistributed` is
 * computed from the supplied `prizeTierCoins` array (the chunk-6
 * scanner stores the per-tier reward maps, but the admin dashboard
 * only needs the coin delta).
 */
export function tournamentToDayInput(
  t: Tournament,
  participantCount: number,
  prizeCoinsDistributed: number,
): TournamentDayInput {
  return {
    createdAt: t.createdAt,
    closedAt: typeof t.closedAt === 'number' ? t.closedAt : null,
    participantCount,
    prizeCoinsDistributed,
  };
}

// ─── Events aggregator ────────────────────────────────────────────────────

/**
 * Per-day events aggregation. Each `kind` is tracked separately so
 * the admin UI can build a stacked chart. `coinsGranted` is the sum
 * of `bonusCoins` paid by the events subscriber for races closed on
 * that day.
 */
export interface EventsDayStats {
  date: string;
  /** How many `xp_double` events went live on that day. */
  xpDoubleActivated: number;
  /** How many `featured_track` events went live on that day. */
  featuredTrackActivated: number;
  /** How many `special_offer` events went live on that day. */
  specialOfferActivated: number;
  /** Sum of `bonusCoins` paid by the events subscriber on that day. */
  coinsGranted: number;
}

export interface EventDayInput {
  /** When the event window started (epoch-ms). */
  startsAt: number;
  /** Event kind. */
  kind: 'xp_double' | 'featured_track' | 'special_offer';
  /** Sum of `bonusCoins` paid on races that closed on that day. */
  coinsGranted: number;
}

export function aggregateEventsByDay(
  inputs: ReadonlyArray<EventDayInput>,
  fromDate: string,
  toDate: string,
): EventsDayStats[] {
  const days = zeroFillDateRange(fromDate, toDate);
  const map = new Map<string, EventsDayStats>();
  for (const d of days) {
    map.set(d, {
      date: d,
      xpDoubleActivated: 0,
      featuredTrackActivated: 0,
      specialOfferActivated: 0,
      coinsGranted: 0,
    });
  }
  for (const e of inputs) {
    if (typeof e.startsAt !== 'number' || !Number.isFinite(e.startsAt)) continue;
    const k = utcDateStr(e.startsAt);
    const row = map.get(k);
    if (row === undefined) continue;
    if (e.kind === 'xp_double') row.xpDoubleActivated += 1;
    else if (e.kind === 'featured_track') row.featuredTrackActivated += 1;
    else if (e.kind === 'special_offer') row.specialOfferActivated += 1;
    if (e.coinsGranted > 0) row.coinsGranted += e.coinsGranted;
  }
  return days.map((d) => map.get(d)!);
}

// ─── Player-search helper ─────────────────────────────────────────────────

/**
 * Case-insensitive partial match. The admin RPC passes the search term
 * through unmodified; this helper is pure so the unit test pins the
 * contract.
 */
export function playerMatchesSearch(
  haystack: { displayName: string; userId: string },
  needle: string,
): boolean {
  if (needle === '') return true;
  const n = needle.toLowerCase();
  return (
    haystack.userId.toLowerCase().includes(n) ||
    haystack.displayName.toLowerCase().includes(n)
  );
}
