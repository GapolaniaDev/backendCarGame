// Phase 9 Chunk 5 — Unit tests for the pure ad reward helpers.

import { describe, it, expect } from 'vitest';
import { verifyAdMock } from '../../modules/src/ads/verify_mock';
import {
  planAdReward,
  utcDateKey,
  endOfUtcDayUtc,
  nextCooldownEnd,
} from '../../modules/src/ads/grant';
import type { AdRewardTier } from '../../modules/src/ads/types';

const NOW = 1_700_000_000_000;

const SMALL: AdRewardTier = { tier: 'small', coins: 5, cooldownSeconds: 300 };
const MEDIUM: AdRewardTier = { tier: 'medium', coins: 15, cooldownSeconds: 900 };
const LARGE: AdRewardTier = { tier: 'large', coins: 30, cooldownSeconds: 1800 };
const XLARGE: AdRewardTier = { tier: 'xlarge', coins: 60, cooldownSeconds: 3600 };

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('ads verifyAdMock (Phase 9 Chunk 5)', () => {
  it('valid for provider=mock + valid UUID + past watchedAtUtc', () => {
    const r = verifyAdMock('mock', 'unit-1', VALID_UUID, NOW - 1000, NOW);
    expect(r.valid).toBe(true);
  });

  it('INVALID_PROVIDER when provider=admob', () => {
    const r = verifyAdMock('admob', 'unit-1', VALID_UUID, NOW - 1000, NOW);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('INVALID_PROVIDER');
  });

  it('INVALID_PROVIDER when provider=unityads', () => {
    const r = verifyAdMock('unityads', 'unit-1', VALID_UUID, NOW - 1000, NOW);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('INVALID_PROVIDER');
  });

  it('INVALID_IMPRESSION_ID when adUnitId is empty', () => {
    const r = verifyAdMock('mock', '', VALID_UUID, NOW - 1000, NOW);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('INVALID_IMPRESSION_ID');
  });

  it('INVALID_IMPRESSION_ID when impressionId is not a UUID', () => {
    const r = verifyAdMock('mock', 'unit-1', 'not-a-uuid', NOW - 1000, NOW);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('INVALID_IMPRESSION_ID');
  });

  it('INVALID_IMPRESSION_ID when impressionId is UUID v1 (not v4)', () => {
    // v1: 6c1f5d68-1e2a-11ec-9621-0242ac130002
    const v1 = '6c1f5d68-1e2a-11ec-9621-0242ac130002';
    const r = verifyAdMock('mock', 'unit-1', v1, NOW - 1000, NOW);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('INVALID_IMPRESSION_ID');
  });

  it('FUTURE_WATCHED_AT when watchedAtUtc > nowUtc + 60s', () => {
    const r = verifyAdMock('mock', 'unit-1', VALID_UUID, NOW + 120_000, NOW);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('FUTURE_WATCHED_AT');
  });

  it('valid when watchedAtUtc is within 60s future (clock skew tolerance)', () => {
    const r = verifyAdMock('mock', 'unit-1', VALID_UUID, NOW + 30_000, NOW);
    expect(r.valid).toBe(true);
  });

  it('valid when watchedAtUtc is in the distant past', () => {
    const r = verifyAdMock('mock', 'unit-1', VALID_UUID, NOW - 3_600_000, NOW);
    expect(r.valid).toBe(true);
  });

  it('FUTURE_WATCHED_AT when watchedAtUtc is NaN', () => {
    const r = verifyAdMock('mock', 'unit-1', VALID_UUID, NaN, NOW);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('FUTURE_WATCHED_AT');
  });
});

describe('ads planAdReward (Phase 9 Chunk 5)', () => {
  it('ok when no prior watch', () => {
    const r = planAdReward(SMALL, NOW, null, 0, 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextEligibleAtUtc).toBe(NOW);
  });

  it('ok when cooldown elapsed', () => {
    const lastWatchedAtUtc = NOW - 600_000; // 10min ago
    const r = planAdReward(SMALL, NOW, lastWatchedAtUtc, 0, 10);
    expect(r.ok).toBe(true);
  });

  it('COOLDOWN when lastWatchedAtUtc + cooldownSeconds > now', () => {
    const lastWatchedAtUtc = NOW - 60_000; // 1min ago
    const r = planAdReward(SMALL, NOW, lastWatchedAtUtc, 0, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('COOLDOWN');
      expect(r.nextEligibleAtUtc).toBe(lastWatchedAtUtc + 300_000);
    }
  });

  it('COOLDOWN at exact boundary (now == lastWatchedAtUtc + cooldownSeconds) → ok', () => {
    const lastWatchedAtUtc = NOW - 300_000; // 5min ago, exactly cooldown
    const r = planAdReward(SMALL, NOW, lastWatchedAtUtc, 0, 10);
    expect(r.ok).toBe(true);
  });

  it('DAILY_CAP when count >= cap', () => {
    const r = planAdReward(SMALL, NOW, null, 10, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('DAILY_CAP');
      expect(r.nextEligibleAtUtc).toBe(endOfUtcDayUtc(NOW));
    }
  });

  it('DAILY_CAP takes precedence over COOLDOWN', () => {
    // both conditions hit, but cap check runs first.
    const lastWatchedAtUtc = NOW - 60_000; // cooldown not elapsed
    const r = planAdReward(SMALL, NOW, lastWatchedAtUtc, 10, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('DAILY_CAP');
    }
  });

  it('ok at count = cap - 1 (boundary)', () => {
    const r = planAdReward(SMALL, NOW, null, 9, 10);
    expect(r.ok).toBe(true);
  });

  it('cooldown is per-tier (lastWatchedAtUtc for a different tier is irrelevant)', () => {
    // Caller passes the lastWatchedAtUtc for the SAME tier they're about to
    // watch. Different tiers have their own lastWatched rows; the RPC reads
    // the per-tier row before calling planAdReward. This test pins the
    // contract: planAdReward checks the cooldown it was given, no more.
    const lastWatchedSmall = NOW - 60_000; // 1min ago
    // If you pass small's lastWatched but ask for medium (which is bound to
    // its own cooldown), the function will use small's cooldownSeconds by
    // mistake. The right test is: ask for medium with no prior watch.
    const r = planAdReward(MEDIUM, NOW, null, 0, 10);
    expect(r.ok).toBe(true);
    // And: with medium's own lastWatched at 1min ago, the medium cooldown
    // (15min) is NOT elapsed → COOLDOWN.
    const r2 = planAdReward(MEDIUM, NOW, NOW - 60_000, 0, 10);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('COOLDOWN');
  });

  it('medium cooldown (15min) is honored', () => {
    const lastWatched = NOW - 600_000; // 10min ago, < 15min
    const r = planAdReward(MEDIUM, NOW, lastWatched, 0, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('COOLDOWN');
  });

  it('xlarge cooldown (60min) is honored', () => {
    const lastWatched = NOW - 30 * 60_000; // 30min ago
    const r = planAdReward(XLARGE, NOW, lastWatched, 0, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('COOLDOWN');
  });

  it('large cooldown (30min) lets you through after 31min', () => {
    const lastWatched = NOW - 31 * 60_000;
    const r = planAdReward(LARGE, NOW, lastWatched, 0, 10);
    expect(r.ok).toBe(true);
  });
});

describe('ads utcDateKey + endOfUtcDayUtc', () => {
  it('utcDateKey produces YYYY-MM-DD for a known instant', () => {
    // 2023-11-14T22:13:20Z
    const d = utcDateKey(1_700_000_000_000);
    expect(d).toBe('2023-11-14');
  });

  it('endOfUtcDayUtc is the next UTC midnight', () => {
    const end = endOfUtcDayUtc(1_700_000_000_000);
    const d = new Date(end);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCDate()).toBe(15);
    expect(d.getUTCMonth()).toBe(10); // November
    expect(d.getUTCFullYear()).toBe(2023);
  });

  it('endOfUtcDayUtc for a UTC midnight exactly returns the next day', () => {
    const startOfDay = Date.UTC(2024, 0, 15, 0, 0, 0, 0);
    const end = endOfUtcDayUtc(startOfDay);
    const d = new Date(end);
    expect(d.getUTCDate()).toBe(16);
  });
});

describe('ads nextCooldownEnd', () => {
  it('returns nowUtc + cooldownSeconds * 1000', () => {
    const end = nextCooldownEnd('small', 300, NOW);
    expect(end).toBe(NOW + 300_000);
  });

  it('xlarge = now + 1h', () => {
    const end = nextCooldownEnd('xlarge', 3600, NOW);
    expect(end).toBe(NOW + 3_600_000);
  });
});
