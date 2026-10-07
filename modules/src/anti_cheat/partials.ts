// Phase 8 Chunk 2 — Race partials (sector times) detection + storage.
//
// `race_partials/{raceId}` — system-owned record of a race's sector times,
// keyed by raceId and owned by the system user. Server-only writes so a
// client cannot forge the record AFTER the race closes.
//
// Detection: `validatePartials` checks consecutive `timeMs` deltas against
// the track's `minSectionTimeMs` (from `core/catalog.ts`). A sector faster
// than the per-track floor is impossible without packet manipulation /
// time-warp / replays.

import type { IStorageObject, INakama } from '../nkruntime';
import { MAX_CAS_RETRIES } from './_reset_for_tests';

/** Storage collection for race partials (system-owned). */
export const RACE_PARTIALS_COLLECTION = 'race_partials';

/** Sentinel owner for race partials rows. Server-only writes. */
export const RACE_PARTIALS_SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

/** One sector of a race. `timeMs` is the cumulative race clock at the
 *  checkpoint (sector time = current - previous). */
export interface RacePartial {
  index: number;
  timeMs: number;
}

/** Single-row payload stored at `race_partials/{raceId}`. */
export interface RacePartialsRow {
  schemaVersion: 1;
  raceId: string;
  partials: RacePartial[];
}

export interface ValidatePartialsResult {
  ok: boolean;
  /** Index of the checkpoint that STARTS the impossible sector (the second
   *  member of the bad pair), when `ok=false`. Undefined when `ok=true`. */
  violationAt?: number;
  /** Sector time that fell below the floor. Negative when out of order. */
  deltaTimeMs?: number;
}

/**
 * Pure check: walks consecutive checkpoints and reports the first sector
 * whose `deltaTimeMs < trackMinSectionTimeMs`. Negative or zero deltas
 * (out-of-order or duplicate timestamps) are also violations — they
 * would be impossible without a clock-warp exploit.
 *
 * Returns `{ ok: true }` when the array is empty or has fewer than 2
 * elements (not enough data to evaluate).
 */
export function validatePartials(
  checkpoints: ReadonlyArray<RacePartial>,
  trackMinSectionTimeMs: number,
): ValidatePartialsResult {
  if (!Number.isInteger(trackMinSectionTimeMs) || trackMinSectionTimeMs < 1) {
    return { ok: false };
  }
  for (let i = 1; i < checkpoints.length; i += 1) {
    const prev = checkpoints[i - 1]!;
    const cur = checkpoints[i]!;
    if (
      typeof prev.timeMs !== 'number' ||
      typeof cur.timeMs !== 'number' ||
      !Number.isFinite(prev.timeMs) ||
      !Number.isFinite(cur.timeMs)
    ) {
      return { ok: false, violationAt: cur.index, deltaTimeMs: 0 };
    }
    const delta = cur.timeMs - prev.timeMs;
    if (delta < trackMinSectionTimeMs) {
      return { ok: false, violationAt: cur.index, deltaTimeMs: delta };
    }
  }
  return { ok: true };
}

// ─── Storage ────────────────────────────────────────────────────────────────

interface RacePartialsReadResult {
  record: RacePartialsRow;
  version: string;
}

function readRacePartialsRow(
  nk: INakama,
  raceId: string,
): RacePartialsReadResult | null {
  const objs = nk.storageRead([
    {
      collection: RACE_PARTIALS_COLLECTION,
      key: raceId,
      userId: RACE_PARTIALS_SYSTEM_USER,
    },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<RacePartialsRow>;
  if (
    !v ||
    typeof v !== 'object' ||
    v.schemaVersion !== 1 ||
    typeof v.raceId !== 'string' ||
    !Array.isArray(v.partials)
  ) {
    return null;
  }
  return {
    record: v as RacePartialsRow,
    version: obj.version ?? '',
  };
}

/** Read the partials row for a race. Returns `[]` when absent. */
export function readRacePartials(nk: INakama, raceId: string): RacePartial[] {
  const row = readRacePartialsRow(nk, raceId);
  return row === null ? [] : row.record.partials;
}

/**
 * Write (or overwrite) the partials row for a race. CAS-retry handles
 * concurrent writers (server fan-out + a retried RPC). Server-only
 * `permissionRead` / `permissionWrite` so a client cannot observe or
 * tamper after the race closes.
 */
export function writeRacePartials(
  nk: INakama,
  raceId: string,
  partials: RacePartial[],
): void {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readRacePartialsRow(nk, raceId);
    const next: RacePartialsRow = {
      schemaVersion: 1,
      raceId,
      partials: [...partials],
    };
    const obj: IStorageObject = {
      collection: RACE_PARTIALS_COLLECTION,
      key: raceId,
      userId: RACE_PARTIALS_SYSTEM_USER,
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
        throw new Error('writeRacePartials: CAS retries exhausted');
      }
    }
  }
  throw new Error('writeRacePartials: unreachable');
}