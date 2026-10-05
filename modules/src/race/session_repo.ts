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
import type { RaceSession, RaceReport, RosterEntry } from './types';

/** Composite storage key for a per-user report inside a session. */
export function reportKey(sessionId: string, userId: string): string {
  return `${sessionId}/reports/${userId}`;
}

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
  };
  const ack = nk.multiUpdate(undefined, [write], undefined, undefined, undefined);
  const first = ack.storageWriteAcks[0];
  if (!first) {
    throw new Error(`multiUpdate returned no storage ack for session ${session.id}`);
  }
  return { version: first.version };
}

/**
 * Atomic `race_session_join` write — appends a roster entry and bumps
 * the session version in a single `multiUpdate`. The caller is
 * responsible for all membership / state / capacity checks; this
 * helper does NOT validate.
 *
 * On version conflict (another join raced us) the runtime refuses the
 * write and the helper throws. The caller should map the throw to a
 * `CONFLICT` envelope.
 */
export function appendRosterEntry(
  nk: INakama,
  session: RaceSession,
  entry: RosterEntry,
  expectedVersion: string,
): { version: string } {
  const next: RaceSession = {
    ...session,
    roster: [...session.roster, entry],
    version: session.version + 1,
  };
  return updateSession(nk, next, expectedVersion);
}

/**
 * Atomic `race_session_start` write — transitions the session to
 * `started` and stamps `startedAt` with `Date.now()`. Caller must
 * verify `state === 'created'` and `caller === session.host` first.
 */
export function markStarted(
  nk: INakama,
  session: RaceSession,
  expectedVersion: string,
  startedAt: number,
): { version: string } {
  const next: RaceSession = {
    ...session,
    state: 'started',
    startedAt,
    version: session.version + 1,
  };
  return updateSession(nk, next, expectedVersion);
}

/**
 * Lookup the most recent closed session for a given user. Chunk 6
 * wires this up but the index is not yet populated — the writer lands
 * in Chunk 9 when sessions transition to `closed`. Until then this
 * always returns `undefined`.
 *
 * Implementation: a `last_closed/{userId}` storage object owned by the
 * system user (perms 0/0) whose value is `{ sessionId, closedAt }`.
 */
export function lookupLastClosed(
  nk: INakama,
  userId: string,
): { sessionId: string; closedAt: number } | null {
  const key = `last_closed/${userId}`;
  const objects = nk.storageRead([
    { collection: RACE_SESSIONS_COLLECTION, key, userId: SYSTEM_USER_ID },
  ]);
  const obj = objects[0];
  if (!obj) return null;
  const v = obj.value as { sessionId?: unknown; closedAt?: unknown };
  if (typeof v.sessionId !== 'string' || typeof v.closedAt !== 'number') return null;
  return { sessionId: v.sessionId, closedAt: v.closedAt };
}

/** Storage key under which the per-user last-closed index lives. */
export const LAST_CLOSED_KEY_PREFIX = 'last_closed/';

// ─── Per-user reports ────────────────────────────────────────────────────────

/**
 * Persisted shape for an individual report: the same fields as the
 * incoming `RaceReport` plus `schemaVersion: 1`.
 */
export interface PersistedReport
  extends RaceReport,
    Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
}

/**
 * Read a single report by `(sessionId, userId)`. Returns `null` if the
 * player hasn't submitted yet. Owner is the joiner (perms 0/0 so only
 * the runtime can read/write).
 */
export function readReport(
  nk: INakama,
  sessionId: string,
  userId: string,
): PersistedReport | null {
  const r = readJson<PersistedReport>(nk, {
    collection: RACE_SESSIONS_COLLECTION,
    key: reportKey(sessionId, userId),
    ownerId: userId,
  });
  return r === null ? null : r.value;
}

/**
 * Atomic submission: writes the report and bumps the roster entry in
 * a single `multiUpdate` with CAS on the session version.
 *
 * On version conflict the runtime refuses the write and the helper
 * throws — caller maps to `CONFLICT`.
 *
 * Note: this is the ONLY valid path for `race_submit_result` writes
 * in Chunk 7. Step-2 validations (clock, min-time, lap-sum) live in
 * Chunk 8 and gate this call.
 */
export function submitReport(
  nk: INakama,
  session: RaceSession,
  reporterId: string,
  report: RaceReport,
  expectedVersion: string,
  nowMs: number,
): { version: string } {
  const newRoster = session.roster.map((e) =>
    e.userId === reporterId
      ? {
          ...e,
          reportedAt: nowMs,
          totalMs: report.totalMs,
          laps: report.laps.slice(),
        }
      : e,
  );
  const nextSession: RaceSession = {
    ...session,
    roster: newRoster,
    version: session.version + 1,
  };

  const persisted: PersistedReport = {
    schemaVersion: SCHEMA_VERSION,
    userId: reporterId,
    totalMs: report.totalMs,
    laps: report.laps.slice(),
    isBotReport: report.isBotReport,
  };

  const writes: IStorageObject[] = [
    {
      collection: RACE_SESSIONS_COLLECTION,
      key: session.id,
      userId: SYSTEM_USER_ID,
      value: nextSession as unknown as PersistedSession,
      permissionRead: 0,
      permissionWrite: 0,
      version: expectedVersion,
    },
    {
      collection: RACE_SESSIONS_COLLECTION,
      key: reportKey(session.id, reporterId),
      userId: reporterId,
      value: persisted as unknown as PersistedReport,
      permissionRead: 0,
      permissionWrite: 0,
    },
  ];

  const ack = nk.multiUpdate(undefined, writes, undefined, undefined, undefined);
  const first = ack.storageWriteAcks[0];
  if (!first) {
    throw new Error(`multiUpdate returned no storage ack for session ${session.id}`);
  }
  return { version: first.version };
}