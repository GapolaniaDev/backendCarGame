// Phase 5 Chunk 8 unit tests — `signRelayToken` / `verifyRelayToken`
// HMAC-SHA-256 round-trip + tamper detection.

import { describe, it, expect } from 'vitest';
import { FakeNakama } from '../e2e/_stubs';
import {
  signRelayToken,
  verifyRelayToken,
  buildRelayTokenPayload,
  RELAY_TOKEN_VERSION,
  RELAY_TOKEN_TTL_SEC,
} from '../../modules/src/region/relay_token';

const SECRET = 'unit-test-secret-32bytes-xxxxxxxxxxx';

function makeFakeNakama(): FakeNakama['nakama'] {
  return new FakeNakama().nakama;
}

describe('relay_token — HMAC sign/verify', () => {
  it('1. sign + verify round-trip happy', () => {
    const nk = makeFakeNakama();
    const expSec = Math.floor(Date.now() / 1000) + RELAY_TOKEN_TTL_SEC;
    const tok = signRelayToken(
      nk,
      { userId: 'u-1', region: 'eu-west-1', expSec },
      SECRET,
    );
    expect(tok.startsWith(`${RELAY_TOKEN_VERSION}.`)).toBe(true);
    const v = verifyRelayToken(nk, tok, SECRET);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.payload.userId).toBe('u-1');
    expect(v.payload.region).toBe('eu-west-1');
    expect(v.payload.exp).toBe(expSec);
    expect(v.payload.v).toBe(1);
  });

  it('2. malformed (not 3 parts) → reason=malformed', () => {
    const nk = makeFakeNakama();
    expect(verifyRelayToken(nk, 'v1', SECRET).reason).toBe('malformed');
    expect(verifyRelayToken(nk, 'v1.a.b.c.d', SECRET).reason).toBe('malformed');
    expect(verifyRelayToken(nk, 'v0.<p>.<s>', SECRET).reason).toBe('malformed');
    expect(verifyRelayToken(nk, '', SECRET).reason).toBe('malformed');
  });

  it('3. expired (exp < nowSec) → reason=expired', () => {
    const nk = makeFakeNakama();
    const nowSec = 1_700_000_000;
    const expSec = nowSec - 1; // already past
    const tok = signRelayToken(nk, { userId: 'u-1', region: 'eu-west-1', expSec }, SECRET);
    expect(verifyRelayToken(nk, tok, SECRET, nowSec).reason).toBe('expired');
  });

  it('4. bad signature (tampered payload) → reason=bad_sig', () => {
    const nk = makeFakeNakama();
    const expSec = Math.floor(Date.now() / 1000) + RELAY_TOKEN_TTL_SEC;
    const tok = signRelayToken(nk, { userId: 'u-1', region: 'eu-west-1', expSec }, SECRET);
    const parts = tok.split('.');
    // Flip one character in the payload b64 to break the signature.
    const payload = parts[1];
    const tampered = `${RELAY_TOKEN_VERSION}.${payload!.slice(0, -2)}AA.${parts[2]}`;
    expect(verifyRelayToken(nk, tampered, SECRET).reason).toBe('bad_sig');
  });

  it('5. wrong secret → reason=bad_sig', () => {
    const nk = makeFakeNakama();
    const expSec = Math.floor(Date.now() / 1000) + RELAY_TOKEN_TTL_SEC;
    const tok = signRelayToken(nk, { userId: 'u-1', region: 'eu-west-1', expSec }, SECRET);
    expect(verifyRelayToken(nk, tok, 'other-secret').reason).toBe('bad_sig');
  });

  it('6. sign is deterministic given (payload, secret)', () => {
    const nk = makeFakeNakama();
    const expSec = 1_700_000_500;
    const a = signRelayToken(nk, { userId: 'u-1', region: 'eu-west-1', expSec }, SECRET);
    const b = signRelayToken(nk, { userId: 'u-1', region: 'eu-west-1', expSec }, SECRET);
    expect(a).toBe(b);
    // Different userId → different signature.
    const c = signRelayToken(nk, { userId: 'u-2', region: 'eu-west-1', expSec }, SECRET);
    expect(c).not.toBe(a);
    // And the wire payload is reproducible (used in assertEnvelope tests).
    expect(buildRelayTokenPayload({ userId: 'u-1', region: 'eu-west-1', expSec }))
      .toBe('{"v":1,"userId":"u-1","region":"eu-west-1","exp":1700000500}');
  });
});