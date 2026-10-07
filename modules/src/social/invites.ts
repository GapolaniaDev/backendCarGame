// Phase 7 Chunk 2 — Invite RPCs (3):
//   - invite_send       — sender → target; persists + (deferred) socket push
//   - invite_list       — target's view of pending invites (lazy expired)
//   - invite_respond    — target CAS-updates to accepted/declined
//
// All 3 RPCs are gated by `assertNotInMaintenance`. Rate limit: 10/min
// for invite_send; 30/min for invite_list + invite_respond.
//
// Decisions locked:
//   - Invite TTL = 24h (D1)
//   - Self-invite → BAD_REQUEST (D2)
//   - Either-side block → FORBIDDEN (D3)
//   - Status transitions: pending → accepted/declined/expired (D4, lazy)
//   - Idempotent inviteId via nk.uuidv4() (D5)
//
// Socket push is STUBBED in Chunk 2 — Nakama 3.27 JS runtime has no
// `socket.send` binding. The deferred helper `tryOnlinePush` always
// returns false → `delivered:'offline'`. Chunk 5 (chat/presence) wires
// the real push path.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import { parseInput } from '../core/parse_input';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import { isBlockedEitherWay } from './blocks_repo';
import {
  isExpired,
  isTerminal,
  listInvitesFor,
  MAX_CAS_RETRIES,
  readInvite,
  tryOnlinePush,
  writeInviteCreate,
  writeInviteUpdate,
} from './invites_repo';
import {
  INVITE_RATE_LIMIT_PER_MIN,
  INVITE_TTL_MS,
  type InviteCard,
  type InviteKind,
  type InviteListOutput,
  type InviteRecord,
  type InviteRespondOutput,
  type InviteSendOutput,
} from './types';

const INVITE_RATE_LIMITS = {
  invite_send: { maxPerWindow: INVITE_RATE_LIMIT_PER_MIN, windowSec: 60 },
  invite_list: { maxPerWindow: 30, windowSec: 60 },
  invite_respond: { maxPerWindow: 30, windowSec: 60 },
} as const;

const VALID_KINDS: ReadonlySet<InviteKind> = new Set<InviteKind>([
  'group',
  'private_room',
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
  logger.warn('invite RPC called with no caller identity');
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
  rpcName: keyof typeof INVITE_RATE_LIMITS,
  userId: string,
): Resp<unknown> | null {
  const opts = INVITE_RATE_LIMITS[rpcName];
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

// ─── invite_send ──────────────────────────────────────────────────────────────

export function invite_send(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'invite_send', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const targetUserId = parsed.data.targetUserId;
  if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'targetUserId is required'));
  }
  if (targetUserId === caller.id) {
    return toJson(err('BAD_REQUEST', 'cannot invite yourself'));
  }
  const rawKind = parsed.data.kind;
  if (typeof rawKind !== 'string' || !VALID_KINDS.has(rawKind as InviteKind)) {
    return toJson(err('BAD_REQUEST', 'kind must be "group" or "private_room"'));
  }
  const kind = rawKind as InviteKind;

  const payloadRaw = parsed.data.payload;
  if (
    payloadRaw === undefined ||
    payloadRaw === null ||
    typeof payloadRaw !== 'object' ||
    Array.isArray(payloadRaw)
  ) {
    return toJson(err('BAD_REQUEST', 'payload must be an object'));
  }
  const payload = payloadRaw as Record<string, unknown>;

  // Either-side block check.
  if (isBlockedEitherWay(nk, caller.id, targetUserId)) {
    return toJson(err('FORBIDDEN', 'cannot invite that user'));
  }

  // Optional expiresAt override (clamped to [now, now + 7d]).
  const now = Date.now();
  const explicitExpires =
    typeof parsed.data.expiresAt === 'number' && Number.isFinite(parsed.data.expiresAt)
      ? parsed.data.expiresAt
      : null;
  const maxExpires = now + 7 * 24 * 60 * 60 * 1000;
  const expiresAt =
    explicitExpires !== null
      ? Math.min(Math.max(explicitExpires, now), maxExpires)
      : now + INVITE_TTL_MS;

  const inviteId = nk.uuidv4();
  const record: InviteRecord = {
    schemaVersion: 1,
    inviteId,
    fromUserId: caller.id,
    targetUserId,
    kind,
    payload,
    createdAt: now,
    expiresAt,
    status: 'pending',
  };
  try {
    writeInviteCreate(nk, record);
  } catch (e) {
    logger.error(
      'invite_send: storage write failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to persist invite'));
  }

  // Best-effort push (stub in Chunk 2).
  const pushed = tryOnlinePush(nk, targetUserId, inviteId);

  emit(nk, logger, 'invite_sent', {
    inviteId,
    targetUserId,
    kind,
  }, { userId: caller.id });

  const out: InviteSendOutput = {
    inviteId,
    delivered: pushed ? 'online' : 'offline',
    expiresAt,
  };
  return toJson(ok(out));
}

// ─── invite_list ─────────────────────────────────────────────────────────────

export function invite_list(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'invite_list', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const records = listInvitesFor(nk, caller.id);
  const now = Date.now();
  const cards: InviteCard[] = [];
  for (const r of records) {
    // Hide terminal invites (accepted/declined).
    if (isTerminal(r)) continue;
    const expiredFlag = isExpired(r, now);
    cards.push({
      inviteId: r.inviteId,
      fromUserId: r.fromUserId,
      kind: r.kind,
      payload: r.payload,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      // Lazy status: surface 'expired' for the client UI but keep
      // underlying record untouched (no CAS-write here — the row
      // remains `pending` until the next respond attempt, which will
      // see `isExpired` and refuse).
      status: expiredFlag ? 'expired' : r.status,
      isExpired: expiredFlag,
    });
  }
  cards.sort((a, b) => b.createdAt - a.createdAt);

  const out: InviteListOutput = { items: cards, count: cards.length };
  return toJson(ok(out));
}

// ─── invite_respond ───────────────────────────────────────────────────────────

/**
 * CAS-update an invite to accepted/declined. Only the target can
 * respond (they own the row). Returns NOT_FOUND when the invite is
 * missing, CONFLICT when already responded to, or INTERNAL on CAS
 * exhaustion.
 */
export function invite_respond(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.data.callerUserId, logger);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'invite_respond', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const inviteId = parsed.data.inviteId;
  if (typeof inviteId !== 'string' || inviteId.length === 0) {
    return toJson(err('BAD_REQUEST', 'inviteId is required'));
  }
  const accept = parsed.data.accept;
  if (typeof accept !== 'boolean') {
    return toJson(err('BAD_REQUEST', 'accept must be a boolean'));
  }

  const initial = readInvite(nk, caller.id, inviteId);
  if (initial === null) {
    return toJson(err('NOT_FOUND', 'no pending invite with that id'));
  }
  const rec = initial.record;
  if (rec.status !== 'pending') {
    return toJson(err('CONFLICT', 'invite already responded'));
  }
  if (isExpired(rec, Date.now())) {
    return toJson(err('CONFLICT', 'invite has expired'));
  }

  const nextStatus: 'accepted' | 'declined' = accept ? 'accepted' : 'declined';
  const respondedAt = Date.now();
  const nextRecord: InviteRecord = {
    ...rec,
    status: nextStatus,
    respondedAt,
  };

  let wrote = false;
  let version = initial.version;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES && !wrote; attempt++) {
    try {
      version = writeInviteUpdate(nk, nextRecord, version);
      wrote = true;
    } catch (e) {
      logger.warn(
        'invite_respond: CAS retry attempt=%d err=%s',
        attempt,
        e instanceof Error ? e.message : String(e),
      );
      // Re-read latest version.
      const reread = readInvite(nk, caller.id, inviteId);
      if (reread === null) {
        return toJson(err('NOT_FOUND', 'no pending invite with that id'));
      }
      if (reread.record.status !== 'pending') {
        return toJson(err('CONFLICT', 'invite already responded'));
      }
      if (isExpired(reread.record, Date.now())) {
        return toJson(err('CONFLICT', 'invite has expired'));
      }
      version = reread.version;
      nextRecord.respondedAt = Date.now();
    }
  }
  if (!wrote) {
    return toJson(err('INTERNAL', 'CAS retries exhausted'));
  }

  emit(nk, logger, 'invite_responded', {
    inviteId,
    status: nextStatus,
    fromUserId: rec.fromUserId,
  }, { userId: caller.id });

  const out: InviteRespondOutput = { status: nextStatus, inviteId };
  return toJson(ok(out));
}