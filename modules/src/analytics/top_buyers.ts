// Phase 9 Chunk 7 — Pure top-buyers aggregation.
//
// Reads `iap_purchase_delivered` events and groups by `userId`,
// reporting per-user total spend (in coins), purchase count, last
// purchase ts, and a unique list of packIds. Results are sorted by
// `totalSpent desc` and capped at `limit`. The username lookup is
// injected so the pure function stays I/O-free.

import type { IapAdAnalyticsRow } from './iap_events';

export interface TopBuyer {
  userId: string;
  username: string;
  totalSpent: number;
  purchaseCount: number;
  lastPurchaseUtc: number;
  packIds: string[];
}

export interface TopBuyersInputs {
  rows: IapAdAnalyticsRow[];
  userLookup: (userId: string) => { username: string } | null;
  limit: number;
}

interface BuyerBucket {
  totalSpent: number;
  purchaseCount: number;
  lastPurchaseUtc: number;
  packIds: Set<string>;
}

export function computeTopBuyers({ rows, userLookup, limit }: TopBuyersInputs): TopBuyer[] {
  const buckets = new Map<string, BuyerBucket>();
  for (const r of rows) {
    if (r.name !== 'iap_purchase_delivered') continue;
    if (typeof r.userId !== 'string') continue;
    const amount = r.props.amountCoins;
    if (typeof amount !== 'number') continue;
    let bucket = buckets.get(r.userId);
    if (bucket === undefined) {
      bucket = { totalSpent: 0, purchaseCount: 0, lastPurchaseUtc: 0, packIds: new Set() };
      buckets.set(r.userId, bucket);
    }
    bucket.totalSpent += amount;
    bucket.purchaseCount += 1;
    if (r.ts > bucket.lastPurchaseUtc) bucket.lastPurchaseUtc = r.ts;
    if (typeof r.props.packId === 'string') bucket.packIds.add(r.props.packId);
  }
  const out: TopBuyer[] = [];
  for (const [userId, b] of Array.from(buckets.entries())) {
    const u = userLookup(userId);
    out.push({
      userId,
      username: u?.username ?? '',
      totalSpent: b.totalSpent,
      purchaseCount: b.purchaseCount,
      lastPurchaseUtc: b.lastPurchaseUtc,
      packIds: Array.from(b.packIds).sort(),
    });
  }
  out.sort((a, b) => {
    if (b.totalSpent !== a.totalSpent) return b.totalSpent - a.totalSpent;
    if (b.purchaseCount !== a.purchaseCount) return b.purchaseCount - a.purchaseCount;
    return b.lastPurchaseUtc - a.lastPurchaseUtc;
  });
  if (limit > 0 && out.length > limit) return out.slice(0, limit);
  return out;
}
