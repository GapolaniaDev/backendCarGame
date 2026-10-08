// Phase 8 Chunk 7 — Tournament admin RPCs.
//
// 6 RPCs, each `assertAdminKey` (Phase 5 D7) + bypass maintenance
// (precedent: `account_delete`, Chunk 5) + `emitAdminAction` audit
// (Phase 5 Chunk 6). The pattern mirrors `admin/rpcs.ts` — each
// handler exports both `<name>_impl: RpcHandler` (testable) and a bare
// `export const <name>: RpcHandler` for the goja AST scanner.
//
// Refund direction: `admin_tournament_void_refund` uses `wallet.grant`
// (system → user) because the original `paidEntryFee` was a
// `wallet.spend` from `tournament_join` (Chunk 5). The grant writes
// a ledger row with `reason='admin'` + sourceId `tournament_void:{tid}:{uid}`
// so the audit trail is searchable.
//
// Idempotency keys:
//   - prize distribution: `tournament_prize:{tid}:{uid}:{rank}` (Chunk 6 D44)
//   - void refund:        `tournament_void_refund:{tid}:{uid}` (Chunk 7 D46)
//   - void inbox:         `tournament:{tid}:void:{uid}` (deterministic per pair)

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { serverNowMs } from '../core/time';
import { assertAdminKey, withoutAdminKey } from '../admin/auth';
import { emitAdminAction } from '../core/admin/analytics';
import { grant } from '../economy/wallet';
import { sendReward } from '../liveops/inbox';
import { distributePrizes, type PrizeDistributionRow } from './prizes';
import { topN } from './leaderboard';
import { tournamentState } from './catalog';
import {
  readTournamentInstance,
  writeTournamentInstance,
  listAllEntries,
} from './repo';
import { grantTournamentPrize } from './scanner';
import type { Tournament, TournamentType } from './types';

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

const VALID_KINDS: ReadonlySet<TournamentType> = new Set([
  'time_trial', 'cup', 'club_cup',
]);
const VALID_LIST_STATES: ReadonlySet<'open' | 'closing' | 'closed' | 'all'> = new Set([
  'open', 'closing', 'closed', 'all',
]);

function readString(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  return typeof v === 'string' ? v : '';
}
function readNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function readBool(raw: Record<string, unknown>, key: string): boolean {
  return raw[key] === true;
}

function adminPrelude(
  _ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
):
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string } {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed;
  const raw = parsed.raw;
  const auth = assertAdminKey(logger, nk, raw);
  if (!auth.ok) return auth;
  return { ok: true, raw };
}

// ─── admin_tournament_list ────────────────────────────────────────────────

export interface AdminTournamentListInput {
  adminKey: string;
  state?: 'open' | 'closing' | 'closed' | 'all';
  kind?: TournamentType;
  limit?: number;
  cursor?: string;
}

export interface AdminTournamentListRow {
  id: string;
  kind: TournamentType;
  trackId: string;
  startsAtUtc: number;
  endsAtUtc: number;
  entryFee: number;
  minLevel: number;
  maxAttempts: number;
  state: 'open' | 'closing' | 'closed';
  cancelled: boolean;
  voided: boolean;
  closedAt: number | null;
  participantCount: number;
}

export interface AdminTournamentListOutput {
  tournaments: AdminTournamentListRow[];
  nextCursor: string;
}

const TOURNAMENT_ADMIN_LIST_DEFAULT_LIMIT = 50;
const TOURNAMENT_ADMIN_LIST_MAX_LIMIT = 500;

function buildAdminListRow(
  t: Tournament,
  nowUtc: number,
  participantCount: number,
): AdminTournamentListRow {
  return {
    id: t.id,
    kind: t.kind,
    trackId: t.trackId,
    startsAtUtc: t.startsAt,
    endsAtUtc: t.endsAt,
    entryFee: t.entryFee,
    minLevel: t.minLevel,
    maxAttempts: t.maxAttempts,
    state: tournamentState(t, nowUtc),
    cancelled: t.cancelled === true,
    voided: t.voided === true,
    closedAt: typeof t.closedAt === 'number' ? t.closedAt : null,
    participantCount,
  };
}

export const admin_tournament_list_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const stateRaw = raw['state'];
  const stateFilter: 'open' | 'closing' | 'closed' | 'all' =
    typeof stateRaw === 'string' && VALID_LIST_STATES.has(stateRaw as 'open' | 'closing' | 'closed' | 'all')
      ? (stateRaw as 'open' | 'closing' | 'closed' | 'all')
      : 'all';

  const kindRaw = raw['kind'];
  const kindFilter: TournamentType | undefined =
    typeof kindRaw === 'string' && VALID_KINDS.has(kindRaw as TournamentType)
      ? (kindRaw as TournamentType)
      : undefined;

  const limitRaw = readNumber(raw, 'limit');
  const limit = Math.min(
    TOURNAMENT_ADMIN_LIST_MAX_LIMIT,
    Math.max(1, limitRaw ?? TOURNAMENT_ADMIN_LIST_DEFAULT_LIMIT),
  );
  const cursor = readString(raw, 'cursor');

  const nowUtc = serverNowMs();

  // Admin sees ALL tournaments (no 7d window filter). Use the
  // instance collection directly via storageList 1-arg.
  const list = nk.storageList({
    collection: 'tournament_instances',
    limit,
    cursor,
  });
  const tournaments: AdminTournamentListRow[] = [];
  for (const o of list.objects) {
    const v = o.value as Partial<Tournament>;
    if (!v || typeof v !== 'object' || v.schemaVersion !== 1 || typeof v.id !== 'string') continue;
    const t = v as Tournament;
    if (kindFilter !== undefined && t.kind !== kindFilter) continue;
    const st = tournamentState(t, nowUtc);
    if (stateFilter !== 'all' && st !== stateFilter) continue;
    // Participant count requires a second scan; defer for list (cheap
    // because we already iterated the entries collection? no — separate
    // collection). Use storageList 1-arg to count; if too expensive
    // for big catalogs, drop the field from the list view. The
    // admin_get RPC always returns the full count.
    const participants = nk.storageList({
      collection: 'tournament_entries',
      limit: 5000,
    });
    let count = 0;
    for (const p of participants.objects) {
      if (p.key === t.id) count += 1;
    }
    tournaments.push(buildAdminListRow(t, nowUtc, count));
  }
  tournaments.sort((a, b) => a.startsAtUtc - b.startsAtUtc);

  emitAdminAction(nk, logger, 'admin_tournament_list', {
    stateFilter,
    kindFilter: kindFilter ?? null,
    returned: tournaments.length,
  });

  const payload: AdminTournamentListOutput = {
    tournaments,
    nextCursor: list.cursor ?? '',
  };
  return JSON.stringify(ok(payload));
};
export const admin_tournament_list: RpcHandler = admin_tournament_list_impl;

// ─── admin_tournament_get ─────────────────────────────────────────────────

export interface AdminTournamentGetInput {
  adminKey: string;
  tournamentId: string;
}

export interface AdminTournamentEntryRow {
  userId: string;
  joinedAt: number;
  attemptsRemaining: number;
  bestTimeMs: number | null;
  paidEntryFee: number;
  updatedAt: number;
}

export interface AdminTournamentLeaderboardRow {
  userId: string;
  bestTimeMs: number;
  recordedAt: number;
}

export interface AdminTournamentGetOutput {
  tournament: AdminTournamentListRow;
  allEntries: AdminTournamentEntryRow[];
  leaderboard: AdminTournamentLeaderboardRow[];
  prizes: Array<{
    userId: string;
    rank: number;
    tierRankFrom: number;
    tierRankTo: number;
    rewards: { coins?: number; gems?: number; cosmeticId?: string };
    distributed: true;
  }>;
}

export const admin_tournament_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const tournamentId = readString(raw, 'tournamentId');
  if (tournamentId.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'tournamentId is required'));
  }
  const t = readTournamentInstance(nk, tournamentId);
  if (t === null) {
    return JSON.stringify(err('NOT_FOUND', `tournament "${tournamentId}" not found`));
  }
  const nowUtc = serverNowMs();
  const entries = listAllEntries(nk, tournamentId);
  const lb = topN(nk, tournamentId, 100);
  const distributions = distributePrizes(t, lb, nowUtc);

  emitAdminAction(nk, logger, 'admin_tournament_get', {
    tournamentId,
    entries: entries.length,
    leaderboard: lb.length,
  });

  const allEntries: AdminTournamentEntryRow[] = entries.map((e) => ({
    userId: e.userId,
    joinedAt: e.createdAt,
    attemptsRemaining: e.attemptsRemaining,
    bestTimeMs: e.bestTimeMs,
    paidEntryFee: e.paidEntryFee,
    updatedAt: e.updatedAt,
  }));
  const leaderboard: AdminTournamentLeaderboardRow[] = lb.map((e) => ({
    userId: e.userId,
    bestTimeMs: e.bestTimeMs,
    recordedAt: e.recordedAt,
  }));
  const prizes: AdminTournamentGetOutput['prizes'] = distributions.map((d) => ({
    userId: d.userId,
    rank: d.rank,
    tierRankFrom: d.tierRankFrom,
    tierRankTo: d.tierRankTo,
    rewards: {
      ...(d.rewards.coins !== undefined ? { coins: d.rewards.coins } : {}),
      ...(d.rewards.gems !== undefined ? { gems: d.rewards.gems } : {}),
      ...(d.rewards.cosmeticId !== undefined ? { cosmeticId: d.rewards.cosmeticId } : {}),
    },
    distributed: true,
  }));

  const payload: AdminTournamentGetOutput = {
    tournament: buildAdminListRow(t, nowUtc, entries.length),
    allEntries,
    leaderboard,
    prizes,
  };
  return JSON.stringify(ok(payload));
};
export const admin_tournament_get: RpcHandler = admin_tournament_get_impl;

// ─── admin_tournament_release_prizes ──────────────────────────────────────

export interface AdminTournamentReleasePrizesInput {
  adminKey: string;
  tournamentId: string;
  force?: boolean;
}

export interface AdminTournamentReleasePrizesOutput {
  distributed: number;
  skipped: number;
  errors: number;
}

export const admin_tournament_release_prizes_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const tournamentId = readString(raw, 'tournamentId');
  if (tournamentId.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'tournamentId is required'));
  }
  const force = readBool(raw, 'force');

  const t = readTournamentInstance(nk, tournamentId);
  if (t === null) {
    return JSON.stringify(err('NOT_FOUND', `tournament "${tournamentId}" not found`));
  }
  const nowUtc = serverNowMs();
  const st = tournamentState(t, nowUtc);
  if (st === 'closed' && !force) {
    return JSON.stringify(err('CONFLICT', 'tournament already closed; pass force=true to re-distribute', {
      tournamentId, state: st,
    }));
  }

  const lb = topN(nk, tournamentId, 100);
  const distributions = distributePrizes(t, lb, nowUtc);
  let distributed = 0;
  let errors = 0;
  for (const row of distributions) {
    // grantTournamentPrize uses the same idempotency key as the
    // scanner close path, so re-running is safe (the localcache
    // already-marked keys become no-ops on wallet grant; the inbox
    // sendReward short-circuits on duplicate key).
    const ok = grantTournamentPrize(nk, logger, tournamentId, row, nowUtc);
    if (ok) distributed += 1;
    else errors += 1;
  }

  emitAdminAction(nk, logger, 'admin_tournament_release_prizes', {
    tournamentId,
    force,
    distributed,
    errors,
  });

  const payload: AdminTournamentReleasePrizesOutput = {
    distributed,
    skipped: distributions.length - distributed,
    errors,
  };
  return JSON.stringify(ok(payload));
};
export const admin_tournament_release_prizes: RpcHandler = admin_tournament_release_prizes_impl;

// ─── admin_tournament_void_refund ─────────────────────────────────────────

export interface AdminTournamentVoidRefundInput {
  adminKey: string;
  tournamentId: string;
  reason: string;
}

export interface AdminTournamentVoidRefundOutput {
  refunded: number;
  totalAmount: number;
}

export const admin_tournament_void_refund_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const tournamentId = readString(raw, 'tournamentId');
  if (tournamentId.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'tournamentId is required'));
  }
  const reason = readString(raw, 'reason');
  if (reason.trim().length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'reason is required'));
  }
  const t = readTournamentInstance(nk, tournamentId);
  if (t === null) {
    return JSON.stringify(err('NOT_FOUND', `tournament "${tournamentId}" not found`));
  }
  if (t.voided === true) {
    return JSON.stringify(err('CONFLICT', 'tournament already voided', { tournamentId }));
  }
  if (t.cancelled === true) {
    return JSON.stringify(err('CONFLICT', 'tournament was cancelled (no refund path)', {
      tournamentId,
    }));
  }
  // If the tournament is already closed AND prizes were distributed
  // (i.e. scanner ran first), block the void — the funds are gone.
  // We approximate "prizes distributed" as "state=closed AND not voided
  // AND not cancelled" with closedAt set; admin can re-evaluate and
  // either cancel (no refund) or accept that the prizes stay.
  if (t.state === 'closed' && t.closedAt !== undefined) {
    return JSON.stringify(err('CONFLICT', 'tournament already closed; cancel without refund instead', {
      tournamentId,
    }));
  }

  const entries = listAllEntries(nk, tournamentId);
  const nowUtc = serverNowMs();
  let refunded = 0;
  let totalAmount = 0;
  for (const e of entries) {
    if (e.paidEntryFee <= 0) continue;
    const idempKey = `tournament_void_refund:${tournamentId}:${e.userId}`;
    const r = grant(
      nk, e.userId, { coins: e.paidEntryFee },
      { reason: 'admin', sourceId: `tournament_void:${tournamentId}:${e.userId}` },
      idempKey,
    );
    if (r.ok) {
      refunded += 1;
      totalAmount += e.paidEntryFee;
    } else {
      logger.error(
        'tournament void refund grant failed tid=%s uid=%s: %s',
        tournamentId, e.userId, r.error?.message ?? 'unknown',
      );
    }
    // Always send the inbox so the player sees the reason. Idempotent
    // on the (userId, rewardId) pair.
    try {
      sendReward(
        nk, e.userId, 'tournament_voided',
        {
          coins: e.paidEntryFee,
          note: `Tournament voided: ${reason}`,
        },
        `tournament:${tournamentId}:void:${e.userId}`,
        nowUtc,
      );
    } catch (ie) {
      logger.error(
        'tournament void inbox send failed tid=%s uid=%s: %s',
        tournamentId, e.userId, ie instanceof Error ? ie.message : String(ie),
      );
    }
  }

  // Mark the tournament voided + closed. CAS-retry via
  // writeTournamentInstance is in repo.writeTournamentInstance.
  try {
    const next: Tournament = {
      ...t,
      voided: true,
      cancelled: false,
      state: 'closed',
      closedAt: nowUtc,
    };
    writeTournamentInstance(nk, next);
  } catch (e) {
    logger.error(
      'tournament void write failed tid=%s: %s',
      tournamentId, e instanceof Error ? e.message : String(e),
    );
  }

  emitAdminAction(nk, logger, 'admin_tournament_void_refund', {
    tournamentId,
    refunded,
    totalAmount,
    reason,
  });

  const payload: AdminTournamentVoidRefundOutput = { refunded, totalAmount };
  return JSON.stringify(ok(payload));
};
export const admin_tournament_void_refund: RpcHandler = admin_tournament_void_refund_impl;

// ─── admin_tournament_cancel ──────────────────────────────────────────────

export interface AdminTournamentCancelInput {
  adminKey: string;
  tournamentId: string;
  reason: string;
}

export interface AdminTournamentCancelOutput {
  cancelled: true;
  tournamentId: string;
  closedAt: number;
}

export const admin_tournament_cancel_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const tournamentId = readString(raw, 'tournamentId');
  if (tournamentId.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'tournamentId is required'));
  }
  const reason = readString(raw, 'reason');
  if (reason.trim().length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'reason is required'));
  }
  const t = readTournamentInstance(nk, tournamentId);
  if (t === null) {
    return JSON.stringify(err('NOT_FOUND', `tournament "${tournamentId}" not found`));
  }
  const st = tournamentState(t, serverNowMs());
  if (st === 'closed') {
    return JSON.stringify(err('CONFLICT', 'tournament already closed', {
      tournamentId, state: st,
    }));
  }
  if (t.cancelled === true) {
    return JSON.stringify(err('CONFLICT', 'tournament already cancelled', { tournamentId }));
  }
  if (t.voided === true) {
    return JSON.stringify(err('CONFLICT', 'tournament already voided', { tournamentId }));
  }

  const nowUtc = serverNowMs();
  const next: Tournament = {
    ...t,
    cancelled: true,
    state: 'closed',
    closedAt: nowUtc,
  };
  try {
    writeTournamentInstance(nk, next);
  } catch (e) {
    return JSON.stringify(err('INTERNAL', `cancel write failed: ${(e as Error).message}`));
  }

  emitAdminAction(nk, logger, 'admin_tournament_cancel', {
    tournamentId, reason, closedAt: nowUtc,
  });

  const payload: AdminTournamentCancelOutput = {
    cancelled: true,
    tournamentId,
    closedAt: nowUtc,
  };
  return JSON.stringify(ok(payload));
};
export const admin_tournament_cancel: RpcHandler = admin_tournament_cancel_impl;

// ─── admin_tournament_extend ──────────────────────────────────────────────

export interface AdminTournamentExtendInput {
  adminKey: string;
  tournamentId: string;
  newEndsAtUtc: number;
  reason: string;
}

export interface AdminTournamentExtendOutput {
  tournamentId: string;
  oldEndsAtUtc: number;
  newEndsAtUtc: number;
}

export const admin_tournament_extend_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const tournamentId = readString(raw, 'tournamentId');
  if (tournamentId.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'tournamentId is required'));
  }
  const newEndsAtUtc = readNumber(raw, 'newEndsAtUtc');
  if (newEndsAtUtc === undefined) {
    return JSON.stringify(err('BAD_REQUEST', 'newEndsAtUtc is required (epoch-ms number)'));
  }
  const reason = readString(raw, 'reason');
  if (reason.trim().length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'reason is required'));
  }
  const t = readTournamentInstance(nk, tournamentId);
  if (t === null) {
    return JSON.stringify(err('NOT_FOUND', `tournament "${tournamentId}" not found`));
  }
  const nowUtc = serverNowMs();
  if (newEndsAtUtc < nowUtc) {
    return JSON.stringify(err('BAD_REQUEST', 'newEndsAtUtc must be >= nowUtc', {
      nowUtc, newEndsAtUtc,
    }));
  }
  const st = tournamentState(t, nowUtc);
  if (st === 'closed') {
    return JSON.stringify(err('CONFLICT', 'cannot extend a closed tournament', {
      tournamentId, state: st,
    }));
  }

  const oldEndsAtUtc = t.endsAt;
  const next: Tournament = { ...t, endsAt: newEndsAtUtc };
  // If the extension moves us OUT of the closing window, flip state back
  // to 'open' so the public list/get shows the new window correctly.
  if (newEndsAtUtc - nowUtc > 60 * 60 * 1000) {
    next.state = 'open';
  } else {
    next.state = 'closing';
  }
  try {
    writeTournamentInstance(nk, next);
  } catch (e) {
    return JSON.stringify(err('INTERNAL', `extend write failed: ${(e as Error).message}`));
  }

  emitAdminAction(nk, logger, 'admin_tournament_extend', {
    tournamentId, oldEndsAtUtc, newEndsAtUtc, reason,
  });

  const payload: AdminTournamentExtendOutput = {
    tournamentId,
    oldEndsAtUtc,
    newEndsAtUtc,
  };
  return JSON.stringify(ok(payload));
};
export const admin_tournament_extend: RpcHandler = admin_tournament_extend_impl;

// Re-export for type-only callers (bundle scanner picks up the named
// export of the response types so goja's AST sees them).
export type { Resp };

// Suppress the unused-import warning for the type-only import above.
void (null as unknown as PrizeDistributionRow);
