// Phase 9 Chunk 2 — Unit tests for the mock receipt verifier.
//
// Covers the parse path that the iap_purchase RPC hits in dev. The
// mock is also the only verifier exercised end-to-end from the
// dispatcher (because `liveops.default.json` ships with provider=mock),
// so the mock tests double as the dispatcher's coverage surface.

import { describe, it, expect } from 'vitest';
import { verifyMock } from '../../modules/src/iap/verify_mock';

const NOW = 1_700_000_000_000;

describe('verifyMock (Phase 9 Chunk 2)', () => {
  it('returns a valid result for a well-formed consumable receipt', () => {
    const r = verifyMock(
      'apple',
      JSON.stringify({
        productId: 'com.cvg.coins100',
        transactionId: '1000',
        originalTransactionId: '1000',
        purchaseDateUtc: NOW - 1000,
      }),
      'com.cvg.coins100',
      NOW,
    );
    expect(r.valid).toBe(true);
    expect(r.platform).toBe('apple');
    expect(r.productId).toBe('com.cvg.coins100');
    expect(r.transactionId).toBe('1000');
    expect(r.originalTransactionId).toBe('1000');
    expect(r.purchaseDateUtc).toBe(NOW - 1000);
    expect(r.isSubscriptionRenewal).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.expiresAtUtc).toBeUndefined();
  });

  it('returns PRODUCT_MISMATCH when productId differs', () => {
    const r = verifyMock(
      'apple',
      JSON.stringify({
        productId: 'com.cvg.wrong',
        transactionId: '1000',
        originalTransactionId: '1000',
        purchaseDateUtc: NOW - 1000,
      }),
      'com.cvg.coins100',
      NOW,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toBe('PRODUCT_MISMATCH');
  });

  it('returns INVALID_RECEIPT for malformed JSON', () => {
    const r = verifyMock('apple', 'not json', 'com.cvg.coins100', NOW);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('INVALID_RECEIPT');
  });

  it('returns INVALID_RECEIPT for JSON missing required fields', () => {
    const r = verifyMock('apple', JSON.stringify({ productId: 'x' }), 'x', NOW);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('INVALID_RECEIPT');
  });

  it('returns EXPIRED when the receipt declares expire=true', () => {
    const r = verifyMock(
      'google',
      JSON.stringify({
        productId: 'com.cvg.coins100',
        transactionId: 't',
        originalTransactionId: 't',
        purchaseDateUtc: NOW - 1000,
        expire: true,
      }),
      'com.cvg.coins100',
      NOW,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toBe('EXPIRED');
  });

  it('returns EXPIRED for a subscription whose expiresAtUtc is in the past', () => {
    const r = verifyMock(
      'apple',
      JSON.stringify({
        productId: 'com.cvg.monthlypass',
        transactionId: 'sub-1',
        originalTransactionId: 'sub-1',
        purchaseDateUtc: NOW - 2_000_000,
        expiresAtUtc: NOW - 1000,
      }),
      'com.cvg.monthlypass',
      NOW,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toBe('EXPIRED');
  });

  it('returns a valid subscription with expiresAtUtc in the future', () => {
    const r = verifyMock(
      'apple',
      JSON.stringify({
        productId: 'com.cvg.monthlypass',
        transactionId: 'sub-1',
        originalTransactionId: 'sub-1',
        purchaseDateUtc: NOW - 1000,
        expiresAtUtc: NOW + 2_000_000,
      }),
      'com.cvg.monthlypass',
      NOW,
    );
    expect(r.valid).toBe(true);
    expect(r.expiresAtUtc).toBe(NOW + 2_000_000);
    expect(r.isSubscriptionRenewal).toBe(false);
  });

  it('marks isSubscriptionRenewal=true when transactionId differs from original', () => {
    const r = verifyMock(
      'apple',
      JSON.stringify({
        productId: 'com.cvg.monthlypass',
        transactionId: 'sub-2',
        originalTransactionId: 'sub-1',
        purchaseDateUtc: NOW - 1000,
        expiresAtUtc: NOW + 2_000_000,
      }),
      'com.cvg.monthlypass',
      NOW,
    );
    expect(r.valid).toBe(true);
    expect(r.isSubscriptionRenewal).toBe(true);
  });

  it('echoes the platform on the result', () => {
    const r = verifyMock(
      'google',
      JSON.stringify({
        productId: 'p', transactionId: 't', originalTransactionId: 't', purchaseDateUtc: NOW,
      }),
      'p', NOW,
    );
    expect(r.platform).toBe('google');
  });
});
