// Phase 8 Chunk 1 — Active-events catalog loader + query helpers.
//
// Reads `catalogs/events.json` once at boot, parses each row into a
// `ScheduledEvent`, and caches them in-process. The public API
// (`activeEvents`, `activeEventOfKind`, `activeEventMultipliers`) is
// pure — given a `nowUtc`, returns the slice that's currently live.
//
// Hot path: the matchmaker/race subscribers may call `activeEvents`
// on every race completion. The cache is read-only after boot — no
// mutex required. Test resets via `_resetActiveEventsCatalogForTests`.

import type { ILogger } from '../nkruntime';
import {
  validateEventsFile,
  type ActiveEvent,
  type EventKind,
  type RawEventsFile,
  type ScheduledEvent,
} from '../events/types';

let CACHED: ScheduledEvent[] | null = null;

export function loadEventsCatalog(
  logger: ILogger,
  raw: unknown,
  _nk: unknown,
): ScheduledEvent[] {
  const v = validateEventsFile(raw);
  if (!v.ok) {
    throw new Error(`events catalog invalid: ${v.reason}`);
  }
  CACHED = v.value.events;
  logger.info(
    'events catalog loaded: version=%d events=%d',
    v.value.version,
    v.value.events.length,
  );
  return CACHED;
}

export function getEventsCatalog(): ReadonlyArray<ScheduledEvent> {
  if (CACHED === null) {
    throw new Error(
      'events catalog not loaded — call loadEventsCatalog at boot before reading',
    );
  }
  return CACHED;
}

/** Test hook. Wipes the cache so the next read re-parses. */
export function _resetActiveEventsCatalogForTests(): void {
  CACHED = null;
}

/**
 * Returns the events currently active at `nowUtc` (an event is active
 * when `startsAt <= nowUtc < endsAt`). Sorted by `endsAt` ascending so
 * the soonest-expiring event appears first.
 */
export function activeEvents(nowUtc: number): ActiveEvent[] {
  const list = getEventsCatalog();
  const out: ActiveEvent[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i]!;
    const startsAt = Date.parse(e.startsAtUtc);
    const endsAt = Date.parse(e.endsAtUtc);
    if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) continue;
    if (startsAt <= nowUtc && nowUtc < endsAt) {
      out.push({
        id: e.id,
        kind: e.kind,
        payload: e.payload,
        startsAt,
        endsAt,
        remainingMs: endsAt - nowUtc,
      });
    }
  }
  out.sort((a, b) => a.endsAt - b.endsAt);
  return out;
}

/**
 * Returns the first active event of the given kind (sorted by endsAt
 * ascending — the soonest-expiring wins). Returns null when none.
 */
export function activeEventOfKind(
  kind: EventKind,
  nowUtc: number,
): ActiveEvent | null {
  const live = activeEvents(nowUtc);
  for (let i = 0; i < live.length; i += 1) {
    if (live[i]!.kind === kind) return live[i]!;
  }
  return null;
}

/**
 * XP + coin multipliers derived from the active `xp_double` event(s).
 * When MULTIPLE `xp_double` events overlap, the HIGHEST multiplier
 * wins (avoids stacking — the operator opted into running two events
 * at once, so the best one is "the event"). Default 1× when no event.
 */
export function activeEventMultipliers(nowUtc: number): { xp: number; coins: number } {
  const list = getEventsCatalog();
  let xp = 1;
  let coins = 1;
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i]!;
    const startsAt = Date.parse(e.startsAtUtc);
    const endsAt = Date.parse(e.endsAtUtc);
    if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) continue;
    if (!(startsAt <= nowUtc && nowUtc < endsAt)) continue;
    if (e.kind !== 'xp_double') continue;
    const payload = e.payload as { multiplier?: unknown };
    const m = typeof payload.multiplier === 'number' && Number.isFinite(payload.multiplier)
      ? payload.multiplier
      : 1;
    if (m > xp) xp = m;
    if (m > coins) coins = m;
  }
  return { xp, coins };
}

/** Re-export for tests + downstream modules. */
export type { ActiveEvent, ScheduledEvent, RawEventsFile };