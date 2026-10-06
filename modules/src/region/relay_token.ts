// Phase 5 Chunk 8 — Relay token format + HMAC-SHA-256 sign/verify.
//
// The home node signs a short-lived token that a relay replica can
// verify OFFLINE without round-tripping to home. The token is
// proof-of-eligibility for entering a match — it does NOT replace
// device authentication (the client still has to authenticate against
// the relay with its deviceId).
//
// Wire format (mirrors Chunk 4's account-link tokens):
//
//   `v1.<payloadB64Url>.<sigB64Url>`
//
//   payload = base64url(JSON({ v:1, userId, region, exp }))
//   sig     = base64url(HMAC-SHA-256(payload, secret))
//
// `exp` is unix SECONDS (not ms). Decision D9: TTL = 60 min.
//
// Verification is constant-time on the signature; expiry is a strict
// `nowSec >= exp` (so a token with `exp === nowSec` is already
// considered expired — matches JWT convention).

import type { INakama } from '../nkruntime';

export const RELAY_TOKEN_VERSION = 'v1';
/** TTL — D9. */
export const RELAY_TOKEN_TTL_SEC = 60 * 60;

export interface RelayTokenPayload {
  v: 1;
  userId: string;
  region: string;
  /** Unix seconds. */
  exp: number;
}

export type VerifyRelayTokenResult =
  | { ok: true; payload: RelayTokenPayload }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad_sig' };

/**
 * Build the canonical payload string used for both signing and
 * verification. Exported for tests that want to assert the exact
 * wire format.
 */
export function buildRelayTokenPayload(input: {
  userId: string;
  region: string;
  expSec: number;
}): string {
  const obj: RelayTokenPayload = {
    v: 1,
    userId: input.userId,
    region: input.region,
    exp: input.expSec,
  };
  return JSON.stringify(obj);
}

/**
 * Sign a relay token. Returns the full wire string
 * `v1.<b64payload>.<b64sig>`.
 */
export function signRelayToken(
  nk: INakama,
  payload: { userId: string; region: string; expSec: number },
  secret: string,
): string {
  const json = buildRelayTokenPayload(payload);
  const payloadB64 = base64UrlEncode(json);
  const sigB64 = bytesToBase64Url(nk.hmacSha256Hash(payloadB64, secret));
  return `${RELAY_TOKEN_VERSION}.${payloadB64}.${sigB64}`;
}

/**
 * Verify a relay token. Returns the decoded payload on success.
 *
 * - malformed: token doesn't parse (wrong arity, bad base64url, bad
 *   JSON, missing/wrong-type fields, version mismatch).
 * - bad_sig: signature mismatch OR payload was tampered with.
 * - expired: signature was valid but the token's `exp` is in the
 *   past (nowSec >= exp).
 *
 * The signature comparison is constant-time. We never leak which
 * specific malformed step tripped — that would help an attacker tune
 * their probes.
 */
export function verifyRelayToken(
  nk: INakama,
  token: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): VerifyRelayTokenResult {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== RELAY_TOKEN_VERSION) {
    return { ok: false, reason: 'malformed' };
  }
  const payload = parts[1];
  const sig = parts[2];
  if (payload === undefined || sig === undefined) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = bytesToBase64Url(nk.hmacSha256Hash(payload, secret));
  if (!constantTimeEquals(expected, sig)) {
    return { ok: false, reason: 'bad_sig' };
  }

  let claims: { v?: unknown; userId?: unknown; region?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(nk.base64UrlDecode(payload));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    claims.v !== 1 ||
    typeof claims.userId !== 'string' ||
    typeof claims.region !== 'string' ||
    typeof claims.exp !== 'number' ||
    !Number.isInteger(claims.exp)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (nowSec >= claims.exp) {
    return { ok: false, reason: 'expired' };
  }
  return {
    ok: true,
    payload: { v: 1, userId: claims.userId, region: claims.region, exp: claims.exp },
  };
}

// ─── Internals (mirrored from `account/token.ts`) ─────────────────────────

function bytesToBase64Url(value: string | Uint8Array | ArrayBuffer): string {
  if (typeof value === 'string') return value;
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;
  if (bytes === null) {
    throw new Error('hmacSha256Hash returned an unsupported shape');
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i] as number);
  }
  return base64UrlEncode(bin);
}

function base64UrlEncode(input: string): string {
  const b64 =
    typeof btoa !== 'undefined'
      ? btoa(input)
      : Buffer.from(input, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}