// Test-only helper that mints account-link tokens.
//
// The server-side `verifyToken` (in `modules/src/account/token.ts`)
// accepts the test-mode token format `v1.<provider>.<b64Payload>.<b64Sig>`
// where the signature is `hmacSha256(payload, TEST_SECRET)` base64-encoded.
//
// Tests build it here with Node's `crypto` directly, avoiding the
// `hmacSha256Hash`/ArrayBuffer formatting tangle from inside the goja
// runtime. The server's `verifyToken` recomputes the HMAC via
// `nk.hmacSha256Hash` and base64-encodes — see `verifyToken` for the
// encoding format the runtime expects.

import { createHmac } from 'node:crypto';

export const ACCOUNT_LINK_TEST_SECRET = 'p5v4-account-link-test-secret-do-not-ship';

export function mintTestToken(provider: string, customId: string, ttlSec: number): string {
  const claims = { provider, customId, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = createHmac('sha256', ACCOUNT_LINK_TEST_SECRET).update(payload).digest('base64url');
  return `v1.${provider}.${payload}.${sig}`;
}