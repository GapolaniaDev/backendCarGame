// Plan T-18 (D-10; HT-65, Prog-2, Soc-1): server collections are
// server-only. The client may write only the cloud-save collections
// (`save`, `public`); the before-hook rejects the rest, the code never
// writes `permissionWrite: 1`, and `admin_migrate_permissions` rewrites
// the objects created before the change.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FakeContext, FakeLogger, FakeNakama, SYSTEM_USER_ID, loadBundleForTest } from '../e2e/_stubs';
import {
  CLIENT_WRITABLE_COLLECTIONS,
  beforeWriteStorageObjectsGuard,
  migratedCollections,
  migrateStoragePermissions,
} from '../../modules/src/core/storage_permissions';
import { COLLECTION_NAMES } from '../../modules/src/core/collections';
import type { IContext, IStorageObject } from '../../modules/src/nkruntime';

const SRC = resolve(__dirname, '..', '..', 'modules', 'src');
const CTX = { _brand: 'NakamaContext', userId: 'u-client' } as IContext;
const U1 = '11111111-1111-4111-8111-111111111111';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Put an object as a pre-T-18 server (or a client) left it, bypassing the D-10 guard of the fake. */
function seedRaw(nak: FakeNakama, obj: Omit<IStorageObject, 'version'>, version = 'v-seed'): void {
  nak.store.set(`${obj.collection}/${obj.key}/${obj.userId}`, { ...obj, version } as IStorageObject);
}

describe('T-18 client write guard', () => {
  it('lets a cloud-save write through unchanged', () => {
    const req = { objects: [{ collection: 'save', key: 'slot0' }, { collection: 'public', key: 'card' }] };
    expect(beforeWriteStorageObjectsGuard(CTX, new FakeLogger(), new FakeNakama().nakama, req)).toBe(req);
  });

  it.each(['pass', 'missions_daily', 'friends_edge', 'clubs_members', 'ranked', 'idem', 'achievements'])(
    'rejects a client write to %s with PERMISSION_DENIED',
    (collection) => {
      const req = { objects: [{ collection: 'save', key: 'slot0' }, { collection, key: 'k' }] };
      let thrown: unknown;
      try {
        beforeWriteStorageObjectsGuard(CTX, new FakeLogger(), new FakeNakama().nakama, req);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toMatchObject({ code: 7 });
      expect(String((thrown as { message: string }).message)).toContain(collection);
    },
  );

  it('is registered as the WriteStorageObjects before-hook', () => {
    const env = loadBundleForTest();
    expect(env.fakeInitializer.beforeWriteStorageObjects).toHaveLength(1);
  });

  it('the cloud-save collections are not server collections', () => {
    for (const c of CLIENT_WRITABLE_COLLECTIONS) expect(COLLECTION_NAMES.has(c)).toBe(false);
    expect(migratedCollections()).not.toContain('save');
    expect(migratedCollections().length).toBe(COLLECTION_NAMES.size);
  });
});

describe('T-18 no server write leaves an object client-writable', () => {
  it('no permissionWrite 1 or owner-write constant in modules/src', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const re of [/permissionWrite:\s*1\b/g, /_WRITE\s*=\s*1\b/g, /permission_write:\s*1\b/g]) {
        for (const m of text.matchAll(re)) offenders.push(`${file.slice(SRC.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('T-18 admin_migrate_permissions', () => {
  it('rewrites write 1 to 0, analytics read to 0, keeps values and leaves the cloud save alone', () => {
    const nak = new FakeNakama();
    seedRaw(nak, { collection: 'pass', key: U1, userId: U1, value: { xp: 5 }, permissionRead: 1, permissionWrite: 1 });
    seedRaw(nak, { collection: 'ranked', key: U1, userId: U1, value: { rating: 1000 }, permissionRead: 2, permissionWrite: 1 });
    seedRaw(nak, { collection: 'analytics_events', key: 'e1', userId: SYSTEM_USER_ID, value: { name: 'x' }, permissionRead: 2, permissionWrite: 0 });
    seedRaw(nak, { collection: 'garage', key: U1, userId: U1, value: { cars: [] }, permissionRead: 0, permissionWrite: 0 });
    seedRaw(nak, { collection: 'save', key: 'slot0', userId: U1, value: { v: 1 }, permissionRead: 1, permissionWrite: 1 });

    const report = migrateStoragePermissions(nak.nakama, new FakeLogger());

    expect(report.done).toBe(true);
    expect(report.rewritten).toBe(3);
    expect(report.byCollection).toEqual({ analytics_events: 1, pass: 1, ranked: 1 });
    const get = (c: string, k: string, u: string): IStorageObject => nak.store.get(`${c}/${k}/${u}`) as IStorageObject;
    expect(get('pass', U1, U1)).toMatchObject({ value: { xp: 5 }, permissionRead: 1, permissionWrite: 0 });
    expect(get('ranked', U1, U1)).toMatchObject({ permissionRead: 2, permissionWrite: 0 });
    expect(get('analytics_events', 'e1', SYSTEM_USER_ID)).toMatchObject({ permissionRead: 0, permissionWrite: 0 });
    expect(get('garage', U1, U1).version).toBe('v-seed');
    expect(get('save', 'slot0', U1)).toMatchObject({ permissionWrite: 1, version: 'v-seed' });

    // A second run finds nothing to do.
    expect(migrateStoragePermissions(nak.nakama, new FakeLogger()).rewritten).toBe(0);
  });

  it('stops at maxObjects and resumes from next', () => {
    const nak = new FakeNakama();
    for (let i = 0; i < 250; i++) {
      const uid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      seedRaw(nak, { collection: 'friends_edge', key: `k${i}`, userId: uid, value: {}, permissionRead: 1, permissionWrite: 1 });
    }
    const first = migrateStoragePermissions(nak.nakama, new FakeLogger(), { collection: 'friends_edge', maxObjects: 100 });
    expect(first.done).toBe(false);
    expect(first.rewritten).toBe(100);
    expect(first.next?.collection).toBe('friends_edge');

    let next = first.next;
    let total = first.rewritten;
    while (next !== undefined) {
      const r = migrateStoragePermissions(nak.nakama, new FakeLogger(), { ...next, maxObjects: 100 });
      total += r.rewritten;
      next = r.next;
    }
    expect(total).toBe(250);
    const left = [...nak.store.values()].filter((o) => o.collection === 'friends_edge' && o.permissionWrite !== 0);
    expect(left).toEqual([]);
  });

  it('an unknown resume collection is an error', () => {
    expect(() => migrateStoragePermissions(new FakeNakama().nakama, new FakeLogger(), { collection: 'nope' }))
      .toThrow(/unknown collection/);
  });

  it('the RPC is admin-gated and returns the report', () => {
    const env = loadBundleForTest();
    const rpc = env.fakeInitializer.resolve('admin_migrate_permissions');
    expect(rpc).toBeDefined();
    const denied = JSON.parse(rpc!(FakeContext, env.logger, env.nak, '{}'));
    expect(denied.ok).toBe(false);
  });
});
