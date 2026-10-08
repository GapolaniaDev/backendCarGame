// Race result ordering, quorum, and close-time aggregation.
//
// Pure module — no I/O, no time side effects beyond reading the `nowMs`
// argument. Handlers feed the close path a snapshot of the session's
// roster + the collected reports; this module decides the final
// `RaceResult[]` ordering and the `confidence` outcome.
//
// Ordering rule: sort reported players by `totalMs` ascending, assign
// ranks 1..N. Players who did not report (`reportedAt === undefined`) are
// marked `abandoned: true` and share the next rank after the last
// finisher. Step-2 validations have already gated invalid reports so
// the totals we see here are trustworthy; `lapSumInvalid` only flags
// individual players when their step-2 check failed (which we record
// at submission time — for now we accept everything step-2 accepted).

import type {
  Confidence,
  RaceReport,
  RaceResult,
  RosterEntry,
} from './types';

/** Sort a list of report-like items by `totalMs` ascending. Stable input order preserved on ties. */
export function orderByTotalTime<T extends { totalMs: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.totalMs - b.totalMs);
}

/**
 * Count the humans in a roster. Used by `computeQuorum` to know how
 * many reports are required for a clean quorum outcome.
 */
export function countHumans(roster: readonly RosterEntry[]): number {
  let n = 0;
  for (const e of roster) if (!e.isBot) n += 1;
  return n;
}

/** Return only the roster entries that did NOT submit a report. */
export function findAbandoned(roster: readonly RosterEntry[]): RosterEntry[] {
  return roster.filter((e) => e.reportedAt === undefined);
}

/**
 * Compute the quorum confidence outcome:
 *  - 0 humans reported → `'server'` (no humans attested anything; we
 *                          take the host's bot times as ground truth)
 *  - all humans reported (i.e. reported count === roster human count)
 *                          → `'quorum'` (no review needed)
 *  - some humans did not report
 *                          → `'client'` + needsReview='incomplete_reports'
 *                          (their totalMs is unverified; humans must
 *                           resolve via the report UI)
 */
export function computeQuorum(
  reports: readonly RaceReport[],
  humansInRoster: number,
): { confidence: Confidence; needsReview: boolean; reviewReason?: string } {
  const humanReports = reports.filter((r) => !r.isBotReport);
  if (humanReports.length === 0) {
    return { confidence: 'server', needsReview: false };
  }
  if (humanReports.length >= humansInRoster) {
    return { confidence: 'quorum', needsReview: false };
  }
  return {
    confidence: 'client',
    needsReview: true,
    reviewReason: 'incomplete_reports',
  };
}

/**
 * Compute the final `RaceResult[]` from a roster snapshot. Each entry
 * in the roster must EITHER have `totalMs`/`laps` (i.e. a report was
 * accepted) OR be marked `abandoned: true`.
 *
 * Reported players are sorted by `totalMs` ascending; ranks 1..N are
 * assigned in that order. Abandoned players share rank N+1 (one past
 * the last finisher), preserving roster order among themselves for
 * determinism.
 */
export function computeResults(roster: readonly RosterEntry[]): RaceResult[] {
  const reported = roster.filter(
    (e): e is RosterEntry & { totalMs: number; laps: number[] } =>
      e.totalMs !== undefined && e.laps !== undefined,
  );
  const abandoned = roster.filter((e) => e.totalMs === undefined);

  const sorted = orderByTotalTime(reported);
  const results: RaceResult[] = [];

  sorted.forEach((e, i) => {
    const r: RaceResult = {
      rank: i + 1,
      userId: e.userId,
      isBot: e.isBot,
      totalMs: e.totalMs,
      abandoned: false,
    };
    if (e.tournamentId !== undefined) r.tournamentId = e.tournamentId;
    results.push(r);
  });

  const baseRank = sorted.length + 1;
  abandoned.forEach((e, i) => {
    const r: RaceResult = {
      rank: baseRank + i,
      userId: e.userId,
      isBot: e.isBot,
      totalMs: 0,
      abandoned: true,
    };
    if (e.tournamentId !== undefined) r.tournamentId = e.tournamentId;
    results.push(r);
  });

  return results;
}

/**
 * Aggregate everything for the final close into a single call result.
 * Returns the `RaceResult[]`, the confidence outcome, and the flags
 * the handler writes to the session.
 */
export interface CloseAggregation {
  results: RaceResult[];
  confidence: Confidence;
  needsReview: boolean;
  reviewReason?: string;
}

export function aggregateForClose(input: {
  roster: readonly RosterEntry[];
  reports: readonly RaceReport[];
  /** Human count BEFORE the close; default = countHumans(roster). */
  humansInRoster?: number;
}): CloseAggregation {
  const humans = input.humansInRoster ?? countHumans(input.roster);
  const quorum = computeQuorum(input.reports, humans);
  return {
    results: computeResults(input.roster),
    confidence: quorum.confidence,
    needsReview: quorum.needsReview,
    ...(quorum.reviewReason !== undefined ? { reviewReason: quorum.reviewReason } : {}),
  };
}