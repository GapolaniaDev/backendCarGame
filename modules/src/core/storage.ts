// Storage helper with `schemaVersion` migration and conditional writes.
//
// Every persisted object carries a `schemaVersion` integer. When reading
// an older version, the migrator chain (`migrators[fromVersion]`) is run
// forward until the object's version matches the current schemaVersion.
//
// Permission semantics for server-only objects: `permissionRead = 0`
// and `permissionWrite = 0` — the storage layer refuses client reads
// and writes regardless of the userID on the key.

import type { INakama } from '../nkruntime';

export const SCHEMA_VERSION = 1;

/** A value-shaped object whose top-level `schemaVersion` is a number. */
export interface VersionedValue {
  schemaVersion: number;
  [key: string]: unknown;
}

export type Migrator<V extends VersionedValue> = (raw: unknown) => V;

export interface ReadOptions<V extends VersionedValue> {
  collection: string;
  key: string;
  ownerId: string;
  migrators?: Partial<Record<number, Migrator<V>>>;
}

export interface WriteOptions<V extends VersionedValue> {
  collection: string;
  key: string;
  ownerId: string;
  value: V;
  /** Permission read — 0 = server-only, 1 = owner, 2 = public. Default 0. */
  permissionRead?: number;
  /** Permission write — 0 = server-only, 1 = owner. Default 0. */
  permissionWrite?: number;
  /** Existing version (for conditional writes). */
  version?: string;
}

export interface ReadResult<V extends VersionedValue> {
  value: V;
  /**
   * Version token returned by the runtime. Always populated by the
   * runtime (server-assigned on writes, monotonically increasing on
   * updates). The type is `string` here even though the underlying
   * field on `IStorageObject` is optional because the runtime ALWAYS
   * returns it on read.
   */
  version: string;
}

/**
 * Reads a single storage object, applies schema migrators if the persisted
 * version is older than the current `SCHEMA_VERSION`. Returns `null` if
 * the object doesn't exist (empty read array).
 */
export function readJson<V extends VersionedValue>(
  nk: INakama,
  opts: ReadOptions<V>,
): ReadResult<V> | null {
  const migrators = opts.migrators ?? {};
  const objects = nk.storageRead([
    { collection: opts.collection, key: opts.key, userId: opts.ownerId },
  ]);
  const obj = objects[0];
  if (!obj) return null;

  let v = obj.value as V;
  const persistedVersion = (v?.schemaVersion ?? 0) as number;
  if (persistedVersion < SCHEMA_VERSION) {
    let current: unknown = v;
    for (let vNum = persistedVersion; vNum < SCHEMA_VERSION; vNum++) {
      const next = migrators[vNum];
      if (!next) {
        throw new Error(
          `no migrator from ${vNum} to ${vNum + 1} for ${opts.collection}/${opts.key}`,
        );
      }
      current = next(current);
    }
    v = current as V;
  }
  return { value: v, version: obj.version ?? '' };
}

/**
 * Writes a value with `permissionRead=0`, `permissionWrite=0` defaults
 * (server-only). Pass `version` for optimistic-concurrency: the write
 * fails server-side if the persisted version doesn't match.
 */
export function writeJson<V extends VersionedValue>(
  nk: INakama,
  opts: WriteOptions<V>,
): { version: string } {
  const baseWrite = {
    collection: opts.collection,
    key: opts.key,
    userId: opts.ownerId,
    value: opts.value,
    permissionRead: opts.permissionRead ?? 0,
    permissionWrite: opts.permissionWrite ?? 0,
  } as Parameters<INakama['storageWrite']>[0][number];

  const writes = [baseWrite];
  if (opts.version !== undefined) {
    (baseWrite as unknown as { version: string }).version = opts.version;
  }
  const ack = nk.storageWrite(writes);
  const first = ack[0];
  if (!first) {
    throw new Error(`storageWrite returned empty ack for ${opts.collection}/${opts.key}`);
  }
  return { version: first.version };
}