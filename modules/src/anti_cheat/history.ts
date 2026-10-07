// Phase 8 Chunk 2 — Anti-cheat check history (per-user, append-only).
//
// `anti_cheat_history/{userId}` — owner-scoped (userId), server-only
// writes. Stores the union of detection results across all 3 helpers
// (partials / abrupt improvement / quorum disagreement) so the
// subscriber (Chunk 4) and admin RPCs (Chunk 4) can render the user's
// full mark timeline.
//
// Capped at `ANTI_CHEAT_HISTORY_MAX_ENTRIES` per user. `pruneHistory`
// removes entries older than a cutoff — the Chunk 4 admin RPC calls
// it after a manual dismiss to drop entries past the dismissal threshold.

import type { IStorageObject, INakama } from '../nkruntime';
import { MAX_CAS_RETRIES } from './_reset_for_tests';
import type { MarkKind } from './types';

/** Storage collection for per-user check history. */
export const ANTI_CHEAT_HISTORY_COLLECTION = 'anti_cheat_history';

/** Cap on entries retained per user (oldest dropped on overflow). */
export const ANTI_CHEAT_HISTORY_MAX_ENTRIES = 1000;

/** A single detection result from any of the 3 anti-cheat helpers. */
export interface AntiCheatHistoryEntry {
  raceId: string;
  /** Epoch-ms when the detection ran. */
  ts: number;
  /** One entry per detector that ran for this race (partials +
   *  abrupt improvement + quorum disagreement). */
  checks: Array<{ kind: MarkKind; ok: boolean }>;
}

export interface AntiCheatHistoryRow {
  schemaVersion: 1;
  userId: string;
  entries: AntiCheatHistoryEntry[];
}

// ─── Storage ────────────────────────────────────────────────────────────────

interface AntiCheatHistoryReadResult {
  record: AntiCheatHistoryRow;
  version: string;
}

function readAntiCheatHistoryRow(
  nk: INakama,
  userId: string,
): AntiCheatHistoryReadResult | null {
  const objs = nk.storageRead([
    { collection: ANTI_CHEAT_HISTORY_COLLECTION, key: userId, userId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<AntiCheatHistoryRow>;
  if (
    !v ||
    typeof v !== 'object' ||
    v.schemaVersion !== 1 ||
    typeof v.userId !== 'string' ||
    !Array.isArray(v.entries)
  ) {
    return null;
  }
  return {
    record: v as AntiCheatHistoryRow,
    version: obj.version ?? '',
  };
}

/** Read the user's history. Returns `[]` when absent. */
export function readHistory(
  nk: INakama,
  userId: string,
): AntiCheatHistoryEntry[] {
  const row = readAntiCheatHistoryRow(nk, userId);
  return row === null ? [] : row.record.entries;
}

/**
 * Append one entry to the user's history. Ring-trimmed to the last
 * `ANTI_CHEAT_HISTORY_MAX_ENTRIES`. CAS-retry handles races against
 * concurrent writers.
 */
export function appendHistory(
  nk: INakama,
  userId: string,
  entry: AntiCheatHistoryEntry,
): void {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readAntiCheatHistoryRow(nk, userId);
    const prev = existing?.record.entries ?? [];
    const next = [...prev, entry].slice(-ANTI_CHEAT_HISTORY_MAX_ENTRIES);
    const row: AntiCheatHistoryRow = {
      schemaVersion: 1,
      userId,
      entries: next,
    };
    const obj: IStorageObject = {
      collection: ANTI_CHEAT_HISTORY_COLLECTION,
      key: userId,
      userId,
      value: row as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 0,
    };
    if (existing !== null) {
      (obj as unknown as { version: string }).version = existing.version;
    }
    try {
      nk.storageWrite([obj]);
      return;
    } catch {
      if (attempt === MAX_CAS_RETRIES - 1) {
        throw new Error('appendHistory: CAS retries exhausted');
      }
    }
  }
  throw new Error('appendHistory: unreachable');
}

/**
 * Drop entries with `ts < olderThanMs`. No-op when the row doesn't
 * exist or nothing matches the cutoff. CAS-retry handles races against
 * concurrent writers.
 */
export function pruneHistory(
  nk: INakama,
  userId: string,
  olderThanMs: number,
): void {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readAntiCheatHistoryRow(nk, userId);
    if (existing === null) return;
    const prev = existing.record.entries;
    const filtered = prev.filter((e) => e.ts >= olderThanMs);
    if (filtered.length === prev.length) return; // nothing to drop
    const row: AntiCheatHistoryRow = {
      schemaVersion: 1,
      userId,
      entries: filtered.slice(-ANTI_CHEAT_HISTORY_MAX_ENTRIES),
    };
    const obj: IStorageObject = {
      collection: ANTI_CHEAT_HISTORY_COLLECTION,
      key: userId,
      userId,
      value: row as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 0,
      version: existing.version,
    };
    try {
      nk.storageWrite([obj]);
      return;
    } catch {
      if (attempt === MAX_CAS_RETRIES - 1) {
        throw new Error('pruneHistory: CAS retries exhausted');
      }
    }
  }
  throw new Error('pruneHistory: unreachable');
}