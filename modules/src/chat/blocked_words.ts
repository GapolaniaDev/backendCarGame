// Phase 7 Chunk 6 — Blocked-words catalog + leet-normalized check.
//
// Catalog shape (`blocked_words.json`):
//   {
//     version: 1,
//     blocked: { es: string[], en: string[], pt: string[] }
//   }
//
// Backward compat: if `blocked` is a flat string array (the Phase 2
// profile-update schema), we treat it as the `es` bucket — every other
// language is empty. This avoids breaking a stale config when the
// chat catalog first ships.
//
// Detection:
//   - Case-insensitive
//   - Leet-substitution normalized: `@→a`, `1→i`, `0→o`, `$→s`, `3→e`,
//     `7→t`, `5→s`, `!→i`, `+→t`, `|→l` (common shape-based bypass).
//   - Token-by-token match (whitespace split) against the normalized
//     content. This means `tontos` matches `tonto` only if the bucketed
//     word is a token-prefix; we use substring match for tighter
//     moderation (matches anywhere in the normalized content).

import type { ILogger, INakama } from '../nkruntime';
import { CHAT_LANGUAGES, type ChatLanguage } from './types';

export interface BlockedWordsCatalog {
  version: number;
  /** language → normalized (lowercase) set of blocked tokens */
  byLanguage: Record<ChatLanguage, ReadonlySet<string>>;
}

export interface RawBlockedWordsFile {
  version: number;
  /**
   * New shape: per-language arrays.
   * Backward-compat: a flat string array is treated as the `es` bucket
   * with every other language empty.
   */
  blocked:
    | Record<string, string[]>
    | string[];
}

// ─── Module cache ───────────────────────────────────────────────────────────

let moduleCatalog: BlockedWordsCatalog | null = null;
export const BLOCKED_WORDS_CACHE_KEY = 'chat:blocked_words:v1';

export function getBlockedWordsCatalog(): BlockedWordsCatalog {
  if (moduleCatalog === null) {
    throw new Error('blocked words catalog not loaded; call loadBlockedWordsCatalog() first');
  }
  return moduleCatalog;
}

export function _resetBlockedWordsForTests(): void {
  moduleCatalog = null;
}

// ─── Load + validate ────────────────────────────────────────────────────────

export function loadBlockedWordsCatalog(
  logger: ILogger,
  raw: unknown,
  nk?: INakama,
): BlockedWordsCatalog {
  validate(raw);
  const r = raw as RawBlockedWordsFile;

  const byLanguage: Record<ChatLanguage, Set<string>> = {
    es: new Set(),
    en: new Set(),
    pt: new Set(),
  };
  if (Array.isArray(r.blocked)) {
    // Backward-compat: flat array → all 'es'.
    for (const w of r.blocked) byLanguage['es'].add(w.toLowerCase());
  } else {
    for (const lang of CHAT_LANGUAGES) {
      const arr = r.blocked[lang];
      if (Array.isArray(arr)) {
        for (const w of arr) byLanguage[lang].add(w.toLowerCase());
      }
    }
  }

  const cat: BlockedWordsCatalog = {
    version: r.version,
    byLanguage: {
      es: byLanguage['es'],
      en: byLanguage['en'],
      pt: byLanguage['pt'],
    },
  };
  moduleCatalog = cat;

  if (nk) {
    // Persist a JSON-encoded snapshot for cross-worker reuse.
    nk.localcachePut(
      BLOCKED_WORDS_CACHE_KEY,
      JSON.stringify({
        version: r.version,
        blocked: r.blocked,
      }),
      7 * 24 * 60 * 60,
    );
  }
  logger.info(
    'blocked_words catalog loaded: es=%d en=%d pt=%d',
    byLanguage['es'].size, byLanguage['en'].size, byLanguage['pt'].size,
  );
  return cat;
}

// ─── Leet normalize ─────────────────────────────────────────────────────────

/**
 * Normalize a string for blocked-word matching: lowercase + replace
 * common leet substitutions with their letter equivalents. Catches
 * shape-based bypasses (`@→a`, `0→o`, `1→i`, `3→e`, `7→t`, `$→s`,
 * `5→s`, `!→i`, `+→t`, `|→l`). Multi-char leet shapes (e.g. `|3→b`,
 * `\/→v`) are intentionally NOT decoded — those require a fuller
 * obfuscation layer and are out of scope for the cheap pre-check.
 */
export function normalizeLeet(s: string): string {
  const out = s.toLowerCase();
  // Order matters: do single-char subs; `1` for clarity, but plain
  // digits/letters work too. Using a simple char-by-char pass keeps
  // the output predictable.
  let result = '';
  for (let i = 0; i < out.length; i++) {
    const c = out.charCodeAt(i);
    switch (c) {
      case 0x40: result += 'a'; break; // @
      case 0x30: result += 'o'; break; // 0
      case 0x31: result += 'i'; break; // 1
      case 0x33: result += 'e'; break; // 3
      case 0x35: result += 's'; break; // 5
      case 0x37: result += 't'; break; // 7
      case 0x24: result += 's'; break; // $
      case 0x21: result += 'i'; break; // !
      case 0x2b: result += 't'; break; // +
      case 0x7c: result += 'l'; break; // |
      default: result += out[i];
    }
  }
  return result;
}

// ─── Check ──────────────────────────────────────────────────────────────────

/**
 * Returns true when `content` (leet-normalized + lowercased) contains
 * ANY blocked token from the given language's bucket as a substring.
 *
 * Substring (not whole-word) match is intentional: it's stricter than
 * token match and avoids false negatives on morphological variants
 * (`tontos` would escape a token-only check). False positives are
 * acceptable for moderation; a noisy admin override is a future layer.
 */
export function containsBlockedWord(content: string, language: ChatLanguage): boolean {
  const cat = getBlockedWordsCatalog();
  const bucket = cat.byLanguage[language];
  if (bucket.size === 0) return false;
  const norm = normalizeLeet(content);
  for (const w of bucket) {
    if (norm.includes(w)) return true;
  }
  return false;
}

// ─── Pure validators (internal) ─────────────────────────────────────────────

function validate(raw: unknown): asserts raw is RawBlockedWordsFile {
  const fail = (msg: string): never => {
    throw new Error(`blocked_words catalog invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail('version must be 1');
  const b = r['blocked'];
  if (Array.isArray(b)) {
    for (const w of b as unknown[]) {
      if (typeof w !== 'string' || w.length === 0) {
        fail('each blocked word (flat array) must be a non-empty string');
      }
    }
    return;
  }
  if (!isPlainObject(b)) fail('blocked must be an object or array');
  for (const lang of Object.keys(b as Record<string, unknown>)) {
    const arr = (b as Record<string, unknown>)[lang];
    if (!Array.isArray(arr)) fail(`blocked.${lang} must be an array`);
    for (const w of arr as unknown[]) {
      if (typeof w !== 'string' || w.length === 0) {
        fail(`blocked.${lang}: each entry must be a non-empty string`);
      }
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}