// Unit tests for the idempotency helper.
//
// The helper relies on `nk.localcacheGet/Put` semantics, which we stub
// with a plain in-memory Map. We don't need the rest of the Nakama API
// for this file.

import { describe, it, expect, beforeEach } from 'vitest';

import type { INakama } from '../../modules/src/nkruntime';
import { withIdempotency } from '../../modules/src/core/idempotency';
import { ok, err } from '../../modules/src/core/response';

interface NkStub {
  store: Map<string, unknown>;
  nk: INakama;
}

function makeNkStub(): NkStub {
  const store = new Map<string, unknown>();
  const nk = {
    localcacheGet<T>(key: string): T | null {
      return store.has(key) ? (store.get(key) as T) : null;
    },
    localcachePut<T>(key: string, value: T): void {
      store.set(key, value);
    },
  } as unknown as INakama;
  return { store, nk };
}

describe('withIdempotency', () => {
  let stub: NkStub;
  beforeEach(() => {
    stub = makeNkStub();
  });

  it('runs the function once and caches the response', async () => {
    let calls = 0;
    const { nk } = stub;
    const scope = 'race_submit_result';
    const key = 'abc';

    const a = await withIdempotency<string>(nk, { scope, key }, async () => {
      calls++;
      return ok('hello');
    });
    expect(a.replayed).toBe(false);
    expect(a.result).toEqual(ok('hello'));
    expect(calls).toBe(1);

    const b = await withIdempotency<string>(nk, { scope, key }, async () => {
      calls++;
      return ok('hello again');
    });
    expect(b.replayed).toBe(true);
    expect(b.result).toEqual(ok('hello'));
    expect(calls).toBe(1);
  });

  it('caches err responses as well as ok', async () => {
    const { nk } = stub;
    const e = err('CONFLICT', 'session closed');
    const a = await withIdempotency(nk, { scope: 'x', key: 'k' }, () => Promise.resolve(e));
    expect(a.result.ok).toBe(false);

    let calls = 0;
    const b = await withIdempotency(nk, { scope: 'x', key: 'k' }, () => {
      calls++;
      return Promise.resolve(ok('should not run'));
    });
    expect(b.replayed).toBe(true);
    expect(b.result).toEqual(e);
    expect(calls).toBe(0);
  });

  it('treats different scopes as independent', async () => {
    const { nk } = stub;
    let calls = 0;

    const a = await withIdempotency(nk, { scope: 'A', key: '1' }, async () => {
      calls++;
      return ok('A1');
    });
    const b = await withIdempotency(nk, { scope: 'B', key: '1' }, async () => {
      calls++;
      return ok('B1');
    });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('treats different keys under same scope as independent', async () => {
    const { nk } = stub;
    let calls = 0;

    const a = await withIdempotency(nk, { scope: 'X', key: 'k1' }, async () => {
      calls++;
      return ok('one');
    });
    const b = await withIdempotency(nk, { scope: 'X', key: 'k2' }, async () => {
      calls++;
      return ok('two');
    });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('does not cache when fn throws', async () => {
    const { nk } = stub;
    let calls = 0;

    await expect(
      withIdempotency(nk, { scope: 'X', key: 'throw' }, () => {
        calls++;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Second call should re-execute.
    const r = await withIdempotency(nk, { scope: 'X', key: 'throw' }, () => {
      calls++;
      return ok('recovered');
    });
    expect(r.replayed).toBe(false);
    expect(r.result).toEqual(ok('recovered'));
    expect(calls).toBe(2);
  });

  it('clears cache across tests (stub store is fresh per test)', () => {
    const { store } = stub;
    expect(store.size).toBe(0);
  });
});
