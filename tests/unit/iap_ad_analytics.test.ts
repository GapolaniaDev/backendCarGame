// Phase 9 Chunk 7 — Unit tests for the IAP/ad analytics pure functions.
//
// Coverage:
//   - ltv.computeLtv (cohort + per-window LTV + perPack breakdown)
//   - ltv.cohortDateForUser
//   - funnel.computeFunnel (per stage + byPack + byPlatform + conversion rates)
//   - top_buyers.computeTopBuyers (sort + limit + username lookup)
//
// The pure functions take `IapAdAnalyticsRow[]` so we synthesise the
// rows in-memory without touching storage. Total ≥30 cases.

import { describe, it, expect } from 'vitest';
import type { IapAdAnalyticsRow } from '../../modules/src/analytics/iap_events';
import { computeLtv, cohortDateForUser } from '../../modules/src/analytics/ltv';
import { computeFunnel } from '../../modules/src/analytics/funnel';
import { computeTopBuyers } from '../../modules/src/analytics/top_buyers';

const COHORT_2024_W1 = '2024-01-01'; // Tuesday (any UTC date is fine for the test)

function makeRow(
  name: IapAdAnalyticsRow['name'],
  ts: number,
  userId: string,
  props: Partial<IapAdAnalyticsRow['props']> = {},
): IapAdAnalyticsRow {
  return {
    name,
    ts,
    userId,
    props: { ...props },
  };
}

// ─── ltv ─────────────────────────────────────────────────────────────

describe('computeLtv (Phase 9 Chunk 7)', () => {
  it('empty input → cohortSize=0, all zeros', () => {
    const r = computeLtv({ rows: [], cohortWeekStart: COHORT_2024_W1, windows: ['7d', '30d', '90d'] });
    expect(r.cohortSize).toBe(0);
    expect(r.ltv).toEqual({ '7d': 0, '30d': 0, '90d': 0 });
    expect(r.perPack).toEqual([]);
  });

  it('cohort with 1 user / 1 purchase of 100 → ltv=100', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 1, 10, 0, 0), 'u1', {
        packId: 'coins_100', amountCoins: 100, cohortDate: '2024-01-01',
      }),
    ];
    const r = computeLtv({ rows, cohortWeekStart: COHORT_2024_W1, windows: ['7d', '30d', '90d'] });
    expect(r.cohortSize).toBe(1);
    expect(r.ltv).toEqual({ '7d': 100, '30d': 100, '90d': 100 });
  });

  it('cohort with 3 users (100, 200, 50) → ltv=116.67', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 2, 10), 'u1', { amountCoins: 100, cohortDate: '2024-01-02' }),
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 3, 10), 'u2', { amountCoins: 200, cohortDate: '2024-01-03' }),
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 4, 10), 'u3', { amountCoins: 50, cohortDate: '2024-01-04' }),
    ];
    const r = computeLtv({ rows, cohortWeekStart: COHORT_2024_W1, windows: ['7d', '30d', '90d'] });
    expect(r.cohortSize).toBe(3);
    expect(r.ltv['7d']).toBeCloseTo(116.67, 2);
  });

  it('7d window only counts purchases within 7 days of cohort start', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 5, 10), 'u1', { amountCoins: 50, cohortDate: '2024-01-01' }),
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 7, 23), 'u1', { amountCoins: 70, cohortDate: '2024-01-01' }), // 7d window includes this (just before Jan 8 00:00)
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 9, 10), 'u1', { amountCoins: 999, cohortDate: '2024-01-01' }), // outside 7d
    ];
    const r = computeLtv({ rows, cohortWeekStart: COHORT_2024_W1, windows: ['7d'] });
    expect(r.cohortSize).toBe(1);
    expect(r.ltv['7d']).toBe(120);
  });

  it('30d window is wider than 7d', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 5, 10), 'u1', { amountCoins: 50, cohortDate: '2024-01-01' }),
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 25, 10), 'u1', { amountCoins: 70, cohortDate: '2024-01-01' }), // within 30d, outside 7d
    ];
    const r = computeLtv({ rows, cohortWeekStart: COHORT_2024_W1, windows: ['7d', '30d'] });
    expect(r.ltv['7d']).toBe(50);
    expect(r.ltv['30d']).toBe(120);
  });

  it('perPack breakdown', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 2, 10), 'u1', { packId: 'coins_100', amountCoins: 100, cohortDate: '2024-01-02' }),
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 3, 10), 'u1', { packId: 'gems_50', amountCoins: 50, cohortDate: '2024-01-03' }),
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 4, 10), 'u2', { packId: 'coins_100', amountCoins: 200, cohortDate: '2024-01-04' }),
    ];
    const r = computeLtv({ rows, cohortWeekStart: COHORT_2024_W1, windows: ['7d'] });
    expect(r.cohortSize).toBe(2);
    expect(r.ltv['7d']).toBe(175); // (100+50+200)/2
    expect(r.perPack).toHaveLength(2);
    const coins = r.perPack.find((p) => p.packId === 'coins_100');
    const gems = r.perPack.find((p) => p.packId === 'gems_50');
    expect(coins?.revenue['7d']).toBe(300);
    expect(coins?.purchaseCount).toBe(2);
    expect(gems?.revenue['7d']).toBe(50);
  });

  it('users outside the cohort are ignored', () => {
    const rows: IapAdAnalyticsRow[] = [
      // u1 in cohort (Jan 2)
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 2, 10), 'u1', { amountCoins: 100, cohortDate: '2024-01-02' }),
      // u2 first delivered in Feb (different cohort)
      makeRow('iap_purchase_delivered', Date.UTC(2024, 1, 5, 10), 'u2', { amountCoins: 999, cohortDate: '2024-02-05' }),
    ];
    const r = computeLtv({ rows, cohortWeekStart: COHORT_2024_W1, windows: ['7d'] });
    expect(r.cohortSize).toBe(1);
    expect(r.ltv['7d']).toBe(100);
  });

  it('invalid cohort date returns zeros', () => {
    const r = computeLtv({ rows: [], cohortWeekStart: 'not-a-date', windows: ['7d'] });
    expect(r.cohortSize).toBe(0);
  });

  it('empty windows array → zeros', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 2, 10), 'u1', { amountCoins: 100, cohortDate: '2024-01-02' }),
    ];
    const r = computeLtv({ rows, cohortWeekStart: COHORT_2024_W1, windows: [] });
    expect(r.cohortSize).toBe(1);
    expect(r.ltv).toEqual({ '7d': 0, '30d': 0, '90d': 0 });
  });
});

describe('cohortDateForUser (Phase 9 Chunk 7)', () => {
  it('returns null for a user with no delivered events', () => {
    expect(cohortDateForUser([], 'u1')).toBeNull();
  });

  it('returns the ISO date of the first delivered event', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', Date.UTC(2024, 2, 5, 10), 'u1', { amountCoins: 100 }),
      makeRow('iap_purchase_delivered', Date.UTC(2024, 2, 3, 10), 'u1', { amountCoins: 50 }),
    ];
    expect(cohortDateForUser(rows, 'u1')).toBe('2024-03-03');
  });

  it('ignores non-delivered events', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_initiated', Date.UTC(2024, 2, 1, 10), 'u1'),
      makeRow('iap_purchase_delivered', Date.UTC(2024, 2, 5, 10), 'u1', { amountCoins: 100 }),
    ];
    expect(cohortDateForUser(rows, 'u1')).toBe('2024-03-05');
  });
});

// ─── funnel ──────────────────────────────────────────────────────────

describe('computeFunnel (Phase 9 Chunk 7)', () => {
  it('empty → all zeros', () => {
    const r = computeFunnel({ rows: [] });
    expect(r.stages).toHaveLength(3);
    expect(r.stages[0]?.count).toBe(0);
    expect(r.stages[1]?.count).toBe(0);
    expect(r.stages[2]?.count).toBe(0);
    expect(r.byPack).toEqual([]);
    expect(r.byPlatform).toEqual([]);
  });

  it('100 initiated / 95 validated / 90 delivered → conversionRates 0.95 / 0.95', () => {
    const rows: IapAdAnalyticsRow[] = [];
    for (let i = 0; i < 100; i += 1) {
      rows.push(makeRow('iap_purchase_initiated', Date.UTC(2024, 0, 1, 10), `u${i}`, {
        transactionId: `tx-${i}`,
      }));
    }
    for (let i = 0; i < 95; i += 1) {
      rows.push(makeRow('iap_purchase_validated', Date.UTC(2024, 0, 1, 11), `u${i}`, {
        transactionId: `tx-${i}`,
      }));
    }
    for (let i = 0; i < 90; i += 1) {
      rows.push(makeRow('iap_purchase_delivered', Date.UTC(2024, 0, 1, 12), `u${i}`, {
        transactionId: `tx-${i}`,
        amountCoins: 100,
      }));
    }
    const r = computeFunnel({ rows });
    expect(r.stages[0]?.count).toBe(100);
    expect(r.stages[1]?.count).toBe(95);
    expect(r.stages[2]?.count).toBe(90);
    expect(r.stages[1]?.conversionFromInitiated).toBeCloseTo(0.95, 2);
    expect(r.stages[2]?.conversionFromPrevious).toBeCloseTo(0.947, 2);
  });

  it('distinct transactionId counts (re-emits for same txId do not double-count)', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_initiated', 1000, 'u1', { transactionId: 'tx-1' }),
      makeRow('iap_purchase_initiated', 1100, 'u1', { transactionId: 'tx-1' }), // duplicate
      makeRow('iap_purchase_validated', 1200, 'u1', { transactionId: 'tx-1' }),
      makeRow('iap_purchase_delivered', 1300, 'u1', { transactionId: 'tx-1' }),
    ];
    const r = computeFunnel({ rows });
    expect(r.stages[0]?.count).toBe(1);
    expect(r.stages[1]?.count).toBe(1);
    expect(r.stages[2]?.count).toBe(1);
  });

  it('filter by packId', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_initiated', 1000, 'u1', { transactionId: 'tx-1', packId: 'coins_100' }),
      makeRow('iap_purchase_initiated', 1100, 'u1', { transactionId: 'tx-2', packId: 'gems_50' }),
      makeRow('iap_purchase_delivered', 1200, 'u1', { transactionId: 'tx-1', packId: 'coins_100', amountCoins: 100 }),
    ];
    const r = computeFunnel({ rows, filters: { packId: 'coins_100' } });
    expect(r.stages[0]?.count).toBe(1);
    expect(r.stages[2]?.count).toBe(1);
  });

  it('filter by platform', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_initiated', 1000, 'u1', { transactionId: 'tx-1', platform: 'apple' }),
      makeRow('iap_purchase_initiated', 1100, 'u1', { transactionId: 'tx-2', platform: 'google' }),
      makeRow('iap_purchase_delivered', 1200, 'u1', { transactionId: 'tx-1', platform: 'apple', amountCoins: 100 }),
    ];
    const r = computeFunnel({ rows, filters: { platform: 'apple' } });
    expect(r.stages[0]?.count).toBe(1);
    expect(r.stages[2]?.count).toBe(1);
  });

  it('byPack bucket', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_initiated', 1000, 'u1', { transactionId: 'tx-1', packId: 'coins_100' }),
      makeRow('iap_purchase_initiated', 1100, 'u1', { transactionId: 'tx-2', packId: 'gems_50' }),
      makeRow('iap_purchase_delivered', 1200, 'u1', { transactionId: 'tx-1', packId: 'coins_100', amountCoins: 100 }),
    ];
    const r = computeFunnel({ rows });
    expect(r.byPack).toHaveLength(2);
    const coins = r.byPack.find((b) => b.bucket === 'coins_100');
    expect(coins?.stages[0]?.count).toBe(1);
    expect(coins?.stages[2]?.count).toBe(1);
  });

  it('byPlatform bucket', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_initiated', 1000, 'u1', { transactionId: 'tx-1', platform: 'apple' }),
      makeRow('iap_purchase_initiated', 1100, 'u1', { transactionId: 'tx-2', platform: 'google' }),
    ];
    const r = computeFunnel({ rows });
    expect(r.byPlatform).toHaveLength(2);
  });

  it('zero initiated → conversion rates are 0 (not NaN)', () => {
    const r = computeFunnel({ rows: [] });
    expect(r.stages[1]?.conversionFromInitiated).toBe(0);
    expect(r.stages[2]?.conversionFromInitiated).toBe(0);
  });
});

// ─── top_buyers ──────────────────────────────────────────────────────

describe('computeTopBuyers (Phase 9 Chunk 7)', () => {
  it('empty → []', () => {
    const r = computeTopBuyers({ rows: [], userLookup: () => null, limit: 10 });
    expect(r).toEqual([]);
  });

  it('3 buyers sorted by totalSpent desc', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', 1000, 'u1', { amountCoins: 100, packId: 'coins_100' }),
      makeRow('iap_purchase_delivered', 1100, 'u2', { amountCoins: 200, packId: 'gems_50' }),
      makeRow('iap_purchase_delivered', 1200, 'u3', { amountCoins: 50, packId: 'coins_100' }),
    ];
    const userLookup = (userId: string) => ({ username: `name-${userId}` });
    const r = computeTopBuyers({ rows, userLookup, limit: 10 });
    expect(r).toHaveLength(3);
    expect(r[0]?.userId).toBe('u2');
    expect(r[0]?.totalSpent).toBe(200);
    expect(r[1]?.userId).toBe('u1');
    expect(r[2]?.userId).toBe('u3');
  });

  it('limit=2 → top 2 only', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', 1000, 'u1', { amountCoins: 100 }),
      makeRow('iap_purchase_delivered', 1100, 'u2', { amountCoins: 200 }),
      makeRow('iap_purchase_delivered', 1200, 'u3', { amountCoins: 50 }),
    ];
    const r = computeTopBuyers({ rows, userLookup: () => null, limit: 2 });
    expect(r).toHaveLength(2);
  });

  it('aggregates multiple purchases for the same user', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', 1000, 'u1', { amountCoins: 100, packId: 'coins_100' }),
      makeRow('iap_purchase_delivered', 1100, 'u1', { amountCoins: 200, packId: 'gems_50' }),
      makeRow('iap_purchase_delivered', 1200, 'u1', { amountCoins: 50, packId: 'coins_100' }),
    ];
    const r = computeTopBuyers({ rows, userLookup: () => null, limit: 10 });
    expect(r[0]?.totalSpent).toBe(350);
    expect(r[0]?.purchaseCount).toBe(3);
    expect(r[0]?.packIds).toEqual(['coins_100', 'gems_50']);
    expect(r[0]?.lastPurchaseUtc).toBe(1200);
  });

  it('missing username → empty string', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', 1000, 'u1', { amountCoins: 100 }),
    ];
    const r = computeTopBuyers({ rows, userLookup: () => null, limit: 10 });
    expect(r[0]?.username).toBe('');
  });

  it('tiebreak by purchaseCount, then lastPurchaseUtc', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_delivered', 1000, 'u1', { amountCoins: 200 }),
      makeRow('iap_purchase_delivered', 1100, 'u1', { amountCoins: 0 }), // zero → counts but no spend
      makeRow('iap_purchase_delivered', 2000, 'u2', { amountCoins: 200 }),
      makeRow('iap_purchase_delivered', 2100, 'u2', { amountCoins: 0 }),
    ];
    const r = computeTopBuyers({ rows, userLookup: () => null, limit: 10 });
    // Both have totalSpent=200. u2 has more recent lastPurchase → wins.
    expect(r[0]?.userId).toBe('u2');
  });

  it('ignores non-delivered events', () => {
    const rows: IapAdAnalyticsRow[] = [
      makeRow('iap_purchase_initiated', 1000, 'u1', { amountCoins: 999 }),
      makeRow('iap_purchase_validated', 1100, 'u1', { amountCoins: 999 }),
      makeRow('iap_purchase_failed', 1200, 'u1', { amountCoins: 999 }),
    ];
    const r = computeTopBuyers({ rows, userLookup: () => null, limit: 10 });
    expect(r).toEqual([]);
  });
});
