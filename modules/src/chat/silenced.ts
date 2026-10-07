// Phase 7 Chunk 6 — Silenced storage helpers.
//
// `silenced/{userId}` = { untilUtc, reason, createdAt }. Server-only
// writes (Write=0). Created by the reports system in Chunk 7 (out of
// scope here — this module just exposes the read/insert surface so
// `chat_send` can gate on it).

import type { IStorageObject, INakama } from '../nkruntime';
import { asSilencedWrite, SILENCED_COLLECTION, type SilencedRecord } from './types';

/** Default silence duration for the auto-3-reports-in-24h trigger (D5). */
export const DEFAULT_SILENCE_DURATION_MS = 60 * 60 * 1000; // 1 hour

export const MAX_CAS_RETRIES = 3;

export interface SilencedReadResult {
  record: SilencedRecord;
  version: string;
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Read the silenced row for `userId`. Returns `null` when absent.
 */
export function readSilenced(
  nk: INakama,
  userId: string,
): SilencedReadResult | null {
  const objs = nk.storageRead([
    { collection: SILENCED_COLLECTION, key: userId, userId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const value = obj.value as Partial<SilencedRecord>;
  if (
    !value || typeof value !== 'object' || value.schemaVersion !== 1 ||
    typeof value.userId !== 'string' ||
    typeof value.untilUtc !== 'number' ||
    typeof value.reason !== 'string' ||
    typeof value.createdAt !== 'number'
  ) {
    return null;
  }
  return { record: value as SilencedRecord, version: obj.version ?? '' };
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export function writeSilencedCreate(
  nk: INakama,
  record: SilencedRecord,
): string {
  const obj: IStorageObject = asSilencedWrite(record);
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

export function writeSilencedUpdate(
  nk: INakama,
  record: SilencedRecord,
  version: string,
): string {
  const obj: IStorageObject = { ...asSilencedWrite(record), version };
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

// ─── Query helpers ──────────────────────────────────────────────────────────

export interface SilencedStatus {
  silenced: boolean;
  untilUtc: number | null;
  reason: string | null;
}

/**
 * Returns whether `userId` is currently silenced (= their `untilUtc`
 * is still in the future). When the silence has expired we still
 * report the values for diagnostics, but `silenced=false`.
 */
export function getSilencedStatus(
  nk: INakama,
  userId: string,
  nowMs: number,
): SilencedStatus {
  const row = readSilenced(nk, userId);
  if (row === null) {
    return { silenced: false, untilUtc: null, reason: null };
  }
  const silenced = row.record.untilUtc > nowMs;
  return {
    silenced,
    untilUtc: silenced ? row.record.untilUtc : null,
    reason: silenced ? row.record.reason : null,
  };
}

// ─── Server-only silence helper (used by reports in Chunk 7) ────────────────

/**
 * Silence a user until `nowMs + durationMs`. Idempotent: if the user
 * is already silenced, the silence is EXTENDED (max of existing
 * untilUtc and new untilUtc wins). CAS-retry handles concurrent writes.
 *
 * Returns the final `untilUtc`.
 */
export function silenceUser(
  nk: INakama,
  userId: string,
  reason: string,
  durationMs: number,
  nowMs: number,
): number {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const existing = readSilenced(nk, userId);
    const proposedUntilUtc = nowMs + durationMs;
    const untilUtc = existing !== null
      ? Math.max(existing.record.untilUtc, proposedUntilUtc)
      : proposedUntilUtc;
    const next: SilencedRecord = {
      schemaVersion: 1,
      userId,
      untilUtc,
      reason: existing?.record.reason ?? reason,
      createdAt: existing?.record.createdAt ?? nowMs,
    };
    try {
      if (existing === null) {
        writeSilencedCreate(nk, next);
      } else {
        writeSilencedUpdate(nk, next, existing.version);
      }
      return untilUtc;
    } catch {
      // CAS conflict — re-read and retry.
      if (attempt === MAX_CAS_RETRIES - 1) {
        throw new Error('silenceUser: CAS retries exhausted');
      }
    }
  }
  throw new Error('silenceUser: unreachable');
}