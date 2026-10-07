// Phase 8 Chunk 2 — Quorum disagreement detection + rolling 7d window.
//
// `quorum_marks/{userId}` — owner-scoped, server-only writes. One row
// per user with `{marks: [{ts, kind}]}` entries. Pruned lazily by
// `pruneHistory` (Chunk 4 admin RPC).
//
// Detection: 5 distinct `quorum_disagreement` marks within a rolling
// 7-day window = violation. The window is computed from `nowUtc - 7d`
// against each mark's `ts` — entries older than the cutoff are ignored
// even if the row hasn't been pruned yet (lazy GC).

import type { IStorageObject, INakama } from '../nkruntime';
import { MAX_CAS_RETRIES } from './_reset_for_tests';

/** Storage collection for per-user quorum marks. */
export const QUORUM_MARKS_COLLECTION = 'quorum_marks';

/** Mark kinds this collection can hold (only `quorum_disagreement`
 *  today; reserved for future quorum helpers without a migration). */
export type QuorumMarkKind = 'quorum_disagreement';

export interface QuorumMark {
  ts: number;
  kind: QuorumMarkKind;
}

export interface QuorumMarksRow {
  schemaVersion: 1;
  userId: string;
  marks: QuorumMark[];
}

/** Rolling window length, in days. */
export const QUORUM_WINDOW_DAYS = 7;
/** Number of marks inside the window that triggers a violation. */
export const QUORUM_THRESHOLD = 5;

export interface QuorumDisagreementResult {
  ok: boolean;
  /** Number of marks inside the rolling window. Populated on `ok=false`. */
  count?: number;
  /** Window cutoff (epoch-ms) the detector computed. */
  windowStartUtc?: number;
}

/**
 * Pure detection: count `quorum_disagreement` marks with `ts` in the
 * last `QUORUM_WINDOW_DAYS` days, computed against `nowUtc`. Returns
 * `{ ok: false, count }` when the count reaches `QUORUM_THRESHOLD`.
 */
export function detectQuorumDisagreement(
  recentMarks: ReadonlyArray<QuorumMark>,
  nowUtc: number,
): QuorumDisagreementResult {
  const windowMs = QUORUM_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowStartUtc = nowUtc - windowMs;
  let count = 0;
  for (const m of recentMarks) {
    if (m.kind !== 'quorum_disagreement') continue;
    if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) continue;
    if (m.ts >= windowStartUtc && m.ts <= nowUtc) count += 1;
  }
  if (count >= QUORUM_THRESHOLD) {
    return { ok: false, count, windowStartUtc };
  }
  return { ok: true, windowStartUtc };
}

// ─── Storage ────────────────────────────────────────────────────────────────

interface QuorumMarksReadResult {
  record: QuorumMarksRow;
  version: string;
}

function readQuorumMarksRow(
  nk: INakama,
  userId: string,
): QuorumMarksReadResult | null {
  const objs = nk.storageRead([
    { collection: QUORUM_MARKS_COLLECTION, key: userId, userId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<QuorumMarksRow>;
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
    record: v as QuorumMarksRow,
    version: obj.version ?? '',
  };
}

/** Read the user's quorum marks row. Returns `[]` when absent. */
export function readRecentQuorumMarks(
  nk: INakama,
  userId: string,
): QuorumMark[] {
  const row = readQuorumMarksRow(nk, userId);
  return row === null ? [] : row.record.marks;
}

/**
 * Append a mark to the user's row. No per-row cap here — pruning is
 * the caller's responsibility (`pruneHistory` in `./history.ts`).
 * CAS-retry handles races against concurrent writers.
 */
export function appendQuorumMark(
  nk: INakama,
  userId: string,
  mark: QuorumMark,
): void {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readQuorumMarksRow(nk, userId);
    const prev = existing?.record.marks ?? [];
    const next = [...prev, mark];
    const row: QuorumMarksRow = {
      schemaVersion: 1,
      userId,
      marks: next,
    };
    const obj: IStorageObject = {
      collection: QUORUM_MARKS_COLLECTION,
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
        throw new Error('appendQuorumMark: CAS retries exhausted');
      }
    }
  }
  throw new Error('appendQuorumMark: unreachable');
}