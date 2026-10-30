// Closing a race session (Chunk 9 close path + plan T-06, audit PC-06).
//
// A session closes in one of three ways:
//   - `all_reported`: the last roster entry reports (race_submit_result);
//   - `grace`: `CLOSE_GRACE_MS` after the first human report, with the
//     players who did not report marked DNF;
//   - `abandoned`: `ABANDONED_SESSION_MS` after the start with no human
//     report at all (everyone DNF).
// A dedicated-server session (plan fishnet-nakama-server) also closes with
// `server_results` (the race server submitted the official results) or as
// `abandoned` when the server releases it; closing it frees its server.
// The last two are "due" closes. They run lazily in `race_session_get` and
// `race_submit_result` (a late report finds the session closed and gets
// CONFLICT) and from the service ticker (`runRaceCloseTick`). Every path
// goes through `closeRace`: the CAS close write, the `RaceCompleted`
// publish, the analytics event and the synchronous reward payout, so a
// race closed by the ticker pays the same as one closed by a submit.

import type { ILogger, INakama } from '../nkruntime';
import { emit } from '../core/admin/analytics';
import { ensureRuntimeState } from '../core/runtime_state';
import { releaseServerOfSession } from '../race_servers/registry_repo';
import { ABANDONED_SESSION_MS, CLOSE_GRACE_MS } from './constants';
import {
  deleteOpenIndex,
  listOpenSessionIds,
  readSession,
  tryCloseAndPublish,
  type CloseOutcome,
  type CloseOverride,
  type ReadSessionResult,
} from './session_repo';
import type { RaceCompletedEvent, RaceSession, RaceSubmitResultRewardEntry } from './types';
import {
  handleRaceCompletedForEconomy,
  type RaceCompletedRewardSummary,
} from '../economy/subscriber';
import {
  handleRaceCompletedForProgression,
  type RaceCompletedProgressionSummary,
} from '../progression/subscriber';

export type CloseReason = 'all_reported' | 'grace' | 'abandoned' | 'server_results';

/** The close write lost the CAS: another caller changed the session first. */
export class CloseConflictError extends Error {
  constructor(sessionId: string, cause: unknown) {
    super(`close of ${sessionId} lost the CAS: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CloseConflictError';
  }
}

export interface ClosedRace {
  outcome: CloseOutcome;
  event: RaceCompletedEvent;
  /** Per-player rewards; absent when the payout failed (logged). */
  rewards?: Record<string, RaceSubmitResultRewardEntry>;
}

/**
 * Epoch ms at which a started session closes without its missing reports:
 * `CLOSE_GRACE_MS` after the first human report, or
 * `ABANDONED_SESSION_MS` after the start when no human reported. `null`
 * for sessions that are not running.
 */
export function closeDeadlineMs(session: RaceSession): number | null {
  if (session.state !== 'started' && session.state !== 'closing') return null;
  let firstHumanReport: number | undefined;
  for (const e of session.roster) {
    if (e.isBot || e.reportedAt === undefined) continue;
    if (firstHumanReport === undefined || e.reportedAt < firstHumanReport) firstHumanReport = e.reportedAt;
  }
  if (firstHumanReport !== undefined) return firstHumanReport + CLOSE_GRACE_MS;
  if (session.startedAt !== null) return session.startedAt + ABANDONED_SESSION_MS;
  return null;
}

/**
 * Close `session` now (CAS on `version`; `CloseConflictError` when another
 * caller changed it first), then pay the
 * rewards. `payoutErrors: 'throw'` keeps the submit path's behaviour (the
 * RPC fails when a grant fails); `'log'` is for the lazy and ticker
 * closes, where the caller only reads the session. `override` carries
 * results decided by the dedicated race server instead of the players'
 * reports (D-07, D-10).
 */
export function closeRace(
  nk: INakama,
  logger: ILogger,
  session: RaceSession,
  version: string,
  nowMs: number,
  reason: CloseReason,
  payoutErrors: 'throw' | 'log',
  override?: CloseOverride,
): ClosedRace {
  // The race bus of the VM serving this call (plan T-29, D-11).
  const bus = ensureRuntimeState(nk, logger);
  let outcome: CloseOutcome;
  try {
    outcome = tryCloseAndPublish(nk, bus, session, version, nowMs, override);
  } catch (e) {
    throw new CloseConflictError(session.id, e);
  }
  freeRaceServer(nk, logger, session);
  logger.info(
    'race closed sid=%s reason=%s confidence=%s needsReview=%s dnf=%d',
    session.id,
    reason,
    outcome.confidence,
    String(outcome.needsReview),
    outcome.results.filter((r) => r.abandoned).length,
  );
  // The event the subscribers received; the RPC computes the per-player
  // reward summary from it synchronously (Phase 3 Decision 6).
  const event: RaceCompletedEvent = outcome.event ?? {
    schemaVersion: 1,
    sessionId: session.id,
    mode: session.mode,
    trackId: session.trackId,
    size: override?.payoutSize ?? session.size,
    results: outcome.results,
    flags: {
      needsReview: outcome.needsReview,
      ...(outcome.reviewReason !== undefined ? { reviewReason: outcome.reviewReason } : {}),
    },
    confidence: outcome.confidence,
    closedAt: nowMs,
  };
  const abandonedCount = outcome.results.filter((r) => r.abandoned === true).length;
  emit(nk, logger, 'race_completed', {
    sessionId: session.id,
    mode: session.mode,
    size: session.size,
    durationMs: typeof session.startedAt === 'number' ? nowMs - session.startedAt : 0,
    finisherCount: outcome.results.length - abandonedCount,
    abandonedCount,
    confidence: outcome.confidence,
    closeReason: reason,
  });

  const closed: ClosedRace = { outcome, event };
  try {
    const econ = handleRaceCompletedForEconomy({ logger, nk, bus }, event);
    const prog = handleRaceCompletedForProgression({ logger, nk, bus }, event);
    closed.rewards = mergeRewardSummaries(econ, prog);
  } catch (e) {
    if (payoutErrors === 'throw') throw e;
    logger.error(
      'race close payout failed sid=%s reason=%s: %s',
      session.id,
      reason,
      e instanceof Error ? e.message : String(e),
    );
  }
  return closed;
}

/**
 * A closed dedicated-server session frees its server (D-07); best effort:
 * the heartbeat of a server that reports no active session and the ticker
 * free it anyway.
 */
function freeRaceServer(nk: INakama, logger: ILogger, session: RaceSession): void {
  if (session.serverHosted !== true || session.server === undefined) return;
  try {
    releaseServerOfSession(nk, session.server.serverId, session.id);
  } catch (e) {
    logger.warn(
      'race closed sid=%s: server %s not released: %s',
      session.id,
      session.server.serverId,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Lazy close: when `cur` is past its deadline, close it and return the
 * stored closed session. Another caller closing first (CAS conflict) is
 * fine: the session is re-read. Never throws for a payout failure.
 */
export function closeIfDue(
  nk: INakama,
  logger: ILogger,
  cur: ReadSessionResult,
  nowMs: number,
  source: string,
): { current: ReadSessionResult; closed: ClosedRace | null } {
  const deadline = closeDeadlineMs(cur.session);
  if (deadline === null || nowMs < deadline) return { current: cur, closed: null };
  const reason: CloseReason = cur.session.roster.some((e) => !e.isBot && e.reportedAt !== undefined)
    ? 'grace'
    : 'abandoned';
  let closed: ClosedRace | null = null;
  try {
    closed = closeRace(nk, logger, cur.session, cur.version, nowMs, reason, 'log');
    logger.info('race close due sid=%s source=%s', cur.session.id, source);
  } catch (e) {
    logger.warn(
      'race close due sid=%s source=%s not applied: %s',
      cur.session.id,
      source,
      e instanceof Error ? e.message : String(e),
    );
  }
  return { current: readSession(nk, cur.session.id) ?? cur, closed };
}

/**
 * Service-ticker job: close every open session whose grace expired and
 * drop closed or missing sessions from the open index.
 */
export function runRaceCloseTick(
  nk: INakama,
  logger: ILogger,
  nowMs: number,
): { scanned: number; closed: number } {
  const ids = listOpenSessionIds(nk);
  let closed = 0;
  for (const sid of ids) {
    const cur = readSession(nk, sid);
    if (cur === null || cur.session.state === 'closed') {
      deleteOpenIndex(nk, sid);
      continue;
    }
    const r = closeIfDue(nk, logger, cur, nowMs, 'service_ticker');
    if (r.closed !== null) closed += 1;
  }
  return { scanned: ids.length, closed };
}

// ─── Reward merging (Phase 3, Decision 6) ────────────────────────────────────

export function mergeRewardSummaries(
  econ: RaceCompletedRewardSummary,
  prog: RaceCompletedProgressionSummary,
): Record<string, RaceSubmitResultRewardEntry> {
  const out: Record<string, RaceSubmitResultRewardEntry> = {};
  // Players with wallet movement come from the economy summary.
  for (const [userId, e] of Object.entries(econ.perPlayer)) {
    const p = prog.perPlayer[userId];
    out[userId] = {
      coins: e.rewards.filter((r) => r.kind === 'coins').reduce((s, r) => s + (r.amount ?? 0), 0),
      gems: e.rewards.filter((r) => r.kind === 'gems').reduce((s, r) => s + (r.amount ?? 0), 0),
      xp: p?.xpAwarded ?? 0,
      isFirstWinOfDay: e.isFirstWinOfDay,
      leveledUp: p?.leveledUp ?? false,
      newLevel: p?.newLevel ?? 1,
      newBalance: e.newBalance,
      levelUpRewards: (p?.levelUpRewards ?? []).map((r) => ({
        kind: (r.kind === 'coins' || r.kind === 'gems' ? r.kind : 'coins') as 'coins' | 'gems',
        amount: r.amount ?? 0,
      })),
    };
  }
  // Players with XP but no wallet movement (e.g. below the XP floor).
  for (const [userId, p] of Object.entries(prog.perPlayer)) {
    if (out[userId] !== undefined) continue;
    out[userId] = {
      coins: 0,
      gems: 0,
      xp: p.xpAwarded,
      isFirstWinOfDay: p.isFirstWinOfDay,
      leveledUp: p.leveledUp,
      newLevel: p.newLevel,
      newBalance: { coins: 0, gems: 0 },
      levelUpRewards: [],
    };
  }
  return out;
}
