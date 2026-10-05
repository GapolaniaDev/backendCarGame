// Race-result submission validations.
//
// This file holds PURE validations — no Nakama I/O, no time side
// effects beyond reading the `nowMs` argument. Handlers call these
// and translate errors to the response envelope.
//
// Two passes (per the plan):
//   - step-1: roster / state / duplicate-rejection. Always runs first.
//             Rejected with INVALID_RESULT / CONFLICT.
//   - step-2: clock / min-time / lap-sum. Runs only after step-1
//             passes. Rejected with INVALID_RESULT (lands in Chunk 8).
//             Bot-auth also lands in Chunk 8.

import { err } from '../core/response';
import type { Resp } from '../core/response';
import type { RaceSession } from './types';

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