// Phase 8 Chunk 5 — Tournament catalog loader + lazy instance helpers.
//
// Reads `catalogs/tournaments.json` once at boot via `loadTournamentsCatalog`.
// The catalog is the source of TEMPLATES; a Tournament INSTANCE is
// materialised on first access (Phase 2 leaderboard pattern).
//
// `ensureTournamentInstance(template, nowUtc)` materialises a template
// into the `tournament_instances/{templateId}` system-owned row on the
// fly; the storage write is idempotent (CAS-retry handles concurrent
// workers). State transitions (open → closing → closed) and prize
// awarding are owned by the Chunk 6 subscriber; this catalog stays
// state='open' on creation.

import type { ILogger, INakama } from '../nkruntime';
import {
  validateTournamentsFile,
  type RawTournamentsFile,
  type Tournament,
  type TournamentTemplate,
} from './types';
import {
  readTournamentInstance,
  writeTournamentInstance,
  TOURNAMENT_INSTANCES_COLLECTION,
  TOURNAMENT_INSTANCES_SYSTEM_USER,
} from './repo';

/** How far ahead of `nowUtc` we materialise upcoming tournaments. */
export const TOURNAMENT_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Cached templates ────────────────────────────────────────────────────

let CACHED: ReadonlyArray<TournamentTemplate> | null = null;

/**
 * Validate and cache the tournaments catalog at boot. Public for the
 * main.ts boot path. Idempotent; subsequent calls are no-ops.
 */
export function loadTournamentsCatalog(
  logger: ILogger,
  raw: unknown,
): ReadonlyArray<TournamentTemplate> {
  const v = validateTournamentsFile(raw);
  if (!v.ok) {
    throw new Error(`tournaments catalog invalid: ${v.reason}`);
  }
  CACHED = Object.freeze(
    v.value.templates.map((t) => Object.freeze({ ...t })),
  );
  logger.info('tournaments catalog loaded: templates=%d', CACHED.length);
  return CACHED;
}

/**
 * Returns the in-memory template list. Throws if the boot loader
 * hasn't run yet — every test RPCs use `loadTournamentsCatalog` first.
 */
export function getTournamentTemplates(): ReadonlyArray<TournamentTemplate> {
  if (CACHED === null) {
    throw new Error(
      'tournaments catalog not loaded — call loadTournamentsCatalog at boot',
    );
  }
  return CACHED;
}

/** Test hook: wipes the cached templates. */
export function _resetTournamentsCatalogForTests(): void {
  CACHED = null;
}

// ─── Lazy instance materialisation ────────────────────────────────────────

/**
 * Find the template by id (or undefined). Public so RPCs can resolve a
 * caller-provided `tournamentId` (which is the template id in the Chunk
 * 5 model) to the template record.
 */
export function findTournamentTemplate(
  id: string,
): TournamentTemplate | undefined {
  return getTournamentTemplates().find((t) => t.id === id);
}

/**
 * Pure helper: returns the `Date.parse`'d window for a template. Returns
 * `{ startsAt: NaN, endsAt: NaN }` when the dates are malformed —
 * callers should treat NaN as "skip" rather than throw.
 */
export function tournamentWindow(t: TournamentTemplate): {
  startsAt: number;
  endsAt: number;
} {
  return {
    startsAt: Date.parse(t.startsAtUtc),
    endsAt: Date.parse(t.endsAtUtc),
  };
}

/**
 * Materialise a tournament template into a runtime instance. Reads
 * `tournament_instances/{templateId}` first; if absent, writes a new
 * instance (CAS-retry handles concurrent workers). Returns the persisted
 * instance — either the freshly-created one or the one other workers
 * already created.
 */
export function ensureTournamentInstance(
  nk: INakama,
  template: TournamentTemplate,
  nowUtc: number,
): Tournament {
  const existing = readTournamentInstance(nk, template.id);
  if (existing !== null) return existing;
  const { startsAt, endsAt } = tournamentWindow(template);
  const fresh: Tournament = {
    schemaVersion: 1,
    id: template.id,
    templateId: template.id,
    kind: template.kind,
    trackId: template.trackId,
    startsAt,
    endsAt,
    entryFee: template.entryFee,
    maxAttempts: template.maxAttempts,
    minLevel: template.minLevel,
    prizes: template.prizes.map((p) => ({ ...p, rewards: { ...p.rewards } })),
    createdAt: nowUtc,
  };
  writeTournamentInstance(nk, fresh);
  return fresh;
}

/**
 * Walk every cached template, materialise the ones whose window
 * overlaps `[nowUtc, nowUtc + TOURNAMENT_LOOKAHEAD_MS]`. Returns the
 * resulting list sorted by `startsAt` ascending. Idempotent: a
 * template already materialised is a no-op.
 *
 * `localcacheGet` / `localcachePut` dedupes within a single worker (the
 * 16 goja workers don't share state). The key is per-template.
 */
export function ensureTournamentsForWindow(
  nk: INakama,
  nowUtc: number,
): Tournament[] {
  const out: Tournament[] = [];
  const templates = getTournamentTemplates();
  for (const tpl of templates) {
    const { startsAt, endsAt } = tournamentWindow(tpl);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) continue;
    if (endsAt <= nowUtc) continue; // expired
    if (startsAt > nowUtc + TOURNAMENT_LOOKAHEAD_MS) continue; // too far out
    out.push(ensureTournamentInstance(nk, tpl, nowUtc));
  }
  out.sort((a, b) => a.startsAt - b.startsAt);
  return out;
}

/**
 * State a tournament is in at `nowUtc`. Lazy-create assumes 'open'
 * (created lazily → player just discovered it → accepting entries).
 * The Chunk 6 subscriber advances 'open' → 'closing' (within last
 * hour) → 'closed' (after `endsAt`).
 */
export type TournamentState = 'open' | 'closing' | 'closed';

/** Compute state purely from the window + `nowUtc`. */
export function tournamentState(t: Tournament, nowUtc: number): TournamentState {
  // Phase 8 Chunk 7 — admin-driven terminal states always win.
  if (t.cancelled === true) return 'closed';
  if (t.voided === true) return 'closed';
  // Persisted state (set by the scanner) takes priority over time inference.
  if (t.state === 'closed' || t.state === 'closing' || t.state === 'open') return t.state;
  if (nowUtc >= t.endsAt) return 'closed';
  if (nowUtc >= t.endsAt - 60 * 60 * 1000) return 'closing';
  return 'open';
}

// ─── Public re-exports for callers (RPC layer) ──────────────────────────

export const TOURNAMENT_INSTANCES_KEYS = {
  collection: TOURNAMENT_INSTANCES_COLLECTION,
  systemUser: TOURNAMENT_INSTANCES_SYSTEM_USER,
} as const;