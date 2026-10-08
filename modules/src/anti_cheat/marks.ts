// Phase 8 Chunk 3 — Per-mark CRUD + aggregate helpers.
//
// `anti_cheat_marks/{userId}` — system-owned row (userId encoded in the
// key; owner = system). R=1 / W=0 so the row is hidden from the client
// even though the key references them. `confirmed` / `dismissed` /
// `hiddenUntilUtc` are flipped per-mark by the admin RPCs (Chunk 4).
//
// Aggregate helpers (`severityForMarkCount`, `isHidden`,
// `visibleMarkCount`) are pure — they take the marks list and (for
// isHidden / visibleMarkCount) the current UTC ms. They feed into the
// ranked / club_week / tournament subscribers (Chunks 4-5) via
// `./leaderboard_filter`.

import type { IStorageObject, INakama } from '../nkruntime';
import { MAX_CAS_RETRIES } from './_reset_for_tests';
import type { MarkKind } from './types';

/** Storage collection for per-user marks (system-owned). */
export const ANTI_CHEAT_MARKS_COLLECTION = 'anti_cheat_marks';

/** Sentinel owner for the marks row — server-only writes. */
export const ANTI_CHEAT_MARKS_SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

/** Severity a mark carries. Derived from mark count via
 *  `severityForMarkCount`. */
export type AntiCheatSeverity = 'low' | 'medium' | 'high';

/** Single mark row. */
export interface AntiCheatMark {
  /** UUID assigned at mark creation. */
  id: string;
  userId: string;
  raceId: string;
  kind: MarkKind;
  severity: AntiCheatSeverity;
  /** Epoch-ms when the detection helper flagged it. */
  detectedAt: number;
  /** True once an admin has CONFIRMED the mark via admin_marks_confirm
   *  (Chunk 4). New marks start `false`. */
  confirmed: boolean;
  /** True once an admin has DISMISSED the mark via admin_marks_dismiss
   *  (Chunk 4). Dismissed marks do not contribute to severity or the
   *  visible mark count. */
  dismissed: boolean;
  /** Set / cleared via admin_marks_sanction (Chunk 4). While
   *  `hiddenUntilUtc > nowUtc`, the user is treated as hidden
   *  regardless of their mark count. */
  hiddenUntilUtc?: number;
}

export interface AntiCheatMarksRow {
  schemaVersion: 1;
  userId: string;
  marks: AntiCheatMark[];
}

// ─── Cached thresholds (loaded at boot from `mark_thresholds.json`) ────────

interface MarkThresholds {
  low: number;
  medium: number;
  high: number;
}

/** Defaults match `catalogs/mark_thresholds.json` (1 / 2 / 4). Used
 *  when the catalog hasn't been installed via `setMarkThresholds`. */
const DEFAULT_THRESHOLDS: MarkThresholds = { low: 1, medium: 2, high: 4 };

let CACHED_THRESHOLDS: MarkThresholds | null = null;

/**
 * Install the thresholds resolved from `mark_thresholds.json`. Called
 * once at boot by the catalog loader. Idempotent. Tests can use the
 * override to inject custom thresholds.
 */
export function setMarkThresholds(thresholds: MarkThresholds): void {
  if (thresholds.low >= thresholds.medium || thresholds.medium >= thresholds.high) {
    throw new Error('mark thresholds must be strictly increasing low<medium<high');
  }
  CACHED_THRESHOLDS = { ...thresholds };
}

function getThresholds(): MarkThresholds {
  return CACHED_THRESHOLDS ?? DEFAULT_THRESHOLDS;
}

/** Test hook: clears the cached thresholds. */
export function _resetMarksStateForTests(): void {
  CACHED_THRESHOLDS = null;
}

// ─── Pure aggregate helpers ────────────────────────────────────────────────

/**
 * Map a mark count to a severity using the cached catalog thresholds
 * (1 = low, 2-3 = medium, 4+ = high). 0 marks maps to `low` — callers
 * that want "no severity" should check `visibleMarkCount === 0`
 * upstream; this helper never returns `null`.
 */
export function severityForMarkCount(count: number): AntiCheatSeverity {
  if (!Number.isInteger(count) || count < 0) return 'low';
  const t = getThresholds();
  if (count >= t.high) return 'high';
  if (count >= t.medium) return 'medium';
  return 'low';
}

/**
 * True when the user is currently hidden — either:
 *   - any non-dismissed mark has `hiddenUntilUtc > nowUtc`, OR
 *   - any non-dismissed mark has severity 'high'.
 */
export function isHidden(marks: ReadonlyArray<AntiCheatMark>, nowUtc: number): boolean {
  let hasHigh = false;
  for (const m of marks) {
    if (m.dismissed) continue;
    if (m.severity === 'high') hasHigh = true;
    if (typeof m.hiddenUntilUtc === 'number' && m.hiddenUntilUtc > nowUtc) return true;
  }
  return hasHigh;
}

/**
 * Count of marks that are NOT dismissed AND NOT hidden. Used by the
 * admin RPCs (Chunk 4) and the leaderboard_filter (this chunk).
 */
export function visibleMarkCount(
  marks: ReadonlyArray<AntiCheatMark>,
  nowUtc: number,
): number {
  let count = 0;
  for (const m of marks) {
    if (m.dismissed) continue;
    if (typeof m.hiddenUntilUtc === 'number' && m.hiddenUntilUtc > nowUtc) continue;
    count += 1;
  }
  return count;
}

// ─── Storage ────────────────────────────────────────────────────────────────

interface MarksReadResult {
  record: AntiCheatMarksRow;
  version: string;
}

function readMarksRow(
  nk: INakama,
  userId: string,
): MarksReadResult | null {
  const objs = nk.storageRead([
    {
      collection: ANTI_CHEAT_MARKS_COLLECTION,
      key: userId,
      userId: ANTI_CHEAT_MARKS_SYSTEM_USER,
    },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<AntiCheatMarksRow>;
  if (
    !v ||
    typeof v !== 'object' ||
    v.schemaVersion !== 1 ||
    typeof v.userId !== 'string' ||
    !Array.isArray(v.marks)
  ) {
    return null;
  }
  return {
    record: v as AntiCheatMarksRow,
    version: obj.version ?? '',
  };
}

/** Read the marks row for a user. Returns `[]` when absent. */
export function readMarks(nk: INakama, userId: string): AntiCheatMark[] {
  const row = readMarksRow(nk, userId);
  return row === null ? [] : row.record.marks;
}

/**
 * Append a mark to the user's row. No cap — callers are expected to
 * `pruneHistory` (Chunk 4 admin RPC) periodically. CAS-retry handles
 * races against concurrent writers.
 */
export function appendMark(
  nk: INakama,
  userId: string,
  mark: AntiCheatMark,
): void {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readMarksRow(nk, userId);
    const prev = existing?.record.marks ?? [];
    const next: AntiCheatMarksRow = {
      schemaVersion: 1,
      userId,
      marks: [...prev, mark],
    };
    const obj: IStorageObject = {
      collection: ANTI_CHEAT_MARKS_COLLECTION,
      key: userId,
      userId: ANTI_CHEAT_MARKS_SYSTEM_USER,
      value: next as unknown as Record<string, unknown>,
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
        throw new Error('appendMark: CAS retries exhausted');
      }
    }
  }
  throw new Error('appendMark: unreachable');
}

/** Find the index of a mark by ID within a row. Returns -1 when absent. */
function findMarkIndex(
  marks: ReadonlyArray<AntiCheatMark>,
  markId: string,
): number {
  for (let i = 0; i < marks.length; i += 1) {
    if (marks[i]!.id === markId) return i;
  }
  return -1;
}

function mutateMark(
  nk: INakama,
  userId: string,
  markId: string,
  mutator: (m: AntiCheatMark) => AntiCheatMark,
  errTag: string,
): void {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readMarksRow(nk, userId);
    if (existing === null) throw new Error(`${errTag}: row missing`);
    const idx = findMarkIndex(existing.record.marks, markId);
    if (idx === -1) throw new Error(`${errTag}: mark not found`);
    const prevMarks = existing.record.marks;
    const nextMarks = [...prevMarks];
    nextMarks[idx] = mutator(prevMarks[idx]!);
    const next: AntiCheatMarksRow = {
      schemaVersion: 1,
      userId,
      marks: nextMarks,
    };
    const obj: IStorageObject = {
      collection: ANTI_CHEAT_MARKS_COLLECTION,
      key: userId,
      userId: ANTI_CHEAT_MARKS_SYSTEM_USER,
      value: next as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 0,
      version: existing.version,
    };
    try {
      nk.storageWrite([obj]);
      return;
    } catch {
      if (attempt === MAX_CAS_RETRIES - 1) {
        throw new Error(`${errTag}: CAS retries exhausted`);
      }
    }
  }
  throw new Error(`${errTag}: unreachable`);
}

/** Mark a single mark CONFIRMED. Throws when the row or mark is missing. */
export function confirmMark(nk: INakama, userId: string, markId: string): void {
  mutateMark(
    nk,
    userId,
    markId,
    (m) => ({ ...m, confirmed: true }),
    'confirmMark',
  );
}

/** Mark a single mark DISMISSED. Throws when the row or mark is missing. */
export function dismissMark(nk: INakama, userId: string, markId: string): void {
  mutateMark(
    nk,
    userId,
    markId,
    (m) => ({ ...m, dismissed: true }),
    'dismissMark',
  );
}

/**
 * Set `hiddenUntilUtc` on a single mark. While `hiddenUntilUtc > nowUtc`,
 * `isHidden(marks, now)` returns true (Chunk 4 wires the leaderboard filter).
 */
export function setHiddenUntilUtc(
  nk: INakama,
  userId: string,
  markId: string,
  untilUtc: number,
): void {
  mutateMark(
    nk,
    userId,
    markId,
    (m) => ({ ...m, hiddenUntilUtc: untilUtc }),
    'setHiddenUntilUtc',
  );
}

/** Clear `hiddenUntilUtc` from a single mark (admin unsanction). */
export function clearHiddenUntilUtc(
  nk: INakama,
  userId: string,
  markId: string,
): void {
  mutateMark(
    nk,
    userId,
    markId,
    (m) => {
      const next: AntiCheatMark = { ...m };
      delete next.hiddenUntilUtc;
      return next;
    },
    'clearHiddenUntilUtc',
  );
}