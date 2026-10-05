// Unit tests for the Phase 3 wallet helpers (grant / spend / ledger).
// Uses an in-memory fake of the parts of `nk` the wallet touches:
//   - localcacheGet/Put  → key/value map
//   - walletUpdate        → records the changeset and returns the
//                           running balance (mutates the fake wallet)
//   - walletLedgerUpdate  → records (changeset, metadata, idempotencyKey)
//   - accountGetId        → returns the fake account or null
//
// `nk.walletUpdate` rejects any changeset that would push a balance
// below zero — modelled in the fake by clamping and asserting.

import { describe, it, expect } from 'vitest';
import {
  grant,
  spend,
  applyLedger,
  walletGet,
  formatLedgerMetadata,
  parseLedgerMetadata,
  LEDGER_METADATA_MAX_BYTES,
  WALLET_IDEMPOTENCY_PREFIX,
  WALLET_IDEMPOTENCY_TTL_SEC,
} from '../../modules/src/economy/wallet';
import type { INakama } from '../../modules/src/nkruntime';

// ─── Fake `nk` ────────────────────────────────────────────────────────────────

interface FakeWallet {
  coins: number;
  gems: number;
}

interface LedgerEntry {
  userId: string;
  changeset: Record<string, number>;
  metadata: Record<string, unknown>;
  idempotencyKey?: string;
}

function makeFakeNk() {
  const wallets = new Map<string, FakeWallet>();
  const cache = new Map<string, string>();
  const updates: Array<{ userId: string; changeset: Record<string, number> }> = [];
  const ledger: LedgerEntry[] = [];

  function ensureWallet(userId: string): FakeWallet {
    let w = wallets.get(userId);
    if (!w) {
      w = { coins: 0, gems: 0 };
      wallets.set(userId, w);
    }
    return w;
  }

  const nk: INakama = {
    localcacheGet: <T = unknown>(key: string): T | null => {
      const v = cache.get(key);
      return (v as unknown as T) ?? null;
    },
    localcachePut: <T = unknown>(key: string, value: T): void => {
      cache.set(key, String(value));
    },
    accountGetId: (userId: string): unknown => {
      const w = wallets.get(userId);
      if (!w) return { wallet: {} };
      return { wallet: { coins: w.coins, gems: w.gems } };
    },
    walletUpdate: (userId: string, changeset: Record<string, number>): Record<string, number> => {
      const w = ensureWallet(userId);
      const next = { ...w };
      if (typeof changeset['coins'] === 'number') {
        const target = w.coins + changeset['coins'];
        if (target < 0) throw new Error('insufficient funds');
        next.coins = target;
      }
      if (typeof changeset['gems'] === 'number') {
        const target = w.gems + changeset['gems'];
        if (target < 0) throw new Error('insufficient funds');
        next.gems = target;
      }
      wallets.set(userId, next);
      updates.push({ userId, changeset: { ...changeset } });
      return { coins: next.coins, gems: next.gems };
    },
    walletLedgerUpdate: (
      userId: string,
      changeset: Record<string, number>,
      metadata?: Record<string, unknown>,
      idempotencyKey?: string,
    ): void => {
      ledger.push({ userId, changeset: { ...changeset }, metadata: metadata ?? {}, idempotencyKey });
    },
  } as unknown as INakama;

  return {
    nk,
    wallets,
    cache,
    updates,
    ledger,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REASON_RACE = { reason: 'race' as const, sourceId: 'sid-001' };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('economy/wallet — metadata packing', () => {
  it('packs the canonical reason:sourceId form', () => {
    expect(formatLedgerMetadata({ reason: 'race', sourceId: 'sid-001' })).toBe('race:sid-001');
    expect(formatLedgerMetadata({ reason: 'store', sourceId: 'offer_xyz' })).toBe(
      'store:offer_xyz',
    );
    expect(formatLedgerMetadata({ reason: 'level', sourceId: '7' })).toBe('level:7');
  });

  it('appends sessionId/confidence/mode after a semicolon', () => {
    const packed = formatLedgerMetadata({
      reason: 'race',
      sourceId: 'sid-001',
      sessionId: 'sess-A',
      confidence: 'quorum',
      mode: 'ranked',
    });
    expect(packed).toBe('race:sid-001;sessionId=sess-A,confidence=quorum,mode=ranked');
  });

  it('rejects payloads exceeding LEDGER_METADATA_MAX_BYTES', () => {
    const huge = 'x'.repeat(LEDGER_METADATA_MAX_BYTES + 50);
    expect(() => formatLedgerMetadata({ reason: 'admin', sourceId: huge })).toThrow(/exceeds/);
  });

  it('round-trips through parseLedgerMetadata', () => {
    const original = {
      reason: 'race' as const,
      sourceId: 'sid-007',
      sessionId: 'sess-X',
      confidence: 'client' as const,
      mode: 'private' as const,
    };
    expect(parseLedgerMetadata(formatLedgerMetadata(original))).toEqual(original);
  });

  it('parseLedgerMetadata returns null for malformed input', () => {
    expect(parseLedgerMetadata('garbage')).toBeNull();
    expect(parseLedgerMetadata('')).toBeNull();
    expect(parseLedgerMetadata('unknown:value')).toBeNull();
  });
});

describe('economy/wallet — walletGet', () => {
  it('returns zeros for an unknown user', () => {
    const { nk } = makeFakeNk();
    expect(walletGet(nk, 'no-such-user')).toEqual({ coins: 0, gems: 0 });
  });

  it('returns the stored coins/gems as numbers', () => {
    const { nk, wallets } = makeFakeNk();
    wallets.set('alice', { coins: 500, gems: 12 });
    expect(walletGet(nk, 'alice')).toEqual({ coins: 500, gems: 12 });
  });
});

describe('economy/wallet — grant', () => {
  it('credits the wallet and writes a ledger entry', () => {
    const { nk, wallets, ledger, updates } = makeFakeNk();
    wallets.set('alice', { coins: 100, gems: 0 });
    const resp = grant(nk, 'alice', { coins: 50 }, REASON_RACE, 'k1');
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toEqual({ coins: 150, gems: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ userId: 'alice', changeset: { coins: 50 } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      userId: 'alice',
      changeset: { coins: 50 },
      idempotencyKey: 'k1',
    });
    expect((ledger[0]?.metadata as { reason?: string }).reason).toBe('race:sid-001');
  });

  it('is idempotent on the same (userId, key) within TTL', () => {
    const { nk, wallets, updates } = makeFakeNk();
    wallets.set('alice', { coins: 0, gems: 0 });
    const r1 = grant(nk, 'alice', { coins: 50 }, REASON_RACE, 'same-key');
    const r2 = grant(nk, 'alice', { coins: 50 }, REASON_RACE, 'same-key');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Only one walletUpdate should have actually fired.
    expect(updates).toHaveLength(1);
    expect(wallets.get('alice')).toEqual({ coins: 50, gems: 0 });
  });

  it('treats different keys as independent grants', () => {
    const { nk, wallets, updates } = makeFakeNk();
    wallets.set('alice', { coins: 0, gems: 0 });
    grant(nk, 'alice', { coins: 30 }, REASON_RACE, 'k-A');
    grant(nk, 'alice', { coins: 70 }, REASON_RACE, 'k-B');
    expect(updates).toHaveLength(2);
    expect(wallets.get('alice')).toEqual({ coins: 100, gems: 0 });
  });

  it('rejects an empty changeset with BAD_REQUEST', () => {
    const { nk, wallets } = makeFakeNk();
    wallets.set('alice', { coins: 0, gems: 0 });
    const resp = grant(nk, 'alice', {}, REASON_RACE, 'k-empty');
    expect(resp).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'grant changeset must contain coins or gems' },
    });
  });

  it('rejects a negative coins value', () => {
    const { nk, wallets } = makeFakeNk();
    wallets.set('alice', { coins: 100, gems: 0 });
    const resp = grant(nk, 'alice', { coins: -10 }, REASON_RACE, 'k-neg');
    expect(resp).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'grant changeset values must be positive' },
    });
  });

  it('rejects a non-integer coins value', () => {
    const { nk, wallets } = makeFakeNk();
    wallets.set('alice', { coins: 0, gems: 0 });
    const resp = grant(nk, 'alice', { coins: 1.5 }, REASON_RACE, 'k-float');
    expect(resp).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'grant changeset values must be integers' },
    });
  });
});

describe('economy/wallet — spend', () => {
  it('debits the wallet when balance is sufficient', () => {
    const { nk, wallets, ledger } = makeFakeNk();
    wallets.set('alice', { coins: 500, gems: 5 });
    const resp = spend(nk, 'alice', { coins: 200 }, REASON_RACE, 'k-spend');
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toEqual({ coins: 300, gems: 5 });
    expect(wallets.get('alice')).toEqual({ coins: 300, gems: 5 });
    expect(ledger).toHaveLength(1);
  });

  it('returns INSUFFICIENT_FUNDS when coins would go negative', () => {
    const { nk, wallets, updates } = makeFakeNk();
    wallets.set('alice', { coins: 100, gems: 50 });
    const resp = spend(nk, 'alice', { coins: 200 }, { reason: 'store', sourceId: 'o1' }, 'k-no-coins');
    expect(resp).toEqual({
      ok: false,
      error: {
        code: 'INSUFFICIENT_FUNDS',
        message: 'not enough coins',
        details: { currency: 'coins', balance: 100 },
      },
    });
    // No walletUpdate should have been issued.
    expect(updates).toHaveLength(0);
    expect(wallets.get('alice')).toEqual({ coins: 100, gems: 50 });
  });

  it('returns INSUFFICIENT_FUNDS when gems would go negative', () => {
    const { nk, wallets } = makeFakeNk();
    wallets.set('alice', { coins: 1000, gems: 1 });
    const resp = spend(nk, 'alice', { gems: 5 }, { reason: 'store', sourceId: 'o2' }, 'k-no-gems');
    expect(resp).toEqual({
      ok: false,
      error: {
        code: 'INSUFFICIENT_FUNDS',
        message: 'not enough gems',
        details: { currency: 'gems', balance: 1 },
      },
    });
  });

  it('is idempotent on the same key', () => {
    const { nk, wallets, updates } = makeFakeNk();
    wallets.set('alice', { coins: 100, gems: 0 });
    const r1 = spend(nk, 'alice', { coins: 40 }, REASON_RACE, 'k-sp');
    const r2 = spend(nk, 'alice', { coins: 40 }, REASON_RACE, 'k-sp');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(wallets.get('alice')).toEqual({ coins: 60, gems: 0 });
  });

  it('rejects a zero or negative coins value', () => {
    const { nk, wallets } = makeFakeNk();
    wallets.set('alice', { coins: 100, gems: 0 });
    const resp = spend(nk, 'alice', { coins: 0 }, REASON_RACE, 'k-zero');
    expect(resp).toEqual({
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'spend changeset values must be positive (helper negates internally)',
      },
    });
  });
});

describe('economy/wallet — applyLedger', () => {
  it('records an idempotent ledger entry without changing balance', () => {
    const { nk, wallets, ledger } = makeFakeNk();
    wallets.set('alice', { coins: 100, gems: 5 });
    const resp = applyLedger(
      nk,
      'alice',
      { reason: 'race', sourceId: 'firstwin', sessionId: 'sess-A' },
      'fw-key',
    );
    expect(resp.ok).toBe(true);
    expect(wallets.get('alice')).toEqual({ coins: 100, gems: 5 });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      userId: 'alice',
      changeset: {},
      idempotencyKey: 'fw-key',
    });
  });

  it('is idempotent on the same key', () => {
    const { nk, ledger } = makeFakeNk();
    applyLedger(nk, 'alice', { reason: 'race', sourceId: 'x' }, 'k');
    applyLedger(nk, 'alice', { reason: 'race', sourceId: 'x' }, 'k');
    expect(ledger).toHaveLength(1);
  });
});

describe('economy/wallet — namespace + TTL constants', () => {
  it('uses a 7-day idempotency TTL', () => {
    expect(WALLET_IDEMPOTENCY_TTL_SEC).toBe(7 * 24 * 60 * 60);
  });
  it('uses the wallet:idemp prefix', () => {
    expect(WALLET_IDEMPOTENCY_PREFIX).toBe('wallet:idemp');
  });
});