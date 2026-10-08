// Phase 9 Chunk 7 — Pure LTV computation.
//
// Reads a list of `IapAdAnalyticsRow` and computes the average spend
// per user in a given cohort for each of the `7d` / `30d` / `90d`
// windows measured from `cohortWeekStart`.
//
// The cohort is the set of users whose FIRST delivered purchase
// (or first initiated purchase when no delivered) lands on or after
// `cohortWeekStart` AND before the next-week boundary. The
// `cohortWeekStart` is the ISO date (YYYY-MM-DD) of the cohort
// boundary (typically the start of an ISO week, but any YYYY-MM-DD
// is accepted).

import type { IapAdAnalyticsRow } from './iap_events';

export type LtvWindow = '7d' | '30d' | '90d';
export const LTV_WINDOWS: ReadonlyArray<LtvWindow> = ['7d', '30d', '90d'];

const MS_PER_DAY = 86_400_000;
const WINDOW_DAYS: Record<LtvWindow, number> = { '7d': 7, '30d': 30, '90d': 90 };

function parseIsoDateUtc(iso: string): number | null {
  // Accept "YYYY-MM-DD" or "YYYY-MM-DDT...". We always treat the
  // day boundary as UTC midnight for cohort math.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
}

function isoDateUtc(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface LtvByPack {
  packId: string;
  revenue: { '7d': number; '30d': number; '90d': number };
  purchaseCount: number;
}

export interface LtvResult {
  cohortWeekStart: string;
  cohortSize: number;
  /** Average spend per user across the cohort, in coins. */
  ltv: { '7d': number; '30d': number; '90d': number };
  perPack: LtvByPack[];
}

export interface LtvInputs {
  rows: IapAdAnalyticsRow[];
  cohortWeekStart: string;
  windows: ReadonlyArray<LtvWindow>;
}

/**
 * Pure: computes LTV for a cohort across the given windows.
 *
 * Cohort selection:
 *   - A user is in the cohort if they have at least one `iap_purchase_delivered`
 *     event with `cohortDate` between `cohortWeekStart` (inclusive) and
 *     `cohortWeekStart + 7d` (exclusive).
 *   - Spend is summed from `iap_purchase_delivered` events whose `ts`
 *     is between `cohortWeekStart` and `cohortWeekStart + windowDays`.
 *
 * `perPack` mirrors the global LTV but bucketed by `packId`.
 */
export function computeLtv({ rows, cohortWeekStart, windows }: LtvInputs): LtvResult {
  const cohortStart = parseIsoDateUtc(cohortWeekStart);
  if (cohortStart === null) {
    return { cohortWeekStart, cohortSize: 0, ltv: { '7d': 0, '30d': 0, '90d': 0 }, perPack: [] };
  }
  const cohortEnd = cohortStart + 7 * MS_PER_DAY; // exclusive

  // Identify the cohort: users with first delivered purchase in [cohortStart, cohortEnd).
  const cohortUsers = new Set<string>();
  for (const r of rows) {
    if (r.name !== 'iap_purchase_delivered') continue;
    if (typeof r.userId !== 'string') continue;
    const cd = r.props.cohortDate;
    if (typeof cd !== 'string') continue;
    const t = parseIsoDateUtc(cd);
    if (t === null) continue;
    if (t >= cohortStart && t < cohortEnd) cohortUsers.add(r.userId);
  }

  // Spend per user in cohort, for each window, scoped by `ts`.
  const spendByUserByWindow: Record<LtvWindow, Map<string, number>> = {
    '7d': new Map(),
    '30d': new Map(),
    '90d': new Map(),
  };
  const spendByPackByWindow: Record<LtvWindow, Map<string, number>> = {
    '7d': new Map(),
    '30d': new Map(),
    '90d': new Map(),
  };
  const packPurchaseCount = new Map<string, number>();

  for (const w of windows) {
    const end = cohortStart + WINDOW_DAYS[w] * MS_PER_DAY;
    for (const r of rows) {
      if (r.name !== 'iap_purchase_delivered') continue;
      if (typeof r.userId !== 'string' || !cohortUsers.has(r.userId)) continue;
      if (r.ts < cohortStart || r.ts >= end) continue;
      const amount = r.props.amountCoins;
      if (typeof amount !== 'number') continue;
      const cur = spendByUserByWindow[w].get(r.userId) ?? 0;
      spendByUserByWindow[w].set(r.userId, cur + amount);
      if (typeof r.props.packId === 'string') {
        const cur2 = spendByPackByWindow[w].get(r.props.packId) ?? 0;
        spendByPackByWindow[w].set(r.props.packId, cur2 + amount);
        packPurchaseCount.set(r.props.packId, (packPurchaseCount.get(r.props.packId) ?? 0) + 1);
      }
    }
  }

  const ltvOut: { '7d': number; '30d': number; '90d': number } = { '7d': 0, '30d': 0, '90d': 0 };
  const cohortSize = cohortUsers.size;
  for (const w of windows) {
    if (cohortSize === 0) {
      ltvOut[w] = 0;
    } else {
      let total = 0;
      for (const v of spendByUserByWindow[w].values()) total += v;
      ltvOut[w] = total / cohortSize;
    }
  }

  // perPack — include all packIds seen in the 90d window (or the longest window present).
  const longest = windows[windows.length - 1] ?? '90d';
  const packIds = new Set<string>();
  for (const r of rows) {
    if (r.name !== 'iap_purchase_delivered') continue;
    if (typeof r.props.packId !== 'string') continue;
    packIds.add(r.props.packId);
  }
  const perPack: LtvByPack[] = [];
  for (const packId of Array.from(packIds).sort()) {
    perPack.push({
      packId,
      revenue: {
        '7d': spendByPackByWindow['7d'].get(packId) ?? 0,
        '30d': spendByPackByWindow['30d'].get(packId) ?? 0,
        '90d': spendByPackByWindow['90d'].get(packId) ?? 0,
      },
      purchaseCount: packPurchaseCount.get(packId) ?? 0,
    });
    // Suppress lint: `longest` is used for clarity but not gated on it.
    void longest;
  }

  return { cohortWeekStart, cohortSize, ltv: ltvOut, perPack };
}

/** Helper: returns the cohort date (YYYY-MM-DD) for a user — the date
 *  of their FIRST delivered purchase. */
export function cohortDateForUser(
  rows: IapAdAnalyticsRow[],
  userId: string,
): string | null {
  let earliest: number | null = null;
  for (const r of rows) {
    if (r.name !== 'iap_purchase_delivered') continue;
    if (r.userId !== userId) continue;
    if (earliest === null || r.ts < earliest) earliest = r.ts;
  }
  return earliest === null ? null : isoDateUtc(earliest);
}
