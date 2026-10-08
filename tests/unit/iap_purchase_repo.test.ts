// Phase 9 Chunk 3 — Unit tests for the purchase repo.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, SYSTEM_USER_ID } from '../e2e/_stubs';
import type { FakeNakama as FakeNakamaT } from '../e2e/_stubs';
import {
  readPurchaseByTxId,
  writePurchase,
  findPurchaseAcrossUsers,
  readFirstPurchase,
  writeFirstPurchase,
  PURCHASES_COLLECTION,
  FIRST_PURCHASE_COLLECTION,
} from '../../modules/src/iap/purchase_repo';
import type { PurchaseRecord } from '../../modules/src/iap/purchase_repo';

const NOW = 1_700_000_000_000;

function newNak(): FakeNakamaT {
  return new FakeNakama();
}

function makeRecord(overrides: Partial<PurchaseRecord> = {}): PurchaseRecord {
  return {
    userId: 'user-A',
    packId: 'coins_100',
    platform: 'apple',
    productId: 'com.cvg.coins100',
    content: { coins: 100, firstTimeBonus: 50 },
    grantedAtUtc: NOW,
    idempotencyKey: 'iap_purchase:tx-1',
    isFirstTime: true,
    ...overrides,
  };
}

describe('iap purchase_repo (Phase 9 Chunk 3)', () => {
  let nak: FakeNakamaT;
  beforeEach(() => {
    nak = newNak();
  });

  it('writePurchase + readPurchaseByTxId round-trips', () => {
    writePurchase(nak.nakama, 'tx-1', makeRecord());
    const got = readPurchaseByTxId(nak.nakama, 'user-A', 'tx-1');
    expect(got).not.toBeNull();
    expect(got!.packId).toBe('coins_100');
    expect(got!.content.coins).toBe(100);
    expect(got!.isFirstTime).toBe(true);
  });

  it('readPurchaseByTxId returns null for unknown txId', () => {
    expect(readPurchaseByTxId(nak.nakama, 'user-A', 'no-such')).toBeNull();
  });

  it('readPurchaseByTxId is scoped per user (same txId, different userId returns null)', () => {
    writePurchase(nak.nakama, 'tx-1', makeRecord({ userId: 'user-A' }));
    expect(readPurchaseByTxId(nak.nakama, 'user-B', 'tx-1')).toBeNull();
  });

  it('findPurchaseAcrossUsers returns the owning user', () => {
    writePurchase(nak.nakama, 'tx-1', makeRecord({ userId: 'user-A' }));
    const hit = findPurchaseAcrossUsers(nak.nakama, 'tx-1');
    expect(hit).not.toBeNull();
    expect(hit!.userId).toBe('user-A');
  });

  it('findPurchaseAcrossUsers returns null when no row matches', () => {
    expect(findPurchaseAcrossUsers(nak.nakama, 'no-such')).toBeNull();
  });

  it('findPurchaseAcrossUsers is symmetric (works for user B as well as A)', () => {
    writePurchase(nak.nakama, 'tx-1', makeRecord({ userId: 'user-B' }));
    const hit = findPurchaseAcrossUsers(nak.nakama, 'tx-1');
    expect(hit).not.toBeNull();
    expect(hit!.userId).toBe('user-B');
  });

  it('writeFirstPurchase + readFirstPurchase round-trips', () => {
    writeFirstPurchase(nak.nakama, 'user-A', 'coins_100', NOW);
    const got = readFirstPurchase(nak.nakama, 'user-A', 'coins_100');
    expect(got).not.toBeNull();
    expect(got!.grantedAtUtc).toBe(NOW);
  });

  it('readFirstPurchase returns null before the first buy', () => {
    expect(readFirstPurchase(nak.nakama, 'user-A', 'coins_100')).toBeNull();
  });

  it('readFirstPurchase is scoped per user + pack', () => {
    writeFirstPurchase(nak.nakama, 'user-A', 'coins_100', NOW);
    expect(readFirstPurchase(nak.nakama, 'user-B', 'coins_100')).toBeNull();
    expect(readFirstPurchase(nak.nakama, 'user-A', 'other_pack')).toBeNull();
  });

  it('storage uses server-only R=1/W=0 permissions', () => {
    writePurchase(nak.nakama, 'tx-1', makeRecord());
    const obj = nak.store.get(`${PURCHASES_COLLECTION}/tx-1/user-A`);
    expect(obj).toBeDefined();
    expect(obj!.permissionRead).toBe(1);
    expect(obj!.permissionWrite).toBe(0);
  });

  it('first-purchase storage also uses R=1/W=0', () => {
    writeFirstPurchase(nak.nakama, 'user-A', 'coins_100', NOW);
    const obj = nak.store.get(`${FIRST_PURCHASE_COLLECTION}/coins_100/user-A`);
    expect(obj).toBeDefined();
    expect(obj!.permissionRead).toBe(1);
    expect(obj!.permissionWrite).toBe(0);
  });
});
