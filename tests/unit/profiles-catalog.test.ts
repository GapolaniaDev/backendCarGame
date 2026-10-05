// Unit tests for `profiles/catalog.ts` — validation, blocked-word
// matching, and pattern enforcement.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadProfilesCatalog,
  validateAvatarUrl,
  validateDisplayName,
  _resetProfilesForTests,
  type RawProfilesFile,
} from '../../modules/src/profiles/catalog';
import type { ILogger } from '../../modules/src/nkruntime';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
} as unknown as ILogger;

const SAMPLE: RawProfilesFile = {
  version: 1,
  blockedWords: ['admin', 'system', 'badword'],
  displayName: {
    minLength: 2,
    maxLength: 16,
    pattern: '^[A-Za-z0-9 _\\-]+$',
  },
  avatarUrl: { maxLength: 256 },
  defaultDisplayName: 'Racer',
};

beforeEach(() => {
  _resetProfilesForTests();
  loadProfilesCatalog(SILENT_LOGGER, SAMPLE);
});

describe('profiles/catalog — validation', () => {
  it('accepts a clean displayName', () => {
    expect(validateDisplayName('Hugo Fast').ok).toBe(true);
    expect(validateDisplayName('a_b-c1').ok).toBe(true);
  });

  it('rejects too-short names', () => {
    expect(validateDisplayName('a').ok).toBe(false);
  });

  it('rejects too-long names', () => {
    expect(validateDisplayName('a'.repeat(20)).ok).toBe(false);
  });

  it('rejects characters outside the pattern', () => {
    expect(validateDisplayName('Hugo!').ok).toBe(false);
    expect(validateDisplayName('hugo@home').ok).toBe(false);
  });

  it('rejects names containing a blocked word (case-insensitive)', () => {
    const v = validateDisplayName('the Admin guy');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('FORBIDDEN');
    }
  });

  it('rejects blocked words as the entire name', () => {
    expect(validateDisplayName('system').ok).toBe(false);
    expect(validateDisplayName('SYSTEM').ok).toBe(false);
  });

  it('does not false-positive on similar-but-different words', () => {
    expect(validateDisplayName('administratrix').ok).toBe(true);
    expect(validateDisplayName('systems').ok).toBe(true);
  });

  it('validates avatarUrl length', () => {
    expect(validateAvatarUrl('https://cdn/x.png').ok).toBe(true);
    expect(validateAvatarUrl('x'.repeat(300)).ok).toBe(false);
  });

  it('throws when validation runs before load', () => {
    _resetProfilesForTests();
    expect(() => validateDisplayName('Hugo')).toThrow(/not loaded/);
  });
});