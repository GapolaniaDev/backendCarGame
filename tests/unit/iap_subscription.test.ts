// Phase 9 Chunk 4 — Unit tests for pure subscription helpers.

import { describe, it, expect } from 'vitest';
import {
  isActive,
  isExpired,
  timeRemainingMs,
  shouldWarnExpiring,
  extendExpiry,
  markCancelled,
  type IapSubscription,
} from '../../modules/src/iap/subscription';

const NOW = 1_700_000_000_000;
const MS_PER_DAY = 86_400_000;

function makeSub(overrides: Partial<IapSubscription> = {}): IapSubscription {
  return {
    userId: 'user-A',
    packId: 'monthly_pass',
    platform: 'apple',
    originalTransactionId: 'orig-tx-1',
    latestTransactionId: 'orig-tx-1',
    activatedAtUtc: NOW - 10 * MS_PER_DAY,
    expiresAtUtc: NOW + 20 * MS_PER_DAY,
    autoRenewing: true,
    renewalHistory: [],
    monthlyCosmeticGranted: false,
    ...overrides,
  };
}

describe('iap subscription helpers (Phase 9 Chunk 4)', () => {
  it('isActive: not cancelled + not expired → true', () => {
    expect(isActive(makeSub(), NOW)).toBe(true);
  });

  it('isActive: cancelled but expiresAtUtc > now → true (Apple/Google behavior)', () => {
    const sub = makeSub({ cancelledAtUtc: NOW - 1 * MS_PER_DAY });
    expect(isActive(sub, NOW)).toBe(true);
  });

  it('isActive: cancelled + expiresAtUtc <= now → false', () => {
    const sub = makeSub({
      cancelledAtUtc: NOW - 5 * MS_PER_DAY,
      expiresAtUtc: NOW - 1 * MS_PER_DAY,
    });
    expect(isActive(sub, NOW)).toBe(false);
  });

  it('isExpired: expiresAtUtc <= now → true', () => {
    expect(isExpired(makeSub({ expiresAtUtc: NOW - 1 }), NOW)).toBe(true);
    expect(isExpired(makeSub({ expiresAtUtc: NOW }), NOW)).toBe(true);
  });

  it('isExpired: expiresAtUtc > now → false', () => {
    expect(isExpired(makeSub({ expiresAtUtc: NOW + 1 }), NOW)).toBe(false);
  });

  it('timeRemainingMs: positive when not expired', () => {
    const sub = makeSub({ expiresAtUtc: NOW + 5_000 });
    expect(timeRemainingMs(sub, NOW)).toBe(5_000);
  });

  it('timeRemainingMs: zero (clamped) when expired', () => {
    const sub = makeSub({ expiresAtUtc: NOW - 1_000 });
    expect(timeRemainingMs(sub, NOW)).toBe(0);
  });

  it('shouldWarnExpiring: 8d remaining → false', () => {
    const sub = makeSub({ expiresAtUtc: NOW + 8 * MS_PER_DAY });
    expect(shouldWarnExpiring(sub, NOW, 7)).toBe(false);
  });

  it('shouldWarnExpiring: 6d remaining → true', () => {
    const sub = makeSub({ expiresAtUtc: NOW + 6 * MS_PER_DAY });
    expect(shouldWarnExpiring(sub, NOW, 7)).toBe(true);
  });

  it('shouldWarnExpiring: 1d remaining → true', () => {
    const sub = makeSub({ expiresAtUtc: NOW + 1 * MS_PER_DAY });
    expect(shouldWarnExpiring(sub, NOW, 7)).toBe(true);
  });

  it('shouldWarnExpiring: already warned → false', () => {
    const sub = makeSub({ expiresAtUtc: NOW + 1 * MS_PER_DAY, warnedExpiring: true });
    expect(shouldWarnExpiring(sub, NOW, 7)).toBe(false);
  });

  it('shouldWarnExpiring: expired → false (not active)', () => {
    const sub = makeSub({ expiresAtUtc: NOW - 1 });
    expect(shouldWarnExpiring(sub, NOW, 7)).toBe(false);
  });

  it('extendExpiry: returns new sub with extended expiresAtUtc (immutable)', () => {
    const sub = makeSub();
    const next = extendExpiry(sub, sub.expiresAtUtc + 30 * MS_PER_DAY);
    expect(next).not.toBe(sub);
    expect(next.expiresAtUtc).toBe(sub.expiresAtUtc + 30 * MS_PER_DAY);
    expect(sub.expiresAtUtc).toBe(sub.expiresAtUtc); // original unchanged
  });

  it('markCancelled: returns new sub with cancelledAtUtc + autoRenewing=false', () => {
    const sub = makeSub();
    const cancelled = markCancelled(sub, NOW);
    expect(cancelled.cancelledAtUtc).toBe(NOW);
    expect(cancelled.autoRenewing).toBe(false);
    expect(sub.autoRenewing).toBe(true); // original unchanged
    expect(sub.cancelledAtUtc).toBeUndefined();
  });
});
