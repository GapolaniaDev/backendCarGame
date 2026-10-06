// Phase 5 Chunk 8 — Relay-only `beforeAuthenticateDevice` hook.
//
// On a relay node, every device-auth request MUST include a
// `relayToken` in `vars`. The home node minted it and signed it with
// `liveops_config.relayTokenSecret`. We verify the HMAC here, OFFLINE,
// before letting Nakama proceed with the device-auth flow.
//
// IMPORTANT: this hook is a no-op on `home` nodes — the home node
// does NOT require `relayToken`s and the auth flow there runs
// unchanged.
//
// The token is proof-of-eligibility, NOT a substitute for device
// authentication. The client still has to authenticate its deviceId
// against the relay. We log success/failure so ops can spot bad
// traffic.
//
// Wire contract for the client (relay node only):
//   POST /v2/account/authenticate/device
//     body: { id: <deviceId>, vars: { relayToken: "v1.<b64>.<b64sig>" } }
//
// To reject: throw an Error — Nakama aborts auth and the message
// bubbles to the client.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { isHome } from '../core/region';
import { loadLiveopsConfig } from '../liveops/config';
import { verifyRelayToken } from './relay_token';

/**
 * Type of the `BeforeAuthFn` envelope, narrowed to the fields we
 * read. Nakama's envelope also has `username`, but we ignore it.
 */
interface BeforeAuthEnvelope {
  userId: string;
  username?: string;
  vars: Record<string, string>;
}

/**
 * The `beforeAuthenticateDevice` handler. Registered from `main.ts`
 * on every node — but the body is only active on `relay` nodes.
 *
 * Behavior on `home`:
 *   Returns silently. The home node DOES NOT require a relayToken.
 *
 * Behavior on `relay`:
 *   1. Reads `envelope.vars.relayToken`.
 *   2. Reads `liveops_config.relayTokenSecret`.
 *   3. Verifies via `verifyRelayToken(nk, token, secret)`.
 *   4. On success: logs and returns.
 *   5. On failure: throws to abort auth (relay_token_*) so the
 *      runtime surfaces a 401 with the reason in the body.
 *
 * NOTE: the hook does NOT consult `ctx` — the device-auth flow runs
 * before the userId is known. The envelope carries `userId` (empty
 * for new accounts) but it's not authoritative pre-auth.
 */
export function beforeAuthenticateDeviceRelay(
  _ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: unknown,
): void {
  if (isHome(nk, logger)) {
    return;
  }
  const e = envelope as BeforeAuthEnvelope | undefined;
  const vars = (e && typeof e === 'object' && e.vars) ? e.vars : {};
  const rawToken = typeof vars['relayToken'] === 'string' ? vars['relayToken'] : undefined;
  if (rawToken === undefined || rawToken.length === 0) {
    logger.warn('relay before_auth: missing relayToken on relay node — rejecting');
    throw new Error('relay_token_required');
  }
  const cfg = loadLiveopsConfig(nk, logger);
  const secret = cfg.relayTokenSecret;
  if (typeof secret !== 'string' || secret.length === 0) {
    logger.warn('relay before_auth: relayTokenSecret not configured — rejecting');
    throw new Error('relay_token_secret_missing');
  }
  const v = verifyRelayToken(nk, rawToken, secret);
  if (!v.ok) {
    logger.warn('relay before_auth: token verify failed reason=%s', v.reason);
    throw new Error(`relay_token_${v.reason}`);
  }
  logger.info(
    'relay before_auth: token OK user=%s region=%s exp=%d',
    v.payload.userId, v.payload.region, v.payload.exp,
  );
}