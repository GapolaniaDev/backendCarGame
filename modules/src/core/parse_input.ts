// Phase 5 Chunk 6 — Shared JSON-body parser.
//
// Extracted from `account/rpcs.ts` (Phase 5 Chunk 4) where it was
// inline. Now used by `account/rpcs.ts`, `liveops/rpcs.ts`, and
// `admin/rpcs.ts`. Returns the parsed payload both as `value` (typed
// `unknown` — handlers cast as needed) and as `raw` (Record, used to
// sniff top-level fields like `adminKey` without re-typing).

import { err } from './response';

export interface ParseOk<T> {
  ok: true;
  value: T;
  raw: Record<string, unknown>;
}
export interface ParseErr {
  ok: false;
  error: string;
}

/**
 * Parse a JSON body string into `{value, raw}`. Empty body → empty
 * object. Non-object payload → `BAD_REQUEST`. Returns the serialized
 * `err()` envelope on failure so the caller can return it directly.
 */
export function parseInput(body: string): ParseOk<unknown> | ParseErr {
  const t = body.trim();
  let raw: unknown = {};
  if (t.length > 0) {
    try {
      raw = JSON.parse(t);
    } catch {
      return { ok: false, error: JSON.stringify(err('BAD_REQUEST', 'payload is not valid JSON')) };
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: JSON.stringify(err('BAD_REQUEST', 'payload must be an object')) };
  }
  return { ok: true, value: raw, raw: raw as Record<string, unknown> };
}