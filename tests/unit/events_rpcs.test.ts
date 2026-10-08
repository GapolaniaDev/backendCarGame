// Phase 8 Chunk 8 — Unit tests for the `event_list` RPC.

import { describe, it, expect, beforeEach } from 'vitest';

import { event_list } from '../../modules/src/events/rpcs';
import {
  loadEventsCatalog,
  _resetActiveEventsCatalogForTests,
} from '../../modules/src/core/active_events';
import { FakeContext, FakeNakama } from '../e2e/_stubs';
import type { IContext, ILogger, INakama } from '../../modules/src/nkruntime';
import type { RawEventsFile } from '../../modules/src/events/types';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
  getFields: () => ({}),
} as unknown as ILogger;

const FULL: RawEventsFile = {
  version: 1,
  events: [
    {
      id: 'evt_xp2',
      kind: 'xp_double',
      startsAtUtc: '2026-10-08T00:00:00Z',
      endsAtUtc: '2026-10-15T00:00:00Z',
      payload: { multiplier: 2 },
    },
    {
      id: 'evt_featured',
      kind: 'featured_track',
      startsAtUtc: '2026-10-05T00:00:00Z',
      endsAtUtc: '2026-11-02T00:00:00Z',
      payload: { trackId: 'stadium_today' },
    },
    {
      id: 'evt_offer',
      kind: 'special_offer',
      startsAtUtc: '2026-10-08T00:00:00Z',
      endsAtUtc: '2026-10-22T00:00:00Z',
      payload: { sku: 'gem_pack_500_50off', discountPct: 50 },
    },
    {
      id: 'evt_future',
      kind: 'special_offer',
      startsAtUtc: '2026-11-15T00:00:00Z',
      endsAtUtc: '2026-11-30T00:00:00Z',
      payload: { sku: 'future_pack', discountPct: 20 },
    },
  ],
};

function setupCatalog(): void {
  _resetActiveEventsCatalogForTests();
  loadEventsCatalog(SILENT_LOGGER, FULL, null);
}

function callRpc(nk: INakama, ctx: IContext, body: unknown): { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } } {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const raw = event_list(ctx, SILENT_LOGGER, nk, payload);
  return JSON.parse(raw) as { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
}

describe('event_list RPC (Phase 8 Chunk 8)', () => {
  let fake: FakeNakama;
  let nk: INakama;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
    setupCatalog();
  });

  it('returns every catalog event with isActive', () => {
    const r = callRpc(nk, { ...FakeContext, userId: 'u1' }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { events: Array<{ id: string; isActive: boolean }>; now: number };
    expect(data.events).toHaveLength(4);
    expect(typeof data.now).toBe('number');
  });

  it('marks currently-live events as isActive=true', () => {
    const r = callRpc(nk, { ...FakeContext, userId: 'u1' }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { events: Array<{ id: string; isActive: boolean }> };
    // serverNowMs() uses the real wall clock; on any day within the
    // 2026-10-08..2026-11-02 window, all 3 of those events are
    // active and evt_future is not.
    const live = data.events.find((e) => e.id === 'evt_xp2')!;
    expect(live.isActive).toBe(true);
  });

  it('marks future-only events as isActive=false', () => {
    const r = callRpc(nk, { ...FakeContext, userId: 'u1' }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { events: Array<{ id: string; isActive: boolean }> };
    const future = data.events.find((e) => e.id === 'evt_future')!;
    expect(future.isActive).toBe(false);
  });

  it('preserves payload field per event', () => {
    const r = callRpc(nk, { ...FakeContext, userId: 'u1' }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { events: Array<{ id: string; payload: Record<string, unknown> }> };
    const xp2 = data.events.find((e) => e.id === 'evt_xp2')!;
    expect(xp2.payload).toEqual({ multiplier: 2 });
    const offer = data.events.find((e) => e.id === 'evt_offer')!;
    expect(offer.payload).toEqual({ sku: 'gem_pack_500_50off', discountPct: 50 });
  });

  it('sorts by startsAtUtc ascending', () => {
    const r = callRpc(nk, { ...FakeContext, userId: 'u1' }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { events: Array<{ id: string; startsAtUtc: string }> };
    for (let i = 1; i < data.events.length; i += 1) {
      expect(data.events[i - 1]!.startsAtUtc <= data.events[i]!.startsAtUtc).toBe(true);
    }
  });

  it('UNAUTHENTICATED when no caller identity (socket) and no callerUserId', () => {
    const r = callRpc(nk, FakeContext, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNAUTHENTICATED');
  });

  it('accepts a callerUserId when ctx.userId is null (HTTP gateway)', () => {
    const r = callRpc(nk, FakeContext, { callerUserId: 'u1' });
    expect(r.ok).toBe(true);
  });

  it('BAD_REQUEST on malformed JSON', () => {
    const raw = event_list({ ...FakeContext, userId: 'u1' }, SILENT_LOGGER, nk, 'not json');
    const r = JSON.parse(raw) as { ok: false; error: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST when payload is an array', () => {
    const r = callRpc(nk, { ...FakeContext, userId: 'u1' }, []);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('empty body is treated as empty input (caller still required)', () => {
    const r = callRpc(nk, { ...FakeContext, userId: 'u1' }, '');
    expect(r.ok).toBe(true);
  });
});
