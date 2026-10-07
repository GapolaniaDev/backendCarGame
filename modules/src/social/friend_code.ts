// Phase 7 Chunk 1 — Stable friend-code generation.
//
// The friend code is a **deterministic** 8-character code derived from
// `sha256(userId + ':cv-friend-code-v1')`. There is NO random
// per-call: every call for the same `userId` yields the same code.
//
// Charset: 31 symbols (A-Z minus O/I/L + digits 2-9). The code maps the
// first 8 bytes of the hex digest into this alphabet. 31^8 ≈ 8.5e11
// distinct codes — collision rate is negligible at the catalog/user
// scales we care about.
//
// The salt (`'cv-friend-code-v1'`) is a deploy-time constant. Bumping
// it would re-randomise every user's code, so changes need a
// coordinated migration (out of scope for Chunk 1).
//
// `verifyCode(answer)` is the inverse: a player who pastes a code calls
// `friend_add_by_code`, which iterates the catalog of friend-code rows
// (via `storageList({collection:'friends_code'})`) and matches. We do
// NOT pre-index an `code -> userId` map (N is small enough that a linear
// scan is sub-ms in practice, and the catalog sits in a single
// collection).

import type { INakama } from '../nkruntime';
import {
  FRIEND_CODE_ALPHABET,
  FRIEND_CODE_LENGTH,
} from './types';

export const FRIEND_CODE_SALT = 'cv-friend-code-v1';
export const FRIEND_CODE_REGEX = /^[A-HJ-KM-NP-Z2-9]{8}$/;

const ALPHABET_LEN = FRIEND_CODE_ALPHABET.length; // 31
const HEX_PER_CODE = FRIEND_CODE_LENGTH * 2; // 16 hex chars

/**
 * Generate the stable friend code for `userId`.
 *
 * `nk.sha256Hash(input): string` is provided by the runtime (Nakama 3.27
 * goja runtime exposes it on `INakama`). Returns 64 lowercase hex chars.
 */
export function generateFriendCode(userId: string, nk: INakama): string {
  const hex = nk.sha256Hash(`${userId}:${FRIEND_CODE_SALT}`);
  // Defensive: if the runtime returns '0x...' (some Go bindings add the
  // prefix), strip it.
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  // Map the first 8 bytes (16 hex digits) into the 31-char alphabet.
  // Each output char takes 5 hex bits (since 31 ≈ 32); we just take
  // each pair of hex digits as a byte (0-255) and reduce mod 31.
  let out = '';
  for (let i = 0; i < HEX_PER_CODE; i += 2) {
    const pair = clean.slice(i, i + 2);
    const byte = parseInt(pair, 16);
    if (Number.isNaN(byte)) {
      throw new Error(
        `generateFriendCode: sha256Hash produced unparseable byte at index ${i}`,
      );
    }
    out += FRIEND_CODE_ALPHABET[byte % ALPHABET_LEN];
  }
  if (out.length !== FRIEND_CODE_LENGTH) {
    throw new Error(
      `generateFriendCode: produced ${out.length} chars, expected ${FRIEND_CODE_LENGTH}`,
    );
  }
  return out;
}

/**
 * Validate the format of a user-pasted code. Returns `true` for any
 * 8-char string using `FRIEND_CODE_ALPHABET`. Does NOT check existence
 * — that's the RPC's job (`friend_add_by_code` resolves the code → userId
 * via `storageList`).
 */
export function isValidCodeFormat(code: string): boolean {
  return typeof code === 'string' && FRIEND_CODE_REGEX.test(code);
}

/**
 * Test-only helper: build the canonical pre-image so they can verify
 * `generateFriendCode` is stable across deploys.
 */
export function friendCodePreImage(userId: string): string {
  return `${userId}:${FRIEND_CODE_SALT}`;
}