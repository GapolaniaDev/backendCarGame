// Leaderboard write hooks. Per Phase 2 spec: "bloquearla en el servidor
// con un hook before que rechace escrituras de cliente".
//
// Strategy: every server-initiated write goes through
// `nk.leaderboardRecordWrite`, which never triggers before-hooks, and
// stamps a sentinel metadata field `server_token` on the record. The
// client API path (`WriteLeaderboardRecord`) is the only one that
// reaches `beforeWriteLeaderboardRecordGuard`, so the guard rejects
// every call it sees: clients never write leaderboards directly.
//
// Registration happens in `main.ts` as a top-level
// `initializer.registerBeforeWriteLeaderboardRecord(...)` statement —
// the 3.27 AST scanner only finds hooks registered there with a global
// function identifier. (The old helper used the non-existent name
// `registerBeforeLeaderboardRecordWrite` from a nested function, which
// is why it never installed.)

import type { IContext, ILogger, INakama } from '../nkruntime';

const SERVER_TOKEN_KEY = '__server_token__';
const SERVER_TOKEN_VALUE = 'phase2';

/**
 * Stamp the server-token into an outbound leaderboard write's metadata.
 * Call this from every code path that writes leaderboard records.
 */
export function stampServerToken(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return { ...metadata, [SERVER_TOKEN_KEY]: SERVER_TOKEN_VALUE };
}

/** Check whether a metadata bag carries the server token. */
export function hasServerToken(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const m = metadata as Record<string, unknown>;
  return m[SERVER_TOKEN_KEY] === SERVER_TOKEN_VALUE;
}

/**
 * Before-hook for the client `WriteLeaderboardRecord` API. Rejects
 * every request: all authoritative writes come from the server via
 * `nk.leaderboardRecordWrite`, which bypasses hooks. Throwing makes
 * Nakama return the error to the client.
 */
export function beforeWriteLeaderboardRecordGuard(
  ctx: IContext,
  logger: ILogger,
  _nk: INakama,
  data: unknown,
): unknown {
  const req = (data ?? {}) as { leaderboardId?: unknown };
  logger.warn(
    'rejecting client leaderboard write [lb=%s user=%s]',
    String(req.leaderboardId ?? '?'),
    String(ctx?.userId ?? '?'),
  );
  throw new Error('leaderboard writes require server authority');
}
