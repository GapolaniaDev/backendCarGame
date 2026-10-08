// Phase 8 Chunk 5 — Tournament storage repo.
//
// Two collections, both R=1 / W=0 (server-only writes):
//
//   - `tournament_instances/{templateId}` (system-owned) — the
//     materialised tournament record. One row per template id.
//   - `tournament_entries/{tournamentId}/{userId}` (owner=userId,
//     R=1 server-only) — the per-player entry row. Tracks attempts
//     remaining, best time, checkpoint splits, paid entry fee.
//
// All reads/writes go through CAS-retry (`MAX_CAS_RETRIES=3`) to
// survive concurrent workers and retries. The entry row is owned by
// the user so `nk.storageList({collection: 'tournament_entries',
// userId})` lets the server enumerate participants.

import type { IStorageObject, INakama } from '../nkruntime';
import { MAX_CAS_RETRIES } from '../anti_cheat/_reset_for_tests';
import type { Tournament, TournamentEntry } from './types';

/** Tournament instance collection — server-owned, one row per template id. */
export const TOURNAMENT_INSTANCES_COLLECTION = 'tournament_instances';

/** Owner sentinel for the instances collection. */
export const TOURNAMENT_INSTANCES_SYSTEM_USER =
  '00000000-0000-0000-0000-000000000000';

/** Tournament entries collection — owner=userId, server-only writes. */
export const TOURNAMENT_ENTRIES_COLLECTION = 'tournament_entries';

// ─── Instances ────────────────────────────────────────────────────────────

interface InstanceReadResult {
  record: Tournament;
  version: string;
}

function readInstanceRow(nk: INakama, templateId: string): InstanceReadResult | null {
  const objs = nk.storageRead([
    {
      collection: TOURNAMENT_INSTANCES_COLLECTION,
      key: templateId,
      userId: TOURNAMENT_INSTANCES_SYSTEM_USER,
    },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<Tournament>;
  if (!v || typeof v !== 'object' || v.schemaVersion !== 1 || typeof v.id !== 'string') {
    return null;
  }
  return { record: v as Tournament, version: obj.version ?? '' };
}

/** Read a tournament instance by template id. Returns null when absent. */
export function readTournamentInstance(
  nk: INakama,
  templateId: string,
): Tournament | null {
  const row = readInstanceRow(nk, templateId);
  return row === null ? null : row.record;
}

/** Write a tournament instance (CAS-retry on the `version` field). */
export function writeTournamentInstance(nk: INakama, t: Tournament): void {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readInstanceRow(nk, t.id);
    const obj: IStorageObject = {
      collection: TOURNAMENT_INSTANCES_COLLECTION,
      key: t.id,
      userId: TOURNAMENT_INSTANCES_SYSTEM_USER,
      value: t as unknown as Record<string, unknown>,
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
        throw new Error('writeTournamentInstance: CAS retries exhausted');
      }
    }
  }
  throw new Error('writeTournamentInstance: unreachable');
}

// ─── Entries ──────────────────────────────────────────────────────────────

interface EntryReadResult {
  record: TournamentEntry;
  version: string;
}

/**
 * Phase 8 Chunk 6 — checkpoints format produced by the subscriber.
 * Each section's `elapsedMs` is the cumulative time-to-that-section;
 * `bestMs` is the player's best across attempts (null on first run).
 */
export interface TournamentCheckpointInput {
  sectionIndex: number;
  elapsedMs: number;
  bestMs: number | null;
}

/**
 * Update an entry after a successful race. CAS-retry handles
 * concurrent race submissions for the same user. The caller passes
 * `nowUtc` to stamp `updatedAt`; `newAttemptTimeMs` is the new
 * `totalMs` (lower than the existing best keeps the best unchanged;
 * otherwise the best becomes the new time).
 *
 * Throws when the entry is absent (caller should have read first
 * via `readEntry`) or when CAS retries exhaust.
 */
export function updateEntryAfterRace(
  nk: INakama,
  tournamentId: string,
  userId: string,
  newAttemptTimeMs: number,
  checkpoints: ReadonlyArray<TournamentCheckpointInput>,
  nowUtc: number,
): TournamentEntry {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readEntryRow(nk, tournamentId, userId);
    if (existing === null) {
      throw new Error('updateEntryAfterRace: entry not found');
    }
    const prev = existing.record;
    const nextBest: number | null =
      prev.bestTimeMs === null || newAttemptTimeMs < prev.bestTimeMs
        ? newAttemptTimeMs
        : prev.bestTimeMs;
    const next: TournamentEntry = {
      ...prev,
      attemptsRemaining: Math.max(0, prev.attemptsRemaining - 1),
      bestTimeMs: nextBest,
      checkpoints: checkpoints.map((c) => ({
        sectionIndex: c.sectionIndex,
        elapsedMs: c.elapsedMs,
        bestMs: c.bestMs,
      })),
      updatedAt: nowUtc,
    };
    const obj: IStorageObject = {
      collection: TOURNAMENT_ENTRIES_COLLECTION,
      key: tournamentId,
      userId,
      value: next as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 0,
      version: existing.version,
    };
    try {
      nk.storageWrite([obj]);
      return next;
    } catch {
      if (attempt === MAX_CAS_RETRIES - 1) {
        throw new Error('updateEntryAfterRace: CAS retries exhausted');
      }
    }
  }
  throw new Error('updateEntryAfterRace: unreachable');
}

/**
 * Delete a tournament entry. Idempotent. Used by the scanner when
 * the post-close retention window elapses (24h).
 */
export function deleteEntry(
  nk: INakama,
  tournamentId: string,
  userId: string,
): void {
  nk.storageDelete([
    { collection: TOURNAMENT_ENTRIES_COLLECTION, key: tournamentId, userId },
  ]);
}

function readEntryRow(
  nk: INakama,
  tournamentId: string,
  userId: string,
): EntryReadResult | null {
  const objs = nk.storageRead([
    {
      collection: TOURNAMENT_ENTRIES_COLLECTION,
      key: tournamentId,
      userId,
    },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<TournamentEntry>;
  if (
    !v ||
    typeof v !== 'object' ||
    v.schemaVersion !== 1 ||
    typeof v.userId !== 'string' ||
    typeof v.tournamentId !== 'string'
  ) {
    return null;
  }
  return { record: v as TournamentEntry, version: obj.version ?? '' };
}

/**
 * Read a player's entry in a tournament. Returns null when the user
 * hasn't joined yet.
 */
export function readEntry(
  nk: INakama,
  tournamentId: string,
  userId: string,
): TournamentEntry | null {
  const row = readEntryRow(nk, tournamentId, userId);
  return row === null ? null : row.record;
}

/**
 * Create a new entry. Throws `CONFLICT` (already joined) when the row
 * is already present, so the join RPC can map cleanly. CAS-retry
 * handles concurrent writers.
 */
export function createEntry(
  nk: INakama,
  tournamentId: string,
  userId: string,
  paidEntryFee: number,
  attemptsRemaining: number,
  nowUtc: number,
): TournamentEntry {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readEntryRow(nk, tournamentId, userId);
    if (existing !== null) {
      throw new Error('createEntry: already joined');
    }
    const entry: TournamentEntry = {
      schemaVersion: 1,
      tournamentId,
      userId,
      attemptsRemaining,
      bestTimeMs: null,
      checkpoints: [],
      createdAt: nowUtc,
      updatedAt: nowUtc,
    };
    const obj: IStorageObject = {
      collection: TOURNAMENT_ENTRIES_COLLECTION,
      key: tournamentId,
      userId,
      value: { ...entry, paidEntryFee } as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 0,
    };
    try {
      nk.storageWrite([obj]);
      return { ...entry, paidEntryFee } as TournamentEntry;
    } catch {
      if (attempt === MAX_CAS_RETRIES - 1) {
        throw new Error('createEntry: CAS retries exhausted');
      }
    }
  }
  throw new Error('createEntry: unreachable');
}

/**
 * Count participants in a tournament via `nk.storageList`. Returns the
 * number of entries (storage list counts each `tournament_entries/{tid}/{userId}`
 * row once). Limited to `limit` (server-clamped to 5000 to avoid hot-path
 * stalls on big tournaments).
 */
export function countParticipants(
  nk: INakama,
  tournamentId: string,
): number {
  const objs = nk.storageList({
    collection: TOURNAMENT_ENTRIES_COLLECTION,
    limit: 5000,
  });
  let n = 0;
  for (const obj of objs.objects) {
    if (obj.key !== tournamentId) continue;
    n += 1;
  }
  return n;
}

/**
 * Storage row shape including the per-user `paidEntryFee` (not exposed
 * on the public `TournamentEntry` type — kept on disk for the lifetime
 * of the tournament so the close path can refund the exact amount if
 * the tournament is voided).
 */
export interface TournamentEntryRow extends TournamentEntry {
  paidEntryFee: number;
}