// Phase 8 Chunk 1 — Anti-cheat types + severity thresholds catalog.
//
// Severity is `low` / `medium` / `high` — derived from the catalog
// thresholds by `severityForMarkCount` (in `./marks.ts`, Chunk 3).
// "Hidden" is NOT a severity — it's a runtime property of the per-user
// mark list (a mark can have `hiddenUntilUtc` or the user can have
// reached a high mark count).

/**
 * Reasons a mark can be issued. Detection helpers (Chunk 2) emit
 * these; the subscriber (Chunk 4) turns them into storage rows.
 */
export type MarkKind =
  | 'partial_impossible'      // sector time below minSectionTimeMs
  | 'abrupt_improvement'      // race time dropped > X% vs player median
  | 'quorum_disagreement';    // clients disagreed on race state

export interface MarkThresholdsFile {
  version: number;
  severityThresholds: { low: number; medium: number; high: number };
  cooldownDays: number;
}

export function validateMarkThresholdsFile(
  raw: unknown,
): { ok: true; value: MarkThresholdsFile } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'mark_thresholds.json must be an object' };
  }
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) {
    return { ok: false, reason: `mark_thresholds.json version must be 1, got ${String(r['version'])}` };
  }
  const th = r['severityThresholds'];
  if (th === undefined || typeof th !== 'object' || th === null) {
    return { ok: false, reason: 'severityThresholds must be an object' };
  }
  const t = th as Record<string, unknown>;
  if (typeof t['low'] !== 'number' || typeof t['medium'] !== 'number' || typeof t['high'] !== 'number') {
    return { ok: false, reason: 'severityThresholds must have low/medium/high numbers' };
  }
  if ((t['low'] as number) >= (t['medium'] as number) || (t['medium'] as number) >= (t['high'] as number)) {
    return { ok: false, reason: 'severityThresholds must be strictly increasing' };
  }
  if (typeof r['cooldownDays'] !== 'number' || r['cooldownDays'] < 1) {
    return { ok: false, reason: 'cooldownDays must be a positive number' };
  }
  return { ok: true, value: r as unknown as MarkThresholdsFile };
}