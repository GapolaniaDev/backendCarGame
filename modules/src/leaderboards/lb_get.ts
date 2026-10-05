// `lb_get` RPC — read a leaderboard with one of three views (global,
// around_me, friends) and batch profile enrichment into a single
// response.
//
// Spec (Phase 2 §2.4):
//   - Input:  leaderboardId, view, limit? (default 20, max 100),
//             aroundUserId? (default caller)
//   - Output: records[] (ranked), ownerRecord (the caller's own entry
//             if it exists), totalCount, profiles{} keyed by userId
//             (empty objects for users without a profile record yet —
//             profile creation lands in Chunk 15).
//
// The "friends" view returns just the caller + their own record for
// now; a real friend-graph lookup lands when the friends module is
// built. The function structure already supports swapping the
// `collectOwnerIdsForView()` helper later without changing the wire
// shape.

import type { IContext, ILogger, ILeaderboardRecord, INakama } from '../nkruntime';
import {
  getLeaderboardTable,
} from './catalog';
import { err, ok, type Resp } from '../core/response';

export type LbView = 'global' | 'around_me' | 'friends';

export interface LbGetInput {
  /** Target leaderboard id. Must exist in the catalog. */
  leaderboardId: string;
  /** View selection. */
  view: LbView;
  /** Page size (default 20, clamped to [1, 100]). */
  limit?: number;
  /**
   * User id to center `around_me` on. Defaults to the caller when omitted.
   * For HTTP gateway calls the caller MUST match this field; we accept
   * it explicitly so the view can be computed for any user when needed
   * (e.g. an admin / spectator tool).
   */
  aroundUserId?: string;
  /**
   * Required when calling via the HTTP gateway (where ctx.userId is
   * null). Verified against ctx.userId on socket calls.
   */
  callerUserId: string;
}

export interface LbRecordWithRank {
  ownerId: string;
  rank: number;
  score: number;
  subscore: number;
  metadata: Record<string, unknown>;
}

export interface LbProfileView {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface LbGetOutput {
  leaderboardId: string;
  view: LbView;
  totalCount: number;
  records: LbRecordWithRank[];
  ownerRecord: LbRecordWithRank | null;
  /** Keyed by ownerId — empty object for users without a profile yet. */
  profiles: Record<string, LbProfileView>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * RPC handler shape. Defined in this module so we can keep the
 * implementation file small. main.ts registers the top-level binding
 * `lb_get` that delegates to this.
 */
export type LbGetRpc = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

export const lb_get_impl: LbGetRpc = (ctx, logger, nk, body) => {
  let payload: Partial<LbGetInput>;
  try {
    payload = JSON.parse(body) as Partial<LbGetInput>;
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

  // Validate inputs.
  const leaderboardId = payload.leaderboardId;
  if (typeof leaderboardId !== 'string' || leaderboardId.length === 0) {
    return toJson(err('BAD_REQUEST', 'leaderboardId is required'));
  }
  if (!getLeaderboardTable(leaderboardId)) {
    return toJson(err('NOT_FOUND', `unknown leaderboard ${leaderboardId}`));
  }
  const view = payload.view;
  if (view !== 'global' && view !== 'around_me' && view !== 'friends') {
    return toJson(err('BAD_REQUEST', "view must be one of 'global' | 'around_me' | 'friends'"));
  }
  const limit = clampLimit(payload.limit);

  const aroundUserId =
    typeof payload.aroundUserId === 'string' && payload.aroundUserId.length > 0
      ? payload.aroundUserId
      : callerId;

  // 1) Pull the records list once. We sort and trim here; Nakama's
  //    leaderboardRecordsList gives us a full sorted slice.
  const all = nk.leaderboardRecordsList(
    leaderboardId,
    /* ownerIds */ [],
    /* limit */ Math.max(MAX_LIMIT * 5, 200),
  );
  const sorted: ILeaderboardRecord[] = all.records.slice().sort(ascendingByScore);

  // 2) Per-view selection.
  const records = selectForView(sorted, view, limit, aroundUserId);

  // 3) Rank within the FULL sorted list (matches Nakama's global ranking).
  const ranked = records.map((r) => ({
    record: r,
    rank: sorted.findIndex((x) => x.ownerId === r.ownerId) + 1,
  }));
  const ownerEntry = sorted.find((r) => r.ownerId === aroundUserId);
  const ownerRecord = ownerEntry
    ? {
        ownerId: ownerEntry.ownerId,
        rank: sorted.findIndex((x) => x.ownerId === ownerEntry.ownerId) + 1,
        score: ownerEntry.score,
        subscore: ownerEntry.subscore,
        metadata: ownerEntry.metadata as Record<string, unknown>,
      }
    : null;

  // 4) Profile enrichment: read `profiles/{userId}` storage objects.
  const ownerIds = new Set<string>();
  for (const r of records) ownerIds.add(r.ownerId);
  if (ownerRecord) ownerIds.add(ownerRecord.ownerId);
  const profiles = enrichProfiles(nk, Array.from(ownerIds));

  const out: LbGetOutput = {
    leaderboardId,
    view,
    totalCount: sorted.length,
    records: ranked.map(({ record, rank }) => ({
      ownerId: record.ownerId,
      rank,
      score: record.score,
      subscore: record.subscore,
      metadata: record.metadata as Record<string, unknown>,
    })),
    ownerRecord,
    profiles,
  };
  logger.info(
    'lb_get table=%s view=%s limit=%d returned=%d profiles=%d caller=%s',
    leaderboardId,
    view,
    limit,
    out.records.length,
    Object.keys(profiles).length,
    callerId,
  );
  return toJson(ok(out));
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

function ascendingByScore(a: ILeaderboardRecord, b: ILeaderboardRecord): number {
  if (a.score !== b.score) return a.score - b.score;
  return a.subscore - b.subscore;
}

function selectForView(
  sorted: ILeaderboardRecord[],
  view: LbView,
  limit: number,
  aroundUserId: string,
): ILeaderboardRecord[] {
  if (view === 'global') {
    return sorted.slice(0, limit);
  }
  if (view === 'friends') {
    // No friend graph yet (lands in a later chunk). For now friends
    // means "just the caller".
    return sorted.filter((r) => r.ownerId === aroundUserId);
  }
  // around_me: band of 3 on each side of the caller, clamped to limit.
  const idx = sorted.findIndex((r) => r.ownerId === aroundUserId);
  if (idx === -1) return sorted.slice(0, limit);
  const half = Math.max(1, Math.floor(limit / 2));
  const start = Math.max(0, idx - half);
  return sorted.slice(start, start + limit);
}

/**
 * Read profile storage objects for the given userIds. Missing objects are
 * returned as empty profile views (displayName=userId, avatarUrl=null). The
 * shape is intentionally tolerant so Chunk 15 (real profile creation) can
 * populate the same key without changing the wire contract.
 */
function enrichProfiles(nk: INakama, ownerIds: string[]): Record<string, LbProfileView> {
  const result: Record<string, LbProfileView> = {};
  if (ownerIds.length === 0) return result;
  const keys = ownerIds.map((id) => ({
    collection: 'profiles',
    key: id,
    userId: id,
  }));
  const objs = nk.storageRead(keys);
  for (const id of ownerIds) {
    const obj = objs.find((o) => o.userId === id);
    if (obj) {
      const v = obj.value as Partial<LbProfileView> | null;
      result[id] = {
        userId: id,
        displayName: typeof v?.displayName === 'string' ? v.displayName : id,
        avatarUrl: typeof v?.avatarUrl === 'string' ? v.avatarUrl : null,
      };
    } else {
      result[id] = {
        userId: id,
        displayName: id,
        avatarUrl: null,
      };
    }
  }
  return result;
}

function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

// Top-level binding so the goja AST scanner can find the RPC. The
// runtime resolves `globalThis[literal]` against this exact name.
export const lb_get: LbGetRpc = lb_get_impl;