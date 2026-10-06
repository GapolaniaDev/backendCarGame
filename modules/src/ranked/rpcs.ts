// Phase 4 `ranked_get` RPC (Chunk 6).
//
// Returns the public ranked summary for `targetUserId` (defaults to
// the caller). Always permits other-user reads — D11 marks ranked
// data as public. No FORBIDDEN cross-user path exists.
//
// Wire contract (matches `RankedGetOutput` in `ranked/types.ts`):
//   input:  { userId?: string, callerUserId: string }
//   output: { userId, seasonId, rating, peak, division,
//             divisionProgress, racesPlayed, wins, topThree,
//             recentAbandons, rank, daysLeftInSeason }
//
// Flow:
//   1. Resolve caller (socket → payload, fail on mismatch).
//   2. Determine targetUserId (payload.userId ?? caller).
//   3. findActiveSeason(catalog, now). If missing → return NOT_FOUND.
//   4. Lazy-close check on the active season (idempotent — skip when
//      still active, close+rewards+create-next when expired).
//   5. Refetch the active season (now the new one if it just rolled).
//   6. Read or migrate the target's RankedRecord for `seasonId`.
//   7. Migrate an old-season record into the new season (rating
//      carries over, racesPlayed resets).
//   8. Compute division via `divisionForRating`, divisionProgress
//      inside the band, daysLeftInSeason.
//   9. Lookup rank via `leaderboardRecordsList` filtered to the target.
//   10. Return the wire output.

import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import type { IContext, ILogger, INakama } from '../nkruntime';
import { RATE_LIMITS } from './constants';
import {
  findActiveSeason,
  getSeasonsCatalog,
  type Season,
} from './seasons';
import { getRankedConfig, type RankedConfig } from './config';
import { divisionForRating } from './division';
import {
  createRankedRecord,
  readRankedRecord,
  readSeasonMeta,
  updateRankedRecord,
} from './ranked_repo';
import {
  daysLeftInSeason,
  lazyCloseSeason,
} from './season';
import type { RankedGetInput, RankedGetOutput, RankedRecord } from './types';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

export const ranked_get_impl: RpcHandler = (ctx, logger, nk, body) => {
  // Parse.
  let payload: Partial<RankedGetInput>;
  try {
    payload = JSON.parse(body) as Partial<RankedGetInput>;
  } catch {
    return toJson(err('BAD_REQUEST', 'payload is not valid JSON'));
  }

  // Resolve caller.
  const socketCaller = ctx.userId ?? null;
  const declaredCaller = typeof payload.callerUserId === 'string' ? payload.callerUserId : null;
  let callerId: string | null;
  if (socketCaller !== null) {
    if (declaredCaller !== null && declaredCaller !== socketCaller) {
      return toJson(err('FORBIDDEN', 'callerUserId does not match authenticated user'));
    }
    callerId = socketCaller;
  } else if (declaredCaller !== null) {
    callerId = declaredCaller;
  } else {
    return toJson(err('UNAUTHENTICATED', 'no caller identity'));
  }

  // Rate limit per caller (30/60s — generous because ranked_get is
  // called on every UI render of the badge).
  const rl = checkRateLimit(nk, {
    rpcName: 'ranked_get',
    userId: callerId,
    maxPerWindow: RATE_LIMITS.ranked_get.maxPerWindow,
    windowSec: RATE_LIMITS.ranked_get.windowSec,
  });
  if (!rl.allowed) {
    return toJson(err('RATE_LIMITED', `ranked_get rate limit exceeded (${rl.count}/${rl.limit})`));
  }

  // Determine the target. D11: `userId` always allowed.
  const targetUserId =
    typeof payload.userId === 'string' && payload.userId.length > 0 ? payload.userId : callerId;
  if (targetUserId === null) {
    return toJson(err('UNAUTHENTICATED', 'no target user resolved'));
  }

  const now = Date.now();
  const seasons = getSeasonsCatalog();
  const cfg = getRankedConfig();

  let active: Season | null = findActiveSeason(seasons, now);
  if (active === null) {
    return toJson(err('NOT_FOUND', 'no active ranked season'));
  }

  // Lazy-close check. The helper is idempotent — when the season is
  // still active it returns `closed: false` and we continue; when
  // expired it ships rewards + spins up a new season and returns the
  // new season id. The bundled catalog stays static across the
  // close (it documents the season's declared start/end); the meta
  // is what flips to `closed` and drives the migration.
  const closeOutcome = lazyCloseSeason(nk, now, active.id);
  let activeId: string = active.id;
  if (closeOutcome.closed && closeOutcome.nextSeasonId !== null) {
    const nextId = closeOutcome.nextSeasonId;
    // Re-resolve from the catalog first (the bundled seasons.json is
    // the source of truth for known ids). If the lazy close just
    // minted a new id that the catalog doesn't know about, fall
    // back to the meta we just wrote.
    const fromCatalog = findActiveSeason(seasons, now);
    if (fromCatalog !== null && fromCatalog.id === nextId) {
      active = fromCatalog;
    } else {
      const meta = readSeasonMeta(nk, nextId);
      if (meta === null) {
        return toJson(err('NOT_FOUND', `lazy-close did not register next season ${nextId}`));
      }
      active = syntheticSeason(meta.meta);
    }
    activeId = nextId;
    logger.info(
      'ranked_get lazy-closed season=%s next=%s rewards=%d',
      closeOutcome.seasonId ?? '?',
      nextId,
      closeOutcome.rewards.length,
    );
  }

  // Read or migrate the target's record.
  const { record } = ensureCurrentRecord(nk, targetUserId, activeId, cfg.initialRating, now);

  // Compute output fields.
  const division = divisionForRating(cfg, record.rating);
  const divisionProgress = divisionProgressFor(cfg, record.rating, division);
  const daysLeft = daysLeftInSeason(active.endsAt, now);
  const rank = lookupRank(nk, activeId, targetUserId);

  const out: RankedGetOutput = {
    userId: record.userId,
    seasonId: activeId,
    rating: record.rating,
    peak: record.peak,
    division,
    divisionProgress,
    racesPlayed: record.racesPlayed,
    wins: record.wins,
    topThree: record.topThree,
    recentAbandons: record.recentAbandons,
    rank,
    daysLeftInSeason: daysLeft,
  };
  logger.info(
    'ranked_get target=%s season=%s rating=%d division=%s rank=%s daysLeft=%d',
    out.userId,
    out.seasonId,
    out.rating,
    out.division,
    out.rank === null ? 'n/a' : String(out.rank),
    out.daysLeftInSeason,
  );
  return toJson(ok(out));
};

// Top-level binding so the goja AST scanner can find the RPC.
export const ranked_get: RpcHandler = ranked_get_impl;

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ReadOrMigrateResult {
  record: RankedRecord;
  version: string;
}

/**
 * Returns the target's record for `seasonId`, creating it on first
 * read. If an older record exists for a different season, the rating
 * carries over and the per-season counters reset.
 */
function ensureCurrentRecord(
  nk: INakama,
  userId: string,
  seasonId: string,
  initialRating: number,
  nowMs: number,
): ReadOrMigrateResult {
  const cfg = getRankedConfig();
  const existing = readRankedRecord(nk, userId);
  if (existing === null) {
    const created: RankedRecord = defaultRecord(userId, seasonId, cfg, initialRating, nowMs);
    const r = createRankedRecord(nk, created);
    return { record: created, version: r.version };
  }
  if (existing.record.seasonId === seasonId) {
    return existing;
  }
  // Migrate: carry rating+peak, reset per-season counters, update
  // seasonId. Use CAS on the existing version.
  const carried: RankedRecord = {
    ...existing.record,
    schemaVersion: 1,
    seasonId,
    racesPlayed: 0,
    wins: 0,
    topThree: 0,
    divisionId: divisionForRating(cfg, existing.record.rating),
    lastRatedAt: existing.record.lastRatedAt,
  };
  const r = updateRankedRecord(nk, carried, existing.version);
  return { record: carried, version: r.version };
}

function defaultRecord(
  userId: string,
  seasonId: string,
  cfg: RankedConfig,
  initialRating: number,
  nowMs: number,
): RankedRecord {
  return {
    schemaVersion: 1,
    userId,
    seasonId,
    rating: initialRating,
    peak: initialRating,
    racesPlayed: 0,
    wins: 0,
    topThree: 0,
    recentAbandons: 0,
    lastRatedAt: nowMs,
    divisionId: divisionForRating(cfg, initialRating),
  };
}

/**
 * 0.0 at the top of `divisionId`, 1.0 at the bottom. Returns 0 when
 * `rating` is not in any band (only happens when divisions list is
 * empty, which the validator prevents).
 */
function divisionProgressFor(
  cfg: RankedConfig,
  rating: number,
  divisionId: string,
): number {
  const div = cfg.divisions.find((d) => d.id === divisionId);
  if (div === undefined) return 0;
  if (rating <= div.minRating) return 0;
  const span = div.maxRating - div.minRating;
  if (span <= 0) return 0;
  const into = rating - div.minRating;
  const progress = into / span;
  return Math.max(0, Math.min(1, progress));
}

/**
 * Build a synthetic `Season` from a `SeasonMeta` when the bundled
 * catalog doesn't yet know about a lazy-close-created season. Only
 * the lazy-close output crosses this path; the bundled catalog stays
 * authoritative for everything else.
 */
function syntheticSeason(meta: { seasonId: string; startedAt: number; endsAt: number }): Season {
  return {
    id: meta.seasonId,
    displayName: meta.seasonId,
    startsAt: meta.startedAt,
    endsAt: meta.endsAt,
    divisions: [],
  };
}

/**
 * Look up the target's global rank in the season's leaderboard. The
 * stub returns `null` for owners that haven't been written; the
 * production `leaderboardRecordsList` with a single ownerId returns
 * the entry (or nothing) plus the owner's rank when a fresh ordered
 * list is also available. To keep the stub simple we list up to 10k
 * records and search.
 */
function lookupRank(nk: INakama, seasonId: string, userId: string): number | null {
  const lb = nk.leaderboardRecordsList(`ranked_${seasonId}`, [], 10_000);
  // Stub returns records sorted by score ascending. Production rank
  // would come from `leaderboardRecordsList`'s envelope's `rank`
  // field; the stub doesn't populate that.
  const sorted = lb.records.slice().sort((a, b) => a.score - b.score);
  const idx = sorted.findIndex((r) => r.ownerId === userId);
  return idx === -1 ? null : idx + 1;
}