// `lb_get` RPC — read a leaderboard with one of three views (global,
// around_me, friends) and batch profile enrichment into a single
// response.
//
// Spec (Phase 2 §2.4):
//   - Input:  leaderboardId, view, limit? (default 20, max 100),
//             aroundUserId? (default caller), cursor? (plan T-13)
//   - Output: records[] (ranked), ownerRecord (the around user's own
//             entry if it exists), totalCount, profiles{} keyed by
//             userId, nextCursor / prevCursor (plan T-13, additive).
//
// Plan T-13 (audit 05 f5-f6, 06 f4, HT-65):
//   - Order and rank come from Nakama, i.e. from each table's own sort
//     order (`leaderboards.json`): `wins_week` and the ranked table are
//     descending, the time tables ascending. The handler used to sort
//     every table ascending, which inverted `wins_week`.
//   - Pages are Nakama cursors: `global` and `around_me` return the
//     cursors of `leaderboardRecordsList` / `leaderboardRecordsHaystack`
//     as they are; `friends` pages its (small) list with an offset
//     cursor of its own.
//   - `friends` lists the caller and their friends (`friends_edge`,
//     the graph `friend_list_get` returns), not just the caller.
//   - Each record carries `username` (written by the server since T-13;
//     filled from the account for older records), and the profile
//     fallback is that username instead of the raw user id.
//   - The ranked table of a season (`ranked_{seasonId}`) is accepted.
//
// Club tables (`ownerKind: 'club'`, plan B2): `global`/`around_me` around the
// caller's club; records carry the club name in `username`; `clubs` maps club ids
// to name, emblem and member count.

import type { IContext, ILogger, ILeaderboardRecord, INakama } from '../nkruntime';
import { resolveLeaderboardTable, type LeaderboardOwnerKind } from './catalog';
import { err, ok, type Resp } from '../core/response';
import { liveopsGate } from '../core/liveops';
import type { ClientPlatform } from '../liveops/types';
import { requireCaller } from '../core/caller';
import { withRuntime } from '../core/runtime_state';
import { listFriendEdges } from '../social/friends_repo';
import { readMembership } from '../clubs/members_repo';
import { readClubMetadataMany } from '../clubs/clubs_repo';
import { usernamesById } from './usernames';

const PLATFORM_DEFAULT: ClientPlatform = 'ios';

export type LbView = 'global' | 'around_me' | 'friends';

export interface LbGetInput {
  /** Target leaderboard id. Must exist in the catalog (or be a season's ranked table). */
  leaderboardId: string;
  /** View selection. */
  view: LbView;
  /** Page size (default 20, clamped to [1, 100]). */
  limit?: number;
  /**
   * User id to center `around_me` on (and whose `ownerRecord` is
   * returned). Defaults to the caller. Leaderboards are public.
   */
  aroundUserId?: string;
  /** Club tables: club to center `around_me` on; defaults to the caller's club. */
  aroundClubId?: string;
  /** `nextCursor` / `prevCursor` of a previous page of the same view (plan T-13). */
  cursor?: string;
  /**
   * Optional; when present it must match the session user (D-03).
   */
  callerUserId: string;
  /** Client semver — sent in payload (RPC handler can't read HTTP headers). */
  clientVersion?: string;
  /** Client platform (defaults to 'ios' when omitted). */
  platform?: ClientPlatform;
}

export interface LbRecordWithRank {
  ownerId: string;
  /** Owner's account username (plan T-13, additive); '' when unknown. */
  username: string;
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

export interface LbClubView {
  clubId: string;
  name: string;
  emblemId: string;
  memberCount: number;
}

export interface LbGetOutput {
  leaderboardId: string;
  view: LbView;
  ownerKind: LeaderboardOwnerKind;
  /** Ranked records in the whole table (not just this page). */
  totalCount: number;
  records: LbRecordWithRank[];
  ownerRecord: LbRecordWithRank | null;
  /** Keyed by ownerId; falls back to the username for users without a profile. */
  profiles: Record<string, LbProfileView>;
  /** Club tables: the clubs of the page and ownerRecord, keyed by club id; {} otherwise. */
  clubs: Record<string, LbClubView>;
  /** Cursor of the next page, or null on the last one (plan T-13, additive). */
  nextCursor: string | null;
  /** Cursor of the previous page, or null on the first one (plan T-13, additive). */
  prevCursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Prefix of the offset cursors the `friends` view hands out. */
const FRIENDS_CURSOR_PREFIX = 'friends:';

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

interface Page {
  records: ILeaderboardRecord[];
  nextCursor: string | null;
  prevCursor: string | null;
}

export const lb_get_impl: LbGetRpc = (ctx, logger, nk, body) => {
  let payload: Partial<LbGetInput>;
  try {
    payload = JSON.parse(body) as Partial<LbGetInput>;
  } catch {
    return toJson(err('BAD_REQUEST', 'payload is not valid JSON'));
  }

  // Resolve caller: session only; a body callerUserId must match (D-03).
  const caller = requireCaller(ctx, payload);
  if (!caller.ok) return toJson(caller.error);
  const callerId = caller.userId;

  // LiveOps gate (maintenance + min client version).
  const gate = liveopsGate(
    logger,
    nk,
    callerId,
    typeof payload.clientVersion === 'string' ? payload.clientVersion : undefined,
    typeof payload.platform === 'string' ? (payload.platform as ClientPlatform) : PLATFORM_DEFAULT,
  );
  if (gate !== null) return toJson(gate);

  // Validate inputs.
  const leaderboardId = payload.leaderboardId;
  if (typeof leaderboardId !== 'string' || leaderboardId.length === 0) {
    return toJson(err('BAD_REQUEST', 'leaderboardId is required'));
  }
  const table = resolveLeaderboardTable(leaderboardId);
  if (!table) {
    return toJson(err('NOT_FOUND', `unknown leaderboard ${leaderboardId}`));
  }
  const ownerKind = table.ownerKind;
  const view = payload.view;
  if (view !== 'global' && view !== 'around_me' && view !== 'friends') {
    return toJson(err('BAD_REQUEST', "view must be one of 'global' | 'around_me' | 'friends'"));
  }
  if (ownerKind === 'club' && view === 'friends') {
    return toJson(err('BAD_REQUEST', "view 'friends' is not available for club tables"));
  }
  if (payload.cursor !== undefined && payload.cursor !== null && typeof payload.cursor !== 'string') {
    return toJson(err('BAD_REQUEST', 'cursor must be a string'));
  }
  const cursor = typeof payload.cursor === 'string' ? payload.cursor : '';
  const limit = clampLimit(payload.limit);

  // The owner the view is centered on: a player, or for club tables the
  // explicit club or else the caller's club ('' when they have none).
  let aroundUserId: string;
  if (ownerKind === 'club') {
    aroundUserId =
      typeof payload.aroundClubId === 'string' && payload.aroundClubId.length > 0
        ? payload.aroundClubId
        : readMembership(nk, callerId)?.record.clubId ?? '';
  } else {
    aroundUserId =
      typeof payload.aroundUserId === 'string' && payload.aroundUserId.length > 0
        ? payload.aroundUserId
        : callerId;
  }

  // A ranked season's table is created by its first ranked race (or at
  // boot for the active season): until then the board is empty.
  if ((nk.leaderboardsGetId([leaderboardId]) ?? []).length === 0) {
    return toJson(ok(emptyOutput(leaderboardId, view, ownerKind)));
  }

  // 1) The page, in the table's own order with Nakama's ranks, plus
  //    the around user's own record. The runtime throws on a malformed
  //    cursor or user id: that is the caller's input, answered as
  //    BAD_REQUEST inside the envelope.
  let read: ViewRead | null;
  try {
    read = readView(nk, leaderboardId, view, callerId, aroundUserId, limit, cursor);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/cursor|owner id|identifier|user id/i.test(message)) {
      logger.warn('lb_get rejected input table=%s view=%s: %s', leaderboardId, view, message);
      return toJson(err('BAD_REQUEST', 'invalid cursor or user id'));
    }
    logger.error('lb_get read failed table=%s view=%s: %s', leaderboardId, view, message);
    return toJson(err('INTERNAL', 'leaderboard read failed'));
  }
  if (read === null) return toJson(err('BAD_REQUEST', 'cursor is not a friends-view cursor'));
  const { page, ownerEntry, totalCount } = read;

  if (ownerKind === 'club') {
    return toJson(ok(buildClubOutput(logger, nk, leaderboardId, view, read)));
  }

  // 2) Usernames (records written before T-13 have none) and profiles.
  const ownerIds = new Set<string>(page.records.map((r) => r.ownerId));
  if (ownerEntry) ownerIds.add(ownerEntry.ownerId);
  const missingNames = [...page.records, ...(ownerEntry ? [ownerEntry] : [])]
    .filter((r) => typeof r.username !== 'string' || r.username.length === 0)
    .map((r) => r.ownerId);
  const accountNames = usernamesById(logger, nk, missingNames);
  const nameOf = (r: ILeaderboardRecord): string =>
    typeof r.username === 'string' && r.username.length > 0 ? r.username : accountNames.get(r.ownerId) ?? '';
  const records = page.records.map((r) => toWire(r, nameOf(r)));
  const ownerRecord = ownerEntry ? toWire(ownerEntry, nameOf(ownerEntry)) : null;
  const names = new Map<string, string>();
  for (const r of [...records, ...(ownerRecord ? [ownerRecord] : [])]) names.set(r.ownerId, r.username);
  const profiles = enrichProfiles(nk, Array.from(ownerIds), names);

  const out: LbGetOutput = {
    leaderboardId,
    view,
    ownerKind: 'user',
    totalCount,
    records,
    ownerRecord,
    profiles,
    clubs: {},
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
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

// ─── Views ───────────────────────────────────────────────────────────────────

interface ViewRead {
  page: Page;
  ownerEntry: ILeaderboardRecord | undefined;
  totalCount: number;
}

/** The view's page and the around user's record; null for a foreign cursor on `friends`. */
function readView(
  nk: INakama,
  leaderboardId: string,
  view: LbView,
  callerId: string,
  aroundUserId: string,
  limit: number,
  cursor: string,
): ViewRead | null {
  // An empty around id (a club table, caller without a club) never goes
  // to the runtime as an owner id: it reads the top page without an owner.
  const ownerIds = aroundUserId.length > 0 ? [aroundUserId] : [];
  if (view === 'global') {
    const res = nk.leaderboardRecordsList(leaderboardId, ownerIds, limit, cursor);
    return {
      page: { records: res.records, nextCursor: res.nextCursor ?? null, prevCursor: res.prevCursor ?? null },
      ownerEntry: res.ownerRecords.find((r) => r.ownerId === aroundUserId),
      totalCount: res.rankCount ?? 0,
    };
  }
  const own = nk.leaderboardRecordsList(leaderboardId, ownerIds, 0);
  const ownerEntry = own.ownerRecords.find((r) => r.ownerId === aroundUserId);
  const totalCount = own.rankCount ?? 0;
  if (view === 'around_me') {
    return {
      page: aroundPage(nk, leaderboardId, aroundUserId, limit, cursor, ownerEntry !== undefined),
      ownerEntry,
      totalCount,
    };
  }
  const offset = parseFriendsCursor(cursor);
  if (offset === null) return null;
  return { page: friendsPage(nk, leaderboardId, callerId, limit, offset), ownerEntry, totalCount };
}

/**
 * Nakama's haystack around the user; a user without a record gets the
 * top of the table (the haystack is empty for them), as before.
 */
function aroundPage(
  nk: INakama,
  leaderboardId: string,
  aroundUserId: string,
  limit: number,
  cursor: string,
  hasRecord: boolean,
): Page {
  if (cursor.length > 0 || !hasRecord) {
    const res = nk.leaderboardRecordsList(leaderboardId, [], limit, cursor);
    return { records: res.records, nextCursor: res.nextCursor ?? null, prevCursor: res.prevCursor ?? null };
  }
  const res = nk.leaderboardRecordsHaystack(leaderboardId, aroundUserId, limit);
  return { records: res.records, nextCursor: res.nextCursor ?? null, prevCursor: res.prevCursor ?? null };
}

/**
 * The caller and their friends, in the table's order with their global
 * ranks. A friend list is at most a few hundred ids, so it is read in
 * one call and paged by offset.
 */
function friendsPage(
  nk: INakama,
  leaderboardId: string,
  callerId: string,
  limit: number,
  offset: number,
): Page {
  const ids = [callerId, ...listFriendEdges(nk, callerId).map((e) => e.friendId)];
  const unique = Array.from(new Set(ids));
  const all = nk.leaderboardRecordsList(leaderboardId, unique, 0).ownerRecords;
  const records = all.slice(offset, offset + limit);
  return {
    records,
    nextCursor: offset + limit < all.length ? `${FRIENDS_CURSOR_PREFIX}${offset + limit}` : null,
    prevCursor: offset > 0 ? `${FRIENDS_CURSOR_PREFIX}${Math.max(0, offset - limit)}` : null,
  };
}

function parseFriendsCursor(cursor: string): number | null {
  if (cursor.length === 0) return 0;
  if (!cursor.startsWith(FRIENDS_CURSOR_PREFIX)) return null;
  const n = Number(cursor.slice(FRIENDS_CURSOR_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

function toWire(r: ILeaderboardRecord, username: string): LbRecordWithRank {
  return {
    ownerId: r.ownerId,
    username,
    rank: typeof r.rank === 'number' ? r.rank : 0,
    score: r.score,
    subscore: r.subscore,
    metadata: r.metadata as Record<string, unknown>,
  };
}

function emptyOutput(leaderboardId: string, view: LbView, ownerKind: LeaderboardOwnerKind): LbGetOutput {
  return {
    leaderboardId,
    view,
    ownerKind,
    totalCount: 0,
    records: [],
    ownerRecord: null,
    profiles: {},
    clubs: {},
    nextCursor: null,
    prevCursor: null,
  };
}

/**
 * The response of a club table: records carry the club name in `username`
 * ('' for a deleted club, which then has no `clubs` entry) and `clubs`
 * maps each club of the page and the owner record to name, emblem and size.
 */
function buildClubOutput(
  logger: ILogger,
  nk: INakama,
  leaderboardId: string,
  view: LbView,
  read: ViewRead,
): LbGetOutput {
  const { page, ownerEntry, totalCount } = read;
  const ids = Array.from(
    new Set<string>([...page.records.map((r) => r.ownerId), ...(ownerEntry ? [ownerEntry.ownerId] : [])]),
  );
  let groups: Array<{ id: string; name: string; edgeCount: number }> = [];
  if (ids.length > 0) {
    try {
      groups = nk.groupsGetId(ids);
    } catch (e) {
      logger.warn('lb_get club names unavailable table=%s: %s', leaderboardId, e instanceof Error ? e.message : String(e));
    }
  }
  let metas: ReturnType<typeof readClubMetadataMany> = new Map();
  if (ids.length > 0) {
    try {
      metas = readClubMetadataMany(nk, ids);
    } catch (e) {
      logger.warn('lb_get club emblems unavailable table=%s: %s', leaderboardId, e instanceof Error ? e.message : String(e));
    }
  }
  const clubs: Record<string, LbClubView> = {};
  const names = new Map<string, string>();
  for (const g of groups) {
    names.set(g.id, g.name);
    clubs[g.id] = {
      clubId: g.id,
      name: g.name,
      emblemId: metas.get(g.id)?.record.emblemId ?? '',
      memberCount: g.edgeCount,
    };
  }
  const wire = (r: ILeaderboardRecord): LbRecordWithRank => toWire(r, names.get(r.ownerId) ?? '');
  return {
    leaderboardId,
    view,
    ownerKind: 'club',
    totalCount,
    records: page.records.map(wire),
    ownerRecord: ownerEntry ? wire(ownerEntry) : null,
    profiles: {},
    clubs,
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
  };
}

/**
 * Read profile storage objects for the given userIds. Users without a
 * profile get their username (or, without one, their id) as the
 * display name and no avatar.
 */
function enrichProfiles(
  nk: INakama,
  ownerIds: string[],
  usernames: ReadonlyMap<string, string>,
): Record<string, LbProfileView> {
  const result: Record<string, LbProfileView> = {};
  if (ownerIds.length === 0) return result;
  const keys = ownerIds.map((id) => ({
    collection: 'profiles',
    key: id,
    userId: id,
  }));
  const objs = nk.storageRead(keys);
  for (const id of ownerIds) {
    const fallbackName = usernames.get(id) || id;
    const obj = objs.find((o) => o.userId === id);
    if (obj) {
      const v = obj.value as Partial<LbProfileView> | null;
      result[id] = {
        userId: id,
        displayName: typeof v?.displayName === 'string' ? v.displayName : fallbackName,
        avatarUrl: typeof v?.avatarUrl === 'string' ? v.avatarUrl : null,
      };
    } else {
      result[id] = {
        userId: id,
        displayName: fallbackName,
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
export const lb_get: LbGetRpc = withRuntime(lb_get_impl);
