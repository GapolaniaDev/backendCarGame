// Phase 7 Chunk 7 — Auto-silence pipeline.
//
// `addReportAndCheckSilence(nk, targetUserId, reporterUserId, nowMs)`:
//   1. Read `reports_recent/{targetUserId}`
//   2. GC entries older than 24h
//   3. Insert/replace the new reporter
//   4. CAS-write back
//   5. Count distinct reporters
//   6. If count >= 3 → call `chat/silenced.silenceUser` for 1h
//   7. Return `{ distinctCount, triggeredSilence, silencedUntilUtc }`
//
// `silenceUser` from chat/silenced uses max-of-extension semantics, so
// repeated triggers naturally accumulate (don't shrink an existing
// silence). The reason string is `auto:3_reports_24h` for diagnostics.

import type { INakama } from '../nkruntime';
import {
  AUTO_SILENCE_DISTINCT_REPORTERS,
  AUTO_SILENCE_DURATION_MS,
  AUTO_SILENCE_WINDOW_MS,
} from './types';
import {
  MAX_CAS_RETRIES,
  countDistinctReporters,
  gcReportsRecent,
  readReportsRecent,
  writeReportsRecentCreate,
  writeReportsRecentUpdate,
} from './reports_repo';
import { silenceUser } from '../chat/silenced';

export const AUTO_SILENCE_REASON = 'auto:3_reports_24h';

export interface AutoSilenceResult {
  /** How many DISTINCT reporters are inside the 24h window AFTER this insert. */
  distinctCount: number;
  /** True iff the auto-silence threshold fired on this report. */
  triggeredSilence: boolean;
  /**
   * Final `untilUtc` for the target's silence row, or null when no
   * silence was applied. `silenceUser` returns the existing/new
   * untilUtc (max-of extension), so this can be non-null even when
   * `triggeredSilence=false` (existing silence extended by `silenceUser`
   * when called from admin — not from here, since we only call it on
   * the threshold trigger).
   */
  silencedUntilUtc: number | null;
}

/**
 * Insert a new report into the recent-window for `targetUserId`, GC
 * old entries, count distinct reporters, and (if the threshold fires)
 * silence the target for 1h.
 *
 * Idempotent on the threshold: calling it a 4th time while the same
 * target is already silenced re-runs `silenceUser`, which extends
 * (max-of) the existing `untilUtc`. That's the desired behavior —
 * `silenceUser` is the only writer and enforces the invariant.
 */
export function addReportAndCheckSilence(
  nk: INakama,
  targetUserId: string,
  reporterUserId: string,
  nowMs: number,
): AutoSilenceResult {
  let nextRecord: ReturnType<typeof gcReportsRecent> | null = null;
  let finalVersion = '';

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const prev = readReportsRecent(nk, targetUserId);
    const built = gcReportsRecent(
      prev?.record ?? null,
      targetUserId,
      reporterUserId,
      nowMs,
      AUTO_SILENCE_WINDOW_MS,
    );
    try {
      if (prev === null) {
        writeReportsRecentCreate(nk, built);
      } else {
        writeReportsRecentUpdate(nk, built, prev.version);
      }
      nextRecord = built;
      finalVersion = prev?.version ?? '';
      break;
    } catch {
      // CAS conflict — retry
      if (attempt === MAX_CAS_RETRIES - 1) {
        // last attempt failed — surface as a no-op result
        return {
          distinctCount: prev?.record ? countDistinctReporters(prev.record) : 0,
          triggeredSilence: false,
          silencedUntilUtc: null,
        };
      }
    }
  }

  if (nextRecord === null) {
    return { distinctCount: 0, triggeredSilence: false, silencedUntilUtc: null };
  }

  const distinctCount = countDistinctReporters(nextRecord);
  if (distinctCount < AUTO_SILENCE_DISTINCT_REPORTERS) {
    return { distinctCount, triggeredSilence: false, silencedUntilUtc: null };
  }

  // Threshold fired. Silence the target for 1h (silenceUser enforces
  // max-of extension so back-to-back triggers accumulate).
  const untilUtc = silenceUser(
    nk,
    targetUserId,
    AUTO_SILENCE_REASON,
    AUTO_SILENCE_DURATION_MS,
    nowMs,
  );

  // Suppress unused-warning on finalVersion when not needed
  void finalVersion;

  return {
    distinctCount,
    triggeredSilence: true,
    silencedUntilUtc: untilUtc,
  };
}