// Who may write storage (plan T-18, decision D-10; HT-65, Prog-2, Soc-1).
//
// Every collection of `core/collections.ts` is server-only: objects are
// written with `permissionWrite: 0` (Nakama's default for an omitted
// field is 1, owner-writable), so a modified client cannot rewrite its
// pass, missions, rating or club role with the native
// `WriteStorageObjects` API. Permissions alone do not stop a client from
// CREATING an object the server has not written yet (a `pass` row before
// the first `pass_get`, an `idem` key…), so the before-hook below rejects
// every client write outside the cloud-save whitelist.
//
// The only client-writable collections are those of the cloud save
// (client plan B2, `NakamaSaveCloudStore` in com.jgk.backend.nakama):
// `save` (owner read/write) and `public` (public read, owner write). The
// server never writes them.
//
// `migrateStoragePermissions` rewrites the objects created before T-18
// (`admin_migrate_permissions`): write 0 everywhere, read 0 for
// `analytics_events`.

import type { IContext, ILogger, INakama, IStorageObject, IStorageObjectEnvelope } from '../nkruntime';
import { COLLECTIONS } from './collections';
import { ANALYTICS_COLLECTION, ANALYTICS_PERMISSION_READ } from './admin/analytics';
import { listStorage } from './storage';

/** Collections a client may write with the native storage API (cloud save, plan B2). */
export const CLIENT_WRITABLE_COLLECTIONS: ReadonlySet<string> = new Set(['save', 'public']);

/** gRPC PERMISSION_DENIED: the client receives HTTP 403. */
const PERMISSION_DENIED = 7;

/**
 * Before-hook of the client `WriteStorageObjects` API. Lets a request
 * through only when every object targets a cloud-save collection;
 * otherwise throws a custom error (PERMISSION_DENIED, not logged as a
 * runtime failure) and nothing is written.
 */
export function beforeWriteStorageObjectsGuard(
  ctx: IContext,
  logger: ILogger,
  _nk: INakama,
  data: IStorageObjectEnvelope,
): IStorageObjectEnvelope {
  const objects = Array.isArray(data?.objects) ? data.objects : [];
  const denied = objects
    .map((o) => String(o?.collection ?? ''))
    .filter((c) => !CLIENT_WRITABLE_COLLECTIONS.has(c));
  if (denied.length > 0) {
    logger.warn(
      'rejecting client storage write [user=%s collections=%s]: server-only collections',
      String(ctx?.userId ?? '?'),
      [...new Set(denied)].join(','),
    );
    throw { message: `storage collection is server-only: ${denied[0]}`, code: PERMISSION_DENIED };
  }
  return data;
}

// ─── Migration of existing objects ──────────────────────────────────────────

/** Collections the migration walks: the registry, in order, minus the cloud save. */
export function migratedCollections(): string[] {
  return COLLECTIONS.map((c) => c.name).filter((n) => !CLIENT_WRITABLE_COLLECTIONS.has(n));
}

/** The permissions an object of `collection` must have after T-18 (`read` unchanged when null). */
function targetPermissions(collection: string): { read: number | null; write: number } {
  return collection === ANALYTICS_COLLECTION
    ? { read: ANALYTICS_PERMISSION_READ, write: 0 }
    : { read: null, write: 0 };
}

function needsRewrite(obj: IStorageObject): boolean {
  const target = targetPermissions(obj.collection);
  if ((obj.permissionWrite ?? 1) !== target.write) return true;
  return target.read !== null && (obj.permissionRead ?? 1) !== target.read;
}

function rewriteOf(obj: IStorageObject): IStorageObject {
  const target = targetPermissions(obj.collection);
  return {
    collection: obj.collection,
    key: obj.key,
    userId: obj.userId,
    value: obj.value,
    permissionRead: target.read ?? obj.permissionRead ?? 1,
    permissionWrite: target.write,
    version: obj.version ?? '*',
  };
}

export interface MigratePermissionsOptions {
  /** Resume point: start at this collection (default: the first one). */
  collection?: string;
  /** Resume point inside `collection` (the `next.cursor` of a previous call). */
  cursor?: string;
  /** Stop after scanning about this many objects (default 2000, max 10 000). */
  maxObjects?: number;
}

export interface MigratePermissionsReport {
  scanned: number;
  rewritten: number;
  /** Objects rewritten per collection (only the ones with changes). */
  byCollection: Record<string, number>;
  /** Objects whose rewrite lost twice to a concurrent write (left to the next run). */
  skipped: number;
  done: boolean;
  /** Where the next call resumes when `done` is false. */
  next?: { collection: string; cursor: string };
}

const PAGE = 100;

/**
 * Rewrite every object of the server collections that is still
 * client-writable (or, for `analytics_events`, client-readable). Pages
 * through every owner of each collection; resumable through `next`.
 * Each rewrite keeps the object's value and checks its version, so a
 * concurrent server write wins (and already writes the T-18 permissions).
 */
export function migrateStoragePermissions(
  nk: INakama,
  logger: ILogger,
  opts: MigratePermissionsOptions = {},
): MigratePermissionsReport {
  const all = migratedCollections();
  const budget = Math.max(PAGE, Math.min(10_000, Math.floor(opts.maxObjects ?? 2000)));
  const startIdx = opts.collection !== undefined ? all.indexOf(opts.collection) : 0;
  if (startIdx < 0) throw new Error(`unknown collection: ${opts.collection}`);
  const report: MigratePermissionsReport = { scanned: 0, rewritten: 0, byCollection: {}, skipped: 0, done: false };

  for (let i = startIdx; i < all.length; i++) {
    const collection = all[i] as string;
    let cursor = i === startIdx ? opts.cursor ?? '' : '';
    do {
      if (report.scanned >= budget) {
        report.next = { collection, cursor };
        return report;
      }
      const page = listStorage(nk, { collection, limit: PAGE, cursor });
      report.scanned += page.objects.length;
      const stale = page.objects.filter(needsRewrite);
      if (stale.length > 0) {
        const n = rewriteAll(nk, logger, stale, report);
        if (n > 0) report.byCollection[collection] = (report.byCollection[collection] ?? 0) + n;
      }
      cursor = page.cursor;
    } while (cursor !== '');
  }
  report.done = true;
  logger.info(
    'storage permissions migrated: scanned=%d rewritten=%d skipped=%d %s',
    report.scanned, report.rewritten, report.skipped, JSON.stringify(report.byCollection),
  );
  return report;
}

/** Rewrite a page in one write; on a lost version, object by object with a fresh read. */
function rewriteAll(nk: INakama, logger: ILogger, stale: IStorageObject[], report: MigratePermissionsReport): number {
  try {
    nk.storageWrite(stale.map(rewriteOf));
    report.rewritten += stale.length;
    return stale.length;
  } catch {
    // One object changed since the listing: retry each on its own.
  }
  let n = 0;
  for (const obj of stale) {
    const fresh = nk.storageRead([{ collection: obj.collection, key: obj.key, userId: obj.userId ?? '' }])[0];
    if (fresh === undefined) continue;
    const current: IStorageObject = { ...fresh, collection: obj.collection, key: obj.key, userId: obj.userId };
    if (!needsRewrite(current)) continue;
    try {
      nk.storageWrite([rewriteOf(current)]);
      report.rewritten += 1;
      n += 1;
    } catch (e) {
      report.skipped += 1;
      logger.warn(
        'permission migration skipped %s/%s/%s: %s',
        obj.collection, obj.key, String(obj.userId ?? ''), e instanceof Error ? e.message : String(e),
      );
    }
  }
  return n;
}
