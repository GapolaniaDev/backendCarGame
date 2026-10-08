// Phase 9 Chunk 7 — Pure funnel conversion computation.
//
// Counts events per stage of the IAP purchase funnel and reports the
// per-stage conversion rate. The funnel has 3 stages (in order):
//
//   initiated → validated → delivered
//
// Each stage is an `iap_purchase_initiated` / `iap_purchase_validated`
// / `iap_purchase_delivered` event keyed by `transactionId`. The
// distinct count of `transactionId`s per stage is the funnel count.
// Filters: packId / platform narrow the events before counting.

import { type IapAdEventPayload, type IapAdAnalyticsRow } from './iap_events';

export interface FunnelFilters {
  packId?: string;
  platform?: 'apple' | 'google' | 'mock';
}

export interface FunnelStage {
  stage: 'initiated' | 'validated' | 'delivered';
  count: number;
  /** Fraction of initiated that reached this stage. 0 when initiated=0. */
  conversionFromInitiated: number;
  /** Fraction of the previous stage that reached this stage. 0 when previous=0. */
  conversionFromPrevious: number;
}

export interface FunnelByBucket {
  bucket: string; // packId or platform
  stages: FunnelStage[];
}

export interface FunnelResult {
  stages: FunnelStage[];
  byPack: FunnelByBucket[];
  byPlatform: FunnelByBucket[];
}

export interface FunnelInputs {
  rows: IapAdAnalyticsRow[];
  filters?: FunnelFilters;
}

const STAGE_LABELS = ['initiated', 'validated', 'delivered'] as const;
const STAGE_EVENTS = [
  'iap_purchase_initiated',
  'iap_purchase_validated',
  'iap_purchase_delivered',
] as const;

type StageEvent = typeof STAGE_EVENTS[number];

function matchesFilters(p: IapAdEventPayload, f: FunnelFilters | undefined): boolean {
  if (!f) return true;
  if (f.packId !== undefined && p.packId !== f.packId) return false;
  if (f.platform !== undefined && p.platform !== f.platform) return false;
  return true;
}

/** Pure: counts distinct transactionIds per stage. */
export function countStage(
  rows: IapAdAnalyticsRow[],
  stage: StageEvent,
  filters?: FunnelFilters,
): Set<string> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.name !== stage) continue;
    if (!matchesFilters(r.props, filters)) continue;
    if (typeof r.props.transactionId !== 'string') continue;
    ids.add(r.props.transactionId);
  }
  return ids;
}

function buildStages(initiated: Set<string>, validated: Set<string>, delivered: Set<string>): FunnelStage[] {
  const prev = [initiated.size, validated.size, delivered.size];
  const out: FunnelStage[] = [];
  for (let i = 0; i < 3; i += 1) {
    const label = STAGE_LABELS[i]!;
    const count = prev[i]!;
    const prevCount = i > 0 ? prev[i - 1]! : count;
    out.push({
      stage: label,
      count,
      conversionFromInitiated: initiated.size === 0 ? 0 : count / initiated.size,
      conversionFromPrevious: prevCount === 0 ? 0 : (i === 0 ? 1 : count / prevCount),
    });
  }
  return out;
}

export function computeFunnel({ rows, filters }: FunnelInputs): FunnelResult {
  const initiated = countStage(rows, STAGE_EVENTS[0], filters);
  const validated = countStage(rows, STAGE_EVENTS[1], filters);
  const delivered = countStage(rows, STAGE_EVENTS[2], filters);
  const stages = buildStages(initiated, validated, delivered);

  // byPack — group events by packId, then per-bucket count.
  const packIds = new Set<string>();
  for (const r of rows) {
    if (typeof r.props.packId === 'string' && STAGE_EVENTS.includes(r.name as typeof STAGE_EVENTS[number])) {
      packIds.add(r.props.packId);
    }
  }
  const byPack: FunnelByBucket[] = [];
  for (const packId of Array.from(packIds).sort()) {
    const subFilters: FunnelFilters = { packId };
    const i = countStage(rows, STAGE_EVENTS[0], subFilters);
    const v = countStage(rows, STAGE_EVENTS[1], subFilters);
    const d = countStage(rows, STAGE_EVENTS[2], subFilters);
    byPack.push({ bucket: packId, stages: buildStages(i, v, d) });
  }

  // byPlatform.
  const platforms = new Set<'apple' | 'google' | 'mock'>();
  for (const r of rows) {
    const p = r.props.platform;
    if ((p === 'apple' || p === 'google' || p === 'mock') && STAGE_EVENTS.includes(r.name as typeof STAGE_EVENTS[number])) {
      platforms.add(p);
    }
  }
  const byPlatform: FunnelByBucket[] = [];
  for (const platform of Array.from(platforms).sort()) {
    const subFilters: FunnelFilters = { platform };
    const i = countStage(rows, STAGE_EVENTS[0], subFilters);
    const v = countStage(rows, STAGE_EVENTS[1], subFilters);
    const d = countStage(rows, STAGE_EVENTS[2], subFilters);
    byPlatform.push({ bucket: platform, stages: buildStages(i, v, d) });
  }

  return { stages, byPack, byPlatform };
}
