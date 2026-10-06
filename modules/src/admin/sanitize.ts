// Phase 5 Chunk 6 — `admin_sanitize_session` + `admin_remove_player`.
//
// `sanitizeSession` flags a race session for review (`flags.needsReview`,
// `flags.reviewReason`). If the admin requests the destructive path
// (`removeFromLeaderboards: true`), every human roster entry is also
// abandoned via `removePlayerFromAll` so they're excluded from
// leaderboards.
//
// `removePlayer` is a SANCTION — reversible, marks the user's profile
// `archivedAt`, and calls `removePlayerFromAll`. The account row stays
// intact; an admin can lift the sanction by clearing `archivedAt`.
// For GDPR-grade deletion use `account_delete` (Phase 5 Chunk 5),
// which is irreversible.

import type { IStorageObject, ILogger, INakama } from '../nkruntime';
import { readSession, updateSession } from '../race/session_repo';
import { removePlayerFromAll } from '../race/remove_player';
import { emitAdminAction } from '../core/admin/analytics';
import type {
  AdminRemovePlayerInput,
  AdminRemovePlayerOutput,
  AdminSanitizeSessionInput,
  AdminSanitizeSessionOutput,
} from './types';

// ─── admin_sanitize_session ────────────────────────────────────────────────

export interface SanitizeSessionResult {
  ok: boolean;
  error?: { code: string; message: string };
  data?: AdminSanitizeSessionOutput;
}

export function sanitizeSession(
  nk: INakama,
  logger: ILogger,
  input: AdminSanitizeSessionInput,
): SanitizeSessionResult {
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } };
  }
  if (typeof input.reviewReason !== 'string' || input.reviewReason.trim().length === 0) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'reviewReason is required and must be non-empty' } };
  }

  const read = readSession(nk, input.sessionId);
  if (read === null) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `session not found: ${input.sessionId}` } };
  }
  const { session, version } = read;
  if (session.state === 'closed') {
    // Closed sessions are immutable — sanitizing a closed session makes
    // no sense (the leaderboards have already been written).
    return { ok: false, error: { code: 'CONFLICT', message: 'session is already closed' } };
  }

  const next = {
    ...session,
    flags: { ...session.flags, needsReview: true, reviewReason: input.reviewReason },
    version: session.version + 1,
  };
  try {
    updateSession(nk, next, version);
  } catch (e) {
    logger.warn('admin_sanitize_session: CAS conflict for %s: %s', input.sessionId, e instanceof Error ? e.message : String(e));
    return { ok: false, error: { code: 'CONFLICT', message: 'session changed under us; retry' } };
  }

  let removed = 0;
  if (input.removeFromLeaderboards) {
    for (const entry of session.roster) {
      if (entry.isBot) continue;
      // removePlayerFromAll no-ops when the player is already
      // abandoned, so repeated calls are safe.
      removePlayerFromAll(nk, logger, entry.userId);
      removed += 1;
    }
  }

  emitAdminAction(nk, logger, 'admin_sanitize_session', {
    targetSessionId: input.sessionId,
    reason: input.reviewReason,
    removeFromLeaderboards: input.removeFromLeaderboards,
    rosterRemoved: removed,
  });
  logger.warn('admin_sanitize_session sid=%s reason=%s removeFromLeaderboards=%s rosterRemoved=%d', input.sessionId, input.reviewReason, String(input.removeFromLeaderboards), removed);
  return { ok: true, data: { sessionId: input.sessionId, needsReview: true } };
}

// ─── admin_remove_player ───────────────────────────────────────────────────

export interface RemovePlayerResult {
  ok: boolean;
  error?: { code: string; message: string };
  data?: AdminRemovePlayerOutput;
}

const PROFILES_COLLECTION = 'profiles';

export function removePlayer(
  nk: INakama,
  logger: ILogger,
  input: AdminRemovePlayerInput,
): RemovePlayerResult {
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'userId is required' } };
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'reason is required and must be non-empty' } };
  }
  const nowMs = Date.now();

  // Read profile (NOT_FOUND if missing — admin needs to know the user
  // is real before sanctioning them).
  const reads = nk.storageRead([
    { collection: PROFILES_COLLECTION, key: input.userId, userId: input.userId },
  ]);
  const obj = reads[0];
  if (obj === undefined || obj.value === undefined) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `profile not found: ${input.userId}` } };
  }

  // Mark archived (additive; safe with exactOptionalPropertyTypes).
  const profile = obj.value as Record<string, unknown>;
  const next: Record<string, unknown> = { ...profile, archivedAt: nowMs };
  const writeObj = {
    collection: PROFILES_COLLECTION,
    key: input.userId,
    userId: input.userId,
    value: next,
    ...(obj.version !== undefined ? { version: obj.version } : {}),
    permissionRead: obj.permissionRead ?? 1,
    permissionWrite: obj.permissionWrite ?? 0,
  } as unknown as IStorageObject;
  try {
    nk.storageWrite([writeObj]);
  } catch (e) {
    logger.warn('admin_remove_player: profile CAS conflict for %s: %s', input.userId, e instanceof Error ? e.message : String(e));
    return { ok: false, error: { code: 'CONFLICT', message: 'profile changed under us; retry' } };
  }

  const abandoned = removePlayerFromAll(nk, logger, input.userId);
  emitAdminAction(nk, logger, 'admin_remove_player', {
    targetUserId: input.userId,
    reason: input.reason,
    archivedAt: nowMs,
    abandonedFromRaces: abandoned.abandonedFrom.length,
  });
  logger.warn('admin_remove_player user=%s reason=%s abandoned=%d', input.userId, input.reason, abandoned.abandonedFrom.length);
  return {
    ok: true,
    data: { removedAt: nowMs, abandonedFromRaces: abandoned.abandonedFrom.length },
  };
}