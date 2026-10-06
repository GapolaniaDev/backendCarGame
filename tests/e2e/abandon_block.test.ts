// E2E tests for Phase 4 Chunk 9: `ranked_get` surfaces the
// `abandonsLast24h` + `blockedUntilUtc` fields driven by the liveops
// abandon tracker.
//
// The subscriber → abandon_tracker wiring is tested in
// `rating_subscriber.test.ts` (unit). The e2e suite focuses on the
// consumer side: ranked_get reads the abandon record and shapes the
// response. We seed the abandons/{userId} storage record directly
// because the race submit path only auto-closes a session when
// every human reports — the abandon path itself is exercised via
// `handleRaceCompletedForRanked` in the unit suite.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest } from './_stubs';
import type { RankedGetOutput } from '../../modules/src/ranked/types';

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string | null,
  payload: unknown,
): Envelope<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const raw = handler(ctx, env.logger, env.nak, body);
  return JSON.parse(raw as string) as Envelope<T>;
}

/** Seed an abandon record for `userId` directly in the store. */
function seedAbandons(
  env: ReturnType<typeof loadBundleForTest>,
  userId: string,
  entries: Array<{ at: number }>,
  blockedUntilUtc: number | null,
): void {
  const now = new Date().toISOString();
  env.fakeNakama.store.set(`abandons/${userId}/${userId}`, {
    collection: 'abandons',
    key: userId,
    userId,
    value: {
      schemaVersion: 1,
      entries,
      blockedUntilUtc,
    },
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: now,
    updateTime: now,
    expiresAt: null,
  });
}

describe('ranked_get (Phase 4 Chunk 9) — D6 abandon block exposed', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('ranked_get on a brand-new player returns abandonsLast24h=0, blockedUntilUtc=null', () => {
    const r = call<Envelope<RankedGetOutput>>(env, 'ranked_get', 'clean-user', {
      callerUserId: 'clean-user',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.abandonsLast24h).toBe(0);
    expect(r.data.blockedUntilUtc).toBeNull();
  });

  it('ranked_get returns abandonsLast24h=2 after 2 entries (no block yet)', () => {
    const NOW = Date.now();
    seedAbandons(env, 'two-abandon-user', [
      { at: NOW - 60_000 },
      { at: NOW - 30_000 },
    ], null);
    const r = call<Envelope<RankedGetOutput>>(env, 'ranked_get', 'two-abandon-user', {
      callerUserId: 'two-abandon-user',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.abandonsLast24h).toBe(2);
    expect(r.data.blockedUntilUtc).toBeNull();
  });

  it('ranked_get on a blocked player returns abandonsLast24h=3 + blockedUntilUtc', () => {
    const NOW = Date.now();
    seedAbandons(env, 'blocked-user', [
      { at: NOW - 5 * 60_000 },
      { at: NOW - 3 * 60_000 },
      { at: NOW - 60_000 },
    ], NOW + 15 * 60 * 1000);
    const r = call<Envelope<RankedGetOutput>>(env, 'ranked_get', 'blocked-user', {
      callerUserId: 'blocked-user',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.abandonsLast24h).toBe(3);
    expect(r.data.blockedUntilUtc).not.toBeNull();
    expect(r.data.blockedUntilUtc!).toBeGreaterThan(NOW);
    // Block is ~15 minutes from the third entry.
    expect(r.data.blockedUntilUtc!).toBeLessThanOrEqual(NOW + 16 * 60 * 1000);
  });

  it('ranked_get returns gracefully during a block — no error, just signals', () => {
    const NOW = Date.now();
    seedAbandons(env, 'midblock-user', [
      { at: NOW - 4 * 60_000 },
      { at: NOW - 3 * 60_000 },
      { at: NOW - 2 * 60_000 },
    ], NOW + 10 * 60 * 1000);
    const r = call<Envelope<RankedGetOutput>>(env, 'ranked_get', 'midblock-user', {
      callerUserId: 'midblock-user',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.blockedUntilUtc).not.toBeNull();
  });

  it('ranked_get drops expired entries from the count (lazy GC)', () => {
    const NOW = Date.now();
    seedAbandons(env, 'stale-user', [
      { at: NOW - 25 * 60 * 60 * 1000 }, // expired
      { at: NOW - 24 * 60 * 60 * 1000 - 60_000 }, // expired
      { at: NOW - 60_000 }, // fresh
    ], null);
    const r = call<Envelope<RankedGetOutput>>(env, 'ranked_get', 'stale-user', {
      callerUserId: 'stale-user',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.abandonsLast24h).toBe(1);
  });

  it('ranked_get on an expired block returns blockedUntilUtc=null (auto-clears)', () => {
    const NOW = Date.now();
    seedAbandons(env, 'expired-block-user', [
      { at: NOW - 30 * 60 * 1000 },
      { at: NOW - 20 * 60 * 1000 },
      { at: NOW - 10 * 60 * 1000 },
    ], NOW - 60_000); // block expired 1 minute ago
    const r = call<Envelope<RankedGetOutput>>(env, 'ranked_get', 'expired-block-user', {
      callerUserId: 'expired-block-user',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.blockedUntilUtc).toBeNull();
    // Entries are still inside the 24h window, so the counter stays.
    expect(r.data.abandonsLast24h).toBe(3);
  });

  it('abandons are independent per user — P1 blocks, P2 stays clean', () => {
    const NOW = Date.now();
    seedAbandons(env, 'p1-multi', [
      { at: NOW - 5 * 60_000 },
      { at: NOW - 4 * 60_000 },
      { at: NOW - 3 * 60_000 },
    ], NOW + 15 * 60 * 1000);
    seedAbandons(env, 'p2-single', [{ at: NOW - 60_000 }], null);

    const r1 = call<Envelope<RankedGetOutput>>(env, 'ranked_get', 'p1-multi', {
      callerUserId: 'p1-multi',
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.abandonsLast24h).toBe(3);
    expect(r1.data.blockedUntilUtc).not.toBeNull();

    const r2 = call<Envelope<RankedGetOutput>>(env, 'ranked_get', 'p2-single', {
      callerUserId: 'p2-single',
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.abandonsLast24h).toBe(1);
    expect(r2.data.blockedUntilUtc).toBeNull();
  });
});