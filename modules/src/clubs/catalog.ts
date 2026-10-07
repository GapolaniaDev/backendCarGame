// Phase 7 Chunk 3 — Emblem catalog loader.
//
// Loads `modules/src/catalogs/emblemas.json` once at boot and exposes
// `getEmblema(id)` for validation. ~20 entries minimum (peer spec).
//
// Re-runnable: `loadEmblemasCatalog` overwrites the previous set; the
// helper `_resetEmblemasCatalogForTests` exists for vitest.

import type { ILogger } from '../nkruntime';
import { type EmblemDef } from './types';

let emblemas: EmblemDef[] | null = null;

/**
 * Validate an emblemas.json payload. Throws on shape mismatch.
 */
export function validateEmblemasCatalog(raw: unknown): asserts raw is EmblemDef[] {
  if (!Array.isArray(raw)) throw new Error('emblemas.json: must be an array');
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('emblemas.json: entry must be an object');
    }
    const e = entry as Partial<EmblemDef>;
    if (typeof e.id !== 'string' || e.id.length === 0) {
      throw new Error('emblemas.json: every entry needs an id');
    }
    if (typeof e.name !== 'string' || e.name.length === 0) {
      throw new Error(`emblemas.json: ${e.id} needs a name`);
    }
    if (typeof e.imageUrl !== 'string' || e.imageUrl.length === 0) {
      throw new Error(`emblemas.json: ${e.id} needs an imageUrl`);
    }
  }
}

/**
 * Load + validate. Idempotent; safe to call from InitModule.
 */
export function loadEmblemasCatalog(
  logger: ILogger,
  raw: unknown,
): EmblemDef[] {
  validateEmblemasCatalog(raw);
  emblemas = raw.slice();
  logger.info('emblemas catalog loaded: %d entries', emblemas.length);
  return emblemas;
}

/**
 * Test-only: clear the cached emblemas so each test reloads from the
 * source-TS loaders. Mirrors `_resetMissionsCatalogsForTests`.
 */
export function _resetEmblemasCatalogForTests(): void {
  emblemas = null;
}

/**
 * Get the loaded emblemas. Returns `[]` when no catalog has been
 * loaded (test stub). Use `getEmblema(id)` for the
 * common lookup; this raw accessor is for `club_search` previews.
 */
export function getEmblemas(): EmblemDef[] {
  return emblemas ?? [];
}

/**
 * Lookup one emblema by id. Returns null when missing.
 */
export function getEmblema(id: string): EmblemDef | null {
  if (emblemas === null) return null;
  return emblemas.find((e) => e.id === id) ?? null;
}