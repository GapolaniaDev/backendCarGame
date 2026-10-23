// Unit tests for the Phase 3 wallet helpers (grant / spend / ledger),
// rewritten for the durable, single-transaction movements of plan T-11
// (audit PC-11, HT-73, 05 f11-f13).

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  grant,
  spend,
  applyLedger,
  moveWallet,
  revert,
  walletGet,
  formatLedgerMetadata,
  parseLedgerMetadata,
  LEDGER_METADATA_MAX_BYTES,
} from '../../modules/src/economy/wallet';
import { IDEMPOTENCY_COLLECTION, type IdempotencyRecord } from '../../modules/src/core/idempotency';
import type { INakama, IStorageObject, IWalletUpdate } from '../../modules/src/nkruntime';

// ─── Fake `nk` ────────────────────────────────────────────────────────────────
//
// Mirrors the v3.27.0 JS bindings the wallet uses (plan T-11): one
// `multiUpdate` transaction checks every storage version (`*` = create
// only) and every balance before applying anything; a wallet update with
// `updateLedger` appends a ledger row with its metadata. The backing maps
// can outlive a "process" (`restartedNk`) because the idempotency record
// lives in storage, not in a process-local cache.

interface FakeWallet {
  coins: number;
  gems: number;
}

interface LedgerEntry {
  userId: string;
  changeset: Record<string, number>;
  metadata: Record<string, unknown>;
}

interface Backing {
  wallets: Map<string, FakeWallet>;
  storage: Map<string, IStorageObject>;
  ledger: LedgerEntry[];
  /** Successful multiUpdate calls that moved a wallet. */
  updates: Array<{ userId: string; changeset: Record<string, number> }>;
  version: { n: number };
}

function newBacking(): Backing {
  return { wallets: new Map(), storage: new Map(), ledger: [], updates: [], version: { n: 0 } };
}

const sKey = (o: { collection: string; key: string; userId?: string | null }): string =>
  `${o.collection}/${o.key}/${o.userId ?? ''}`;

function makeFakeNk(backing: Backing = newBacking(), hooks: { beforeCommit?: () => void } = {}) {
  const { wallets, storage, ledger, updates } = backing;
  const nk = {
    accountGetId: (userId: string): unknown => {
      const w = wallets.get(userId);
      return { wallet: w ? { coins: w.coins, gems: w.gems } : {} };
    },
    sha256Hash: (input: string): string => createHash('sha256').update(input).digest('hex'),
    storageRead: (keys: Array<{ collection: string; key: string; userId?: string }>): IStorageObject[] =>
      keys.map((k) => storage.get(sKey(k))).filter((o): o is IStorageObject => o !== undefined),
    // analytics `emit` writes here; not under test.
    storageWrite: (): unknown[] => [],
    multiUpdate: (
      _acc: unknown,
      writes: IStorageObject[] | undefined,
      _del: unknown,
      walletUpdates: IWalletUpdate[] | undefined,
      updateLedger: boolean | undefined,
    ) => {
      const hook = hooks.beforeCommit;
      hooks.beforeCommit = undefined;
      hook?.();
      for (const w of writes ?? []) {
        const cur = storage.get(sKey(w));
        if (w.version === '*' ? cur !== undefined : (w.version !== undefined && cur?.version !== w.version)) {
          throw new Error('error running multi update: Storage write rejected - version check failed.');
        }
      }
      const planned = new Map<string, FakeWallet>();
      const acks: Array<{ userId: string; updated: Record<string, number>; previous: Record<string, number> }> = [];
      for (const u of walletUpdates ?? []) {
        const before = planned.get(u.userId) ?? { ...(wallets.get(u.userId) ?? { coins: 0, gems: 0 }) };
        const after = { ...before };
        for (const [k, v] of Object.entries(u.changeset)) {
          const next = (after[k as keyof FakeWallet] ?? 0) + v;
          if (next < 0) {
            throw new Error(`error running multi update: wallet update rejected negative value at path '${k}'`);
          }
          after[k as keyof FakeWallet] = next;
        }
        planned.set(u.userId, after);
        acks.push({ userId: u.userId, previous: { ...before }, updated: { ...after } });
      }
      for (const w of writes ?? []) {
        backing.version.n += 1;
        storage.set(sKey(w), { ...w, version: `v${backing.version.n}` });
      }
      for (const [userId, w] of planned) wallets.set(userId, w);
      for (const u of walletUpdates ?? []) {
        updates.push({ userId: u.userId, changeset: { ...u.changeset } });
        if (updateLedger === true) {
          ledger.push({ userId: u.userId, changeset: { ...u.changeset }, metadata: { ...(u.metadata ?? {}) } });
        }
      }
      return { storageWriteAcks: [], walletUpdateAcks: acks };
    },
  } as unknown as INakama;
  return { nk, backing, wallets, ledger, updates, storage, hooks };
}

function idemRecord(storage: Map<string, IStorageObject>, userId: string, key: string): IdempotencyRecord | undefined {
  return storage.get(`${IDEMPOTENCY_COLLECTION}/${key}/${userId}`)?.value as IdempotencyRecord | undefined;
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
  it('credits the wallet with its ledger row and idempotency record in one multiUpdate', () => {
    const { nk, wallets, ledger, updates, storage } = makeFakeNk();
    wallets.set('alice', { coins: 100, gems: 0 });
    const resp = grant(nk, 'alice', { coins: 50 }, REASON_RACE, 'k1');
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toEqual({ coins: 150, gems: 0 });
    expect(updates).toEqual([{ userId: 'alice', changeset: { coins: 50 } }]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      userId: 'alice',
      changeset: { coins: 50 },
      metadata: { reason: 'race:sid-001', idempotencyKey: 'k1' },
    });
    expect(idemRecord(storage, 'alice', 'k1')).toMatchObject({ key: 'k1', state: 'applied', changeset: { coins: 50 } });
  });

  it('is idempotent on the same (userId, key)', () => {
    const { nk, wallets, updates } = makeFakeNk();
    wallets.set('alice', { coins: 0, gems: 0 });
    const r1 = grant(nk, 'alice', { coins: 50 }, REASON_RACE, 'same-key');
    const r2 = grant(nk, 'alice', { coins: 50 }, REASON_RACE, 'same-key');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(wallets.get('alice')).toEqual({ coins: 50, gems: 0 });
  });

  it('stays idempotent across a restart (the key is in storage, PC-11)', () => {
    const first = makeFakeNk();
    first.wallets.set('alice', { coins: 0, gems: 0 });
    grant(first.nk, 'alice', { coins: 50 }, REASON_RACE, 'restart-key');
    const restarted = makeFakeNk(first.backing);
    const again = grant(restarted.nk, 'alice', { coins: 50 }, REASON_RACE, 'restart-key');
    expect(again).toEqual({ ok: true, data: { coins: 50, gems: 0 } });
    expect(first.updates).toHaveLength(1);
  });

  it('a concurrent grant with the same key that commits first makes this one a replay', () => {
    const fake = makeFakeNk();
    fake.wallets.set('alice', { coins: 0, gems: 0 });
    // Another VM commits the same key between this call's read and its write.
    fake.hooks.beforeCommit = () => {
      grant(makeFakeNk(fake.backing).nk, 'alice', { coins: 50 }, REASON_RACE, 'race-key');
    };
    const resp = grant(fake.nk, 'alice', { coins: 50 }, REASON_RACE, 'race-key');
    expect(resp).toEqual({ ok: true, data: { coins: 50, gems: 0 } });
    expect(fake.updates).toHaveLength(1);
  });

  it('a failed write leaves the key unclaimed, so the retry pays (audit 05 f13)', () => {
    const fake = makeFakeNk();
    fake.wallets.set('alice', { coins: 0, gems: 0 });
    fake.hooks.beforeCommit = () => { throw new Error('db down'); };
    const failed = grant(fake.nk, 'alice', { coins: 50 }, REASON_RACE, 'flaky');
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('INTERNAL');
    const retry = grant(fake.nk, 'alice', { coins: 50 }, REASON_RACE, 'flaky');
    expect(retry).toEqual({ ok: true, data: { coins: 50, gems: 0 } });
  });

  it('hashes a key longer than the 128-character storage key', () => {
    const { nk, storage } = makeFakeNk();
    const long = `k:${'x'.repeat(200)}`;
    expect(grant(nk, 'alice', { coins: 5 }, REASON_RACE, long).ok).toBe(true);
    const keys = [...storage.keys()].filter((k) => k.startsWith(`${IDEMPOTENCY_COLLECTION}/`));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^idem\/sha256:[0-9a-f]{64}\/alice$/);
    expect(grant(nk, 'alice', { coins: 5 }, REASON_RACE, long)).toEqual({ ok: true, data: { coins: 5, gems: 0 } });
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
    expect(ledger[0]?.changeset).toEqual({ coins: -200 });
  });

  it('returns INSUFFICIENT_FUNDS when coins would go negative, with nothing written', () => {
    const { nk, wallets, updates, storage } = makeFakeNk();
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
    expect(updates).toHaveLength(0);
    expect(wallets.get('alice')).toEqual({ coins: 100, gems: 50 });
    expect(idemRecord(storage, 'alice', 'k-no-coins')).toBeUndefined();
  });

  it('two spends that both pass the balance pre-check cannot both commit', () => {
    const fake = makeFakeNk();
    fake.wallets.set('alice', { coins: 100, gems: 0 });
    // A concurrent spend commits after this call checked the balance.
    fake.hooks.beforeCommit = () => {
      spend(makeFakeNk(fake.backing).nk, 'alice', { coins: 80 }, REASON_RACE, 'other-buy');
    };
    const resp = spend(fake.nk, 'alice', { coins: 80 }, REASON_RACE, 'this-buy');
    expect(resp).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', message: 'not enough coins', details: { currency: 'coins', balance: 20 } },
    });
    expect(fake.wallets.get('alice')).toEqual({ coins: 20, gems: 0 });
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

  it('rolls the charge back when the delivery written with it loses its CAS', () => {
    const { nk, wallets, storage } = makeFakeNk();
    wallets.set('alice', { coins: 100, gems: 0 });
    const stale: IStorageObject = {
      collection: 'garage', key: 'alice', userId: 'alice', value: {}, version: 'v-stale', permissionRead: 0, permissionWrite: 0,
    };
    const resp = spend(nk, 'alice', { coins: 40 }, REASON_RACE, 'k-cas', { extraWrites: [stale] });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('CONFLICT');
      expect(resp.error.details).toEqual({ reason: 'VERSION_CONFLICT' });
    }
    expect(wallets.get('alice')).toEqual({ coins: 100, gems: 0 });
    expect(idemRecord(storage, 'alice', 'k-cas')).toBeUndefined();
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

describe('economy/wallet — moveWallet', () => {
  it('applies several moves in order and records their net changeset', () => {
    const { nk, wallets, ledger, storage } = makeFakeNk();
    wallets.set('alice', { coins: 3000, gems: 0 });
    const moved = moveWallet(nk, 'alice', 'pack-key', [
      { changeset: { coins: -2500 }, metadata: { reason: 'store', sourceId: 'perm_starter_pack' } },
      { changeset: { coins: 1000, gems: 20 }, metadata: { reason: 'store', sourceId: 'perm_starter_pack:pack' } },
    ], { result: { delivery: 'x' } });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.data).toMatchObject({ replayed: false, balance: { coins: 1500, gems: 20 } });
    expect(ledger.map((l) => l.changeset)).toEqual([{ coins: -2500 }, { coins: 1000, gems: 20 }]);
    expect(idemRecord(storage, 'alice', 'pack-key')).toMatchObject({ changeset: { coins: -1500, gems: 20 }, result: { delivery: 'x' } });
    const replay = moveWallet(nk, 'alice', 'pack-key', []);
    expect(replay.ok && replay.data.replayed).toBe(true);
    if (replay.ok) expect(replay.data.record.result).toEqual({ delivery: 'x' });
  });
});

describe('economy/wallet — revert', () => {
  it('undoes the movement and frees the key: the next spend charges again (HT-73)', () => {
    const { nk, wallets, ledger, storage } = makeFakeNk();
    wallets.set('alice', { coins: 100, gems: 0 });
    expect(spend(nk, 'alice', { coins: 40 }, REASON_RACE, 'buy').ok).toBe(true);
    const refund = revert(nk, 'alice', 'buy', { reason: 'store', sourceId: 'o1:refund' });
    expect(refund).toEqual({ ok: true, data: { reverted: true, balance: { coins: 100, gems: 0 } } });
    expect(ledger.map((l) => l.changeset)).toEqual([{ coins: -40 }, { coins: 40 }]);
    expect(idemRecord(storage, 'alice', 'buy')?.state).toBe('reverted');
    const rebuy = spend(nk, 'alice', { coins: 40 }, REASON_RACE, 'buy');
    expect(rebuy).toEqual({ ok: true, data: { coins: 60, gems: 0 } });
    expect(idemRecord(storage, 'alice', 'buy')?.state).toBe('applied');
  });

  it('is a no-op for an unknown or already reverted key', () => {
    const { nk, wallets } = makeFakeNk();
    wallets.set('alice', { coins: 100, gems: 0 });
    expect(revert(nk, 'alice', 'nope', REASON_RACE)).toEqual({ ok: true, data: { reverted: false, balance: { coins: 100, gems: 0 } } });
    spend(nk, 'alice', { coins: 10 }, REASON_RACE, 'once');
    revert(nk, 'alice', 'once', REASON_RACE);
    expect(revert(nk, 'alice', 'once', REASON_RACE)).toEqual({ ok: true, data: { reverted: false, balance: { coins: 100, gems: 0 } } });
  });

  it('a credited amount already spent cannot be reverted (INSUFFICIENT_FUNDS)', () => {
    const { nk, wallets } = makeFakeNk();
    wallets.set('alice', { coins: 0, gems: 0 });
    grant(nk, 'alice', { coins: 50 }, REASON_RACE, 'gift');
    spend(nk, 'alice', { coins: 30 }, REASON_RACE, 'other');
    const r = revert(nk, 'alice', 'gift', REASON_RACE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(wallets.get('alice')).toEqual({ coins: 20, gems: 0 });
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
      metadata: { idempotencyKey: 'fw-key' },
    });
  });

  it('is idempotent on the same key', () => {
    const { nk, ledger } = makeFakeNk();
    applyLedger(nk, 'alice', { reason: 'race', sourceId: 'x' }, 'k');
    applyLedger(nk, 'alice', { reason: 'race', sourceId: 'x' }, 'k');
    expect(ledger).toHaveLength(1);
  });
});
