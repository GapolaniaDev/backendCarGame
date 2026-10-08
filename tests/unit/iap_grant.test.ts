// Phase 9 Chunk 3 — Unit tests for the pure grant planner.

import { describe, it, expect } from 'vitest';
import { planGrant, totalCoins } from '../../modules/src/iap/grant';
import type { IapPack } from '../../modules/src/iap/types';

const NOW = 1_700_000_000_000;
const MS_PER_DAY = 86_400_000;

const CONSUMABLE: IapPack = {
  id: 'coins_100', kind: 'consumable', displayName: '100 Coins',
  appleProductId: 'com.cvg.coins100', googleProductId: 'coins_100',
  sortOrder: 1,
  baseCoins: 100, firstTimeBonus: 50,
};
const NON_CONSUMABLE: IapPack = {
  id: 'gem_pack_500', kind: 'non_consumable', displayName: '500 Gems',
  appleProductId: 'com.cvg.gempack500', googleProductId: 'gem_pack_500',
  sortOrder: 2,
  cosmeticId: 'gem_pack_500',
};
const SUBSCRIPTION: IapPack = {
  id: 'monthly_pass', kind: 'subscription', displayName: 'Monthly Pass',
  appleProductId: 'com.cvg.monthlypass', googleProductId: 'monthly_pass',
  sortOrder: 3,
  durationDays: 30, monthlyCoins: 500, monthlyCosmeticId: 'pass_exclusive_01',
};

describe('planGrant (Phase 9 Chunk 3)', () => {
  it('consumable + first time: baseCoins + firstTimeBonus', () => {
    const p = planGrant(CONSUMABLE, true, NOW);
    expect(p.coins).toBe(100);
    expect(p.firstTimeBonus).toBe(50);
    expect(totalCoins(p)).toBe(150);
  });

  it('consumable + NOT first time: baseCoins only', () => {
    const p = planGrant(CONSUMABLE, false, NOW);
    expect(p.coins).toBe(100);
    expect(p.firstTimeBonus).toBe(0);
    expect(totalCoins(p)).toBe(100);
  });

  it('non-consumable: cosmeticId, no coins', () => {
    const p = planGrant(NON_CONSUMABLE, false, NOW);
    expect(p.coins).toBe(0);
    expect(p.firstTimeBonus).toBe(0);
    expect(p.cosmeticId).toBe('gem_pack_500');
    expect(totalCoins(p)).toBe(0);
  });

  it('subscription: subscriptionId + monthlyCoins + expiresAtUtc = now + durationDays', () => {
    const p = planGrant(SUBSCRIPTION, false, NOW);
    expect(p.coins).toBe(0);
    expect(p.firstTimeBonus).toBe(0);
    expect(p.subscriptionId).toBe('monthly_pass');
    expect(p.monthlyCoins).toBe(500);
    expect(p.monthlyCosmeticId).toBe('pass_exclusive_01');
    expect(p.expiresAtUtc).toBe(NOW + 30 * MS_PER_DAY);
    expect(totalCoins(p)).toBe(0);
  });

  it('subscription: first-time flag is ignored (no firstTimeBonus on subs)', () => {
    const p = planGrant(SUBSCRIPTION, true, NOW);
    expect(p.firstTimeBonus).toBe(0);
    expect(p.subscriptionId).toBe('monthly_pass');
  });
});
