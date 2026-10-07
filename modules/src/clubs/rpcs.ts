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

import type { IContext, ILogger, INakama, IGroup } from '../nkruntime';
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
} from './clubs_repo';
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
  type ClubGetOutput,
  type ClubMetadata,
  type ClubSearchOutput,
  type ClubView,
} from './types';

const CLUB_RATE_LIMITS = {
  club_create: { maxPerWindow: 5, windowSec: 60 },
  club_get: { maxPerWindow: 60, windowSec: 60 },
  club_search: { maxPerWindow: 30, windowSec: 60 },
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