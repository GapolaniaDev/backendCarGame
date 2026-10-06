// Phase 5 Chunk 6 — 5 admin RPCs, each shared-secret gated by
// `assertAdminKey` and maintenance-gated by NOTHING (admin ops
// continue during a maintenance pause — same precedent as
// `account_delete`, which also bypasses the gate).
//
// Pattern matches `account/rpcs.ts`: each handler exports both
// `<name>_impl: RpcHandler` (testable directly with a hand-crafted
// ctx) and a bare `export const <name>: RpcHandler = <name>_impl` for
// the goja AST scanner (`initializer.registerRpc('admin_*', fn)`).

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { assertAdminKey, withoutAdminKey } from './auth';
import { walletAdjust } from './wallet_admin';
import { sendInboxBulk } from './inbox_admin';
import { sanitizeSession, removePlayer } from './sanitize';
import { cleanupRaceSessions } from './cleanup';
import type {
  AdminCleanupRaceSessionsInput,
  AdminCleanupRaceSessionsOutput,
  AdminRemovePlayerInput,
  AdminRemovePlayerOutput,
  AdminSanitizeSessionInput,
  AdminSanitizeSessionOutput,
  AdminSendInboxInput,
  AdminSendInboxOutput,
  AdminWalletAdjustInput,
  AdminWalletAdjustOutput,
} from './types';

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

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

const ADMIN_USER_ID = 'admin';

/**
 * Shared admin-RPC preamble:
 *   1. parse body (404-equivalent envelope on malformed JSON)
 *   2. assertAdminKey (FORBIDDEN / SERVICE_UNAVAILABLE)
 *   3. return the `{value, raw}` pair to the handler
 */
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

// ─── admin_wallet_adjust ───────────────────────────────────────────────────

export const admin_wallet_adjust_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const input: AdminWalletAdjustInput = {
    adminKey: '',
    userId: typeof raw['userId'] === 'string' ? (raw['userId'] as string) : '',
    reason: typeof raw['reason'] === 'string' ? (raw['reason'] as string) : '',
    ...(typeof raw['coins'] === 'number' ? { coins: raw['coins'] as number } : {}),
    ...(typeof raw['gems'] === 'number' ? { gems: raw['gems'] as number } : {}),
  };
  const r = walletAdjust(nk, logger, input);
  if (!r.ok) return JSON.stringify(err(asCode(r.error?.code), r.error?.message ?? 'unknown'));
  const data = r.data as AdminWalletAdjustOutput;
  return JSON.stringify(ok(data));
};
export const admin_wallet_adjust: RpcHandler = admin_wallet_adjust_impl;

// ─── admin_send_inbox ──────────────────────────────────────────────────────

export const admin_send_inbox_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const userIdsRaw = raw['userIds'];
  const userIds: string[] | 'all' = userIdsRaw === 'all'
    ? 'all'
    : Array.isArray(userIdsRaw)
      ? (userIdsRaw as unknown[]).filter((u): u is string => typeof u === 'string')
      : [];
  const messageRaw = (raw['message'] && typeof raw['message'] === 'object')
    ? (raw['message'] as Record<string, unknown>)
    : {};
  const r = sendInboxBulk(nk, logger, {
    adminKey: '',
    userIds,
    message: {
      kind: messageRaw['kind'] === 'system' ? 'system' : 'reward',
      title: typeof messageRaw['title'] === 'string' ? (messageRaw['title'] as string) : '',
      body: typeof messageRaw['body'] === 'string' ? (messageRaw['body'] as string) : '',
      ...(messageRaw['reward'] !== undefined && typeof messageRaw['reward'] === 'object' ? { reward: messageRaw['reward'] as never } : {}),
      ...(typeof messageRaw['expiresAt'] === 'number' ? { expiresAt: messageRaw['expiresAt'] as number } : {}),
    },
  } satisfies AdminSendInboxInput);
  if (!r.ok) return JSON.stringify(err(asCode(r.error?.code), r.error?.message ?? 'unknown'));
  const data = r.data as AdminSendInboxOutput;
  return JSON.stringify(ok(data));
};
export const admin_send_inbox: RpcHandler = admin_send_inbox_impl;

// ─── admin_sanitize_session ────────────────────────────────────────────────

export const admin_sanitize_session_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const r = sanitizeSession(nk, logger, {
    adminKey: '',
    sessionId: typeof raw['sessionId'] === 'string' ? (raw['sessionId'] as string) : '',
    reviewReason: typeof raw['reviewReason'] === 'string' ? (raw['reviewReason'] as string) : '',
    removeFromLeaderboards: raw['removeFromLeaderboards'] === true,
  });
  if (!r.ok) return JSON.stringify(err(asCode(r.error?.code), r.error?.message ?? 'unknown'));
  const data = r.data as AdminSanitizeSessionOutput;
  return JSON.stringify(ok(data));
};
export const admin_sanitize_session: RpcHandler = admin_sanitize_session_impl;

// ─── admin_remove_player ──────────────────────────────────────────────────

export const admin_remove_player_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);
  const r = removePlayer(nk, logger, {
    adminKey: '',
    userId: typeof raw['userId'] === 'string' ? (raw['userId'] as string) : '',
    reason: typeof raw['reason'] === 'string' ? (raw['reason'] as string) : '',
  });
  if (!r.ok) return JSON.stringify(err(asCode(r.error?.code), r.error?.message ?? 'unknown'));
  const data = r.data as AdminRemovePlayerOutput;
  return JSON.stringify(ok(data));
};
export const admin_remove_player: RpcHandler = admin_remove_player_impl;

// ─── admin_cleanup_race_sessions ───────────────────────────────────────────

export const admin_cleanup_race_sessions_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  void withoutAdminKey(pre.raw); // we have nothing else to use from the body
  const r = cleanupRaceSessions(nk, logger, { adminKey: '' });
  if (!r.ok) return JSON.stringify(err(asCode(r.error?.code), r.error?.message ?? 'unknown'));
  const data = r.data as AdminCleanupRaceSessionsOutput;
  return JSON.stringify(ok(data));
};
export const admin_cleanup_race_sessions: RpcHandler = admin_cleanup_race_sessions_impl;

// Side-effect: keep ADMIN_USER_ID as a compile-time marker so
// TypeScript complains if every reference is removed (would indicate
// dead-code elimination got too aggressive).
void ADMIN_USER_ID;
void ADMIN_USER_ID;

// Type re-export used by the bundle scanner so goja sees the named
// exports of the response types.
export type { Resp };