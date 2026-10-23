// T-24 (PC-04, HT-75, HT-78) — iap_purchase delivers once, durably.
//
// Through the built bundle with IAP_MOCK=true:
//   - the purchase is one wallet movement: coins, ledger row, purchase
//     row, first-purchase marker and transaction index commit together;
//   - a retry (also on a fresh VM, i.e. after a restart) answers
//     idempotent: true and delivers nothing more;
//   - the transaction index keeps a second account out even without the
//     first account's purchase row;
//   - a Google purchase token longer than Nakama's 128-character key works.

import { describe, it, expect, beforeEach } from 'vitest';
import { loadBundleForTest, FakeNakama, FakeContext } from './_stubs';
import type { LoadedBundle } from './_stubs';
import type { IContext, ILogger } from '../../modules/src/nkruntime';

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const MOCK = { IAP_MOCK: 'true' };

type Env = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; details?: { reason?: string } } };

function buy(bundle: LoadedBundle, nk: FakeNakama, userId: string, tx: string, productId = 'com.cvg.coins100'): Env {
  const ctx: IContext = { ...FakeContext, userId, env: MOCK };
  const receiptData = JSON.stringify({
    Store: 'AppleAppStore', TransactionID: tx,
    Payload: JSON.stringify({ productId, transactionId: tx, originalTransactionId: tx, purchaseDateUtc: 1 }),
  });
  const raw = bundle.resolver('iap_purchase')!(ctx, mkLogger(), nk.nakama,
    JSON.stringify({ platform: tx.length > 100 ? 'google' : 'apple', productId, receiptData, transactionId: tx }));
  return JSON.parse(raw) as Env;
}

const coins = (nk: FakeNakama, uid: string): number => nk.wallets.get(uid)?.['coins'] ?? 0;
const iapLedgerRows = (nk: FakeNakama, uid: string): number =>
  (nk.ledger.get(uid) ?? []).filter((l) => JSON.stringify(l).includes('iap')).length;

describe('iap_purchase T-24: one durable delivery', () => {
  let bundle: LoadedBundle;
  let nk: FakeNakama;

  beforeEach(() => {
    bundle = loadBundleForTest();
    nk = new FakeNakama();
  });

  it('delivers once; the retry is idempotent with the same content and no second credit', () => {
    const first = buy(bundle, nk, A, 'tx-once');
    expect(first.ok).toBe(true);
    expect(first.data!['idempotent']).toBe(false);
    const credited = coins(nk, A);
    expect(credited).toBeGreaterThan(0);
    expect(iapLedgerRows(nk, A)).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      const again = buy(bundle, nk, A, 'tx-once');
      expect(again.ok).toBe(true);
      expect(again.data!['idempotent']).toBe(true);
      expect(again.data!['content']).toEqual(first.data!['content']);
    }
    expect(coins(nk, A)).toBe(credited);
    expect(iapLedgerRows(nk, A)).toBe(1);
    // Everything of the purchase is in storage: idem key, row, marker, index.
    const keys = [...nk.store.keys()];
    expect(keys).toContain(`idem/iap_purchase:apple:tx-once/${A}`);
    expect(keys).toContain(`iap_purchases/tx-once/${A}`);
    expect(keys.some((k) => k.startsWith('iap_first_purchase/'))).toBe(true);
    expect(keys).toContain('iap_transactions/apple:tx-once/00000000-0000-0000-0000-000000000000');
  });

  it('after a restart (fresh VM, same storage) the retry delivers nothing', () => {
    expect(buy(bundle, nk, A, 'tx-restart').ok).toBe(true);
    const credited = coins(nk, A);
    const restarted = loadBundleForTest();
    const again = buy(restarted, nk, A, 'tx-restart');
    expect(again.data!['idempotent']).toBe(true);
    expect(coins(nk, A)).toBe(credited);
  });

  it('a retry whose purchase row is gone replays from the durable key without paying', () => {
    expect(buy(bundle, nk, A, 'tx-key').ok).toBe(true);
    const credited = coins(nk, A);
    nk.store.delete(`iap_purchases/tx-key/${A}`);
    nk.store.delete('iap_transactions/apple:tx-key/00000000-0000-0000-0000-000000000000');
    const again = buy(bundle, nk, A, 'tx-key');
    expect(again.ok).toBe(true);
    expect(again.data!['idempotent']).toBe(true);
    expect(coins(nk, A)).toBe(credited);
  });

  it('the transaction index keeps another account out, even without the owner purchase row', () => {
    expect(buy(bundle, nk, A, 'tx-shared').ok).toBe(true);
    nk.store.delete(`iap_purchases/tx-shared/${A}`);
    const theirs = buy(bundle, nk, B, 'tx-shared');
    expect(theirs.ok).toBe(false);
    expect(theirs.error?.code).toBe('CONFLICT');
    expect(theirs.error?.details?.reason).toBe('RECEIPT_USED');
    expect(coins(nk, B)).toBe(0);
  });

  it('a Google purchase token longer than 128 characters is stored under its hash', () => {
    const token = `tok.${'x'.repeat(180)}`;
    const r = buy(bundle, nk, A, token, 'coins_100');
    expect(r.ok).toBe(true);
    expect([...nk.store.keys()].every((k) => k.split('/')[1]!.length <= 128)).toBe(true);
    expect(buy(bundle, nk, A, token, 'coins_100').data!['idempotent']).toBe(true);
    expect(buy(bundle, nk, B, token, 'coins_100').error?.code).toBe('CONFLICT');
  });
});
