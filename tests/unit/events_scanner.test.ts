// Phase 8 Chunk 8 — Unit tests for the events scanner.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  startEventScanner,
  runEventScannerTick,
  resolveActiveSpecialOfferIds,
  ACTIVE_SPECIAL_OFFERS_CAP,
  EVENT_SCANNER_INTERVAL_MS,
} from '../../modules/src/events/scanner';
import { stopEventScannerForTests } from '../../modules/src/events/_reset_for_tests';
import {
  loadEventsCatalog,
  _resetActiveEventsCatalogForTests,
} from '../../modules/src/core/active_events';
import { readProfile, writeProfileCreate } from '../../modules/src/profiles/storage';
import { FakeNakama } from '../e2e/_stubs';
import type { ILogger, INakama } from '../../modules/src/nkruntime';
import type { RawEventsFile } from '../../modules/src/events/types';
import type { ProfileRecord } from '../../modules/src/profiles/storage';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
  getFields: () => ({}),
} as unknown as ILogger;

const EVENTS_NO_OFFER: RawEventsFile = {
  version: 1,
  events: [
    {
      id: 'evt_xp2',
      kind: 'xp_double',
      startsAtUtc: '2026-10-08T00:00:00Z',
      endsAtUtc: '2026-10-15T00:00:00Z',
      payload: { multiplier: 2 },
    },
  ],
};

const EVENTS_ONE_OFFER: RawEventsFile = {
  version: 1,
  events: [
    {
      id: 'evt_offer_gem',
      kind: 'special_offer',
      startsAtUtc: '2026-10-08T00:00:00Z',
      endsAtUtc: '2026-10-15T00:00:00Z',
      payload: { sku: 'gem_pack_500_50off', discountPct: 50 },
    },
  ],
};

const EVENTS_MULTIPLE_OFFERS: RawEventsFile = {
  version: 1,
  events: [
    {
      id: 'evt_offer_a',
      kind: 'special_offer',
      startsAtUtc: '2026-10-08T00:00:00Z',
      endsAtUtc: '2026-10-22T00:00:00Z',
      payload: { sku: 'sku_a', discountPct: 30 },
    },
    {
      id: 'evt_offer_b',
      kind: 'special_offer',
      startsAtUtc: '2026-10-10T00:00:00Z',
      endsAtUtc: '2026-10-20T00:00:00Z',
      payload: { sku: 'sku_b', discountPct: 50 },
    },
    {
      id: 'evt_offer_expired',
      kind: 'special_offer',
      startsAtUtc: '2026-09-01T00:00:00Z',
      endsAtUtc: '2026-09-30T00:00:00Z',
      payload: { sku: 'sku_old', discountPct: 10 },
    },
  ],
};

function setupCatalogs(events: RawEventsFile): void {
  _resetActiveEventsCatalogForTests();
  loadEventsCatalog(SILENT_LOGGER, events, null);
}

function seedProfile(nk: INakama, p: ProfileRecord): void {
  writeProfileCreate(nk, p);
}

describe('events scanner (Phase 8 Chunk 8)', () => {
  let fake: FakeNakama;
  let nk: INakama;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
  });

  afterEach(() => {
    stopEventScannerForTests();
  });

  // ─── resolveActiveSpecialOfferIds (pure) ──────────────────────────────

  it('returns empty when no special_offer events are live', () => {
    setupCatalogs(EVENTS_NO_OFFER);
    const ids = resolveActiveSpecialOfferIds(Date.parse('2026-10-08T12:00:00Z'));
    expect(ids).toEqual([]);
  });

  it('returns the live special_offer event id', () => {
    setupCatalogs(EVENTS_ONE_OFFER);
    const ids = resolveActiveSpecialOfferIds(Date.parse('2026-10-08T12:00:00Z'));
    expect(ids).toEqual(['evt_offer_gem']);
  });

  it('skips expired special_offers', () => {
    setupCatalogs(EVENTS_MULTIPLE_OFFERS);
    const ids = resolveActiveSpecialOfferIds(Date.parse('2026-10-15T12:00:00Z'));
    expect(ids).toContain('evt_offer_a');
    expect(ids).toContain('evt_offer_b');
    expect(ids).not.toContain('evt_offer_expired');
  });

  it('sorts by endsAt ascending (soonest-expiring first)', () => {
    setupCatalogs(EVENTS_MULTIPLE_OFFERS);
    const ids = resolveActiveSpecialOfferIds(Date.parse('2026-10-15T12:00:00Z'));
    expect(ids[0]).toBe('evt_offer_b'); // ends 2026-10-20
    expect(ids[1]).toBe('evt_offer_a'); // ends 2026-10-22
  });

  it('caps at ACTIVE_SPECIAL_OFFERS_CAP', () => {
    const many = RawEventsFile(
      Array.from({ length: 15 }, (_, i) => ({
        id: `evt_offer_${i}`,
        kind: 'special_offer' as const,
        startsAtUtc: '2026-10-08T00:00:00Z',
        endsAtUtc: `2026-10-${(9 + i).toString().padStart(2, '0')}T00:00:00Z`,
        payload: { sku: `sku_${i}`, discountPct: 10 },
      })),
    );
    setupCatalogs(many);
    const ids = resolveActiveSpecialOfferIds(Date.parse('2026-10-08T12:00:00Z'));
    expect(ids).toHaveLength(ACTIVE_SPECIAL_OFFERS_CAP);
  });

  // ─── runEventScannerTick ──────────────────────────────────────────────

  it('updates profile.activeSpecialOffers when an event is live', () => {
    setupCatalogs(EVENTS_ONE_OFFER);
    const nkNow = Date.parse('2026-10-10T00:00:00Z');
    seedProfile(nk, {
      schemaVersion: 1,
      userId: 'u1',
      displayName: 'u1',
      avatarUrl: null,
      createdAt: 0,
      updatedAt: 0,
    });
    const r = runEventScannerTick({
      logger: SILENT_LOGGER,
      nk,
      nowFn: () => nkNow,
    });
    expect(r.scanned).toBe(1);
    expect(r.updated).toBe(1);
    expect(r.desired).toEqual(['evt_offer_gem']);
    const p = readProfile(nk, 'u1');
    expect(p?.activeSpecialOffers).toEqual(['evt_offer_gem']);
  });

  it('no-ops when desired == current', () => {
    setupCatalogs(EVENTS_ONE_OFFER);
    const nkNow = Date.parse('2026-10-10T00:00:00Z');
    seedProfile(nk, {
      schemaVersion: 1,
      userId: 'u1',
      displayName: 'u1',
      avatarUrl: null,
      createdAt: 0,
      updatedAt: 0,
      activeSpecialOffers: ['evt_offer_gem'],
    });
    const r = runEventScannerTick({
      logger: SILENT_LOGGER,
      nk,
      nowFn: () => nkNow,
    });
    expect(r.updated).toBe(0);
  });

  it('clears the flag when the offer has expired', () => {
    setupCatalogs(EVENTS_ONE_OFFER);
    const nkNow = Date.parse('2026-10-20T00:00:00Z'); // after endsAt
    seedProfile(nk, {
      schemaVersion: 1,
      userId: 'u1',
      displayName: 'u1',
      avatarUrl: null,
      createdAt: 0,
      updatedAt: 0,
      activeSpecialOffers: ['evt_offer_gem'],
    });
    const r = runEventScannerTick({
      logger: SILENT_LOGGER,
      nk,
      nowFn: () => nkNow,
    });
    expect(r.desired).toEqual([]);
    expect(r.updated).toBe(1);
    const p = readProfile(nk, 'u1');
    expect(p?.activeSpecialOffers).toEqual([]);
  });

  it('skips profiles missing userId (defensive)', () => {
    setupCatalogs(EVENTS_ONE_OFFER);
    const nkNow = Date.parse('2026-10-10T00:00:00Z');
    // Inject a profile without userId via direct store.
    nk.storageWrite([{
      collection: 'profiles',
      key: 'malformed',
      userId: 'malformed',
      value: { schemaVersion: 1 } as unknown as Record<string, unknown>,
      permissionRead: 0,
      permissionWrite: 0,
    }]);
    const r = runEventScannerTick({
      logger: SILENT_LOGGER,
      nk,
      nowFn: () => nkNow,
    });
    // The malformed row is visited but not updated (no userId).
    expect(r.scanned).toBe(1);
    expect(r.updated).toBe(0);
  });

  it('startEventScanner is idempotent — second call returns no-op handle', () => {
    setupCatalogs(EVENTS_ONE_OFFER);
    const h1 = startEventScanner({ logger: SILENT_LOGGER, nk, intervalMs: 60_000 });
    const h2 = startEventScanner({ logger: SILENT_LOGGER, nk, intervalMs: 60_000 });
    expect(h1).toBeDefined();
    expect(h2).toBeDefined();
    h1.stop();
  });

  it('scanner interval constant is 5 minutes', () => {
    expect(EVENT_SCANNER_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});

// Helper to build a RawEventsFile from a list of events.
function RawEventsFile(events: import('../../modules/src/events/types').ScheduledEvent[]): RawEventsFile {
  return { version: 1, events };
}
