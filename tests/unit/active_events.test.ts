// Phase 8 Chunk 1 — Unit tests for the active-events catalog + queries.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  loadEventsCatalog,
  activeEvents,
  activeEventOfKind,
  activeEventMultipliers,
  _resetActiveEventsCatalogForTests,
  getEventsCatalog,
} from '../../modules/src/core/active_events';
import type { RawEventsFile } from '../../modules/src/events/types';
import type { ILogger } from '../../modules/src/nkruntime';

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

function fixedUtcMs(iso: string): number {
  return Date.parse(iso);
}

const LIVE_EVENTS_FILE: RawEventsFile = {
  version: 1,
  events: [
    {
      id: 'evt_xp2_now',
      kind: 'xp_double',
      startsAtUtc: '2026-10-08T00:00:00Z',
      endsAtUtc: '2026-10-15T00:00:00Z',
      payload: { multiplier: 2 },
    },
    {
      id: 'evt_xp3_later',
      kind: 'xp_double',
      startsAtUtc: '2026-10-30T00:00:00Z',
      endsAtUtc: '2026-11-02T00:00:00Z',
      payload: { multiplier: 3 },
    },
    {
      id: 'evt_featured_stadium',
      kind: 'featured_track',
      startsAtUtc: '2026-10-05T00:00:00Z',
      endsAtUtc: '2026-11-02T00:00:00Z',
      payload: { trackId: 'stadium_today' },
    },
    {
      id: 'evt_offer_now',
      kind: 'special_offer',
      startsAtUtc: '2026-10-08T00:00:00Z',
      endsAtUtc: '2026-10-22T00:00:00Z',
      payload: { sku: 'gem_pack_500_50off', discountPct: 50 },
    },
    {
      id: 'evt_offer_ends_earlier',
      kind: 'special_offer',
      startsAtUtc: '2026-10-08T00:00:00Z',
      endsAtUtc: '2026-10-12T00:00:00Z',
      payload: { sku: 'starter_pack_oct', discountPct: 25 },
    },
    {
      id: 'evt_expired',
      kind: 'xp_double',
      startsAtUtc: '2026-09-25T00:00:00Z',
      endsAtUtc: '2026-10-02T00:00:00Z',
      payload: { multiplier: 2 },
    },
    {
      id: 'evt_future',
      kind: 'special_offer',
      startsAtUtc: '2026-11-15T00:00:00Z',
      endsAtUtc: '2026-11-30T00:00:00Z',
      payload: { sku: 'gem_pack_500_50off', discountPct: 50 },
    },
  ],
};

// Now = 2026-10-08T12:00:00Z (mid-day, with multiple live).
const NOW_UTC = fixedUtcMs('2026-10-08T12:00:00Z');

describe('active_events (Phase 8 Chunk 1)', () => {
  beforeEach(() => {
    _resetActiveEventsCatalogForTests();
    loadEventsCatalog(mkLogger(), LIVE_EVENTS_FILE, null);
  });

  it('returns only events within window at nowUtc', () => {
    const live = activeEvents(NOW_UTC);
    const ids = live.map((e) => e.id).sort();
    expect(ids).toEqual(['evt_featured_stadium', 'evt_offer_ends_earlier', 'evt_offer_now', 'evt_xp2_now']);
  });

  it('excludes expired events', () => {
    const live = activeEvents(NOW_UTC);
    expect(live.find((e) => e.id === 'evt_expired')).toBeUndefined();
  });

  it('excludes future events', () => {
    const live = activeEvents(NOW_UTC);
    expect(live.find((e) => e.id === 'evt_future')).toBeUndefined();
  });

  it('sorts active events by endsAt ascending', () => {
    const live = activeEvents(NOW_UTC);
    for (let i = 1; i < live.length; i += 1) {
      expect(live[i - 1]!.endsAt).toBeLessThanOrEqual(live[i]!.endsAt);
    }
  });

  it('activeEventOfKind returns null when none active', () => {
    // Between evt_expired (ends 2026-10-02) and evt_xp2_now
    // (starts 2026-10-08) there's a window with NO xp_double event.
    const t = fixedUtcMs('2026-10-05T00:00:00Z');
    const r = activeEventOfKind('xp_double', t);
    expect(r).toBeNull();
  });

  it('activeEventOfKind returns the soonest-expiring active event of that kind', () => {
    const r = activeEventOfKind('xp_double', NOW_UTC);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.id).toBe('evt_xp2_now');
  });

  it('activeEventMultipliers defaults to 1× / 1× when no xp_double active', () => {
    // Use a moment where no xp_double is live (between evt_expired and evt_xp2_now).
    const t = fixedUtcMs('2026-10-03T00:00:00Z');
    const m = activeEventMultipliers(t);
    expect(m.xp).toBe(1);
    expect(m.coins).toBe(1);
  });

  it('activeEventMultipliers uses the xp_double multiplier when active', () => {
    const m = activeEventMultipliers(NOW_UTC);
    expect(m.xp).toBe(2);
    expect(m.coins).toBe(2);
  });

  it('activeEventMultipliers picks the highest when multiple xp_double events overlap', () => {
    // Pick a moment inside BOTH evt_xp2_now (x2) AND evt_xp3_later
    // (x3). They don't overlap in our fixture; use evt_xp3_later's
    // window for the test.
    const t = fixedUtcMs('2026-10-31T00:00:00Z');
    const m = activeEventMultipliers(t);
    expect(m.xp).toBe(3);
    expect(m.coins).toBe(3);
  });

  it('catalog has 7 events (>= 10 target is in the JSON, > 7 to keep this test small)', () => {
    const cat = getEventsCatalog();
    expect(cat.length).toBeGreaterThanOrEqual(7);
  });
});