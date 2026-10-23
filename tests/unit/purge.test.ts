// account/purge.ts (plan T-16): the purge rules of the collection
// registry, paging, and the 3.27 leaderboard listing.

import { describe, it, expect } from 'vitest';
import { FakeNakama, FakeLogger } from '../e2e/_stubs';
import { purgeFromLeaderboards, purgeUserStorage } from '../../modules/src/account/purge';
import type { CollectionSpec } from '../../modules/src/core/collections';
import type { ILeaderboard, ILeaderboardRecord } from '../../modules/src/nkruntime';

const U = 'user-u';
const V = 'user-v';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

function put(nak: FakeNakama, collection: string, key: string, userId: string, value: Record<string, unknown> = {}): void {
  nak.store.set(`${collection}/${key}/${userId}`, {
    collection, key, userId, value, version: 'v1', permissionRead: 1, permissionWrite: 0,
    createTime: '', updateTime: '', expiresAt: null,
  });
}

const spec = (name: string, purge: CollectionSpec['purge'] = []): CollectionSpec => ({ name, module: 'test', owner: 'mixed', purge });

describe('purgeUserStorage', () => {
  it('deletes every owned object, past one listing page', () => {
    const nak = new FakeNakama();
    for (let i = 0; i < 250; i++) put(nak, 'c', `k${i}`, U);
    put(nak, 'c', 'k0', V);
    const r = purgeUserStorage(nak.nakama, new FakeLogger(), U, [spec('c')]);
    expect(r).toEqual({ storageDeleted: 250, collectionsAffected: ['c'], referencesRemoved: 0 });
    expect(nak.store.size).toBe(1);
  });

  it('systemKey and systemKeySuffix delete only the user’s system rows', () => {
    const nak = new FakeNakama();
    put(nak, 'idx', U, SYSTEM);
    put(nak, 'idx', V, SYSTEM);
    put(nak, 'pres', `s1/${U}`, SYSTEM);
    put(nak, 'pres', `s1/${V}`, SYSTEM);
    const r = purgeUserStorage(nak.nakama, new FakeLogger(), U, [
      spec('idx', [{ kind: 'systemKey', key: (u) => u }]),
      spec('pres', [{ kind: 'systemKeySuffix', suffix: (u) => `/${u}` }]),
    ]);
    expect(r.storageDeleted).toBe(2);
    expect([...nak.store.keys()].sort()).toEqual([`idx/${V}/${SYSTEM}`, `pres/s1/${V}/${SYSTEM}`]);
  });

  it('keyIsUser, valueField and entries clean other owners’ references', () => {
    const nak = new FakeNakama();
    put(nak, 'edge', U, V, { friendId: U });
    put(nak, 'edge', 'w', V, { friendId: 'w' });
    put(nak, 'inv', 'i1', V, { fromUserId: U });
    put(nak, 'inv', 'i2', V, { fromUserId: 'w' });
    put(nak, 'riv', V, V, { entries: [{ userId: U }, { userId: 'w' }], other: 1 });
    const r = purgeUserStorage(nak.nakama, new FakeLogger(), U, [
      spec('edge', [{ kind: 'keyIsUser' }]),
      spec('inv', [{ kind: 'valueField', field: 'fromUserId' }]),
      spec('riv', [{ kind: 'entries', field: 'entries' }]),
    ]);
    expect(r.referencesRemoved).toBe(3);
    expect(r.collectionsAffected).toEqual(['edge', 'inv', 'riv']);
    expect(nak.store.has(`edge/w/${V}`)).toBe(true);
    expect(nak.store.has(`inv/i2/${V}`)).toBe(true);
    expect(nak.store.get(`riv/${V}/${V}`)?.value).toEqual({ entries: [{ userId: 'w' }], other: 1 });
  });
});

describe('purgeFromLeaderboards', () => {
  function board(nak: FakeNakama, id: string, owners: string[]): void {
    nak.leaderboards.set(id, { id } as unknown as ILeaderboard);
    nak.leaderboardRecords.set(id, new Map(owners.map((o) => [o, { leaderboardId: id, ownerId: o, score: 1 } as unknown as ILeaderboardRecord])));
  }

  it('lists with the 3.27 signature (limit ≤ 100) and counts only boards with a record', () => {
    const nak = new FakeNakama();
    board(nak, 'a', [U, V]);
    board(nak, 'b', [V]);
    board(nak, 'c', [U]);
    const r = purgeFromLeaderboards(nak.nakama, new FakeLogger(), U);
    expect(r).toEqual({ boardsDeleted: 2, boardsAffected: ['a', 'c'] });
    expect(nak.leaderboardRecords.get('a')?.has(U)).toBe(false);
    expect(nak.leaderboardRecords.get('a')?.has(V)).toBe(true);
  });
});
