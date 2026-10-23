// Phase 7 Chunk 3 — Clubs RPCs:
//   - club_create  — spend 5000 coins, create Nakama group + metadata
//   - club_get     — fetch club + member preview
//   - club_search  — paginated search by name prefix
//   - club_join    — join a club through its rules (plan T-21)
//
// All are gated by `assertNotInMaintenance`.
//
// Errors (per peer spec):
//   - club_create: BAD_REQUEST, FORBIDDEN (level<8), INSUFFICIENT_FUNDS,
//                  RATE_LIMITED, CONFLICT (name taken, lifetime cap hit)
//   - club_get:    BAD_REQUEST (clubId missing), NOT_FOUND
//   - club_search: BAD_REQUEST (limit too big)
//
// Blocked-words check on motto is a placeholder list (defer real
// moderation to Chunk 5/6). Name uniqueness is checked via
// `nk.groupsList(name)` (case-insensitive exact match) and enforced again
// by `groupCreate`, which refuses a duplicate name.

import type { IContext, ILogger, INakama, IGroup, IGroupList } from '../nkruntime';
import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import { parseInput } from '../core/parse_input';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import { spend } from '../economy/wallet';
import { readProfile } from '../profiles/storage';
import {
  buildClubView,
  checkClubJoinGate,
  clubCreatedWrite,
  clubMetadataWrite,
  readClubCreated,
  readClubGroup,
  readClubMetadata,
  readClubMetadataMany,
  writeClubMetadataUpdate,
} from './clubs_repo';
import { ensureWeekBoundary } from './club_week_reset';
import {
  MAX_CAS_RETRIES,
  memberWrite,
  multiUpdateMembers,
  readClubMembers,
  readMember,
  readMembership,
  resolveUsername,
  writeMemberUpdate,
} from './members_repo';
import { joinClub, removeClubMember, syncGroupLeader, type ClubJoinOutput } from './join';
import {
  applyTransfer,
  canDemoteTo,
  canKickMember,
  canLeave,
  canPromoteTo,
  canUpdateClub,
} from './roles';
import {
  getEmblema,
  getEmblemas,
} from './catalog';
import {
  CLUB_DEFAULT_CREATE_COST_COINS,
  CLUB_DEFAULT_MIN_DIVISION,
  CLUB_MAX_MEMBERS,
  CLUB_MIN_LEVEL_TO_CREATE,
  CLUB_MOTTO_MAX_LEN,
  CLUB_MOTTO_MIN_LEN,
  CLUB_NAME_MAX_LEN,
  CLUB_NAME_MIN_LEN,
  type ClubCreateOutput,
  type ClubDemoteOutput,
  type ClubGetOutput,
  type ClubKickOutput,
  type ClubLeaveOutput,
  type ClubMembersListOutput,
  type ClubMemberView,
  type ClubMemberViewV2,
  type ClubMetadata,
  type ClubPromoteOutput,
  type ClubSearchOutput,
  type ClubUpdateOutput,
  type ClubView,
  type MemberRecord,
  type Role,
} from './types';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';

const CLUB_RATE_LIMITS = {
  club_create: { maxPerWindow: 5, windowSec: 60 },
  club_get: { maxPerWindow: 60, windowSec: 60 },
  club_search: { maxPerWindow: 30, windowSec: 60 },
  club_join: { maxPerWindow: 10, windowSec: 60 },
  // Chunk 4
  club_update: { maxPerWindow: 30, windowSec: 60 },
  club_members_list: { maxPerWindow: 60, windowSec: 60 },
  club_kick: { maxPerWindow: 10, windowSec: 60 },
  club_promote: { maxPerWindow: 10, windowSec: 60 },
  club_demote: { maxPerWindow: 10, windowSec: 60 },
  club_leave: { maxPerWindow: 10, windowSec: 60 },
} as const;

// Placeholder blocked-words list — real moderation lands Chunk 5/6.
const BLOCKED_WORDS: ReadonlySet<string> = new Set<string>([
  'admin', 'moderator', 'support', 'system',
]);



function parseBody(body: string): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed;
  return { ok: true, data: parsed.value as Record<string, unknown> };
}

function checkRateOrLimit(
  nk: INakama,
  logger: ILogger,
  rpcName: keyof typeof CLUB_RATE_LIMITS,
  userId: string,
): Resp<unknown> | null {
  const opts = CLUB_RATE_LIMITS[rpcName];
  const verdict = checkRateLimit(nk, {
    rpcName,
    userId,
    maxPerWindow: opts.maxPerWindow,
    windowSec: opts.windowSec,
  });
  if (!verdict.allowed) {
    logger.warn(
      '%s rate limit exceeded user=%s %d/%d',
      rpcName, userId, verdict.count, verdict.limit,
    );
    return err(
      'RATE_LIMITED',
      `${rpcName} rate limit exceeded (${verdict.count}/${verdict.limit})`,
    );
  }
  return null;
}

// ─── Pure validators ─────────────────────────────────────────────────────────

function isAsciiPrintable(s: string): boolean {
  // Forbid control chars; allow letters, digits, common punctuation.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

export function validateClubName(name: unknown): { ok: true; value: string } | { ok: false; code: string; message: string } {
  if (typeof name !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', message: 'name is required' };
  }
  const trimmed = name.trim();
  if (trimmed.length < CLUB_NAME_MIN_LEN || trimmed.length > CLUB_NAME_MAX_LEN) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: `name must be ${CLUB_NAME_MIN_LEN}..${CLUB_NAME_MAX_LEN} chars`,
    };
  }
  if (!isAsciiPrintable(trimmed)) {
    return { ok: false, code: 'BAD_REQUEST', message: 'name must be printable ASCII' };
  }
  if (containsBlockedWord(trimmed)) {
    return { ok: false, code: 'BAD_REQUEST', message: 'name contains blocked word' };
  }
  return { ok: true, value: trimmed };
}

export function validateClubMotto(motto: unknown): { ok: true; value: string } | { ok: false; code: string; message: string } {
  if (typeof motto !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', message: 'motto is required' };
  }
  const trimmed = motto.trim();
  if (trimmed.length < CLUB_MOTTO_MIN_LEN || trimmed.length > CLUB_MOTTO_MAX_LEN) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: `motto must be ${CLUB_MOTTO_MIN_LEN}..${CLUB_MOTTO_MAX_LEN} chars`,
    };
  }
  if (!isAsciiPrintable(trimmed)) {
    return { ok: false, code: 'BAD_REQUEST', message: 'motto must be printable ASCII' };
  }
  if (containsBlockedWord(trimmed)) {
    return { ok: false, code: 'BAD_REQUEST', message: 'motto contains blocked word' };
  }
  return { ok: true, value: trimmed };
}

/** Case-insensitive blocked-word check. */
function containsBlockedWord(s: string): boolean {
  const lower = s.toLowerCase();
  for (const word of BLOCKED_WORDS) {
    if (lower.includes(word)) return true;
  }
  return false;
}

// ─── club_create ──────────────────────────────────────────────────────────────

export function club_create_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_create', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  // Lifetime cap: 1 club_create per user.
  const existingCap = readClubCreated(nk, caller.id);
  if (existingCap !== null) {
    return toJson(err('CONFLICT', 'user has already created a club', { existingClubId: existingCap.record.clubId }));
  }

  // Level check.
  const profile = readProfile(nk, caller.id);
  const level = profile !== null && profile.progression !== undefined
    ? profile.progression.level
    : 1;
  if (typeof level !== 'number' || level < CLUB_MIN_LEVEL_TO_CREATE) {
    return toJson(err('FORBIDDEN', `level ${CLUB_MIN_LEVEL_TO_CREATE} required to create a club`));
  }

  // Body validation.
  const nameRes = validateClubName(parsed.data.name);
  if (!nameRes.ok) return toJson(err(nameRes.code as 'BAD_REQUEST', nameRes.message));
  const mottoRes = validateClubMotto(parsed.data.motto);
  if (!mottoRes.ok) return toJson(err(mottoRes.code as 'BAD_REQUEST', mottoRes.message));

  const emblemId = parsed.data.emblemId;
  if (typeof emblemId !== 'string' || emblemId.length === 0) {
    return toJson(err('BAD_REQUEST', 'emblemId is required'));
  }
  const emblem = getEmblema(emblemId);
  if (emblem === null) {
    return toJson(err('BAD_REQUEST', 'unknown emblemId'));
  }

  const region = parsed.data.region;
  if (typeof region !== 'string' || region.length === 0) {
    return toJson(err('BAD_REQUEST', 'region is required'));
  }

  const minDivisionRaw = parsed.data.minDivision;
  const minDivision = typeof minDivisionRaw === 'string' && minDivisionRaw.length > 0
    ? minDivisionRaw
    : CLUB_DEFAULT_MIN_DIVISION;

  // One club per player: a member of another club cannot found one.
  if (readMembership(nk, caller.id) !== null) {
    return toJson(err('CONFLICT', 'already in a club; leave it first', { reason: 'ALREADY_IN_CLUB' }));
  }

  // Name uniqueness via nk.groupsList(name); groupCreate refuses a
  // duplicate too (a concurrent create of the same name).
  const dup = findGroupByName(nk, nameRes.value);
  if (dup !== null) {
    return toJson(err('CONFLICT', 'a club with that name already exists'));
  }

  // Create the Nakama group FIRST (we need its id for the metadata): the
  // caller is its superadmin. It is CLOSED: the client JoinGroup API would
  // only file a join request, and the before-hook refuses it anyway; the
  // way in is `club_join` (plan T-21).
  let group: IGroup;
  try {
    group = nk.groupCreate(
      caller.id,
      nameRes.value,
      caller.id,
      'es',
      mottoRes.value,
      '',
      false, // closed
      {
        emblemId,
        region,
        minDivision,
        createdBy: caller.id,
      },
      CLUB_MAX_MEMBERS,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.indexOf('already exists') >= 0) {
      return toJson(err('CONFLICT', 'a club with that name already exists'));
    }
    logger.error('club_create: groupCreate failed: %s', msg);
    return toJson(err('INTERNAL', 'failed to create club group'));
  }

  // Charge 5000 coins and write the metadata, the lifetime counter and
  // the leader's membership row in ONE transaction (T-11 wallet helper):
  // no charge without a club, no club without a charge. The counter and
  // the membership row are create-only, so a concurrent create (or join)
  // loses the CAS and nothing is charged. On failure the group goes too.
  const cost = CLUB_DEFAULT_CREATE_COST_COINS;
  const now = Date.now();
  const meta: ClubMetadata = {
    schemaVersion: 1,
    clubId: group.id,
    leaderId: caller.id,
    motto: mottoRes.value,
    emblemId,
    region,
    minDivision,
    weeklyPoints: 0,
    createdAt: now,
  };
  const leader: MemberRecord = {
    schemaVersion: 1,
    clubId: group.id,
    userId: caller.id,
    role: 'leader',
    joinedAt: now,
    weeklyContribution: 0,
  };
  const spendResult = spend(
    nk,
    caller.id,
    { coins: cost },
    {
      reason: 'club',
      sourceId: caller.id,
    },
    // The group is in the key: wallet keys are durable (T-11), and a
    // player who left a club may found another one.
    `club_create:${caller.id}:${group.id}`,
    {
      extraWrites: [
        clubMetadataWrite(meta, '*'),
        clubCreatedWrite({ schemaVersion: 1, userId: caller.id, clubId: group.id, createdAt: now }),
        memberWrite(leader, '*'),
      ],
    },
  );
  if (!spendResult.ok) {
    try { nk.groupDelete(group.id); } catch { /* best-effort */ }
    return toJson(spendResult);
  }
  const newBalance = spendResult.data;

  emit(nk, logger, 'club_created', {
    clubId: group.id,
    name: nameRes.value,
    emblemId,
    region,
  }, { userId: caller.id });

  const out: ClubCreateOutput = {
    clubId: group.id,
    name: nameRes.value,
    costPaid: cost,
    newBalance,
  };
  return toJson(ok(out));
}

/** Characters the 3.27 ILIKE name filter treats as wildcards. */
function stripLikeWildcards(s: string): string {
  return s.split('%').join('').split('_').join('').split('\\').join('');
}

/**
 * Exact-name duplicate via `nk.groupsList(name)`: the 3.27 name filter is
 * an ILIKE pattern, so a name without wildcards matches case-insensitively.
 */
export function findGroupByName(
  nk: INakama,
  name: string,
): IGroup | null {
  const pattern = stripLikeWildcards(name);
  if (pattern.length === 0) return null;
  const res = nk.groupsList(pattern, null, null, null, 50, null);
  const lower = name.toLowerCase();
  for (const g of res.groups ?? []) {
    if (g.name.toLowerCase() === lower) return g;
  }
  return null;
}

// ─── club_get ─────────────────────────────────────────────────────────────────

export function club_get_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_get', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const clubId = parsed.data.clubId;
  if (typeof clubId !== 'string' || clubId.length === 0) {
    return toJson(err('BAD_REQUEST', 'clubId is required'));
  }

  // Phase 7 Chunk 5: lazy weekly reset. The first call after a
  // Monday-boundary owns the weekly reward; every other call is a
  // cheap same-week no-op. We re-read meta after the reset so the
  // returned view reflects `weeklyPoints=0` when the week just rolled.
  ensureWeekBoundary(nk, logger, clubId);

  const meta = readClubMetadata(nk, clubId);
  if (meta === null) {
    return toJson(err('NOT_FOUND', 'no club with that id'));
  }

  const group: IGroup | null = readClubGroup(nk, clubId);
  if (group === null) {
    return toJson(err('NOT_FOUND', 'no club with that id'));
  }

  // The leader preview, with the real username (audit 07 f14).
  const nameCache = new Map<string, string>();
  const members: ClubMemberView[] = [{
    userId: meta.record.leaderId,
    isLeader: true,
    username: resolveUsername(nk, meta.record.leaderId, nameCache),
  }];
  const view = buildClubView(group, meta.record, group.edgeCount);

  const out: ClubGetOutput = {
    club: view,
    members,
    weeklyRank: null,
  };
  return toJson(ok(out));
}

// ─── club_search ──────────────────────────────────────────────────────────────

export function club_search_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_search', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const limitRaw = parsed.data.limit;
  const limitN = typeof limitRaw === 'number' ? Math.min(50, Math.max(1, Math.floor(limitRaw))) : 20;
  const cursor = typeof parsed.data.cursor === 'string' ? parsed.data.cursor : '';
  const namePrefix = typeof parsed.data.name === 'string' ? parsed.data.name : '';
  const regionFilter = typeof parsed.data.region === 'string' ? parsed.data.region : '';

  // 3.27: groupsList(name, langTag, open, edgeCount, limit, cursor); the
  // name filter is an ILIKE pattern, so a prefix search appends '%'
  // (the old (limit, cursor, name) call answered HTTP 500).
  const pattern = stripLikeWildcards(namePrefix);
  let res: IGroupList;
  try {
    res = nk.groupsList(pattern.length > 0 ? `${pattern}%` : null, null, null, null, limitN, cursor.length > 0 ? cursor : null);
  } catch (e) {
    if (cursor.length > 0) return toJson(err('BAD_REQUEST', 'invalid cursor'));
    logger.error('club_search: groupsList failed: %s', e instanceof Error ? e.message : String(e));
    return toJson(err('INTERNAL', 'club search failed'));
  }
  const groups: IGroup[] = res.groups ?? [];
  const nextCursor = res.cursor ?? '';

  // Phase 7 Chunk 5: lazy weekly reset for each club returned (the first
  // call after a boundary owns the weekly reward), then one metadata read.
  for (const g of groups) ensureWeekBoundary(nk, logger, g.id);
  const metas = readClubMetadataMany(nk, groups.map((g) => g.id));
  const views: ClubView[] = [];
  for (const g of groups) {
    const meta = metas.get(g.id);
    if (meta === undefined) continue;
    if (regionFilter.length > 0 && meta.record.region !== regionFilter) continue;
    views.push(buildClubView(g, meta.record, g.edgeCount));
  }

  const out: ClubSearchOutput = {
    clubs: views,
    nextCursor,
  };
  return toJson(ok(out));
}

// ─── club_join ────────────────────────────────────────────────────────────────

/**
 * Join a club (plan T-21; audit PC-13, 07 f1). The rules are the ones the
 * native JoinGroup hook applies (`clubs/join.ts`): one club per player,
 * room left, level 8, minimum division, no block with the leader or an
 * admin. The caller lands as `member` and shows in `club_members_list`.
 *
 * Errors: BAD_REQUEST (clubId), NOT_FOUND, CONFLICT (`details.reason`
 * ALREADY_MEMBER | ALREADY_IN_CLUB | CLUB_FULL), FORBIDDEN (`details.reason`
 * BLOCKED | MIN_LEVEL | MIN_DIVISION), RATE_LIMITED, SERVICE_UNAVAILABLE.
 */
export function club_join_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_join', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const clubId = parsed.data.clubId;
  if (typeof clubId !== 'string' || clubId.length === 0) {
    return toJson(err('BAD_REQUEST', 'clubId is required'));
  }

  const joined = joinClub(nk, logger, caller.id, clubId, Date.now());
  if (!joined.ok) return toJson(joined);

  emit(nk, logger, 'club_joined', { clubId }, { userId: caller.id });
  return toJson(ok<ClubJoinOutput>(joined.data));
}

// ─── Pure helper exposed for unit tests ──────────────────────────────────────

export { checkClubJoinGate };

// Touch emblems array to keep imports warm.
void getEmblemas;

// ════════════════════════════════════════════════════════════════════════════
// Phase 7 Chunk 4 — Membership + roles + updates (6 RPCs).
//
// All 6 RPCs share the same caller-resolution + maintenance gate +
// per-RPC rate limit pattern as Chunk 3. Permission checks use the
// pure `roles.ts` helpers + the `readMember` storage helper.
// ════════════════════════════════════════════════════════════════════════════

// ─── Reused helpers (private to this file) ──────────────────────────────────

function memberRecordFromRead(
  meta: { record: ClubMetadata; version: string },
  members: { userId: string; role: Role; joinedAt: number; weeklyContribution: number }[],
): MemberRecord | null {
  // Find the leader row among the read members; the leader identity
  // lives in `meta.record.leaderId`. If the leader row is missing
  // (e.g. a stale metadata row after Chunk 4 migration), we return
  // null so callers can synthesise from metadata.
  const m = members.find((x) => x.userId === meta.record.leaderId);
  if (m === undefined) return null;
  return {
    schemaVersion: 1,
    clubId: meta.record.clubId,
    userId: m.userId,
    role: m.role,
    joinedAt: m.joinedAt,
    weeklyContribution: m.weeklyContribution,
  };
}

function readActorRole(
  nk: INakama,
  clubId: string,
  userId: string,
): Role | null {
  const m = readMember(nk, clubId, userId);
  return m !== null ? m.record.role : null;
}
void readActorRole;

function readTargetRole(
  nk: INakama,
  clubId: string,
  userId: string,
): { role: Role; version: string } | null {
  const m = readMember(nk, clubId, userId);
  return m !== null ? { role: m.record.role, version: m.version } : null;
}

/**
 * Role names a client may send. The Unity adapter says `officer` for the
 * server's `admin` (accepted as an alias, D-05 additive).
 */
function normaliseRole(raw: unknown): unknown {
  return raw === 'officer' ? 'admin' : raw;
}

// ─── club_update ────────────────────────────────────────────────────────────

export function club_update_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_update', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const clubId = parsed.data.clubId;
  if (typeof clubId !== 'string' || clubId.length === 0) {
    return toJson(err('BAD_REQUEST', 'clubId is required'));
  }

  // Validate fields.
  const fields: { motto?: string; emblemId?: string; minDivision?: string } = {};
  if (parsed.data.motto !== undefined) {
    const r = validateClubMotto(parsed.data.motto);
    if (!r.ok) return toJson(err(r.code as 'BAD_REQUEST', r.message));
    fields.motto = r.value;
  }
  if (parsed.data.emblemId !== undefined) {
    if (typeof parsed.data.emblemId !== 'string' || parsed.data.emblemId.length === 0) {
      return toJson(err('BAD_REQUEST', 'emblemId must be a non-empty string'));
    }
    if (getEmblema(parsed.data.emblemId) === null) {
      return toJson(err('BAD_REQUEST', 'unknown emblemId'));
    }
    fields.emblemId = parsed.data.emblemId;
  }
  if (parsed.data.minDivision !== undefined) {
    if (typeof parsed.data.minDivision !== 'string' || parsed.data.minDivision.length === 0) {
      return toJson(err('BAD_REQUEST', 'minDivision must be a non-empty string'));
    }
    fields.minDivision = parsed.data.minDivision;
  }
  if (Object.keys(fields).length === 0) {
    return toJson(err('BAD_REQUEST', 'at least one field to update is required'));
  }

  const meta = readClubMetadata(nk, clubId);
  if (meta === null) return toJson(err('NOT_FOUND', 'no club with that id'));

  const actorRole = readActorRole(nk, clubId, caller.id);
  const decision = canUpdateClub(actorRole, fields);
  if (!decision.allowed) {
    return toJson(err('FORBIDDEN', `not allowed to update ${String(decision.deniedField)}`));
  }

  const next: ClubMetadata = {
    ...meta.record,
    motto: fields.motto ?? meta.record.motto,
    emblemId: fields.emblemId ?? meta.record.emblemId,
    minDivision: fields.minDivision ?? meta.record.minDivision,
  };
  writeClubMetadataUpdate(nk, next, meta.version);

  emit(nk, logger, 'club_updated', {
    clubId, fields: Object.keys(fields),
  }, { userId: caller.id });

  const out: ClubUpdateOutput = { clubId, updatedAt: Date.now() };
  return toJson(ok(out));
}

// ─── club_members_list ──────────────────────────────────────────────────────

export function club_members_list_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_members_list', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const clubId = parsed.data.clubId;
  if (typeof clubId !== 'string' || clubId.length === 0) {
    return toJson(err('BAD_REQUEST', 'clubId is required'));
  }

  if (readClubMetadata(nk, clubId) === null) {
    return toJson(err('NOT_FOUND', 'no club with that id'));
  }

  const limitRaw = parsed.data.limit;
  const limitN = typeof limitRaw === 'number'
    ? Math.min(100, Math.max(1, Math.floor(limitRaw)))
    : 50;
  const cursor = typeof parsed.data.cursor === 'string' ? parsed.data.cursor : '';

  // The whole roster (the group, paged by the runtime cursor, joined with
  // the membership rows: at most 30). Stable order: leader, admins, then
  // members by joinedAt, ties by user id.
  const all = readClubMembers(nk, clubId);
  const order: Record<Role, number> = { leader: 0, admin: 1, member: 2 };
  all.sort((a, b) =>
    order[a.record.role] - order[b.record.role]
    || a.record.joinedAt - b.record.joinedAt
    || (a.record.userId < b.record.userId ? -1 : a.record.userId > b.record.userId ? 1 : 0));

  // Cursor = offset into that order. It was the last joinedAt, which
  // skipped or repeated members on ties and across roles (the flaky
  // `club_membership_flow` cursor test).
  let startIdx = 0;
  if (cursor.length > 0) {
    const n = Number(cursor);
    if (!Number.isInteger(n) || n < 0) return toJson(err('BAD_REQUEST', 'invalid cursor'));
    startIdx = Math.min(n, all.length);
  }
  const page = all.slice(startIdx, startIdx + limitN);
  const nextCursor = (startIdx + page.length < all.length) ? String(startIdx + page.length) : '';

  const nameCache = new Map<string, string>();
  const members: ClubMemberViewV2[] = page.map((m) => {
    let level: number | null = null;
    let avatarUrl: string | null = null;
    try {
      const profile = readProfile(nk, m.record.userId);
      if (profile !== null) {
        level = profile.progression?.level ?? null;
        avatarUrl = profile.avatarUrl ?? null;
      }
    } catch { /* best-effort */ }
    return {
      userId: m.record.userId,
      username: resolveUsername(nk, m.record.userId, nameCache),
      avatarUrl,
      role: m.record.role,
      level,
      weeklyContribution: m.record.weeklyContribution,
      joinedAt: m.record.joinedAt,
    };
  });

  const out: ClubMembersListOutput = { members, nextCursor };
  return toJson(ok(out));
}

// ─── club_kick ──────────────────────────────────────────────────────────────

export function club_kick_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_kick', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const clubId = parsed.data.clubId;
  const targetUserId = parsed.data.targetUserId;
  if (typeof clubId !== 'string' || clubId.length === 0) {
    return toJson(err('BAD_REQUEST', 'clubId is required'));
  }
  if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'targetUserId is required'));
  }

  if (readClubMetadata(nk, clubId) === null) {
    return toJson(err('NOT_FOUND', 'no club with that id'));
  }

  const actor = readMember(nk, clubId, caller.id);
  const target = readMember(nk, clubId, targetUserId);
  const verdict = canKickMember(
    actor !== null ? { role: actor.record.role } : null,
    target !== null ? { role: target.record.role } : null,
  );
  if (!verdict.allowed) {
    if (verdict.reason === 'self_kick') return toJson(err('CONFLICT', 'use club_leave to exit'));
    if (verdict.reason === 'cannot_kick_leader') return toJson(err('CONFLICT', 'must transfer leadership first'));
    if (verdict.reason === 'admin_cannot_kick_admin') return toJson(err('FORBIDDEN', 'only the leader can kick admins'));
    if (verdict.reason === 'target_not_member') return toJson(err('NOT_FOUND', 'target is not a member'));
    return toJson(err('FORBIDDEN', 'no permission to kick'));
  }

  removeClubMember(nk, logger, target!);

  emit(nk, logger, 'club_kicked', {
    clubId, targetUserId, by: caller.id,
  }, { userId: caller.id });

  const out: ClubKickOutput = { removed: true, clubId, targetUserId };
  return toJson(ok(out));
}

// ─── club_promote (atomic leader swap when `to === 'leader'`) ──────────────

export function club_promote_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_promote', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const clubId = parsed.data.clubId;
  const targetUserId = parsed.data.targetUserId;
  const to = normaliseRole(parsed.data.to);
  if (typeof clubId !== 'string' || clubId.length === 0) {
    return toJson(err('BAD_REQUEST', 'clubId is required'));
  }
  if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'targetUserId is required'));
  }
  if (to !== 'admin' && to !== 'leader') {
    return toJson(err('BAD_REQUEST', 'to must be admin or leader'));
  }

  const meta = readClubMetadata(nk, clubId);
  if (meta === null) return toJson(err('NOT_FOUND', 'no club with that id'));

  const actor = readMember(nk, clubId, caller.id);
  const target = readMember(nk, clubId, targetUserId);
  const verdict = canPromoteTo(
    actor !== null ? { role: actor.record.role } : null,
    target !== null ? { role: target.record.role } : null,
    to,
  );
  if (!verdict.allowed) {
    if (verdict.reason === 'not_leader') return toJson(err('FORBIDDEN', 'only the leader can promote'));
    if (verdict.reason === 'target_not_member') return toJson(err('NOT_FOUND', 'target is not a member'));
    if (verdict.reason === 'already_role') return toJson(err('BAD_REQUEST', 'target already has that role'));
    return toJson(err('FORBIDDEN', 'cannot promote'));
  }

  // Promotion path. CAS retry loop in case someone else wrote in between.
  if (to === 'admin') {
    let lastVersion = target!.version;
    let fresh: { record: MemberRecord; version: string } | null = target;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const nextTarget: MemberRecord = { ...fresh!.record, role: 'admin' };
      try {
        lastVersion = writeMemberUpdate(nk, nextTarget, lastVersion);
        emit(nk, logger, 'club_promoted', {
          clubId, targetUserId, to: 'admin', by: caller.id,
        }, { userId: caller.id });
        const out: ClubPromoteOutput = { clubId, userId: targetUserId, role: 'admin' };
        return toJson(ok(out));
      } catch (e) {
        const reRead = readMember(nk, clubId, targetUserId);
        if (reRead === null) return toJson(err('NOT_FOUND', 'target row vanished'));
        if (reRead.record.role === 'admin') {
          const out: ClubPromoteOutput = { clubId, userId: targetUserId, role: 'admin' };
          return toJson(ok(out));
        }
        fresh = reRead;
        lastVersion = reRead.version;
        if (attempt === MAX_CAS_RETRIES - 1) {
          logger.warn('club_promote CAS retries exhausted: %s', e instanceof Error ? e.message : String(e));
          return toJson(err('INTERNAL', 'CAS retries exhausted'));
        }
      }
    }
    return toJson(err('INTERNAL', 'unreachable'));
  }

  // to === 'leader' — atomic transfer: both membership rows and the
  // metadata (system-owned, so its owner does not change) in one batch.
  const steps = applyTransfer(caller.id, targetUserId, target!.record.role);
  const writes = steps.map((s) => (s.userId === caller.id
    ? memberWrite({ ...actor!.record, role: s.to }, actor!.version)
    : memberWrite({ ...target!.record, role: s.to }, target!.version)));
  writes.push(clubMetadataWrite({ ...meta.record, leaderId: targetUserId }, meta.version));

  try {
    multiUpdateMembers(nk, writes);
  } catch (e) {
    logger.warn('club_promote leader transfer lost a CAS: %s', e instanceof Error ? e.message : String(e));
    return toJson(err('CONFLICT', 'the club changed meanwhile; please retry', { reason: 'VERSION_CONFLICT' }));
  }
  // The group superadmin follows the leadership, so a later kick of the
  // former leader (now admin) is not refused as "last superadmin".
  syncGroupLeader(nk, logger, clubId, targetUserId, caller.id);

  emit(nk, logger, 'club_promoted', {
    clubId, targetUserId, to: 'leader', by: caller.id,
  }, { userId: caller.id });

  const out: ClubPromoteOutput = { clubId, userId: targetUserId, role: 'leader' };
  return toJson(ok(out));
}

// ─── club_demote ────────────────────────────────────────────────────────────

export function club_demote_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_demote', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const clubId = parsed.data.clubId;
  const targetUserId = parsed.data.targetUserId;
  const to = normaliseRole(parsed.data.to);
  if (typeof clubId !== 'string' || clubId.length === 0) {
    return toJson(err('BAD_REQUEST', 'clubId is required'));
  }
  if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'targetUserId is required'));
  }
  if (to !== 'admin' && to !== 'member') {
    return toJson(err('BAD_REQUEST', 'to must be admin or member'));
  }

  if (readClubMetadata(nk, clubId) === null) {
    return toJson(err('NOT_FOUND', 'no club with that id'));
  }

  const actor = readMember(nk, clubId, caller.id);
  const target = readMember(nk, clubId, targetUserId);
  const verdict = canDemoteTo(
    actor !== null ? { role: actor.record.role } : null,
    target !== null ? { role: target.record.role } : null,
    to,
  );
  if (!verdict.allowed) {
    if (verdict.reason === 'not_leader') return toJson(err('FORBIDDEN', 'only the leader can demote'));
    if (verdict.reason === 'target_not_member') return toJson(err('NOT_FOUND', 'target is not a member'));
    if (verdict.reason === 'cannot_demote_leader') return toJson(err('CONFLICT', 'must transfer leadership first'));
    if (verdict.reason === 'cannot_demote_to_leader') return toJson(err('BAD_REQUEST', 'use promote to reach leader'));
    if (verdict.reason === 'already_role') return toJson(err('BAD_REQUEST', 'target already has that role'));
    return toJson(err('FORBIDDEN', 'cannot demote'));
  }

  const next: MemberRecord = { ...target!.record, role: to };
  writeMemberUpdate(nk, next, target!.version);

  emit(nk, logger, 'club_demoted', {
    clubId, targetUserId, to, by: caller.id,
  }, { userId: caller.id });

  const out: ClubDemoteOutput = { clubId, userId: targetUserId, role: to };
  return toJson(ok(out));
}

// ─── club_leave ─────────────────────────────────────────────────────────────

export function club_leave_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_leave', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const clubId = parsed.data.clubId;
  if (typeof clubId !== 'string' || clubId.length === 0) {
    return toJson(err('BAD_REQUEST', 'clubId is required'));
  }

  if (readClubMetadata(nk, clubId) === null) {
    return toJson(err('NOT_FOUND', 'no club with that id'));
  }

  const actor = readMember(nk, clubId, caller.id);
  const verdict = canLeave(
    actor !== null ? { role: actor.record.role } : null,
  );
  if (!verdict.allowed) {
    if (verdict.reason === 'leader_cannot_leave') return toJson(err('FORBIDDEN', 'leader must transfer leadership first'));
    return toJson(err('NOT_FOUND', 'not a member'));
  }

  removeClubMember(nk, logger, actor!);

  emit(nk, logger, 'club_left', {
    clubId, userId: caller.id,
  }, { userId: caller.id });

  const out: ClubLeaveOutput = { left: true, clubId, userId: caller.id };
  return toJson(ok(out));
}

// Touch memberRecordFromRead so esbuild keeps it.
void memberRecordFromRead;

// ─── Top-level bindings ──────────────────────────────────────────────────────

// Global names the 3.27 registration scanner resolves (main.ts). Each one
// loads the VM's runtime state first (plan T-29, D-11; audit N8).
export const club_create = withRuntime(club_create_impl);
export const club_get = withRuntime(club_get_impl);
export const club_search = withRuntime(club_search_impl);
export const club_join = withRuntime(club_join_impl);
export const club_update = withRuntime(club_update_impl);
export const club_members_list = withRuntime(club_members_list_impl);
export const club_kick = withRuntime(club_kick_impl);
export const club_promote = withRuntime(club_promote_impl);
export const club_demote = withRuntime(club_demote_impl);
export const club_leave = withRuntime(club_leave_impl);
