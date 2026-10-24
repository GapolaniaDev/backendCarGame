// Storage access for the race server registry (D-02). The only module that
// knows the layout of `race_servers`. Writes are conditional on the storage
// version token (CAS); a null version is a create-only write.

import type { ILogger, INakama, IStorageObject } from '../nkruntime';
import { listStorage, readJson, writeJson, SCHEMA_VERSION } from '../core/storage';
import { SYSTEM_USER_ID } from '../race/constants';
import {
  RACE_SERVERS_COLLECTION,
  RACE_SERVER_ALIVE_MS,
  RACE_SERVER_STALE_MS,
  type RaceServerRecord,
} from './types';

const LIST_PAGE = 100;
/** Nakama's create-only conditional write. */
const CREATE_ONLY = '*';
/** Free servers the matchmaker hook tries before giving up (a lost CAS moves on to the next, D-04). */
export const CLAIM_ATTEMPTS = 3;

export interface ServerEntry {
  serverId: string;
  record: RaceServerRecord;
  version: string;
}

export function readServer(nk: INakama, serverId: string): { record: RaceServerRecord; version: string } | null {
  const r = readJson<RaceServerRecord>(nk, {
    collection: RACE_SERVERS_COLLECTION,
    key: serverId,
    ownerId: SYSTEM_USER_ID,
  });
  return r === null ? null : { record: r.value, version: r.version };
}

/**
 * Writes `record`. `version` is the token read before (CAS); `null` creates
 * the row and fails when it already exists. Throws when the check fails.
 */
export function writeServer(
  nk: INakama,
  serverId: string,
  record: RaceServerRecord,
  version: string | null,
): { version: string } {
  return writeJson<RaceServerRecord>(nk, {
    collection: RACE_SERVERS_COLLECTION,
    key: serverId,
    ownerId: SYSTEM_USER_ID,
    value: { ...record, schemaVersion: SCHEMA_VERSION as 1 },
    version: version ?? CREATE_ONLY,
  });
}

/** Every registered server (all pages). */
export function listServers(nk: INakama): ServerEntry[] {
  const out: ServerEntry[] = [];
  let cursor = '';
  do {
    const page = listStorage(nk, {
      userId: SYSTEM_USER_ID,
      collection: RACE_SERVERS_COLLECTION,
      limit: LIST_PAGE,
      cursor,
    });
    for (const o of page.objects) {
      out.push({ serverId: o.key, record: o.value as RaceServerRecord, version: o.version ?? '' });
    }
    cursor = page.cursor;
  } while (cursor.length > 0);
  return out;
}

/**
 * Assigns `sessionId` to the server if it is free and unchanged since
 * `entry` was read. Returns false when the CAS fails or it is not free.
 */
export function claimServer(nk: INakama, entry: ServerEntry, sessionId: string, nowMs: number): boolean {
  if (entry.record.sessionId !== null) return false;
  try {
    writeServer(nk, entry.serverId, { ...entry.record, sessionId, assignedAtMs: nowMs }, entry.version);
    return true;
  } catch {
    return false;
  }
}

/** `true` when the server's last heartbeat is recent enough (D-02). */
export function isServerAlive(record: RaceServerRecord, nowMs: number): boolean {
  return record.lastSeenMs >= nowMs - RACE_SERVER_ALIVE_MS;
}

/**
 * Live servers without a session, the one with the most recent heartbeat
 * first (D-04).
 */
export function listFreeServers(nk: INakama, nowMs: number): ServerEntry[] {
  return listServers(nk)
    .filter((e) => e.record.sessionId === null && isServerAlive(e.record, nowMs))
    .sort((a, b) => b.record.lastSeenMs - a.record.lastSeenMs);
}

/**
 * The storage write that reserves `entry` for `sessionId` (D-04): the row
 * with `sessionId` and `assignedAtMs`, conditional on the version read in
 * `entry` (CAS). The matchmaker hook commits it in the same atomic update
 * as the session itself, so a reserved server always has its session.
 */
export function serverClaimWrite(entry: ServerEntry, sessionId: string, nowMs: number): IStorageObject {
  return {
    collection: RACE_SERVERS_COLLECTION,
    key: entry.serverId,
    userId: SYSTEM_USER_ID,
    value: { ...entry.record, sessionId, assignedAtMs: nowMs, schemaVersion: SCHEMA_VERSION as 1 },
    version: entry.version,
    permissionRead: 0,
    permissionWrite: 0,
  };
}

/**
 * Frees the server when it still holds `expectedSessionId` and is unchanged
 * since `entry` was read. Returns false when the CAS fails.
 */
export function releaseServer(nk: INakama, entry: ServerEntry, expectedSessionId: string): boolean {
  if (entry.record.sessionId !== expectedSessionId) return false;
  try {
    writeServer(nk, entry.serverId, { ...entry.record, sessionId: null }, entry.version);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ticker job: frees the session of every server whose last heartbeat is
 * older than `RACE_SERVER_STALE_MS`. Returns how many were freed.
 */
export function releaseStaleServers(nk: INakama, logger: ILogger, nowMs: number): number {
  let freed = 0;
  for (const entry of listServers(nk)) {
    const sessionId = entry.record.sessionId;
    if (sessionId === null || entry.record.lastSeenMs >= nowMs - RACE_SERVER_STALE_MS) continue;
    if (releaseServer(nk, entry, sessionId)) {
      freed += 1;
      logger.warn('race server %s without heartbeat for %d ms: session %s released',
        entry.serverId, nowMs - entry.record.lastSeenMs, sessionId);
    }
  }
  return freed;
}
