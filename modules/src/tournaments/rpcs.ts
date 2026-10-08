// Phase 8 Chunk 5 — Tournament RPCs.
//
// Three RPCs registered on the goja bundle:
//
//   - tournament_list    → returns instances within the 7d window,
//                          filtered by kind + status. Calls
//                          `ensureTournamentsForWindow` so callers see
//                          freshly-materialised instances without a
//                          cron.
//   - tournament_get     → single instance + the caller's entry (if
//                          joined) + the top 10 times from
//                          `tournament_leaderboard/{id}` (Chunk 6
//                          populates the leaderboard; this returns []
//                          when absent).
//   - tournament_join    → level + state + funds checks, deducts
//                          `entryFee` from the wallet (idempotency
//                          key `tournament_join:{tid}:{uid}`), creates
//                          the entry row.
//
// All three are blocked during maintenance via `assertNotInMaintenance`.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { serverNowMs } from '../core/time';
import { assertNotInMaintenance } from '../core/liveops';
import { readProfile } from '../profiles/storage';
import { spend, walletGet } from '../economy/wallet';
import { emit } from '../core/admin/analytics';
import {
  ensureTournamentsForWindow,
  tournamentState,
  type TournamentState,
} from './catalog';
import {
  readTournamentInstance,
  readEntry,
  createEntry,
  countParticipants,
} from './repo';
import type {
  Tournament,
  TournamentType,
  TournamentEntry,
} from './types';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

const ERR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
  'RATE_LIMITED', 'INVALID_RESULT', 'INTERNAL', 'CATALOG_INVALID',
  'INSUFFICIENT_FUNDS', 'SERVICE_UNAVAILABLE', 'UPGRADE_REQUIRED',
  'NOT_IMPLEMENTED',
]);
function asCode(code: string | undefined): ErrorCode {
  if (code !== undefined && (ERR_CODES as Set<string>).has(code)) return code as ErrorCode;
  return 'INTERNAL';
}

function tournamentNotFound(id: string): string {
  return JSON.stringify(err('NOT_FOUND', `tournament "${id}" not found`));
}

/**
 * Resolve the caller's effective level. Reads `profiles/{userId}` and
 * returns `progression.level` (defaults to 1 when the row is missing
 * or progression is absent). The level check in `tournament_join`
 * uses this — a brand new account is treated as level 1.
 */
function callerLevel(nk: INakama, userId: string): number {
  const p = readProfile(nk, userId);
  if (!p) return 1;
  return typeof p.progression?.level === 'number' ? p.progression.level : 1;
}

// ─── List view shape ──────────────────────────────────────────────────────

export interface TournamentListEntry {
  id: string;
  kind: TournamentType;
  trackId: string;
  startsAtUtc: number;
  endsAtUtc: number;
  entryFee: number;
  maxAttempts: number;
  minLevel: number;
  prizeTiersCount: number;
  participantCount: number;
  state: TournamentState;
}

export interface TournamentListOutput {
  tournaments: TournamentListEntry[];
}

const VALID_KINDS: ReadonlySet<TournamentType> = new Set([
  'time_trial', 'cup', 'club_cup',
]);
const VALID_STATUSES: ReadonlySet<'upcoming' | 'open' | 'closed'> = new Set([
  'upcoming', 'open', 'closed',
]);

function tournamentListEntry(t: Tournament, now: number, nk: INakama): TournamentListEntry {
  return {
    id: t.id,
    kind: t.kind,
    trackId: t.trackId,
    startsAtUtc: t.startsAt,
    endsAtUtc: t.endsAt,
    entryFee: t.entryFee,
    maxAttempts: t.maxAttempts,
    minLevel: t.minLevel,
    prizeTiersCount: t.prizes.length,
    participantCount: countParticipants(nk, t.id),
    state: tournamentState(t, now),
  };
}

// ─── tournament_list ──────────────────────────────────────────────────────

export interface TournamentListInput {
  kind?: TournamentType;
  /** 'upcoming' = startsAt > nowUtc (not yet open);
   *  'open'     = state === 'open' || state === 'closing';
   *  'closed'   = state === 'closed'. */
  status?: 'upcoming' | 'open' | 'closed';
}

export const tournament_list_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const raw = parsed.raw;

  const userId = typeof ctx.userId === 'string' ? ctx.userId : '';
  const m = assertNotInMaintenance(logger, nk, userId);
  if (m !== null) return JSON.stringify(m);

  const kindRaw = raw['kind'];
  const kindFilter: TournamentType | undefined = (
    typeof kindRaw === 'string' && VALID_KINDS.has(kindRaw as TournamentType)
  ) ? (kindRaw as TournamentType)
    : undefined;

  const statusRaw = raw['status'];
  const statusFilter: 'upcoming' | 'open' | 'closed' | undefined = (
    typeof statusRaw === 'string' && VALID_STATUSES.has(statusRaw as 'upcoming' | 'open' | 'closed')
  ) ? (statusRaw as 'upcoming' | 'open' | 'closed')
    : undefined;

  const now = serverNowMs();
  const instances = ensureTournamentsForWindow(nk, now);

  const out: TournamentListEntry[] = [];
  for (const t of instances) {
    if (kindFilter !== undefined && t.kind !== kindFilter) continue;
    const view = tournamentListEntry(t, now, nk);
    if (statusFilter === 'upcoming') {
      if (view.startsAtUtc <= now) continue;
    } else if (statusFilter === 'closed') {
      if (view.state !== 'closed') continue;
    } else if (statusFilter === 'open') {
      if (view.state === 'closed') continue;
    }
    out.push(view);
  }
  out.sort((a, b) => a.startsAtUtc - b.startsAtUtc);

  emit(nk, logger, 'tournament_listed', {
    userId, kindFilter: kindFilter ?? null, statusFilter: statusFilter ?? null,
    returned: out.length,
  });

  const payload: TournamentListOutput = { tournaments: out };
  return JSON.stringify(ok(payload));
};
export const tournament_list: RpcHandler = tournament_list_impl;

// ─── tournament_get ───────────────────────────────────────────────────────

export interface TournamentGetInput {
  tournamentId: string;
}

export interface TournamentTopTime {
  userId: string;
  bestTimeMs: number;
  position: number;
}

export interface TournamentGetOutput {
  tournament: TournamentListEntry;
  /** Player's entry — null when not joined. */
  myEntry: TournamentEntry | null;
  /** Up to 10 best times for this tournament. Empty when Chunk 6 has
   *  not yet populated `tournament_leaderboard/{id}`. */
  topTimes: TournamentTopTime[];
}

export const tournament_get_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const raw = parsed.raw;

  const userId = typeof ctx.userId === 'string' ? ctx.userId : '';
  const m = assertNotInMaintenance(logger, nk, userId);
  if (m !== null) return JSON.stringify(m);

  const tournamentIdRaw = raw['tournamentId'];
  if (typeof tournamentIdRaw !== 'string' || tournamentIdRaw.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'tournamentId is required'));
  }
  const tournamentId = tournamentIdRaw;

  // Ensure the instance exists (lazy-create on get as well — players
  // may navigate to a tournament page that the catalog surfaced).
  ensureTournamentsForWindow(nk, serverNowMs());
  const t = readTournamentInstance(nk, tournamentId);
  if (t === null) return tournamentNotFound(tournamentId);

  const entry = readEntry(nk, tournamentId, userId);
  const myEntry: TournamentEntry | null = entry === null ? null : entry;

  // Chunk 5 stub: topTimes[] is empty. The Chunk 6 subscriber writes
  // to `tournament_leaderboard/{id}`; that RPC will populate this once
  // wired. The shape is locked now so the Unity client can build
  // against it.
  const topTimes: TournamentTopTime[] = [];

  emit(nk, logger, 'tournament_viewed', {
    userId, tournamentId, joined: myEntry !== null,
  });

  const now = serverNowMs();
  const payload: TournamentGetOutput = {
    tournament: tournamentListEntry(t, now, nk),
    myEntry,
    topTimes,
  };
  return JSON.stringify(ok(payload));
};
export const tournament_get: RpcHandler = tournament_get_impl;

// ─── tournament_join ──────────────────────────────────────────────────────

export interface TournamentJoinInput {
  tournamentId: string;
}

export interface TournamentJoinOutput {
  entryId: string;
  joinedAt: number;
  attemptsRemaining: number;
  paidEntryFee: number;
  newBalance: { coins: number; gems: number };
}

export const tournament_join_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const raw = parsed.raw;

  const userId = typeof ctx.userId === 'string' ? ctx.userId : '';
  if (userId.length === 0) {
    return JSON.stringify(err('UNAUTHENTICATED', 'authentication required'));
  }

  const m = assertNotInMaintenance(logger, nk, userId);
  if (m !== null) return JSON.stringify(m);

  const tournamentIdRaw = raw['tournamentId'];
  if (typeof tournamentIdRaw !== 'string' || tournamentIdRaw.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'tournamentId is required'));
  }
  const tournamentId = tournamentIdRaw;

  const now = serverNowMs();
  ensureTournamentsForWindow(nk, now);
  const t = readTournamentInstance(nk, tournamentId);
  if (t === null) return tournamentNotFound(tournamentId);

  // State gate: only 'open' accepts joins. 'closed' → FORBIDDEN.
  const state = tournamentState(t, now);
  if (state === 'closed') {
    return JSON.stringify(err('FORBIDDEN', 'tournament already closed', {
      tournamentId, state,
    }));
  }

  // Level gate.
  const lvl = callerLevel(nk, userId);
  if (lvl < t.minLevel) {
    return JSON.stringify(err('FORBIDDEN', 'level below tournament minimum', {
      tournamentId, level: lvl, minLevel: t.minLevel,
    }));
  }

  // Already joined?
  const existing = readEntry(nk, tournamentId, userId);
  if (existing !== null) {
    return JSON.stringify(err('CONFLICT', 'already joined', {
      tournamentId, entryId: existing.createdAt,
    }));
  }

  // Deduct entry fee (idempotent on join+join retry).
  let newBalance: { coins: number; gems: number };
  if (t.entryFee > 0) {
    const sp = spend(
      nk, userId, { coins: t.entryFee },
      { reason: 'store', sourceId: `tournament:${tournamentId}` },
      `tournament_join:${tournamentId}:${userId}`,
    );
    if (!sp.ok) return JSON.stringify(sp);
    newBalance = sp.data;
  } else {
    // Free tournament — no spend, just report the current balance.
    newBalance = walletGet(nk, userId);
  }

  // Create the entry row.
  let entry: TournamentEntry;
  try {
    entry = createEntry(nk, tournamentId, userId, t.entryFee, t.maxAttempts, now);
  } catch (e) {
    // CAS-retry / already-joined race — surface as CONFLICT.
    return JSON.stringify(err('CONFLICT', (e as Error).message));
  }

  emit(nk, logger, 'tournament_joined', {
    userId, tournamentId, paidEntryFee: t.entryFee,
    attemptsRemaining: t.maxAttempts, level: lvl,
  });

  const payload: TournamentJoinOutput = {
    entryId: `${tournamentId}:${userId}`,
    joinedAt: entry.createdAt,
    attemptsRemaining: entry.attemptsRemaining,
    paidEntryFee: t.entryFee,
    newBalance,
  };
  return JSON.stringify(ok(payload));
};
export const tournament_join: RpcHandler = tournament_join_impl;

// Type re-export used by the bundle scanner so goja sees the named
// exports of the response types.
export type { Resp };