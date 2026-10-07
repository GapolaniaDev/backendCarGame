// Phase 7 Chunk 1 — friend code unit tests.
//
// Covers:
//   1. generateFriendCode is a SHA-256-based deterministic function of
//      `userId`. Same input → same code, every time.
//   2. Output is exactly 8 chars, drawn from the 31-char alphabet
//      (A-Z minus O/I/L + digits 2-9).
//   3. Different userIds produce different codes (high probability).
//   4. `0x`-prefixed sha256Hash output is tolerated (some Go bindings
//      prepend `0x`).
//   5. isValidCodeFormat accepts valid codes; rejects 0/O/1/I/L chars,
//      wrong lengths, non-strings.
//   6. FRIEND_CODE_SALT is the locked constant.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import type { INakama } from '../../modules/src/nkruntime';
import {
  generateFriendCode,
  isValidCodeFormat,
  friendCodePreImage,
  FRIEND_CODE_SALT,
} from '../../modules/src/social/friend_code';
import {
  FRIEND_CODE_ALPHABET,
  FRIEND_CODE_LENGTH,
  RECENT_RIVALS_CAP,
  RECENT_RIVALS_WINDOW_MS,
} from '../../modules/src/social/types';

function makeNk(): INakama {
  return {
    sha256Hash: (s: string): string =>
      createHash('sha256').update(s).digest('hex'),
  } as unknown as INakama;
}

describe('friend_code (Phase 7 Chunk 1)', () => {
  describe('FRIEND_CODE_SALT', () => {
    it('is the locked constant "cv-friend-code-v1"', () => {
      expect(FRIEND_CODE_SALT).toBe('cv-friend-code-v1');
    });
  });

  describe('alphabet + length constants', () => {
    it('FRIEND_CODE_ALPHABET is 31 chars (A-Z − O/I/L + 2-9)', () => {
      expect(FRIEND_CODE_ALPHABET.length).toBe(31);
      // No 0, O, 1, I, L
      expect(FRIEND_CODE_ALPHABET).not.toMatch(/[0O1IL]/);
      // Has digits 2-9
      expect(FRIEND_CODE_ALPHABET).toMatch(/[2-9]/);
      // Has A,B,C,..,Z minus O,I,L
      const expected = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      expect(FRIEND_CODE_ALPHABET).toBe(expected);
    });

    it('FRIEND_CODE_LENGTH is 8', () => {
      expect(FRIEND_CODE_LENGTH).toBe(8);
    });

    it('RECENT_RIVALS_CAP is 20', () => {
      expect(RECENT_RIVALS_CAP).toBe(20);
    });

    it('RECENT_RIVALS_WINDOW_MS is 30 days', () => {
      expect(RECENT_RIVALS_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });

  describe('generateFriendCode', () => {
    it('produces a string of FRIEND_CODE_LENGTH (8) chars', () => {
      const nk = makeNk();
      const code = generateFriendCode('userA', nk);
      expect(typeof code).toBe('string');
      expect(code.length).toBe(8);
    });

    it('uses only the FRIEND_CODE_ALPHABET characters', () => {
      const nk = makeNk();
      for (const uid of ['userA', 'userB', 'userZ', 'long-user-id-1234']) {
        const code = generateFriendCode(uid, nk);
        for (const ch of code) {
          expect(FRIEND_CODE_ALPHABET).toContain(ch);
        }
      }
    });

    it('is deterministic across calls', () => {
      const nk = makeNk();
      const a = generateFriendCode('userA', nk);
      const b = generateFriendCode('userA', nk);
      const c = generateFriendCode('userA', nk);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it('returns different codes for different userIds', () => {
      const nk = makeNk();
      const codes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        codes.add(generateFriendCode(`user-${i}`, nk));
      }
      // 50 codes from a 31-char alphabet of length 8 → 31^8 unique
      // values, collisions are vanishingly rare.
      expect(codes.size).toBe(50);
    });

    it('is stable across 1000 calls', () => {
      const nk = makeNk();
      const first = generateFriendCode('user-stable', nk);
      for (let i = 0; i < 1000; i++) {
        const next = generateFriendCode('user-stable', nk);
        expect(next).toBe(first);
      }
    });

    it('strips a 0x prefix when sha256Hash returns one', () => {
      const nk: INakama = {
        sha256Hash: (s: string): string =>
          '0x' + createHash('sha256').update(s).digest('hex'),
      } as unknown as INakama;
      const code = generateFriendCode('user-prefix', nk);
      expect(code.length).toBe(8);
      for (const ch of code) {
        expect(FRIEND_CODE_ALPHABET).toContain(ch);
      }
    });

    it('matches a manual sha256 implementation', () => {
      const nk = makeNk();
      const uid = 'user-manual';
      const expectedHex = createHash('sha256')
        .update(`${uid}:${FRIEND_CODE_SALT}`)
        .digest('hex');
      let manualCode = '';
      for (let i = 0; i < 16; i += 2) {
        const byte = parseInt(expectedHex.slice(i, i + 2), 16);
        manualCode += FRIEND_CODE_ALPHABET[byte % FRIEND_CODE_ALPHABET.length];
      }
      const generated = generateFriendCode(uid, nk);
      expect(generated).toBe(manualCode);
    });

    it('friendCodePreImage returns the canonical pre-image', () => {
      expect(friendCodePreImage('userX')).toBe(`userX:${FRIEND_CODE_SALT}`);
    });

    it('throws when sha256Hash returns garbage', () => {
      const nk: INakama = {
        sha256Hash: (): string => 'not-hex-data-zzzzzzzzzzzzzzzzzz',
      } as unknown as INakama;
      expect(() => generateFriendCode('userX', nk)).toThrow(/unparseable/);
    });
  });

  describe('isValidCodeFormat', () => {
    it('accepts 8-char codes from the alphabet', () => {
      expect(isValidCodeFormat('ABCDEFGH')).toBe(true);
      expect(isValidCodeFormat('23456789')).toBe(true);
      expect(isValidCodeFormat('JKKMNPPP')).toBe(true);
      expect(isValidCodeFormat('ZZZZZZZZ')).toBe(true);
    });

    it('rejects codes containing forbidden chars (0/O/1)', () => {
      expect(isValidCodeFormat('ABCDE0FG')).toBe(false);
      expect(isValidCodeFormat('OBCDEFGH')).toBe(false);
      expect(isValidCodeFormat('1BCDEFGH')).toBe(false);
      expect(isValidCodeFormat('ABCDEFG1')).toBe(false);
    });

    it('rejects codes with wrong length', () => {
      expect(isValidCodeFormat('ABCDE')).toBe(false);
      expect(isValidCodeFormat('ABCDEFG')).toBe(false);
      expect(isValidCodeFormat('ABCDEFGHI')).toBe(false);
      expect(isValidCodeFormat('')).toBe(false);
    });

    it('rejects non-string inputs', () => {
      expect(isValidCodeFormat(undefined as unknown as string)).toBe(false);
      expect(isValidCodeFormat(null as unknown as string)).toBe(false);
      expect(isValidCodeFormat(123 as unknown as string)).toBe(false);
    });

    it('accepts lowercase as a courtesy? (no — strict upper only)', () => {
      // We document upper-only; lowercase is NOT valid format.
      expect(isValidCodeFormat('abcdefgh')).toBe(false);
    });
  });
});