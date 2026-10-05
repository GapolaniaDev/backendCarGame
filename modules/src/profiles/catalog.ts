// Profile catalog: declarative registry loaded at InitModule to
// gate the profile_update RPC. The catalog owns the blocked-words list
// ( applied to displayName) and the displayName/avatarUrl validation
// rules. The runtime catalog is cross-worker persisted via localcache
// the same way tracks/modes/leaderboards are.
//
// Phase 2 spec:
//   "el RPC profile_update valida la entrada contra una lista de
//    palabras bloqueadas y los límites del catálogo".

import type { ILogger, INakama } from '../nkruntime';

export interface ProfilesCatalog {
  version: number;
  blockedWords: ReadonlySet<string>;
  displayNameRules: {
    minLength: number;
    maxLength: number;
    pattern: RegExp;
  };
  avatarUrlRules: {
    maxLength: number;
  };
  defaultDisplayName: string;
}

export interface RawProfilesFile {
  version: number;
  blockedWords: string[];
  displayName: { minLength: number; maxLength: number; pattern: string };
  avatarUrl: { maxLength: number };
  defaultDisplayName: string;
}

export const PROFILES_CATALOG_CACHE_KEY = 'profiles:catalog:v1';

let moduleCatalog: ProfilesCatalog | null = null;

export function getProfilesCatalog(): ProfilesCatalog {
  if (moduleCatalog === null) {
    throw new Error('profiles catalog not loaded; call loadProfilesCatalog() first');
  }
  return moduleCatalog;
}

export function loadProfilesCatalog(
  logger: ILogger,
  raw: RawProfilesFile,
  nk?: INakama,
): void {
  validate(raw);
  moduleCatalog = {
    version: raw.version,
    blockedWords: new Set(raw.blockedWords.map((w) => w.toLowerCase())),
    displayNameRules: {
      minLength: raw.displayName.minLength,
      maxLength: raw.displayName.maxLength,
      pattern: new RegExp(raw.displayName.pattern),
    },
    avatarUrlRules: {
      maxLength: raw.avatarUrl.maxLength,
    },
    defaultDisplayName: raw.defaultDisplayName,
  };

  if (nk) {
    nk.localcachePut(
      PROFILES_CATALOG_CACHE_KEY,
      JSON.stringify({
        version: raw.version,
        blockedWords: raw.blockedWords,
        displayName: raw.displayName,
        avatarUrl: raw.avatarUrl,
        defaultDisplayName: raw.defaultDisplayName,
      }),
      7 * 24 * 60 * 60,
    );
  }
  logger.info(
    'profiles catalog loaded: blockedWords=%d defaultName=%s',
    raw.blockedWords.length,
    raw.defaultDisplayName,
  );
}

export function _resetProfilesForTests(): void {
  moduleCatalog = null;
}

export type ValidationResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * Validate a displayName against the catalog. Returns `{ ok: false }`
 * with a stable error code/message on rejection. Match is
 * case-insensitive against the blocked-words list and the raw name
 * is matched against the pattern (so users cannot sneak past via
 * mixed-case or zero-width chars).
 */
export function validateDisplayName(name: string): ValidationResult {
  const cat = getProfilesCatalog();
  if (typeof name !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', message: 'displayName must be a string' };
  }
  if (name.length < cat.displayNameRules.minLength) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: `displayName too short (min ${cat.displayNameRules.minLength})`,
    };
  }
  if (name.length > cat.displayNameRules.maxLength) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: `displayName too long (max ${cat.displayNameRules.maxLength})`,
    };
  }
  if (!cat.displayNameRules.pattern.test(name)) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: 'displayName contains characters outside the allowed set',
    };
  }
  // Blocked-words check: any whitespace-separated token must not be
  // an exact match against the blocked list (case-insensitive).
  const tokens = name.toLowerCase().split(/\s+/);
  for (const t of tokens) {
    if (cat.blockedWords.has(t)) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'displayName contains a blocked word',
      };
    }
  }
  return { ok: true };
}

export function validateAvatarUrl(url: string): ValidationResult {
  const cat = getProfilesCatalog();
  if (typeof url !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', message: 'avatarUrl must be a string' };
  }
  if (url.length > cat.avatarUrlRules.maxLength) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: `avatarUrl too long (max ${cat.avatarUrlRules.maxLength})`,
    };
  }
  return { ok: true };
}

function validate(raw: unknown): asserts raw is RawProfilesFile {
  const fail = (msg: string): never => {
    throw new Error(`profiles catalog invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail('version must be 1');
  if (!Array.isArray(r['blockedWords'])) fail('blockedWords must be an array');
  for (const w of r['blockedWords'] as unknown[]) {
    if (typeof w !== 'string' || w.length === 0) {
      fail('each blockedWord must be a non-empty string');
    }
  }
  const dn = r['displayName'];
  if (!isPlainObject(dn)) fail('displayName must be an object');
  const dnObj = dn as Record<string, unknown>;
  if (typeof dnObj['minLength'] !== 'number' || dnObj['minLength'] < 1) {
    fail('displayName.minLength must be a positive number');
  }
  if (
    typeof dnObj['maxLength'] !== 'number' ||
    typeof dnObj['minLength'] !== 'number' ||
    dnObj['maxLength'] < dnObj['minLength']
  ) {
    fail('displayName.maxLength must be >= minLength');
  }
  if (typeof dnObj['pattern'] !== 'string') fail('displayName.pattern must be a string');
  const au = r['avatarUrl'];
  if (!isPlainObject(au)) fail('avatarUrl must be an object');
  if (typeof (au as Record<string, unknown>)['maxLength'] !== 'number') {
    fail('avatarUrl.maxLength must be a number');
  }
  if (typeof r['defaultDisplayName'] !== 'string' || r['defaultDisplayName'].length === 0) {
    fail('defaultDisplayName must be a non-empty string');
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}