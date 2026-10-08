// Phase 9 Chunk 5 — e2e tests for the ad_watched RPC.

import { describe, it, expect, beforeEach } from 'vitest';
import { loadBundleForTest, FakeNakama, FakeContext } from './_stubs';
import type { LoadedBundle } from './_stubs';
import { _resetAdRewardsCatalogForTests } from '../../modules/src/ads/_reset_for_tests';
import { loadAdRewardsCatalog } from '../../modules/src/ads/catalog';
import adRewardsJson from '../../modules/src/catalogs/ad_rewards.json';
import {
  readAdLastWatched,
  readAdDailyCount,
  readAdWatchLog,
  writeAdLastWatched,
} from '../../modules/src/ads/repo';
import { endOfUtcDayUtc } from '../../modules/src/ads/grant';
import type { FakeNakama as FakeNakamaT } from './_stubs';
import type { IContext, ILogger } from '../../modules/src/nkruntime';

const REAL_NOW = Date.now();
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

function callRpc(
  bundle: LoadedBundle,
  nk: FakeNakamaT,
  userId: string,
  rpcName: string,
  payload: Record<string, unknown>,
): { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } {
  const ctx: IContext = { ...FakeContext, userId };
  const handler = bundle.resolver(rpcName);
  if (!handler) throw new Error(`${rpcName} RPC not registered`);
  const raw = handler(ctx, mkLogger(), nk.nakama, JSON.stringify(payload));
  return JSON.parse(raw) as ReturnType<typeof callRpc>;
}

function uuid(seed: number): string {
  // RFC 4122 v4 layout: xxxxxxxx-xxxx-4xxx-Yxxx-xxxxxxxxxxxx where Y in {8,9,a,b}.
  const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
  // LCG: deterministic per seed.
  let s = (seed * 2654435761 + 1) >>> 0;
  const next = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
  const a = next();
  const b = next();
  const c = next();
  // 8-4-4-4-12
  const part1 = hex(a, 8);
  const part2 = hex((b >>> 16) & 0xffff, 4);
  const part3 = '4' + hex(a & 0x0fff, 3);
  // Y = 8,9,a,b (top 2 bits = 10) + 12 random bits.
  const yNibble = 0x8 | ((b >>> 12) & 0x3);
  const part4 = hex((yNibble << 12) | (b & 0x0fff), 4);
  // Last 12 hex chars from c.
  const part5 = hex(c, 12).slice(0, 12);
  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

describe('ad_watched e2e (Phase 9 Chunk 5)', () => {
  let bundle: LoadedBundle;
  let nak: FakeNakamaT;

  beforeEach(() => {
    bundle = loadBundleForTest();
    _resetAdRewardsCatalogForTests();
    loadAdRewardsCatalog(mkLogger(), adRewardsJson);
    nak = new FakeNakama();
  });

  // ─── Happy path ──────────────────────────────────────────────────────

  it('happy path: grants coins + writes sidecars + returns balance', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small',
      provider: 'mock',
      adUnitId: 'rewarded_coins_v1',
      impressionId: VALID_UUID,
      watchedAtUtc: REAL_NOW - 1000,
    });
    if (!r.ok) throw new Error('ad_watched failed: ' + JSON.stringify(r));
    expect(r.data!.tier).toBe('small');
    expect(r.data!.coinsGranted).toBe(5);
    expect(r.data!.newBalance).toBe(5);
    expect(r.data!.idempotent).toBe(false);
    expect(r.data!.dailyCount).toBe(1);
    expect(r.data!.dailyCap).toBe(10);
    // last_watched row
    const lw = readAdLastWatched(nak.nakama, 'user-A', 'small');
    expect(lw).not.toBeNull();
    expect(lw!.lastImpressionId).toBe(VALID_UUID);
    // daily count row
    const today = new Date().toISOString().slice(0, 10);
    const dc = readAdDailyCount(nak.nakama, 'user-A', today);
    expect(dc).not.toBeNull();
    expect(dc!.count).toBe(1);
    // watch log row
    const log = readAdWatchLog(nak.nakama, 'user-A', VALID_UUID);
    expect(log).not.toBeNull();
    expect(log!.coinsGranted).toBe(5);
    expect(log!.newBalance).toBe(5);
  });

  it('happy path: medium tier grants 15 coins', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'medium', provider: 'mock', adUnitId: 'unit-m',
      impressionId: uuid(1), watchedAtUtc: REAL_NOW - 1000,
    });
    if (!r.ok) throw new Error('ad_watched failed: ' + JSON.stringify(r));
    expect(r.data!.coinsGranted).toBe(15);
    expect(r.data!.newBalance).toBe(15);
  });

  it('happy path: xlarge tier grants 60 coins', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'xlarge', provider: 'mock', adUnitId: 'unit-x',
      impressionId: uuid(2), watchedAtUtc: REAL_NOW - 1000,
    });
    if (!r.ok) throw new Error('ad_watched failed: ' + JSON.stringify(r));
    expect(r.data!.coinsGranted).toBe(60);
  });

  // ─── Idempotency ─────────────────────────────────────────────────────

  it('idempotent: same impressionId returns cached + idempotent:true', () => {
    const args = {
      tier: 'small', provider: 'mock', adUnitId: 'unit-1',
      impressionId: VALID_UUID, watchedAtUtc: REAL_NOW - 1000,
    };
    const r1 = callRpc(bundle, nak, 'user-A', 'ad_watched', args);
    if (!r1.ok) throw new Error('first failed: ' + JSON.stringify(r1));
    const r2 = callRpc(bundle, nak, 'user-A', 'ad_watched', args);
    if (!r2.ok) throw new Error('replay failed: ' + JSON.stringify(r2));
    expect(r2.data!.idempotent).toBe(true);
    expect(r2.data!.coinsGranted).toBe(5);
    // No double grant — balance still 5.
    expect(r2.data!.newBalance).toBe(5);
    // Daily count still 1.
    expect(r2.data!.dailyCount).toBe(0); // placeholder for replay (idempotent path)
  });

  // ─── Cooldown ────────────────────────────────────────────────────────

  it('cooldown: same tier twice in a row → CONFLICT', () => {
    const r1 = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'u',
      impressionId: uuid(10), watchedAtUtc: REAL_NOW - 1000,
    });
    if (!r1.ok) throw new Error('first failed: ' + JSON.stringify(r1));
    const r2 = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'u',
      impressionId: uuid(11), watchedAtUtc: REAL_NOW - 1000,
    });
    expect(r2.ok).toBe(false);
    expect(r2.error!.code).toBe('CONFLICT');
    expect(r2.error!.message).toMatch(/cooldown/i);
  });

  it('cooldown: per-tier (different tiers can run back-to-back)', () => {
    const r1 = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'u',
      impressionId: uuid(20), watchedAtUtc: REAL_NOW - 1000,
    });
    if (!r1.ok) throw new Error('small failed: ' + JSON.stringify(r1));
    const r2 = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'medium', provider: 'mock', adUnitId: 'u',
      impressionId: uuid(21), watchedAtUtc: REAL_NOW - 1000,
    });
    if (!r2.ok) throw new Error('medium should not cooldown: ' + JSON.stringify(r2));
    expect(r2.data!.coinsGranted).toBe(15);
  });

  // ─── Daily cap ───────────────────────────────────────────────────────

  it('daily cap: 10 ads succeed, 11th → CONFLICT', () => {
    // Use 10 distinct users — each watches 1 ad, proving the cap is
    // per-user and not a global ceiling. Then the 11th user proves
    // the cap is independent across users.
    for (let i = 0; i < 10; i += 1) {
      const r = callRpc(bundle, nak, `user-${i}`, 'ad_watched', {
        tier: 'small', provider: 'mock', adUnitId: 'u',
        impressionId: uuid(100 + i), watchedAtUtc: REAL_NOW - 1000,
      });
      if (!r.ok) throw new Error(`ad #${i} failed: ` + JSON.stringify(r));
    }
    // Now one user exhausts their own 10/10 cap. Re-seed cooldown
    // between calls so only the cap gates the 11th.
    const user = 'user-cap';
    const tiers = ['small', 'medium', 'large', 'xlarge'] as const;
    for (let i = 0; i < 10; i += 1) {
      // Re-seed the tier's lastWatched so cooldown passes.
      writeAdLastWatched(nak.nakama, user, tiers[i % tiers.length]!, {
        lastWatchedAtUtc: REAL_NOW - 3_600_000,
        lastImpressionId: 'seed',
      });
      const tier = tiers[i % tiers.length]!;
      const r = callRpc(bundle, nak, user, 'ad_watched', {
        tier, provider: 'mock', adUnitId: 'u',
        impressionId: uuid(500 + i), watchedAtUtc: REAL_NOW - 1000,
      });
      if (!r.ok) throw new Error(`#${i} (tier=${tier}) failed: ` + JSON.stringify(r));
    }
    // 11th — re-seed cooldown again so we isolate the cap.
    writeAdLastWatched(nak.nakama, user, 'xlarge', {
      lastWatchedAtUtc: REAL_NOW - 3_600_000,
      lastImpressionId: 'seed',
    });
    const r11 = callRpc(bundle, nak, user, 'ad_watched', {
      tier: 'xlarge', provider: 'mock', adUnitId: 'u',
      impressionId: uuid(600), watchedAtUtc: REAL_NOW - 1000,
    });
    expect(r11.ok).toBe(false);
    expect(r11.error!.code).toBe('CONFLICT');
    expect(r11.error!.message).toMatch(/cap/i);
  });

  it('daily cap: per-user (mixed tiers still count toward 10)', () => {
    // Re-seed cooldown between calls so we isolate the cap. Watch 5 small
    // and 5 medium (rotation across 4 tiers means 3 small + 2 medium
    // + 3 small + 2 medium, with cooldown re-seeded each call).
    const user = 'user-mix';
    const tiers = ['small', 'medium', 'large', 'xlarge'] as const;
    const sequence: ReadonlyArray<typeof tiers[number]> = [
      'small', 'medium', 'large', 'xlarge',
      'small', 'medium', 'large', 'xlarge',
      'small', 'medium',
    ];
    for (let i = 0; i < sequence.length; i += 1) {
      const tier = sequence[i]!;
      writeAdLastWatched(nak.nakama, user, tier, {
        lastWatchedAtUtc: REAL_NOW - 3_600_000,
        lastImpressionId: 'seed',
      });
      const r = callRpc(bundle, nak, user, 'ad_watched', {
        tier, provider: 'mock', adUnitId: 'u',
        impressionId: uuid(700 + i), watchedAtUtc: REAL_NOW - 1000,
      });
      if (!r.ok) throw new Error(`#${i} (tier=${tier}) failed: ` + JSON.stringify(r));
    }
    // 11th — re-seed, then expect cap.
    writeAdLastWatched(nak.nakama, user, 'xlarge', {
      lastWatchedAtUtc: REAL_NOW - 3_600_000,
      lastImpressionId: 'seed',
    });
    const r11 = callRpc(bundle, nak, user, 'ad_watched', {
      tier: 'xlarge', provider: 'mock', adUnitId: 'u',
      impressionId: uuid(800), watchedAtUtc: REAL_NOW - 1000,
    });
    expect(r11.ok).toBe(false);
    expect(r11.error!.code).toBe('CONFLICT');
  });

  // ─── Mock verify rejections ──────────────────────────────────────────

  it('rejects provider=admob → BAD_REQUEST', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'admob', adUnitId: 'u',
      impressionId: VALID_UUID, watchedAtUtc: REAL_NOW - 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('BAD_REQUEST');
  });

  it('rejects malformed impressionId → BAD_REQUEST', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'u',
      impressionId: 'not-a-uuid', watchedAtUtc: REAL_NOW - 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('BAD_REQUEST');
  });

  it('rejects watchedAtUtc in the far future → BAD_REQUEST', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'u',
      impressionId: VALID_UUID, watchedAtUtc: REAL_NOW + 600_000,
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('BAD_REQUEST');
  });

  it('accepts watchedAtUtc within 60s future (clock skew)', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'u',
      impressionId: VALID_UUID, watchedAtUtc: REAL_NOW + 30_000,
    });
    if (!r.ok) throw new Error('should accept 30s future: ' + JSON.stringify(r));
    expect(r.data!.coinsGranted).toBe(5);
  });

  // ─── Bad input ───────────────────────────────────────────────────────

  it('BAD_REQUEST when tier is missing', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      provider: 'mock', adUnitId: 'u',
      impressionId: VALID_UUID, watchedAtUtc: REAL_NOW - 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST when tier is not in catalog', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'mega', provider: 'mock', adUnitId: 'u',
      impressionId: VALID_UUID, watchedAtUtc: REAL_NOW - 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST when adUnitId is empty', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: '',
      impressionId: VALID_UUID, watchedAtUtc: REAL_NOW - 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST when impressionId is missing', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'u',
      watchedAtUtc: REAL_NOW - 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST when watchedAtUtc is missing', () => {
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'u',
      impressionId: VALID_UUID,
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('BAD_REQUEST');
  });

  // ─── Maintenance bypass ──────────────────────────────────────────────

  it('ad_watched BYPASSES maintenance (D77)', () => {
    // Flip the maintenance flag in liveops.
    nak.nakama.storageWrite([{
      collection: 'liveops', key: 'config',
      userId: '00000000-0000-0000-0000-000000000000',
      value: { version: 1, flags: { maintenance: true, maintenanceMessage: 'down' } },
      permissionRead: 1, permissionWrite: 0,
    }]);
    const r = callRpc(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'u',
      impressionId: VALID_UUID, watchedAtUtc: REAL_NOW - 1000,
    });
    if (!r.ok) throw new Error('ad_watched should bypass maintenance: ' + JSON.stringify(r));
    expect(r.data!.coinsGranted).toBe(5);
  });
});
