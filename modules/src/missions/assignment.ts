// Phase 6 — assignment algorithm (D1-D5).
//
// Deterministic per (userId, dateUtc) selection of N missions from
// the catalog. Driven by `sha256(userId + ':' + dateUtc + ':' + SALT)`,
// so two players see different assignments on the same day but each
// player sees the same assignment across server restarts.
//
// D1 — 3 daily missions assigned/day.
// D2 — 3 weekly missions assigned/week (weekUtc resets Monday 00:00 UTC).
// D5 — unlockLevel gate: locked missions are returned with
//      `locked: true` so the client can still render a "locked" card.

import type { ILogger, INakama } from '../nkruntime';
import type {
  DailyMissions,
  MissionDefinition,
  MissionInstance,
} from './types';

/** Compile-time constant — bundled into the binary, never random per boot. */
export const ASSIGNMENT_SALT = 'cv-missions-assignment-v1';

/** Number of daily missions per player per day. D1 = 3. */
export const DAILY_MISSION_COUNT = 3;
/** Number of weekly missions per player per week. D2 = 3. */
export const WEEKLY_MISSION_COUNT = 3;

/** Build 3 MissionInstance records with progress=0, completed=false, claimed=false. */
export function buildMissionInstances(
  definitions: ReadonlyArray<MissionDefinition>,
  dateOrWeekUtc: string,
): MissionInstance[] {
  const out: MissionInstance[] = [];
  for (const def of definitions) {
    const prefix = def.id.includes('daily_') ? 'daily' : 'weekly';
    const instanceId = `${prefix}:${def.id}@${dateOrWeekUtc}`;
    out.push({
      instanceId,
      missionId: def.id,
      progress: 0,
      completed: false,
      claimed: false,
    });
  }
  return out;
}

/**
 * Returns true when the daily record has at least one free reroll left.
 */
export function shouldRerollFree(dailyRecord: DailyMissions): boolean {
  return dailyRecord.rerollsLeftToday > 0;
}

/**
 * Throws CATALOG_INVALID when the catalog has fewer entries than
 * `count`. Called from boot-time catalog loaders and at the head of
 * the assignment helpers.
 */
export function assertCatalogHasEnoughEntries(
  catalog: ReadonlyArray<MissionDefinition>,
  count: number,
  label: string,
): void {
  if (catalog.length < count) {
    throw new Error(
      `mission catalog invalid: ${label} has ${catalog.length} entries, need at least ${count}`,
    );
  }
}

/**
 * Returns the subset of definitions the player CANNOT see (still
 * returned by missions_get with `locked: true`). Used to surface the
 * locked card without hiding the mission entirely.
 */
export function findLockedMissions(
  definitions: ReadonlyArray<MissionDefinition>,
  playerLevel: number,
): MissionDefinition[] {
  const out: MissionDefinition[] = [];
  for (const d of definitions) {
    if (d.unlockLevel > playerLevel) out.push(d);
  }
  return out;
}

// ─── Deterministic selection ─────────────────────────────────────────────────

/**
 * sha256 of the input via `nk.sha256Hash`. Nakama returns lowercase
 * hex without an `0x` prefix (verified via existing tests).
 *
 * NOTE: This helper REQUIRES a valid `nk`. There is no built-in
 * fallback because the goja runtime ships no SHA-256 primitive. Tests
 * pass a fake `nk` with a stubbed `sha256Hash`.
 */
export function sha256Hex(input: string, nk: INakama): string {
  if (nk === undefined || nk === null) {
    throw new Error('assignment: sha256Hex needs a valid INakama (no Node fallback in production)');
  }
  if (typeof nk.sha256Hash !== 'function') {
    throw new Error('assignment: nk.sha256Hash is not available');
  }
  return nk.sha256Hash(input).replace(/^0x/, '').toLowerCase();
}

/** Convert the first 8 hex chars into an integer index modulo `max`. */
export function hexToIndex(hex: string, max: number): number {
  const head = hex.slice(0, 8);
  const n = parseInt(head, 16);
  return Number.isFinite(n) ? Math.abs(n) % max : 0;
}

/**
 * Pick N missions deterministically. Walks N consecutive entries
 * (wrapping with modulo) from the seed-derived start index. Duplicates
 * are skipped (start advances until we have N distinct missions).
 */
function pickN(
  catalog: ReadonlyArray<MissionDefinition>,
  seed: string,
  count: number,
): MissionDefinition[] {
  const startIdx = hexToIndex(seed, catalog.length);
  const out: MissionDefinition[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < catalog.length && out.length < count; i++) {
    const idx = (startIdx + i) % catalog.length;
    const candidate = catalog[idx];
    if (candidate === undefined) continue;
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
  }
  return out;
}

/**
 * Returns the daily mission assignment for the user on the given
 * UTC date. Deterministic — same (userId, dateUtc) always yields the
 * same 3 missions.
 */
export function dailyAssignmentsFor(
  userId: string,
  dateUtc: string,
  dailyCatalog: ReadonlyArray<MissionDefinition>,
  nk: INakama,
): MissionDefinition[] {
  assertCatalogHasEnoughEntries(dailyCatalog, DAILY_MISSION_COUNT, 'missions_daily');
  const seed = sha256Hex(`${userId}:daily:${dateUtc}:${ASSIGNMENT_SALT}`, nk);
  return pickN(dailyCatalog, seed, DAILY_MISSION_COUNT);
}

/**
 * Returns the weekly mission assignment for the user on the given
 * UTC week key (e.g. '2026-W02'). Deterministic.
 */
export function weeklyAssignmentsFor(
  userId: string,
  weekUtc: string,
  weeklyCatalog: ReadonlyArray<MissionDefinition>,
  nk: INakama,
): MissionDefinition[] {
  assertCatalogHasEnoughEntries(weeklyCatalog, WEEKLY_MISSION_COUNT, 'missions_weekly');
  const seed = sha256Hex(`${userId}:weekly:${weekUtc}:${ASSIGNMENT_SALT}`, nk);
  return pickN(weeklyCatalog, seed, WEEKLY_MISSION_COUNT);
}

/**
 * Reroll: pick a replacement mission NOT in `excludeIds`. Falls back
 * to a different seed by mixing in the reroll counter so the result
 * changes each time without exhausting distinctness.
 */
export function rerollSingleMission(
  userId: string,
  dateUtc: string,
  catalog: ReadonlyArray<MissionDefinition>,
  excludeIds: ReadonlySet<string>,
  rerollIndex: number,
  nk: INakama,
): MissionDefinition | null {
  if (catalog.length <= excludeIds.size) return null;
  const seed = sha256Hex(
    `${userId}:daily:${dateUtc}:${ASSIGNMENT_SALT}:r${rerollIndex}`,
    nk,
  );
  const startIdx = hexToIndex(seed, catalog.length);
  for (let i = 0; i < catalog.length; i++) {
    const idx = (startIdx + i) % catalog.length;
    const candidate = catalog[idx];
    if (candidate === undefined) continue;
    if (excludeIds.has(candidate.id)) continue;
    return candidate;
  }
  return null;
}

// ─── Node fallback (test-only) ───────────────────────────────────────────────
// (Removed — goja has no built-in SHA-256. Tests inject a fake `nk`.)