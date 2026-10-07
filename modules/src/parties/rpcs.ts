// Phase 7 Chunk 8 — Party RPCs (5):
//   - party_create   — leader creates a party, joins themselves.
//   - party_invite   — leader invites a friend (delegates to invites_repo).
//   - party_leave    — non-leader leaves; leader can leave ONLY when empty.
//   - party_kick     — leader removes a member.
//   - party_get      — fetch a party's roster (members-only).
//
// All 5 RPCs are gated by `assertNotInMaintenance` (player surface).
// Per-RPC rate limit: 30/min (the global `core/checkRateLimit`).
//
// `party_invite` deliberately writes directly to the invites
// collection (via `social/invites_repo`) instead of routing through
// `invite_send`, so the party metadata (`partyId`) is captured in the
// invite `payload`. Same block-check + leader-check applies. The
// invite's TTL = `INVITE_TTL_MS` (24h), matching Phase 7 Chunk 2.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import { parseInput } from '../core/parse_input';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import { isBlockedEitherWay } from '../social/blocks_repo';
import {
  writeInviteCreate,
} from '../social/invites_repo';
import {
  INVITE_TTL_MS,
  type InviteRecord,
} from '../social/types';
import {
  PARTY_DEFAULT_SIZE,
  PARTY_MAX_SIZE,
  PARTY_STATE_OPEN,
  VALID_PARTY_SIZES,
  asPartyCard,
  canAddMember,
  hasMember,
  isValidPartySize,
  type ActivePartyRecord,
  type PartyCard,
  type PartyMemberCard,
  type PartyRecord,
  type PartyState,
} from './types';
import {
  MAX_CAS_RETRIES,
  deleteActiveParty,
  deleteParty,
  joinParty,
  readActiveParty,
  readParty,
  writeActivePartyCreate,
  writePartyCreate,
  writePartyUpdate,
} from './parties_repo';

const PARTY_RPC_RATE = { maxPerWindow: 30, windowSec: 60 };

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

// ─── Caller plumbing ────────────────────────────────────────────────────────

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
  logger.warn('party RPC called with no caller identity');
  return {
    ok: false,
    error: toJson(err('UNAUTHENTICATED', 'no caller identity')),
  };
}

function checkRpcRate(
  nk: INakama,
  logger: ILogger,
  rpcName: string,
  userId: string,
): Resp<unknown> | null {
  const verdict = checkRateLimit(nk, {
    rpcName,
    userId,
    ...PARTY_RPC_RATE,
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

// ─── party_create ───────────────────────────────────────────────────────────

export interface PartyCreateRpcInput {
  callerUserId: string;
  /** Default 4. */
  maxSize?: 2 | 4 | 6;
}

export interface PartyCreateRpcOutput {
  partyId: string;
  leaderUserId: string;
  maxSize: 2 | 4 | 6;
  state: PartyState;
  createdAt: number;
  members: PartyMemberCard[];
}

export function party_create_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.raw['callerUserId'], logger);
  if (!caller.ok) return caller.error;

  const limit = checkRpcRate(nk, logger, 'party_create', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  // Caller must not already be in a party.
  const existing = readActiveParty(nk, caller.id);
  if (existing !== null) {
    return toJson(err('FORBIDDEN', 'caller is already in a party'));
  }

  const raw = parsed.raw;
  let maxSize: 2 | 4 | 6 = PARTY_DEFAULT_SIZE;
  if (raw['maxSize'] !== undefined) {
    if (!isValidPartySize(raw['maxSize'])) {
      return toJson(err('BAD_REQUEST', `maxSize must be one of: ${VALID_PARTY_SIZES.join(', ')}`));
    }
    maxSize = raw['maxSize'] as 2 | 4 | 6;
  }

  const nowMs = Date.now();
  const partyId = nk.uuidv4();
  const record: PartyRecord = {
    schemaVersion: 1,
    partyId,
    leaderUserId: caller.id,
    maxSize,
    state: PARTY_STATE_OPEN,
    createdAt: nowMs,
    members: [{ userId: caller.id, joinedAt: nowMs }],
  };
  try {
    writePartyCreate(nk, record);
  } catch (e) {
    logger.error(
      'party_create: writePartyCreate failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to persist party'));
  }

  // Active-party inverse index.
  const activeRec: ActivePartyRecord = {
    schemaVersion: 1,
    userId: caller.id,
    partyId,
    joinedAt: nowMs,
  };
  try {
    writeActivePartyCreate(nk, activeRec);
  } catch (e) {
    logger.error(
      'party_create: writeActivePartyCreate failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to persist active_party index'));
  }

  emit(nk, logger, 'party_created', {
    partyId,
    leaderUserId: caller.id,
    maxSize,
  }, { userId: caller.id });

  const out: PartyCreateRpcOutput = {
    partyId,
    leaderUserId: caller.id,
    maxSize,
    state: PARTY_STATE_OPEN,
    createdAt: nowMs,
    members: [{ userId: caller.id, joinedAt: nowMs }],
  };
  return toJson(ok(out));
}
export const party_create: RpcHandler = party_create_impl;

// ─── party_invite ───────────────────────────────────────────────────────────

export interface PartyInviteRpcInput {
  callerUserId: string;
  partyId: string;
  targetUserId: string;
}

export interface PartyInviteRpcOutput {
  inviteId: string;
  expiresAt: number;
  partyId: string;
  targetUserId: string;
}

export function party_invite_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.raw['callerUserId'], logger);
  if (!caller.ok) return caller.error;

  const limit = checkRpcRate(nk, logger, 'party_invite', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const raw = parsed.raw;
  const partyId = raw['partyId'];
  if (typeof partyId !== 'string' || partyId.length === 0) {
    return toJson(err('BAD_REQUEST', 'partyId is required'));
  }
  const targetUserId = raw['targetUserId'];
  if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'targetUserId is required'));
  }
  if (targetUserId === caller.id) {
    return toJson(err('BAD_REQUEST', 'cannot invite yourself to your own party'));
  }

  const partyRow = readParty(nk, partyId);
  if (partyRow === null) {
    return toJson(err('NOT_FOUND', 'party not found'));
  }
  const party = partyRow.record;
  if (party.leaderUserId !== caller.id) {
    return toJson(err('FORBIDDEN', 'only the leader can invite'));
  }

  // Either-side block check (matches invite_send behavior).
  if (isBlockedEitherWay(nk, caller.id, targetUserId)) {
    return toJson(err('FORBIDDEN', 'cannot invite that user'));
  }

  // Target must not already be in another party.
  const targetActive = readActiveParty(nk, targetUserId);
  if (targetActive !== null) {
    return toJson(err('FORBIDDEN', 'target is already in a party'));
  }

  // Party roster must have room.
  if (!canAddMember(party, targetUserId)) {
    if (party.state !== PARTY_STATE_OPEN) {
      return toJson(err('CONFLICT', 'party is closed'));
    }
    if (party.members.length >= party.maxSize) {
      return toJson(err('CONFLICT', 'party is full'));
    }
    return toJson(err('CONFLICT', 'target is already a member'));
  }

  // Issue the invite. Uses the invites collection (Chunk 2).
  const nowMs = Date.now();
  const inviteId = nk.uuidv4();
  const expiresAt = nowMs + INVITE_TTL_MS;
  const inviteRecord: InviteRecord = {
    schemaVersion: 1,
    inviteId,
    fromUserId: caller.id,
    targetUserId,
    kind: 'group',
    payload: {
      partyId: party.partyId,
      partyMaxSize: party.maxSize,
    },
    createdAt: nowMs,
    expiresAt,
    status: 'pending',
  };
  try {
    writeInviteCreate(nk, inviteRecord);
  } catch (e) {
    logger.error(
      'party_invite: writeInviteCreate failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to persist invite'));
  }

  emit(nk, logger, 'party_invite_sent', {
    partyId: party.partyId,
    inviteId,
    targetUserId,
  }, { userId: caller.id });

  const out: PartyInviteRpcOutput = { inviteId, expiresAt, partyId: party.partyId, targetUserId };
  return toJson(ok(out));
}
export const party_invite: RpcHandler = party_invite_impl;

// ─── party_join ─────────────────────────────────────────────────────────────

export interface PartyJoinRpcInput {
  callerUserId: string;
  partyId: string;
}

export interface PartyJoinRpcOutput {
  party: PartyCard;
  partyId: string;
  joinedAt: number;
}

export function party_join_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.raw['callerUserId'], logger);
  if (!caller.ok) return caller.error;

  const limit = checkRpcRate(nk, logger, 'party_join', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const raw = parsed.raw;
  const partyId = raw['partyId'];
  if (typeof partyId !== 'string' || partyId.length === 0) {
    return toJson(err('BAD_REQUEST', 'partyId is required'));
  }

  // Caller must not already be in a party.
  const existing = readActiveParty(nk, caller.id);
  if (existing !== null) {
    return toJson(err('FORBIDDEN', 'caller is already in a party'));
  }

  let result;
  try {
    result = joinParty(nk, logger, caller.id, partyId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'party is closed') {
      return toJson(err('CONFLICT', msg));
    }
    if (msg === 'party is full') {
      return toJson(err('CONFLICT', msg));
    }
    if (msg === 'already a member') {
      return toJson(err('CONFLICT', msg));
    }
    logger.error('party_join: joinParty failed: %s', msg);
    return toJson(err('INTERNAL', msg));
  }
  if (result === null) {
    return toJson(err('NOT_FOUND', 'party not found'));
  }

  const me = result.record.members.find((m) => m.userId === caller.id);
  const joinedAt = me?.joinedAt ?? Date.now();

  emit(nk, logger, 'party_joined', {
    partyId,
    userId: caller.id,
  }, { userId: caller.id });

  const out: PartyJoinRpcOutput = {
    party: asPartyCard(result.record),
    partyId,
    joinedAt,
  };
  return toJson(ok(out));
}
export const party_join: RpcHandler = party_join_impl;

// ─── party_leave ────────────────────────────────────────────────────────────

export interface PartyLeaveRpcOutput {
  left: true;
  disbanded: boolean;
}

export function party_leave_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.raw['callerUserId'], logger);
  if (!caller.ok) return caller.error;

  const limit = checkRpcRate(nk, logger, 'party_leave', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const raw = parsed.raw;
  const partyId = raw['partyId'];
  if (typeof partyId !== 'string' || partyId.length === 0) {
    return toJson(err('BAD_REQUEST', 'partyId is required'));
  }

  const partyRow = readParty(nk, partyId);
  if (partyRow === null) {
    return toJson(err('NOT_FOUND', 'party not found'));
  }
  const party = partyRow.record;
  if (!hasMember(party, caller.id)) {
    return toJson(err('FORBIDDEN', 'not a member of this party'));
  }

  // Leader cannot leave when other members exist. Spec: "leader can't
  // leave — must transfer or kick all". We add the convenience path:
  // empty party → leader leaving disbands it.
  const isLeader = party.leaderUserId === caller.id;
  const otherMembers = party.members.filter((m) => m.userId !== caller.id);
  if (isLeader && otherMembers.length > 0) {
    return toJson(err(
      'FORBIDDEN',
      'leader cannot leave with members present (kick all first)',
      { otherMembers: otherMembers.map((m) => m.userId) },
    ));
  }

  // Update party roster + clear caller's active_party.
  const nextParty: PartyRecord = {
    ...party,
    members: party.members.filter((m) => m.userId !== caller.id),
  };

  let disbanded = false;
  try {
    if (nextParty.members.length === 0) {
      // Empty → disband.
      deleteParty(nk, party.partyId);
      disbanded = true;
    } else {
      writePartyUpdate(nk, nextParty, partyRow.version);
    }
  } catch (e) {
    logger.error(
      'party_leave: party write failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to update party'));
  }

  try {
    deleteActiveParty(nk, caller.id);
  } catch (e) {
    logger.error(
      'party_leave: deleteActiveParty failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    // non-fatal — the party update succeeded; client can recover
  }

  emit(nk, logger, 'party_left', {
    partyId: party.partyId,
    userId: caller.id,
    wasLeader: isLeader,
    disbanded,
  }, { userId: caller.id });

  const out: PartyLeaveRpcOutput = { left: true, disbanded };
  return toJson(ok(out));
}
export const party_leave: RpcHandler = party_leave_impl;

// ─── party_kick ─────────────────────────────────────────────────────────────

export interface PartyKickRpcInput {
  callerUserId: string;
  partyId: string;
  targetUserId: string;
}

export interface PartyKickRpcOutput {
  kicked: true;
  partyId: string;
  targetUserId: string;
}

export function party_kick_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.raw['callerUserId'], logger);
  if (!caller.ok) return caller.error;

  const limit = checkRpcRate(nk, logger, 'party_kick', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const raw = parsed.raw;
  const partyId = raw['partyId'];
  if (typeof partyId !== 'string' || partyId.length === 0) {
    return toJson(err('BAD_REQUEST', 'partyId is required'));
  }
  const targetUserId = raw['targetUserId'];
  if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'targetUserId is required'));
  }

  const partyRow = readParty(nk, partyId);
  if (partyRow === null) {
    return toJson(err('NOT_FOUND', 'party not found'));
  }
  const party = partyRow.record;
  if (party.leaderUserId !== caller.id) {
    return toJson(err('FORBIDDEN', 'only the leader can kick'));
  }
  if (targetUserId === caller.id) {
    return toJson(err('BAD_REQUEST', 'cannot kick yourself; use party_leave'));
  }
  if (!hasMember(party, targetUserId)) {
    return toJson(err('NOT_FOUND', 'target is not a member of this party'));
  }

  const nextParty: PartyRecord = {
    ...party,
    members: party.members.filter((m) => m.userId !== targetUserId),
  };
  let wrote = false;
  let version = partyRow.version;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES && !wrote; attempt++) {
    try {
      writePartyUpdate(nk, nextParty, version);
      wrote = true;
    } catch {
      const reread = readParty(nk, partyId);
      if (reread === null) {
        return toJson(err('NOT_FOUND', 'party disappeared'));
      }
      version = reread.version;
      // Build nextParty from the fresh party + same filter.
      nextParty.members = reread.record.members.filter((m) => m.userId !== targetUserId);
    }
  }
  if (!wrote) {
    return toJson(err('INTERNAL', 'CAS retries exhausted'));
  }

  // Clear target's active_party.
  try {
    deleteActiveParty(nk, targetUserId);
  } catch {
    // non-fatal
  }

  emit(nk, logger, 'party_kicked', {
    partyId: party.partyId,
    targetUserId,
    leaderUserId: caller.id,
  }, { userId: caller.id });

  const out: PartyKickRpcOutput = { kicked: true, partyId: party.partyId, targetUserId };
  return toJson(ok(out));
}
export const party_kick: RpcHandler = party_kick_impl;

// ─── party_get ──────────────────────────────────────────────────────────────

export interface PartyGetRpcOutput {
  party: PartyCard;
}

export function party_get_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.raw['callerUserId'], logger);
  if (!caller.ok) return caller.error;

  const limit = checkRpcRate(nk, logger, 'party_get', caller.id);
  if (limit !== null) return toJson(limit);

  // NOT maintenance-gated (read).
  const partyId = parsed.raw['partyId'];
  if (typeof partyId !== 'string' || partyId.length === 0) {
    return toJson(err('BAD_REQUEST', 'partyId is required'));
  }

  const partyRow = readParty(nk, partyId);
  if (partyRow === null) {
    return toJson(err('NOT_FOUND', 'party not found'));
  }
  const party = partyRow.record;
  if (!hasMember(party, caller.id)) {
    return toJson(err('FORBIDDEN', 'not a member of this party'));
  }

  const out: PartyGetRpcOutput = { party: asPartyCard(party) };
  return toJson(ok(out));
}
export const party_get: RpcHandler = party_get_impl;

// Suppress unused-warning on PARTY_MAX_SIZE (kept here as a breadcrumb).
void PARTY_MAX_SIZE;

// Type re-export used by the bundle scanner so goja sees the named
// exports of the response types.
export type { Resp };