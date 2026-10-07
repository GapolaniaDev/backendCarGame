// Phase 6 Chunk 6 — pass season helpers + lazy close.
//
// The pass has its OWN season metadata (independent from `ranked`
// seasons — a server op may run a "Season 1 of the ranked ladder" for
// 28 days but extend the battle pass to a longer window). The pass
// season comes from the catalog (`pass_s1.json`); the lazy close is
// driven by `pass_get` access post-`endUtc`.
//
// D11 — season close trigger = **Lazy on pass_get / ranked_get
// post-endUtc**. The `ranked_get` close is already handled by
// `modules/src/ranked/season.ts`; this module covers the pass side.
//
// Storage layout:
//   - `season_close/{passSeasonId}` (server-owned) — close marker so
//     a re-entry is idempotent.
//   - PassRecord already carries `seasonClosed: boolean` (the per-user
//     view); the `season_close` collection is the GLOBAL close marker so
//     any player reading the pass learns the season is over without
//     needing to write per-user rows.

import type { IStorageObject, ILogger, INakama } from '../nkruntime';
import { SYSTEM_USER_ID } from '../race/constants';
import { getPassCatalog } from './catalog';
import { readPassRecord, writePassUpdate } from './pass_repo';

/** Server-owned permission bits (Phase 4/5 convention). */
export const SERVER_OWNED_READ = 1;
export const SERVER_OWNED_WRITE = 1;

export const SEASON_CLOSE_COLLECTION = 'season_close';

export function seasonCloseKey(passSeasonId: string): string {
  return passSeasonId;
}

export interface PassSeasonCloseOutcome {
  /** True iff this call performed the close. False = no-op (already closed / still active). */
  closed: boolean;
  passSeasonId: string;
  /** ISO UTC string of the end boundary. */
  endUtc: string;
}

/**
 * Return the current pass seasonId (from the loaded catalog). Throws
 * if the catalog has not been loaded yet (boot-order issue).
 */
export function getCurrentSeasonId(): string {
  return getPassCatalog().seasonId;
}

/**
 * Return `true` if `nowMs` is past the loaded catalog's `endUtc`.
 */
export function isSeasonExpired(nowMs: number): boolean {
  const cat = getPassCatalog();
  return Date.parse(cat.endUtc) <= nowMs;
}

/**
 * Read the global close marker for `passSeasonId`. Returns `null`
 * when absent. The marker is a tiny `{schemaVersion:1, closedAt:number}`
 * payload — its existence is the signal.
 */
export function readSeasonCloseMarker(
  nk: INakama,
  passSeasonId: string,
): { schemaVersion: 1; closedAt: number } | null {
  const objs = nk.storageRead([{
    collection: SEASON_CLOSE_COLLECTION,
    key: seasonCloseKey(passSeasonId),
    userId: SYSTEM_USER_ID,
  }]);
  const obj = objs[0];
  if (!obj) return null;
  const value = obj.value as { schemaVersion?: number; closedAt?: number } | null;
  if (!value || value.schemaVersion !== 1 || typeof value.closedAt !== 'number') {
    return null;
  }
  return { schemaVersion: 1, closedAt: value.closedAt };
}

/**
 * Idempotent lazy close. Idempotency comes from the global
 * `season_close/{seasonId}` marker — only the first caller wins, every
 * subsequent caller reads the marker and short-circuits. This is the
 * pass-side analog of `ranked/season.ts::lazyCloseSeason`.
 *
 * Pass season close has NO reward grants — battle pass rewards are
 * already claimed per-level by individual players via `pass_claim`,
 * which returns CONFLICT once `passGet` reports `seasonClosed: true`.
 * (The spec did not call for end-of-season inbox dumps; players pick
 * up their track by level as they go.)
 *
 * On the FIRST close:
 *   - Writes `season_close/{seasonId}` (server-owned).
 *   - Logs at info level.
 *
 * On every call (closed or already-closed):
 *   - Returns `{ closed: false, passSeasonId, endUtc }`.
 *
 * The RPC layer then flips every player's `PassRecord.seasonClosed`
 * flag on next `pass_get` so the UI knows the season is over.
 */
export function maybeCloseSeason(
  nk: INakama,
  logger: ILogger,
  nowMs: number,
  passSeasonId: string,
): PassSeasonCloseOutcome {
  const cat = getPassCatalog();
  const endUtc = cat.endUtc;

  if (Date.parse(endUtc) > nowMs) {
    return { closed: false, passSeasonId, endUtc };
  }

  // Already closed → no-op.
  const existing = readSeasonCloseMarker(nk, passSeasonId);
  if (existing !== null) {
    return { closed: false, passSeasonId, endUtc };
  }

  // First close — server-owned marker.
  const obj: IStorageObject = {
    collection: SEASON_CLOSE_COLLECTION,
    key: seasonCloseKey(passSeasonId),
    userId: SYSTEM_USER_ID,
    value: { schemaVersion: 1, closedAt: nowMs },
    permissionRead: SERVER_OWNED_READ,
    permissionWrite: SERVER_OWNED_WRITE,
  };
  try {
    nk.storageWrite([obj]);
    logger.info(
      'pass season closed: seasonId=%s endUtc=%s closedAtMs=%s',
      passSeasonId, endUtc, String(nowMs),
    );
    return { closed: true, passSeasonId, endUtc };
  } catch (e) {
    logger.warn(
      'pass season close storage write failed: seasonId=%s: %s',
      passSeasonId,
      e instanceof Error ? e.message : String(e),
    );
    return { closed: false, passSeasonId, endUtc };
  }
}

/**
 * Settle the per-user PassRecord flag for a player whose `pass_get`
 * observed the season just rolled. Reads `pass/{userId}`, sets
 * `seasonClosed = true` via CAS, writes back. No-op when the player
 * has no PassRecord yet (lazy-create on next `pass_get`).
 *
 * The CAS retry budget mirrors Phase 6 Chunk 3's claim path (3 tries).
 */
export const SETTLE_FLAG_MAX_CAS_RETRIES = 3;

export function settleClosedSeasonRewards(
  nk: INakama,
  logger: ILogger,
  userId: string,
  passSeasonId: string,
): void {
  for (let attempt = 0; attempt < SETTLE_FLAG_MAX_CAS_RETRIES; attempt += 1) {
    const existing = readPassRecord(nk, userId, passSeasonId);
    if (existing === null) return; // no row yet → lazy-create will set it
    if (existing.record.seasonClosed) return;
    const next = { ...existing.record, seasonClosed: true };
    try {
      writePassUpdate(nk, next, existing.version);
      logger.info(
        'pass season closed (per-user settle) user=%s seasonId=%s attempt=%d',
        userId, passSeasonId, attempt + 1,
      );
      return;
    } catch (e) {
      logger.warn(
        'pass settle CAS conflict user=%s seasonId=%s attempt=%d: %s',
        userId, passSeasonId, attempt + 1,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}