// Phase 7 Chunk 3 — Clubs RPCs (3):
//   - club_create  — spend 5000 coins, create Nakama group + metadata
//   - club_get     — fetch club + member preview
//   - club_search  — paginated search by name prefix
//
// All 3 RPCs are gated by `assertNotInMaintenance`.
//
// Errors (per peer spec):
//   - club_create: BAD_REQUEST, FORBIDDEN (level<8), INSUFFICIENT_FUNDS,
//                  RATE_LIMITED, CONFLICT (name taken, lifetime cap hit)
//   - club_get:    BAD_REQUEST (clubId missing), NOT_FOUND
//   - club_search: BAD_REQUEST (limit too big)
//
// Blocked-words check on motto is a placeholder list (defer real
// moderation to Chunk 5/6). Name uniqueness is checked via
// `nk.groupsList(name)` which scans all groups server-side.

import type { IContext, ILogger, INakama, IGroup, IStorageObject } from '../nkruntime';
import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import { parseInput } from '../core/parse_input';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import { spend } from '../economy/wallet';
import { readProfile } from '../profiles/storage';
import {
  buildClubView,
  buildMemberView,
  checkClubJoinGate,
  readClubCreated,
  readClubGroup,
  readClubMetadata,
  writeClubCreated,
  writeClubMetadataCreate,
  writeClubMetadataUpdate,
} from './clubs_repo';
import {
  CLUBS_MEMBERS_COLLECTION,
  MAX_CAS_RETRIES,
  deleteMember,
  multiUpdateMembers,
  readClubMembers,
  readMember,
  resolveUsername,
  writeMemberCreate,
  writeMemberUpdate,
} from './members_repo';
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
  type ClubMemberViewV2,
  type ClubMetadata,
  type ClubPromoteOutput,
  type ClubSearchOutput,
  type ClubUpdateOutput,
  type ClubView,
  type MemberRecord,
  type Role,
} from './types';

const CLUB_RATE_LIMITS = {
  club_create: { maxPerWindow: 5, windowSec: 60 },
  club_get: { maxPerWindow: 60, windowSec: 60 },
  club_search: { maxPerWindow: 30, windowSec: 60 },
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

interface CallerOk { ok: true; id: string; }
interface CallerErr { ok: false; error: string; }

function resolveCaller(
  ctx: IContext,
  declared: unknown,
  logger: ILogger,
): CallerOk | CallerErr {
  const socketCaller = ctx.userId ?? null;
  const declaredCaller =
    typeof declared === 'string' && declared.length > 0 ? declared : null;
  if (socketCaller !== null) {
    if (declaredCaller !== null && declaredCaller !== socketCaller) {
      return {
        ok: false,
        error: toJson(err('FORBIDDEN', 'callerUserId does not match authenticated user')),
      };
    }
    return { ok: true, id: socketCaller };
  }
  if (declaredCaller !== null) return { ok: true, id: declaredCaller };
  logger.warn('club RPC called with no caller identity');
  return { ok: false, error: toJson(err('UNAUTHENTICATED', 'no caller identity')) };
}

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

export function club_create(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
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

  // Name uniqueness scan via nk.groupsList(name).
  const dup = findGroupByName(nk, nameRes.value);
  if (dup !== null) {
    return toJson(err('CONFLICT', 'a club with that name already exists'));
  }

  // Create the Nakama group FIRST. The caller is auto-joined as
  // superadmin by Nakama on creation. We need a real `groupId` before
  // we can persist metadata, so we must do this before any spend.
  let group: IGroup;
  let groupCreateSucceeded = false;
  try {
    const created = nk.groupCreate(
      nameRes.value,
      mottoRes.value,
      'es',
      {
        emblemId,
        region,
        minDivision,
        createdBy: caller.id,
      },
      CLUB_MAX_MEMBERS,
      true, // open
    );
    group = created.group;
    groupCreateSucceeded = true;
  } catch (e) {
    logger.error(
      'club_create: groupCreate failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to create club group'));
  }

  // Spend 5000 coins. On failure, delete the orphan group so the
  // caller doesn't see a phantom club.
  const cost = CLUB_DEFAULT_CREATE_COST_COINS;
  const spendResult = spend(
    nk,
    caller.id,
    { coins: cost },
    {
      reason: 'club',
      sourceId: caller.id,
    },
    `club_create:${caller.id}`,
  );
  if (!spendResult.ok) {
    if (groupCreateSucceeded) {
      try { nk.groupDelete(group.groupId); } catch { /* best-effort */ }
    }
    return toJson(spendResult);
  }
  const newBalance = spendResult.data.coins;

  // Persist metadata + lifetime counter.
  const now = Date.now();
  const meta: ClubMetadata = {
    schemaVersion: 1,
    clubId: group.groupId,
    leaderId: caller.id,
    motto: mottoRes.value,
    emblemId,
    region,
    minDivision,
    weeklyPoints: 0,
    createdAt: now,
  };
  try {
    writeClubMetadataCreate(nk, meta);
    writeClubCreated(nk, {
      schemaVersion: 1,
      userId: caller.id,
      clubId: group.groupId,
      createdAt: now,
    });
  } catch (e) {
    logger.error(
      'club_create: metadata write failed: %s — group %s and charge %d coins retained; manual cleanup required',
      e instanceof Error ? e.message : String(e),
      group.groupId, cost,
    );
    return toJson(err('INTERNAL', 'failed to persist club metadata'));
  }

  emit(nk, logger, 'club_created', {
    clubId: group.groupId,
    name: nameRes.value,
    emblemId,
    region,
  }, { userId: caller.id });

  const out: ClubCreateOutput = {
    clubId: group.groupId,
    name: nameRes.value,
    costPaid: cost,
    newBalance,
  };
  return toJson(ok(out));
}

/**
 * Linear scan via `nk.groupsList(name)` for an exact-name duplicate.
 * `groupsList(name)` filters server-side on the `name` query param —
 * returns groups whose name starts with the substring. The caller
 * still compares the full string client-side.
 */
export function findGroupByName(
  nk: INakama,
  name: string,
): IGroup | null {
  const res = nk.groupsList(50, '', name);
  const list = Array.isArray(res) ? res : (res as { groups?: IGroup[] }).groups ?? [];
  for (const g of list) {
    if (typeof g === 'object' && g !== null && 'name' in g && (g as IGroup).name === name) {
      return g as IGroup;
    }
  }
  return null;
}

// ─── club_get ─────────────────────────────────────────────────────────────────

export function club_get(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_get', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const clubId = parsed.data.clubId;
  if (typeof clubId !== 'string' || clubId.length === 0) {
    return toJson(err('BAD_REQUEST', 'clubId is required'));
  }

  const meta = readClubMetadata(nk, clubId);
  if (meta === null) {
    return toJson(err('NOT_FOUND', 'no club with that id'));
  }

  // Read members via nk.groupUsersList.
  let memberCount = 1;
  let leaderUsername = 'unknown';
  try {
    const res = nk.groupUsersList(clubId, 50, '') as unknown;
    const list = Array.isArray(res) ? res : ((res as { groupUsers?: unknown[] }).groupUsers ?? []);
    memberCount = list.length;
    // First user with creator flag or matching meta.leaderId is the leader.
    for (const m of list) {
      const entry = m as { user?: { userId: string; username?: string } };
      if (entry?.user?.userId === meta.record.leaderId) {
        leaderUsername = entry.user.username ?? 'unknown';
        break;
      }
    }
  } catch (e) {
    logger.warn(
      'club_get: groupUsersList failed: %s',
      e instanceof Error ? e.message : String(e),
    );
  }

  // Look up the actual Nakama group for the real name + description.
  // Fall back to a synthetic group from metadata when not found
  // (group was deleted but metadata lingers).
  let group: IGroup | null = readClubGroup(nk, clubId);
  if (group === null) {
    group = {
      groupId: meta.record.clubId,
      creatorUserId: meta.record.leaderId,
      name: leaderUsername === 'unknown' ? meta.record.clubId : leaderUsername,
      description: meta.record.motto,
      metadata: {
        emblemId: meta.record.emblemId,
        region: meta.record.region,
        minDivision: meta.record.minDivision,
      },
      maxCount: CLUB_MAX_MEMBERS,
      open: true,
    };
  }

  const view = buildClubView(group, meta.record, memberCount);
  const members = buildMemberView(
    [{ userId: meta.record.leaderId }],
    meta.record.leaderId,
  );

  const out: ClubGetOutput = {
    club: view,
    members,
    weeklyRank: null,
  };
  return toJson(ok(out));
}

// ─── club_search ──────────────────────────────────────────────────────────────

export function club_search(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
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

  // nk.groupsList signature: (limit, cursor, nameFilter).
  const res = nk.groupsList(limitN, cursor, namePrefix) as unknown;
  let groups: IGroup[] = [];
  let nextCursor = '';
  if (Array.isArray(res)) {
    groups = res as IGroup[];
  } else if (res && typeof res === 'object') {
    const r = res as { groups?: IGroup[]; cursor?: string };
    groups = Array.isArray(r.groups) ? r.groups : [];
    nextCursor = typeof r.cursor === 'string' ? r.cursor : '';
  }

  const views: ClubView[] = [];
  for (const g of groups) {
    const meta = readClubMetadata(nk, g.groupId);
    if (meta === null) continue;
    if (regionFilter.length > 0 && meta.record.region !== regionFilter) continue;
    views.push(buildClubView(g, meta.record, 1));
  }

  const out: ClubSearchOutput = {
    clubs: views,
    nextCursor,
  };
  return toJson(ok(out));
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

// ─── club_update ────────────────────────────────────────────────────────────

export function club_update(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
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

export function club_members_list(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
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

  const all = readClubMembers(nk, clubId);
  // Stable order: leader first, then admins, then members by joinedAt asc.
  const order: Record<Role, number> = { leader: 0, admin: 1, member: 2 };
  all.sort((a, b) => {
    const roleDiff = order[a.record.role] - order[b.record.role];
    if (roleDiff !== 0) return roleDiff;
    return a.record.joinedAt - b.record.joinedAt;
  });

  // Cursor = joinedAt of the last item we've returned.
  let startIdx = 0;
  if (cursor.length > 0) {
    const cursorAt = Number(cursor);
    if (Number.isFinite(cursorAt)) {
      startIdx = all.findIndex((m) => m.record.joinedAt > cursorAt);
      if (startIdx === -1) startIdx = all.length;
    }
  }
  const page = all.slice(startIdx, startIdx + limitN);
  const nextCursor = (startIdx + page.length < all.length)
    ? String(page[page.length - 1]!.record.joinedAt)
    : '';

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

export function club_kick(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
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

  deleteMember(nk, clubId, targetUserId, target!.version);

  emit(nk, logger, 'club_kicked', {
    clubId, targetUserId, by: caller.id,
  }, { userId: caller.id });

  const out: ClubKickOutput = { removed: true, clubId, targetUserId };
  return toJson(ok(out));
}

// ─── club_promote (atomic leader swap when `to === 'leader'`) ──────────────

export function club_promote(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_promote', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const clubId = parsed.data.clubId;
  const targetUserId = parsed.data.targetUserId;
  const to = parsed.data.to;
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

  // to === 'leader' — atomic transfer.
  const steps = applyTransfer(caller.id, targetUserId, target!.record.role);
  const writes: IStorageObject[] = steps.map((s) => {
    if (s.userId === caller.id) {
      return {
        collection: CLUBS_MEMBERS_COLLECTION,
        key: clubId,
        userId: caller.id,
        value: { ...actor!.record, role: s.to } as unknown as Record<string, unknown>,
        permissionRead: 1,
        permissionWrite: 1,
        version: actor!.version,
      };
    }
    return {
      collection: CLUBS_MEMBERS_COLLECTION,
      key: clubId,
      userId: targetUserId,
      value: { ...target!.record, role: s.to } as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 1,
      version: target!.version,
    };
  });
  // Also bump metadata.leaderId in the same batch.
  writes.push({
    collection: 'clubs_metadata',
    key: clubId,
    userId: meta.record.leaderId,
    value: { ...meta.record, leaderId: targetUserId } as unknown as Record<string, unknown>,
    permissionRead: 2,
    permissionWrite: 1,
    version: meta.version,
  });

  multiUpdateMembers(nk, writes);

  emit(nk, logger, 'club_promoted', {
    clubId, targetUserId, to: 'leader', by: caller.id,
  }, { userId: caller.id });

  const out: ClubPromoteOutput = { clubId, userId: targetUserId, role: 'leader' };
  return toJson(ok(out));
}

// ─── club_demote ────────────────────────────────────────────────────────────

export function club_demote(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'club_demote', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const clubId = parsed.data.clubId;
  const targetUserId = parsed.data.targetUserId;
  const to = parsed.data.to;
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

export function club_leave(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
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

  deleteMember(nk, clubId, caller.id, actor!.version);

  emit(nk, logger, 'club_left', {
    clubId, userId: caller.id,
  }, { userId: caller.id });

  const out: ClubLeaveOutput = { left: true, clubId, userId: caller.id };
  return toJson(ok(out));
}

// Touch memberRecordFromRead so esbuild keeps it.
void memberRecordFromRead;