// Server-to-server authentication for the dedicated race servers (D-01).
//
// Every `rs_*` RPC is called with the runtime `http_key` (no player
// session) and carries `serverKey` in its body, compared in constant time
// with `RACE_SERVER_SECRET` from `runtime.env`. While the secret is empty
// every call is rejected, so a deployment without it cannot be spoofed.

import type { IContext } from '../nkruntime';
import { err } from '../core/response';
import { envString } from '../core/runtime_env';
import { RACE_SERVER_ID_MAX_LENGTH } from './types';

export const RACE_SERVER_SECRET_ENV = 'RACE_SERVER_SECRET';

const SERVER_ID_RE = /^[A-Za-z0-9._-]+$/;

export type RaceServerAuth =
  | { ok: true; serverId: string }
  | { ok: false; error: string };

/** Same-length comparison that does not stop at the first difference. */
export function secretsMatch(expected: string, received: string): boolean {
  if (expected.length !== received.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}

/** `true` when `id` is a valid server id (1-64 chars of `[A-Za-z0-9._-]`). */
export function isValidServerId(id: unknown): id is string {
  return typeof id === 'string'
    && id.length >= 1
    && id.length <= RACE_SERVER_ID_MAX_LENGTH
    && SERVER_ID_RE.test(id);
}

/**
 * Authenticates a server-to-server call and returns its `serverId`, or the
 * serialized error envelope to return as is.
 */
export function requireRaceServer(ctx: IContext, input: Record<string, unknown>): RaceServerAuth {
  // Server-to-server only: a player session never acts as a race server.
  if (typeof ctx?.userId === 'string' && ctx.userId.length > 0) {
    return { ok: false, error: JSON.stringify(err('FORBIDDEN', 'server-to-server call (http_key) only')) };
  }
  const secret = envString(ctx, RACE_SERVER_SECRET_ENV);
  if (secret.length === 0) {
    return {
      ok: false,
      error: JSON.stringify(err('SERVICE_UNAVAILABLE', 'race servers are not configured', { reason: 'NOT_CONFIGURED' })),
    };
  }
  const key = input['serverKey'];
  if (typeof key !== 'string' || !secretsMatch(secret, key)) {
    return { ok: false, error: JSON.stringify(err('FORBIDDEN', 'serverKey does not match', { reason: 'BAD_SERVER_KEY' })) };
  }
  const serverId = input['serverId'];
  if (!isValidServerId(serverId)) {
    return {
      ok: false,
      error: JSON.stringify(err('BAD_REQUEST', `serverId must be 1-${RACE_SERVER_ID_MAX_LENGTH} characters of [A-Za-z0-9._-]`)),
    };
  }
  return { ok: true, serverId };
}
