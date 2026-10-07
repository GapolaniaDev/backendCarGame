// Phase 7 Chunk 6 — Blocked-words catalog + leet-normalized check.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _resetBlockedWordsForTests,
  containsBlockedWord,
  loadBlockedWordsCatalog,
  normalizeLeet,
} from '../../modules/src/chat/blocked_words';
import type { RawBlockedWordsFile } from '../../modules/src/chat/blocked_words';
import { FakeLogger } from '../e2e/_stubs';

describe('chat blocked-words catalog (Phase 7 Chunk 6)', () => {
  beforeEach(() => {
    _resetBlockedWordsForTests();
  });

  it('loads a multi-lang object with es / en / pt buckets', () => {
    const raw = {
      version: 1,
      blocked: { es: ['Idiota'], en: ['Idiot'], pt: ['Burro'] },
    };
    const cat = loadBlockedWordsCatalog(new FakeLogger(), raw as RawBlockedWordsFile);
    expect(cat.version).toBe(1);
    expect(cat.byLanguage['es'].has('idiota')).toBe(true);
    expect(cat.byLanguage['en'].has('idiot')).toBe(true);
    expect(cat.byLanguage['pt'].has('burro')).toBe(true);
  });

  it('accepts the legacy flat-array shape and routes it to es', () => {
    const raw = {
      version: 1,
      blocked: ['tonto', 'idiota'],
    };
    const cat = loadBlockedWordsCatalog(new FakeLogger(), raw as unknown as RawBlockedWordsFile);
    expect(cat.byLanguage['es'].has('tonto')).toBe(true);
    expect(cat.byLanguage['en'].size).toBe(0);
    expect(cat.byLanguage['pt'].size).toBe(0);
  });

  it('lowercases every entry at load time', () => {
    const raw = { version: 1, blocked: { es: ['TONTO', 'IdIoTa'], en: [], pt: [] } };
    const cat = loadBlockedWordsCatalog(new FakeLogger(), raw as RawBlockedWordsFile);
    expect(Array.from(cat.byLanguage['es'])).toEqual(['tonto', 'idiota']);
  });

  it('checkBlocked is case-insensitive against the raw content', () => {
    loadBlockedWordsCatalog(new FakeLogger(), {
      version: 1,
      blocked: { es: ['tonto'], en: [], pt: [] },
    });
    expect(containsBlockedWord('TONTO', 'es')).toBe(true);
    expect(containsBlockedWord('eres un Tonto', 'es')).toBe(true);
    expect(containsBlockedWord('hola mundo', 'es')).toBe(false);
  });

  it('checkBlocked detects leet substitutions', () => {
    loadBlockedWordsCatalog(new FakeLogger(), {
      version: 1,
      blocked: { es: [], en: ['idiot', 'shit', 'bitch', 'ass'], pt: [] },
    });
    // @→a, 1→i, 0→o, $→s, 3→e, 7→t, 5→s, !→i, +→t, |→l
    expect(containsBlockedWord('@ss', 'en')).toBe(true);  // ass via @→a
    expect(containsBlockedWord('1d10t', 'en')).toBe(true); // idiot
    expect(containsBlockedWord('$h1t', 'en')).toBe(true);  // shit
    expect(containsBlockedWord('b1tch', 'en')).toBe(true); // bitch
    expect(containsBlockedWord('h3||0', 'en')).toBe(false); // hello (clean)
  });

  it('checkBlocked is per-language — same word in different bucket', () => {
    loadBlockedWordsCatalog(new FakeLogger(), {
      version: 1,
      blocked: { es: ['tonto'], en: ['tonto'], pt: [] },
    });
    expect(containsBlockedWord('tonto', 'es')).toBe(true);
    expect(containsBlockedWord('tonto', 'en')).toBe(true);
    expect(containsBlockedWord('tonto', 'pt')).toBe(false);
  });

  it('empty bucket = no false positives for that language', () => {
    loadBlockedWordsCatalog(new FakeLogger(), {
      version: 1,
      blocked: { es: [], en: [], pt: [] },
    });
    expect(containsBlockedWord('cualquier cosa', 'es')).toBe(false);
    expect(containsBlockedWord('cualquier cosa', 'en')).toBe(false);
    expect(containsBlockedWord('cualquier cosa', 'pt')).toBe(false);
  });

  it('validate rejects unknown version', () => {
    expect(() => {
      loadBlockedWordsCatalog(new FakeLogger(), {
        version: 2,
        blocked: { es: [], en: [], pt: [] },
      } as unknown as RawBlockedWordsFile);
    }).toThrow(/version/);
  });

  it('normalizeLeet replaces the canonical substitutions', () => {
    // A→a, @→a, 1→i, O→o, 0→o, $→s, 3→e
    expect(normalizeLeet('A@1O0$3')).toBe('aaioose');
    // 5→s, h→h, !→i, +→t, |→l
    expect(normalizeLeet('5h!+|')).toBe('shitl');
  });
});