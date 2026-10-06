// Phase 4 abandon tracker (D6). Records each ranked abandon and
// stamps a 15-minute matchmaking block when the rolling 24h count
// crosses the configured threshold.
//
// Storage layout:
//   collection: `abandons`
//   key:        `{userId}`
//   owner:      `{userId}` (per-user, server-managed — perms 0/0 so the
//               client cannot tamper with the counter or expiry)
//   value:
//     {
//       schemaVersion: 1,
//       entries: Array<{ at: number }>,   // UTC epoch-ms per abandon
//       blockedUntilUtc?: number,         // set when threshold crossed
//     }
//
// Concurrency: the helper does a read-modify-write under a CAS
// `version`. The stub runtime ignores `version`, but production
// refuses stale writes; the CAS makes concurrent race_session_closes
// safe (only the winner of the CAS writes a new entry).
//
// Read-path laziness: `getAbandonsLast24h` and `isBlocked` run the
// 24h filter on every read and GC any stale entries as a side-effect
// (writing the trimmed value back under CAS). This keeps the tracker
// self-cleaning without a sweeper task.

import type { INakama } from '../nkruntime';
import { getLiveOpsConfig } from './mm_config';

export const ABANDONS_COLLECTION = 'abandons';
export const ABANDONS_SCHEMA_VERSION = 1;

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface AbandonEntry {
  at: number;
}

export interface AbandonRecord {
  schemaVersion: 1;
  entries: AbandonEntry[];
  blockedUntilUtc: number | null;
}

interface PersistedAbandonRecord extends AbandonRecord {
  schemaVersion: typeof ABANDONS_SCHEMA_VERSION;
}

export interface RecordAbandonOutcome {
  /** Count of entries within the last 24h AFTER this write landed. */
  abandonsLast24h: number;
  /** True if this write crossed the threshold and stamped a new block. */
  blockedNow: boolean;
  /** Newest blockedUntilUtc value (or the existing one if no new block was stamped). */
  blockedUntilUtc: number | null;
}

/** Threshold + block duration come from `liveops_config.json` (liveops overrides). */
function readThresholds(): { threshold: number; blockMinutes: number } {
  const cfg = getLiveOpsConfig();
  return {
    threshold: cfg.matchmaking.abandonBlockThreshold,
    blockMinutes: cfg.matchmaking.abandonBlockMinutes,
  };
}

/**
 * Filter the entries to the rolling 24h window. Pure.
 *
 * Keep entries where `0 <= nowMs - e.at <= MS_PER_DAY` (i.e. the entry
 * is at or in the past, and not more than 24h old). The upper bound is
 * inclusive — an entry exactly 24h old still counts so the player
 * doesn't see their counter reset one tick early.
 *
 * The lower bound allows `age === 0` because `recordAbandon` reads the
 * counter immediately after writing the new entry — the freshly-stamped
 * entry has `e.at === nowMs` and must still count.
 */
export function filterFreshEntries(
  entries: ReadonlyArray<AbandonEntry>,
  nowMs: number,
): AbandonEntry[] {
  const out: AbandonEntry[] = [];
  for (const e of entries) {
    if (typeof e.at !== 'number') continue;
    const age = nowMs - e.at;
    if (age < 0) continue;
    if (age > MS_PER_DAY) continue;
    out.push(e);
  }
  return out;
}

/**
 * Append a new abandon to `userId`'s record. Idempotent against
 * concurrent writers (CAS on `version`). If the resulting fresh count
 * crosses the threshold AND there isn't an existing block, stamp a
 * new `blockedUntilUtc = now + blockMinutes`.
 *
 * Returns the post-write summary so callers don't have to re-read.
 */
export function recordAbandon(
  nk: INakama,
  userId: string,
  nowMs: number,
): RecordAbandonOutcome {
  const { threshold, blockMinutes } = readThresholds();
  const existing = readAbandonRecord(nk, userId);
  const currentEntries = existing?.record.entries ?? [];
  const currentBlock = existing?.record.blockedUntilUtc ?? null;

  const fresh = filterFreshEntries(currentEntries, nowMs);
  fresh.push({ at: nowMs });

  const nextBlock =
    currentBlock !== null && currentBlock > nowMs
      ? currentBlock
      : fresh.length >= threshold
        ? nowMs + blockMinutes * MS_PER_MIN
        : null;

  const next: PersistedAbandonRecord = {
    schemaVersion: ABANDONS_SCHEMA_VERSION,
    entries: fresh,
    blockedUntilUtc: nextBlock,
  };

  if (existing === null) {
    // First-write create. The stub accepts the unconditional insert.
    nk.storageWrite([
      {
        collection: ABANDONS_COLLECTION,
        key: userId,
        userId,
        value: next as unknown as Record<string, unknown>,
        permissionRead: 0,
        permissionWrite: 0,
      },
    ]);
  } else {
    nk.storageWrite([
      {
        collection: ABANDONS_COLLECTION,
        key: userId,
        userId,
        value: next as unknown as Record<string, unknown>,
        permissionRead: 0,
        permissionWrite: 0,
        version: existing.version,
      },
    ]);
  }

  return {
    abandonsLast24h: fresh.length,
    blockedNow: nextBlock !== null && (currentBlock === null || nextBlock > currentBlock),
    blockedUntilUtc: nextBlock,
  };
}

/**
 * Count of abandons in the rolling 24h window. Lazy-GCs stale entries
 * on read so the record never grows unbounded.
 */
export function getAbandonsLast24h(
  nk: INakama,
  userId: string,
  nowMs: number,
): number {
  const record = readAbandonRecord(nk, userId);
  if (record === null) return 0;
  const fresh = filterFreshEntries(record.record.entries, nowMs);
  if (fresh.length !== record.record.entries.length) {
    // Lazy GC — write the trimmed list back under CAS.
    const next: PersistedAbandonRecord = {
      schemaVersion: ABANDONS_SCHEMA_VERSION,
      entries: fresh,
      blockedUntilUtc:
        record.record.blockedUntilUtc !== null && record.record.blockedUntilUtc > nowMs
          ? record.record.blockedUntilUtc
          : null,
    };
    nk.storageWrite([
      {
        collection: ABANDONS_COLLECTION,
        key: userId,
        userId,
        value: next as unknown as Record<string, unknown>,
        permissionRead: 0,
        permissionWrite: 0,
        version: record.version,
      },
    ]);
  }
  return fresh.length;
}

/**
 * `blockedUntilUtc` is only meaningful when it is strictly in the
 * future. Expired blocks return `null` so the caller treats the user
 * as unblocked.
 */
export function isBlocked(
  nk: INakama,
  userId: string,
  nowMs: number,
): { blockedUntilUtc: number } | null {
  const record = readAbandonRecord(nk, userId);
  if (record === null) return null;
  const block = record.record.blockedUntilUtc;
  if (block === null || block <= nowMs) return null;
  // Lazy GC: if the block has expired since the record was written,
  // null it out under CAS.
  if (block <= nowMs) {
    const next: PersistedAbandonRecord = {
      schemaVersion: ABANDONS_SCHEMA_VERSION,
      entries: filterFreshEntries(record.record.entries, nowMs),
      blockedUntilUtc: null,
    };
    nk.storageWrite([
      {
        collection: ABANDONS_COLLECTION,
        key: userId,
        userId,
        value: next as unknown as Record<string, unknown>,
        permissionRead: 0,
        permissionWrite: 0,
        version: record.version,
      },
    ]);
    return null;
  }
  return { blockedUntilUtc: block };
}

/**
 * Eager helper: trim stale entries and clear an expired
 * `blockedUntilUtc` immediately. Used by tests + admin tools.
 */
export function expireAbandons(
  nk: INakama,
  userId: string,
  nowMs: number,
): { changed: boolean } {
  const record = readAbandonRecord(nk, userId);
  if (record === null) return { changed: false };
  const fresh = filterFreshEntries(record.record.entries, nowMs);
  const block = record.record.blockedUntilUtc;
  const nextBlock = block !== null && block > nowMs ? block : null;
  if (fresh.length === record.record.entries.length && nextBlock === block) {
    return { changed: false };
  }
  const next: PersistedAbandonRecord = {
    schemaVersion: ABANDONS_SCHEMA_VERSION,
    entries: fresh,
    blockedUntilUtc: nextBlock,
  };
  nk.storageWrite([
    {
      collection: ABANDONS_COLLECTION,
      key: userId,
      userId,
      value: next as unknown as Record<string, unknown>,
      permissionRead: 0,
      permissionWrite: 0,
      version: record.version,
    },
  ]);
  return { changed: true };
}

// ─── Storage ─────────────────────────────────────────────────────────────────

interface ReadAbandonResult {
  record: PersistedAbandonRecord;
  version: string;
}

function readAbandonRecord(
  nk: INakama,
  userId: string,
): ReadAbandonResult | null {
  const reads = nk.storageRead([
    { collection: ABANDONS_COLLECTION, key: userId, userId },
  ]);
  const obj = reads[0];
  if (obj === undefined) return null;
  if (obj.version === undefined) {
    throw new Error(`abandon record missing version for ${userId}`);
  }
  return { record: obj.value as PersistedAbandonRecord, version: obj.version };
}