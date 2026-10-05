// Leaderboard write hooks. Per Phase 2 spec: "bloquearla en el servidor
// con un hook before que rechace escrituras de cliente".
//
// Strategy: every server-initiated write goes through a single RPC-
// internal function that stamps a sentinel metadata field `server_token`
// on the record envelope BEFORE the call. The `before` hook accepts the
// write only if that token is present and matches our constant. Client
// callers cannot set the token because they hit the leaderboard
// write via Nakama's socket transport which doesn't expose the
// `leaderboardRecordWrite` API — but we belt-and-suspenders the
// check anyway in case future RPCs forget to stamp it.

import type {
  IInitializer,
  ILeaderboardRecordEnvelope,
  ILogger,
  INakama,
} from '../nkruntime';

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
 * Register the `before` hook. Must be called from InitModule once per
 * boot. The hook reads the existing metadata and aborts the write (by
 * throwing) when the token is missing — this prevents direct client
 * writes from succeeding via any future API surface.
 */
export function registerLeaderboardWriteGuard(initializer: IInitializer): void {
  initializer.registerBeforeLeaderboardRecordWrite((
    _ctx: unknown,
    logger: ILogger,
    _nk: INakama,
    envelope: ILeaderboardRecordEnvelope,
  ) => {
    if (!hasServerToken(envelope.update.metadata)) {
      logger.warn(
        'rejecting leaderboard write: missing server token [lb=%s user=%s score=%d]',
        envelope.leaderboardId,
        String((envelope.update as { ownerId?: unknown }).ownerId ?? '?'),
        envelope.update.score,
      );
      throw new Error(
        `leaderboard write rejected: ${envelope.leaderboardId} requires server authority`,
      );
    }
  });
}