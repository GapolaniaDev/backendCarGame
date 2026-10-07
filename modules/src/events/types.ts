// Phase 8 Chunk 1 — Scheduled events catalog + active-event types.

/**
 * Event kinds. Each kind carries a different payload shape; the
 * runtime reads `payload` as `unknown` and dispatches by `kind`.
 */
export type EventKind = 'xp_double' | 'featured_track' | 'special_offer';

/**
 * Catalog entry from `catalogs/events.json`. `payload` shape depends
 * on `kind`:
 *   - `xp_double`         → `{multiplier: number}` (typically 2 or 3)
 *   - `featured_track`    → `{trackId: string}`
 *   - `special_offer`     → `{sku: string, discountPct?: number}`
 */
export interface ScheduledEvent {
  id: string;
  kind: EventKind;
  startsAtUtc: string; // ISO-8601 UTC
  endsAtUtc: string;   // ISO-8601 UTC
  payload: Record<string, unknown>;
}

/**
 * Runtime view: an event currently active (nowUtc falls inside the
 * window). `remainingMs` is useful for client-side countdowns.
 */
export interface ActiveEvent {
  id: string;
  kind: EventKind;
  payload: Record<string, unknown>;
  startsAt: number;     // epoch-ms
  endsAt: number;       // epoch-ms
  remainingMs: number;  // endsAt - nowUtc (>= 0)
}

export interface RawEventsFile {
  version: number;
  events: ScheduledEvent[];
}

export function validateEventsFile(
  raw: unknown,
): { ok: true; value: RawEventsFile } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'events.json must be an object' };
  }
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) {
    return { ok: false, reason: `events.json version must be 1, got ${String(r['version'])}` };
  }
  if (!Array.isArray(r['events'])) {
    return { ok: false, reason: 'events.json events must be an array' };
  }
  const ids = new Set<string>();
  for (let i = 0; i < r['events'].length; i += 1) {
    const e = r['events'][i] as Record<string, unknown>;
    if (typeof e['id'] !== 'string' || e['id'].length === 0) {
      return { ok: false, reason: `events[${i}].id must be a non-empty string` };
    }
    if (ids.has(e['id'] as string)) {
      return { ok: false, reason: `events[${i}].id "${e['id']}" duplicates an earlier entry` };
    }
    ids.add(e['id'] as string);
    if (
      e['kind'] !== 'xp_double' &&
      e['kind'] !== 'featured_track' &&
      e['kind'] !== 'special_offer'
    ) {
      return { ok: false, reason: `events[${i}].kind "${String(e['kind'])}" invalid` };
    }
    if (typeof e['startsAtUtc'] !== 'string' || typeof e['endsAtUtc'] !== 'string') {
      return { ok: false, reason: `events[${i}] startsAtUtc + endsAtUtc must be ISO strings` };
    }
    if (e['payload'] === undefined || typeof e['payload'] !== 'object' || e['payload'] === null) {
      return { ok: false, reason: `events[${i}].payload must be an object` };
    }
  }
  return { ok: true, value: r as unknown as RawEventsFile };
}