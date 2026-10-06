// Phase 5 Chunk 4 — Test-mode provider token format.
//
// In production, account-link tokens come from Apple (JWT signed with
// Apple's JWKS-rotating RSA key), Google (`id_token` verified via
// `nk.httpRequest` against `https://oauth2.googleapis.com/tokeninfo`),
// or email (magic-link token delivered via SMTP).
//
// For this chunk we accept a *test-mode* token format so the e2e
// harness can drive the conflict path without hitting live providers:
//
//   `v1.<provider>.<payloadB64Url>.<sigB64Url>`
//
// where:
//   payload = base64url(JSON({ provider, customId, exp }))
//   sig     = base64url(HMAC-SHA-256(payload, TEST_SECRET))
//
// `TEST_SECRET` is a fixed value baked into the runtime. In production
// we'd swap this for the real provider-specific verifiers — see
// `docs/account-linking.md` (Phase 5 Chunk 10) for the ops checklist
// (Apple Service ID + Google OAuth client + SMTP secret).
//
// The minting helper `mintTestToken(...)` lives in
// `tests/e2e/_test_tokens.ts` (Node-only, uses Node's `crypto`) so the
// runtime hot path doesn't depend on Node. Server-side verification is
// what this file exposes.

import type { INakama } from '../nkruntime';
import { isAccountLinkProvider } from './types';

export const ACCOUNT_LINK_TEST_SECRET = 'p5v4-account-link-test-secret-do-not-ship';

export type VerifyTokenResult =
  | { ok: true; customId: string }
  | { ok: false; reason: 'malformed' | 'badSignature' | 'expired' | 'unknownProvider' };

/**
 * Validate a token received from the client. Returns the `customId` on
 * success so the caller can hand it to `nk.accountLinkCustom`.
 *
 * Nakama's `hmacSha256Hash` (3.27.0) returns the raw HMAC bytes via
 * goja `ArrayBuffer`; in practice JS code receives a `Uint8Array`. We
 * normalise to base64url here so the signature comparison happens at
 * a stable string level.
 */
export function verifyToken(nk: INakama, token: string): VerifyTokenResult {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return { ok: false, reason: 'malformed' };
  }
  const provider = parts[1];
  if (!isAccountLinkProvider(provider)) {
    return { ok: false, reason: 'unknownProvider' };
  }
  const payload = parts[2];
  const sig = parts[3];
  if (payload === undefined || sig === undefined) {
    return { ok: false, reason: 'malformed' };
  }
  const expected = bytesToBase64Url(nk.hmacSha256Hash(payload, ACCOUNT_LINK_TEST_SECRET));
  if (!constantTimeEquals(expected, sig)) {
    return { ok: false, reason: 'badSignature' };
  }
  let claims: { provider?: unknown; customId?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(nk.base64UrlDecode(payload));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof claims.provider !== 'string' ||
    typeof claims.customId !== 'string' ||
    typeof claims.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.provider !== provider) {
    return { ok: false, reason: 'malformed' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp <= nowSec) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, customId: claims.customId };
}

function bytesToBase64Url(value: string | Uint8Array | ArrayBuffer): string {
  // `hmacSha256Hash` may surface as either:
  //   - a `string` of base64url-encoded bytes (Node `digest('base64url')`,
  //     typed-surface array path) — already in the on-the-wire format,
  //     pass through unchanged; or
  //   - raw bytes (ArrayBuffer / Uint8Array from goja) — encode here.
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
  // Stand-alone base64url — never relies on Node's Buffer so the helper
  // works inside goja too.
  const b64 = (typeof btoa !== 'undefined')
    ? btoa(input)
    : Buffer.from(input, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}