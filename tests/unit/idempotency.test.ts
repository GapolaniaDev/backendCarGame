// Unit tests for the durable idempotency records (plan T-11, audit PC-11).
// The movement itself (the record written in the wallet's multiUpdate)
// is covered by `wallet.test.ts`; these cover the record helpers.

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import type { INakama, IStorageObject } from '../../modules/src/nkruntime';
import {
  IDEMPOTENCY_COLLECTION,
  IDEMPOTENCY_STORAGE_KEY_MAX,
  idempotencyStorageKey,
  idempotencyWrite,
  isNegativeWallet,
  isVersionConflict,
  readIdempotency,
  type IdempotencyRecord,
} from '../../modules/src/core/idempotency';

function makeNk(objects: IStorageObject[] = []): INakama {
  return {
    sha256Hash: (s: string) => createHash('sha256').update(s).digest('hex'),
    storageRead: (keys: Array<{ collection: string; key: string; userId?: string }>) =>
      objects.filter((o) => keys.some((k) => k.collection === o.collection && k.key === o.key && k.userId === o.userId)),
  } as unknown as INakama;
}

const record = (key: string): IdempotencyRecord => ({
  schemaVersion: 1,
  key,
  state: 'applied',
  changeset: { coins: -100 },
  appliedAt: 1,
});

describe('core/idempotency', () => {
  it('uses the key itself as storage key when it fits, a sha256 otherwise', () => {
    const nk = makeNk();
    expect(idempotencyStorageKey(nk, 'store:buy:car:u1:civic_r')).toBe('store:buy:car:u1:civic_r');
    const long = 'k'.repeat(IDEMPOTENCY_STORAGE_KEY_MAX + 1);
    expect(idempotencyStorageKey(nk, long)).toBe(`sha256:${createHash('sha256').update(long).digest('hex')}`);
    expect(idempotencyStorageKey(nk, long).length).toBeLessThanOrEqual(IDEMPOTENCY_STORAGE_KEY_MAX);
  });

  it('builds a server-only, create-only write (version *) unless a version is given', () => {
    const nk = makeNk();
    const create = idempotencyWrite(nk, 'u1', record('k1'), null);
    expect(create).toMatchObject({
      collection: IDEMPOTENCY_COLLECTION, key: 'k1', userId: 'u1', version: '*', permissionRead: 0, permissionWrite: 0,
    });
    expect(idempotencyWrite(nk, 'u1', record('k1'), 'v7').version).toBe('v7');
  });

  it('reads a record back with its version, or null', () => {
    const nk = makeNk([{
      collection: IDEMPOTENCY_COLLECTION, key: 'k1', userId: 'u1', value: record('k1') as never,
      version: 'v3', permissionRead: 0, permissionWrite: 0,
    }]);
    expect(readIdempotency(nk, 'u1', 'k1')).toEqual({ record: record('k1'), version: 'v3' });
    expect(readIdempotency(nk, 'u2', 'k1')).toBeNull();
    expect(readIdempotency(nk, 'u1', 'k2')).toBeNull();
  });

  it('recognises the 3.27 multiUpdate failures', () => {
    expect(isVersionConflict(new Error('error running multi update: Storage write rejected - version check failed.'))).toBe(true);
    expect(isNegativeWallet({ message: "error running multi update: wallet update rejected negative value at path 'coins'" })).toBe(true);
    expect(isVersionConflict(new Error('db down'))).toBe(false);
    expect(isNegativeWallet('db down')).toBe(false);
  });
});
