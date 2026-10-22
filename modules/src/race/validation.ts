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
import {
  CLOCK_SKEW_TOLERANCE_MS,
  HOST_CLAIM_GRACE_SECONDS,
  HOST_CLAIM_GRACE_TOLERANCE_MS,
  HOST_STALE_MS,
} from './constants';
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

// ─── Phase 4 Chunk 4 — host-claim validation ─────────────────────────────────

/**
 * Outcome of `validateHostClaim`. Distinct so the handler can map
 * rejection reasons to envelope codes (`FORBIDDEN` / `CONFLICT` /
 * `BAD_REQUEST`) without string-matching the message.
 */
export type HostClaimErrorCode =
  | 'FORBIDDEN'        // caller not in roster
  | 'CONFLICT'         // session already claimed by someone else
  | 'BAD_REQUEST';     // session not started, no disconnect, or wrong succession slot

export interface HostClaimInput {
  session: RaceSession;
  callerUserId: string;
  /** Server `serverNowMs()` at validation time. */
  nowMs: number;
  /** Last contact per participant (`readPresence`, plan T-07). */
  lastSeenMs?: ReadonlyMap<string, number>;
  /** Silence after which the host counts as gone; default `HOST_STALE_MS`. */
  staleMs?: number;
}

export type HostClaimResult =
  | { ok: true; /** True when the caller's re-claim is a no-op (already host). */
      idempotent: boolean;
      claimedAt: number }
  | { ok: false; code: HostClaimErrorCode; reason: string; details?: Record<string, unknown> };

/**
 * Last time the server heard from `userId` in `session`: the newest of its
 * recorded contact, its report and the start of the race (for the host,
 * the moment it took over).
 */
export function lastContactMs(
  session: RaceSession,
  userId: string,
  lastSeenMs: ReadonlyMap<string, number> | undefined,
): number {
  const entry = session.roster.find((e) => e.userId === userId);
  const baseline = userId === session.host
    ? session.claimedAt ?? session.startedAt ?? 0
    : session.startedAt ?? 0;
  return Math.max(baseline, entry?.reportedAt ?? 0, lastSeenMs?.get(userId) ?? 0);
}

/**
 * Validate a `race_host_claim` request without performing any storage
 * writes. Returns `{ ok: true, idempotent }` when the caller is already
 * the host (re-claim after a successful claim — return the recorded
 * `claimedAt` so the response matches the original). For a fresh claim
 * returns `{ ok: true, idempotent: false, claimedAt: nowMs }`.
 *
 * Rejections (mapped to envelope codes by the handler):
 *   - `FORBIDDEN`  — caller not in roster; or the host is alive
 *                    (`details.reason = 'NOT_HOST'`, plan T-07)
 *   - `BAD_REQUEST` — session.state != 'started', or caller isn't the
 *                     next live succession slot
 *
 * Host checks:
 *   - Without a `disconnectReportedAt` stamp (the production case), the
 *     host is gone when its last contact (`lastContactMs`) is older than
 *     `staleMs` (plan T-07, audit PC-07).
 *   - With the legacy stamp, `nowMs - disconnectReportedAt <= graceMs +
 *     toleranceMs`.
 *   - Caller must be the first entry after the current host in
 *     `hostSuccession` that is not itself silent for `staleMs` (or an
 *     `idempotent` re-claim when caller == host)
 */
export function validateHostClaim(input: HostClaimInput): HostClaimResult {
  const { session, callerUserId, nowMs } = input;

  // Roster membership — defense against a forged callerUserId over HTTP.
  const callerEntry = session.roster.find((e) => e.userId === callerUserId);
  if (!callerEntry) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: `caller ${callerUserId} is not in the session roster`,
    };
  }

  // State must allow mid-race host transfers.
  if (session.state !== 'started') {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      reason: `session in state ${session.state}; only 'started' allows host claim`,
    };
  }

  // Idempotent re-claim: caller is already host AND there's a claimedAt
  // we can echo. Return the existing claimedAt unchanged so the
  // response matches the original claim.
  if (session.host === callerUserId) {
    const claimedAt = session.claimedAt ?? session.startedAt ?? nowMs;
    return { ok: true, idempotent: true, claimedAt };
  }

  // Current host must have a recorded disconnect.
  const hostEntry = session.roster.find((e) => e.userId === session.host);
  if (!hostEntry) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      reason: `current host ${session.host} not found in roster (data corruption)`,
    };
  }
  const staleMs = input.staleMs ?? HOST_STALE_MS;
  if (hostEntry.disconnectReportedAt !== undefined) {
    // Legacy stamp (Phase 4 Chunk 4). Nothing writes it in production
    // (audit 06 f1); kept, with its grace, for a future relay callback.
    const elapsedMs = nowMs - hostEntry.disconnectReportedAt;
    const graceMs = HOST_CLAIM_GRACE_SECONDS * 1000 + HOST_CLAIM_GRACE_TOLERANCE_MS;
    if (elapsedMs > graceMs) {
      return {
        ok: false,
        code: 'BAD_REQUEST',
        reason: `host disconnect reported ${elapsedMs}ms ago exceeds grace ${graceMs}ms`,
      };
    }
  } else {
    // T-07: the host is gone once it has been silent for `staleMs`.
    const hostSilentMs = nowMs - lastContactMs(session, session.host, input.lastSeenMs);
    if (hostSilentMs <= staleMs) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        reason: `host ${session.host} is alive (last contact ${hostSilentMs}ms ago, stale after ${staleMs}ms)`,
        details: { reason: 'NOT_HOST', host: session.host, hostSilentMs, staleMs },
      };
    }
  }

  // Succession order — the caller must be the first live entry after the
  // host; entries silent for `staleMs` are skipped (T-07).
  const succession = session.hostSuccession;
  const hostIdx = succession.indexOf(session.host);
  const callerIdx = succession.indexOf(callerUserId);
  if (callerIdx === -1) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      reason: `caller ${callerUserId} is not in the host succession list`,
    };
  }
  if (callerIdx <= hostIdx) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      reason: `caller ${callerUserId} is succession[${callerIdx}] but must come after the host at succession[${hostIdx}]`,
    };
  }
  for (let i = hostIdx + 1; i < callerIdx; i += 1) {
    const candidate = succession[i]!;
    if (nowMs - lastContactMs(session, candidate, input.lastSeenMs) <= staleMs) {
      return {
        ok: false,
        code: 'BAD_REQUEST',
        reason: `caller ${callerUserId} is succession[${callerIdx}] but must be succession[${i}], which is live`,
      };
    }
  }

  return { ok: true, idempotent: false, claimedAt: nowMs };
}