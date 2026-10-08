// Phase 8 Chunk 1 — Tournament catalog + lazy-create types.

/**
 * Tournament kinds. Phase 8 Chunk 1 ships the catalog + types; the
 * RPCs land in Chunk 5.
 */
export type TournamentType = 'time_trial' | 'cup' | 'club_cup';

/**
 * Catalog entry from `catalogs/tournaments.json` (one per template).
 * Tournaments are LAZY-CREATED: the catalog ships templates, and a
 * `Tournament` instance is created on first access (Phase 2 leaderboard
 * pattern). The Chunk 1 RPC surface doesn't create instances — that
 * happens in Chunk 5.
 */
export interface TournamentTemplate {
  id: string;
  kind: TournamentType;
  trackId: string;
  startsAtUtc: string; // ISO-8601 UTC
  endsAtUtc: string;   // ISO-8601 UTC
  entryFee: number;    // coins
  maxAttempts: number;
  minLevel: number;
  prizes: TournamentPrizeTier[];
}

export interface TournamentPrizeTier {
  rankFrom: number; // inclusive
  rankTo: number;   // inclusive
  rewards: TournamentRewards;
}

export interface TournamentRewards {
  coins?: number;
  gems?: number;
  cosmeticId?: string;
}

/**
 * Lazy-created instance (Chunk 5 surface). Stored as the source of
 * truth once an instance is created from a template.
 *
 * Phase 8 Chunk 7 — the following fields are OPTIONAL and absent on
 * rows written by the Chunk 5/6 lazy-create path. `tournamentState()`
 * falls back to time-based inference when they're undefined; the
 * scanner + admin RPCs write them as transitions happen.
 */
export interface Tournament {
  schemaVersion: 1;
  id: string;              // matches template.id when lazy-created
  templateId: string;
  kind: TournamentType;
  trackId: string;
  startsAt: number;        // epoch-ms
  endsAt: number;          // epoch-ms
  entryFee: number;
  maxAttempts: number;
  minLevel: number;
  prizes: TournamentPrizeTier[];
  createdAt: number;
  /** Persisted state. Absent = fall back to time-based inference. */
  state?: 'open' | 'closing' | 'closed';
  /** True after `admin_tournament_cancel` — no prizes, no refund. */
  cancelled?: boolean;
  /** True after `admin_tournament_void_refund` — refunds distributed, no prizes. */
  voided?: boolean;
  /** UTC epoch-ms when the scanner transitioned the row to 'closed'
   *  (or when an admin RPC cancelled/voided it). */
  closedAt?: number;
}

/**
 * Per-player entry row (storage shape). Tracks attempts used, best
 * time, and checkpoint splits so the tournament can be paused +
 * resumed across sessions.
 */
export interface TournamentEntry {
  schemaVersion: 1;
  tournamentId: string;
  userId: string;
  attemptsRemaining: number;
  bestTimeMs: number | null;     // null when no completed attempts
  checkpoints: TournamentCheckpoint[];
  createdAt: number;
  updatedAt: number;
}

export interface TournamentCheckpoint {
  sectionIndex: number; // 0..checkpoints
  elapsedMs: number;
  bestMs: number | null;
}

export interface RawTournamentsFile {
  version: number;
  templates: TournamentTemplate[];
}

export function validateTournamentsFile(
  raw: unknown,
): { ok: true; value: RawTournamentsFile } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'tournaments.json must be an object' };
  }
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) {
    return { ok: false, reason: `tournaments.json version must be 1, got ${String(r['version'])}` };
  }
  if (!Array.isArray(r['templates'])) {
    return { ok: false, reason: 'tournaments.json templates must be an array' };
  }
  const ids = new Set<string>();
  for (let i = 0; i < r['templates'].length; i += 1) {
    const t = r['templates'][i] as Record<string, unknown>;
    if (typeof t['id'] !== 'string' || t['id'].length === 0) {
      return { ok: false, reason: `templates[${i}].id must be a non-empty string` };
    }
    if (ids.has(t['id'] as string)) {
      return { ok: false, reason: `templates[${i}].id "${t['id']}" duplicates an earlier entry` };
    }
    ids.add(t['id'] as string);
    if (t['kind'] !== 'time_trial' && t['kind'] !== 'cup' && t['kind'] !== 'club_cup') {
      return { ok: false, reason: `templates[${i}].kind "${String(t['kind'])}" invalid` };
    }
    if (typeof t['trackId'] !== 'string' || t['trackId'].length === 0) {
      return { ok: false, reason: `templates[${i}].trackId required` };
    }
    if (typeof t['startsAtUtc'] !== 'string' || typeof t['endsAtUtc'] !== 'string') {
      return { ok: false, reason: `templates[${i}] startsAtUtc + endsAtUtc must be ISO strings` };
    }
    if (typeof t['entryFee'] !== 'number' || t['entryFee'] < 0) {
      return { ok: false, reason: `templates[${i}].entryFee must be a non-negative number` };
    }
    if (typeof t['maxAttempts'] !== 'number' || t['maxAttempts'] < 1) {
      return { ok: false, reason: `templates[${i}].maxAttempts must be >= 1` };
    }
    if (typeof t['minLevel'] !== 'number' || t['minLevel'] < 1) {
      return { ok: false, reason: `templates[${i}].minLevel must be >= 1` };
    }
    if (!Array.isArray(t['prizes']) || t['prizes'].length === 0) {
      return { ok: false, reason: `templates[${i}].prizes must be a non-empty array` };
    }
    for (let p = 0; p < (t['prizes'] as unknown[]).length; p += 1) {
      const tier = (t['prizes'] as Array<Record<string, unknown>>)[p]!;
      if (typeof tier['rankFrom'] !== 'number' || typeof tier['rankTo'] !== 'number') {
        return { ok: false, reason: `templates[${i}].prizes[${p}] rankFrom/rankTo must be numbers` };
      }
      if ((tier['rankFrom'] as number) > (tier['rankTo'] as number)) {
        return { ok: false, reason: `templates[${i}].prizes[${p}] rankFrom > rankTo` };
      }
      if (
        tier['rewards'] === undefined ||
        typeof tier['rewards'] !== 'object' ||
        tier['rewards'] === null
      ) {
        return { ok: false, reason: `templates[${i}].prizes[${p}].rewards must be an object` };
      }
    }
  }
  return { ok: true, value: r as unknown as RawTournamentsFile };
}