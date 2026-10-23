// Phase 8 Chunk 8 — Events: the live view of the one event source.
//
// Plan T-23 (audit 07 f11, f18; HT-69 Social 10): events have ONE source,
// the bundled `events.json` calendar (`core/active_events.ts`). Everything
// that needs "what is live now" asks it with the server clock:
// `event_list`, the store pricing (`store/pricing.ts`), the XP multiplier
// and the `calendar` of `liveops_config_get`.
//
// This used to be a scanner that rewrote EVERY profile every 5 minutes to
// cache the live special offers in `profile.activeSpecialOffers` (a second,
// stale copy of the calendar; it also rebuilt each profile from a fixed
// field list, so any other field would have been dropped). The service
// ticker now only logs the live counts.

import type { ILogger, INakama } from '../nkruntime';
import { activeEvents } from '../core/active_events';

/** Maximum number of live special-offer ids reported. */
export const ACTIVE_SPECIAL_OFFERS_CAP = 10;

export interface EventScannerDeps {
  logger: ILogger;
  nk: INakama;
  /** Override `Date.now()` for deterministic tests. */
  nowFn?: () => number;
}

/**
 * Compute the desired `activeSpecialOffers` list for `nowUtc`. Pure
 * helper — exported for tests.
 */
export function resolveActiveSpecialOfferIds(nowUtc: number): string[] {
  const live = activeEvents(nowUtc);
  const out: string[] = [];
  for (const e of live) {
    if (e.kind !== 'special_offer') continue;
    if (out.includes(e.id)) continue;
    out.push(e.id);
    if (out.length >= ACTIVE_SPECIAL_OFFERS_CAP) break;
  }
  // activeEvents already returns them sorted by endsAt ascending;
  // the `include` guard dedupes the (extremely unlikely) case where
  // two events share an id.
  return out;
}

/**
 * One read-only pass for the service ticker: how many events are live
 * and which special offers apply now. Writes nothing.
 */
export function runEventScannerTick(deps: EventScannerDeps): {
  live: number;
  desired: string[];
} {
  const nowUtc = (deps.nowFn ?? Date.now)();
  return { live: activeEvents(nowUtc).length, desired: resolveActiveSpecialOfferIds(nowUtc) };
}
