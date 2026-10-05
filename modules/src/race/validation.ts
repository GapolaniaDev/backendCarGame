// Race-result submission validations.
//
// This file holds PURE validations — no Nakama I/O, no time side
// effects beyond reading the `nowMs` argument. Handlers call these
// and translate errors to the response envelope.
//
// Three passes (per the plan):
//   - step-1: roster / state / duplicate-rejection. Always runs first.
//             Rejected with INVALID_RESULT / CONFLICT.
//   - step-2: clock / min-time / lap-count / lap-sum. Runs only after
//             step-1 passes. Rejected with INVALID_RESULT.
//   - bot-auth: gated at the handler level (needs session.host from the
//             storage lookup). Rejected with FORBIDDEN.
//
// Each rejection carries a `details.reason` so callers (logs, future
// analytics) can distinguish between rule failures.

import { err } from '../core/response';
import type { Resp } from '../core/response';
import { CLOCK_SKEW_TOLERANCE_MS } from './constants';
import type { RaceReport, RaceSession, RosterEntry } from './types';
import type { TrackEntry } from '../core/catalog';

/** Outcome of step-1 validation. */
export type Step1ErrorCode =
  | 'INVALID_RESULT'  // reporter is not in the roster
  | 'CONFLICT';       // session state is wrong OR duplicate report

/**
 * Step-1: does the reporter belong to the roster AND is the session
 * accepting reports AND has this player already submitted?
 *
 * On any failure returns a typed envelope with `details.reason` so
 * the caller can branch (debug log vs. user-facing message).
 */
export function validateSubmissionStep1(input: {
  session: RaceSession;
  reporterId: string;
}): Resp<true> {
  const { session, reporterId } = input;

  const rosterEntry = session.roster.find((e) => e.userId === reporterId);
  if (!rosterEntry) {
    return err(
      'INVALID_RESULT',
      `reporter ${reporterId} is not in the session roster`,
      { reason: 'NOT_IN_ROSTER', reporterId },
    );
  }

  if (session.state !== 'started' && session.state !== 'closing') {
    return err(
      'CONFLICT',
      `cannot submit reports to a session in state ${session.state}`,
      { reason: 'BAD_STATE', state: session.state },
    );
  }

  if (rosterEntry.reportedAt !== undefined) {
    return err(
      'CONFLICT',
      `reporter ${reporterId} already submitted a report`,
      { reason: 'ALREADY_REPORTED', reportedAt: rosterEntry.reportedAt },
    );
  }

  return { ok: true, data: true };
}

/** Outcome of step-2 validation. All rejections are `INVALID_RESULT`. */
export type Step2ErrorCode = 'INVALID_RESULT';

/** Input bundle for `validateSubmissionStep2`. */
export interface Step2Input {
  session: RaceSession;
  /** Roster entry of the player submitting (needed for classId). */
  reporter: RosterEntry;
  report: RaceReport;
  /** Track entry for the session's trackId. */
  track: Readonly<TrackEntry>;
  /** Server wall-clock at validation time (`serverNowMs()`). */
  nowMs: number;
}

/**
 * Step-2: clock / min-time / lap-count / lap-sum. All four checks
 * reject with `INVALID_RESULT` and a distinct `details.reason`:
 *   - `TIME_EXCEEDS_CLOCK` — totalMs larger than elapsed wall clock
 *                            (plus a 500ms skew tolerance, see constants).
 *   - `BELOW_MIN_TIME`     — totalMs smaller than `laps * minTimePerLap`.
 *   - `LAP_COUNT_MISMATCH` — `laps.length !== track.modes[mode]`.
 *   - `LAP_SUM_MISMATCH`   — `sum(laps) !== totalMs`.
 *
 * Order: clock first (cheap), then min-time (cheap), then the two
 * lap-shape checks. The lap-shape failures are the strongest signal
 * of tampering so they fire last.
 */
export function validateSubmissionStep2(input: Step2Input): Resp<true> {
  const { session, reporter, report, track, nowMs } = input;

  // ── Clock check ──────────────────────────────────────────────────────────
  if (session.startedAt === null) {
    return err(
      'INVALID_RESULT',
      'session.startedAt is null; cannot validate clock',
      { reason: 'CLOCK_UNSET' },
    );
  }
  const elapsedMs = nowMs - session.startedAt;
  const maxAllowed = elapsedMs + CLOCK_SKEW_TOLERANCE_MS;
  if (report.totalMs > maxAllowed) {
    return err(
      'INVALID_RESULT',
      `report.totalMs ${report.totalMs} exceeds elapsed clock ${elapsedMs}ms (tolerance ${CLOCK_SKEW_TOLERANCE_MS}ms)`,
      {
        reason: 'TIME_EXCEEDS_CLOCK',
        totalMs: report.totalMs,
        elapsedMs,
        toleranceMs: CLOCK_SKEW_TOLERANCE_MS,
      },
    );
  }

  // ── Min-time check ──────────────────────────────────────────────────────
  const expectedLapCount = track.modes[session.mode];
  const minTimePerLap = track.minTimeMsByClass[reporter.loadout.classId];
  const minTotalMs = expectedLapCount * minTimePerLap;
  if (report.totalMs < minTotalMs) {
    return err(
      'INVALID_RESULT',
      `report.totalMs ${report.totalMs} below min total ${minTotalMs} (${expectedLapCount} laps × ${minTimePerLap}ms for class ${reporter.loadout.classId})`,
      {
        reason: 'BELOW_MIN_TIME',
        totalMs: report.totalMs,
        minTotalMs,
        laps: expectedLapCount,
        minTimeMsByClass: minTimePerLap,
        classId: reporter.loadout.classId,
      },
    );
  }

  // ── Lap count check ─────────────────────────────────────────────────────
  if (report.laps.length !== expectedLapCount) {
    return err(
      'INVALID_RESULT',
      `report.laps.length ${report.laps.length} !== expected ${expectedLapCount}`,
      {
        reason: 'LAP_COUNT_MISMATCH',
        actual: report.laps.length,
        expected: expectedLapCount,
      },
    );
  }

  // ── Lap sum check ───────────────────────────────────────────────────────
  const actualSum = report.laps.reduce((a, b) => a + b, 0);
  if (actualSum !== report.totalMs) {
    return err(
      'INVALID_RESULT',
      `sum(laps) ${actualSum} !== totalMs ${report.totalMs}`,
      {
        reason: 'LAP_SUM_MISMATCH',
        actualSum,
        totalMs: report.totalMs,
      },
    );
  }

  return { ok: true, data: true };
}