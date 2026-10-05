// Race state machine. Pure module — no I/O. `canTransition` is the
// only exported function; the allowed-transitions table is private.
//
//   created ─▶ started ─▶ closing ─▶ closed
//
// `created`:    session exists but `startedAt` is null.
// `started`:    `startedAt` is set; reports accepted.
// `closing`:    a report is being processed; no further reports accepted.
// `closed`:     results persisted and RaceCompleted emitted; no further
//               writes accepted. Version is frozen.

import type { RaceState } from './types';

const ALLOWED: Readonly<Record<RaceState, readonly RaceState[]>> = {
  created: ['started'],
  started: ['closing'],
  closing: ['closed'],
  closed: [],
};

export function canTransition(from: RaceState, to: RaceState): boolean {
  return ALLOWED[from].includes(to);
}

/** For diagnostic dumps and tests. */
export function allowedFrom(from: RaceState): readonly RaceState[] {
  return ALLOWED[from];
}

/**
 * True if the state accepts new `race_submit_result` calls. Only `started`
 * does — `closing` is the in-progress slot during the final write.
 */
export function acceptsReports(state: RaceState): boolean {
  return state === 'started';
}