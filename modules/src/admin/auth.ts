// Phase 5 Chunk 6 — Admin RPC auth helper.
//
// `assertAdminKey` reads `liveops_config.adminRpcKey` and compares it
// to the `adminKey` field in the request payload. If the liveops
// config doesn't have an adminRpcKey set, every admin RPC fails
// closed with `SERVICE_UNAVAILABLE`.
//
// D7 rationale: the JS layer cannot see Nakama's HTTP `http_key`
// query param (the runtime validates it server-side before invoking
// the JS RPC, and `IContext` has no `queryParams` field). The shared
// secret is sent BOTH ways by the admin tool — `?http_key=$KEY` on the
// HTTP gateway (server-side gate) AND `{"adminKey": "$KEY"}` in the
// JSON body (this helper). If they ever diverge, the admin tool is
// misconfigured.
//
// The compare is constant-time-ish (length pre-check + char array
// iteration). This is internal tooling, not a public-facing API; the
// timing-leak risk is low. We still do the dance because it's
// trivially correct.

import type { ILogger, INakama } from '../nkruntime';
import { err } from '../core/response';
import { loadLiveopsConfig } from '../liveops/config';

export interface AdminAuthOk {
  ok: true;
}
export interface AdminAuthFail {
  ok: false;
  /** Serialized `err()` JSON the caller can return directly. */
  error: string;
}

/**
 * Verify that the request payload's `adminKey` matches the liveops
 * config's `adminRpcKey`. Returns `{ ok: true }` on success, or a
 * serialized `err('FORBIDDEN', ...)` / `err('SERVICE_UNAVAILABLE', ...)`
 * on failure. Never logs the key value.
 */
export function assertAdminKey(
  logger: ILogger,
  nk: INakama,
  rawBody: Record<string, unknown>,
): AdminAuthOk | AdminAuthFail {
  const cfg = loadLiveopsConfig(nk, logger);
  const expected = cfg.adminRpcKey;
  if (typeof expected !== 'string' || expected.length === 0) {
    // Fail-closed: admin RPCs require the secret to be configured.
    logger.warn('admin RPC rejected: adminRpcKey not configured in liveops_config');
    return { ok: false, error: JSON.stringify(err('SERVICE_UNAVAILABLE', 'admin key not configured')) };
  }
  const provided = rawBody['adminKey'];
  if (typeof provided !== 'string' || provided.length === 0) {
    return { ok: false, error: JSON.stringify(err('FORBIDDEN', 'admin key required')) };
  }
  if (!constantTimeEqual(expected, provided)) {
    return { ok: false, error: JSON.stringify(err('FORBIDDEN', 'admin key mismatch')) };
  }
  return { ok: true };
}

/** Strip the `adminKey` from a payload so it doesn't end up in logs / analytics. */
export function withoutAdminKey(rawBody: Record<string, unknown>): Record<string, unknown> {
  const { adminKey: _omit, ...rest } = rawBody;
  return rest;
}

/**
 * Constant-time string compare. Not crypto-grade (no early exit, but
 * JIT may still optimize the loop) — good enough for an internal
 * admin RPC.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}