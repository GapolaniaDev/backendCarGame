// Phase 8 Chunk 1 — Anti-cheat types + severity mapping.

/**
 * Severity ladder. Storage is `markCount`; severity is DERIVED from the
 * thresholds in `mark_thresholds.json`:
 *
 *   - 1 mark             → low
 *   - 2-3 marks          → medium
 *   - 4+ marks           → high
 *   - manually hidden    → hidden (admin_sanction RPC, Chunk 4)
 */
export type AntiCheatSeverity = 'low' | 'medium' | 'high' | 'hidden';

/**
 * Reasons a mark can be issued. Detection helpers (Chunk 2) emit
 * these; the subscriber (Chunk 4) turns them into storage rows.
 */
export type MarkKind =
  | 'partial_impossible'      // sector time below minSectionTimeMs
  | 'abrupt_improvement'      // race time dropped > X% vs player median
  | 'quorum_disagreement';    // clients disagreed on race state

/**
 * Per-player anti-cheat state. Stored in
 * `anti_cheat/{userId}/{userId}` (owner-scoped, server-writable).
 */
export interface AntiCheatMark {
  schemaVersion: 1;
  userId: string;
  raceId: string;
  kind: MarkKind;
  /** Raw mark count the SUBSCRIBER sees. Severity is derived. */
  markCount: number;
  severity: AntiCheatSeverity;
  detectedAt: number;
  /** Subscriber marks CONFIRMED after cross-checks pass; manual
   * dismiss via `admin_dismiss_mark` (Chunk 4). */
  status: 'pending' | 'confirmed' | 'dismissed';
  cooldownUntil: number | null; // epoch-ms
}

/**
 * Anti-cheat aggregate (cached). Rebuilt by the subscriber; readers
 * (admin RPC, leaderboard guard) hit this for the canonical markCount.
 */
export interface AntiCheatAggregate {
  schemaVersion: 1;
  userId: string;
  markCount: number;
  severity: AntiCheatSeverity;
  lastMarkAt: number | null;
  cooldownUntil: number | null;
  hidden: boolean;            // set by admin_sanction
}

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

/**
 * Map a mark count + hidden flag to a severity label using the
 * catalog thresholds. Pure — caller supplies the thresholds to keep
 * this helper testable.
 */
export function severityForMarkCount(
  markCount: number,
  hidden: boolean,
  thresholds: { low: number; medium: number; high: number },
): AntiCheatSeverity {
  if (hidden) return 'hidden';
  if (markCount >= thresholds.high) return 'high';
  if (markCount >= thresholds.medium) return 'medium';
  if (markCount >= thresholds.low) return 'low';
  return 'low';
}