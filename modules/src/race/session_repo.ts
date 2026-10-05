// Session repository: thin wrapper over `nk.storageRead`/`storageWrite`/
// `multiUpdate` that speaks `RaceSession` objects and applies schema-version
// migration via `core/storage` helpers.
//
// The repository is the only code that knows the storage layout
// (collection name, key shape, owner userId). Handlers depend on this
// module — they never touch `nk.storageRead` directly.

import type { INakama, IStorageObject } from '../nkruntime';
import { readJson, writeJson, SCHEMA_VERSION } from '../core/storage';
import { RACE_SESSIONS_COLLECTION, SYSTEM_USER_ID } from './constants';
import type { RaceSession } from './types';

/** Persisted shape: a RaceSession whose schemaVersion is locked to 1. */
export interface PersistedSession
  extends RaceSession,
    Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
}

export interface ReadSessionResult {
  session: PersistedSession;
  version: string;
}

/**
 * Reads a race session by id, returning `null` if it doesn't exist.
 * Owner is the system user — clients cannot read these objects directly.
 */
export function readSession(
  nk: INakama,
  sessionId: string,
): ReadSessionResult | null {
  const r = readJson<PersistedSession>(nk, {
    collection: RACE_SESSIONS_COLLECTION,
    key: sessionId,
    ownerId: SYSTEM_USER_ID,
  });
  if (r === null) return null;
  return { session: r.value, version: r.version };
}

/**
 * Writes a brand-new session. Does NOT enforce CAS — use `updateSession`
 * for conditional updates. The caller must set `session.version = 0`
 * (first write is unconditional).
 */
export function createSession(
  nk: INakama,
  session: RaceSession,
): { version: string } {
  return writeJson<PersistedSession>(nk, {
    collection: RACE_SESSIONS_COLLECTION,
    key: session.id,
    ownerId: SYSTEM_USER_ID,
    value: session as unknown as PersistedSession,
  });
}

/**
 * Conditional update of an existing session via `nk.multiUpdate`. The
 * `expectedVersion` token must match the version currently in storage;
 * on mismatch the runtime refuses the write and the helper throws.
 *
 * Use this for `race_session_start` and the final close-write in
 * `race_submit_result`. Append-only report writes (Chunks 7-9) use the
 * atomic `multiUpdate` directly because they touch multiple keys.
 */
export function updateSession(
  nk: INakama,
  session: RaceSession,
  expectedVersion: string,
): { version: string } {
  const write: IStorageObject = {
    collection: RACE_SESSIONS_COLLECTION,
    key: session.id,
    userId: SYSTEM_USER_ID,
    value: session as unknown as PersistedSession,
    permissionRead: 0,
    permissionWrite: 0,
    version: expectedVersion,
    createTime: '',
    updateTime: '',
    expiresAt: null,
  };
  const ack = nk.multiUpdate([
    { storage_write: write },
  ]);
  const first = ack.storage_updates[0];
  if (!first) {
    throw new Error(`multiUpdate returned no storage ack for session ${session.id}`);
  }
  return { version: first.version };
}