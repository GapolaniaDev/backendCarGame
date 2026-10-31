// Periodic server work without `setInterval` (plan card T-03, decision
// D-06; audit PC-09).
//
// Nakama 3.27's goja runtime has no timers, so the old scanners ran once
// at boot and never again. The scheduler is an authoritative "service
// match": `InitModule` registers the `service_ticker` match handler and
// creates one instance; Nakama then calls `serviceTickerLoop` once per
// second (`tickRate` 1) for as long as the process lives. The loop runs
// each job when it is due:
//   - tournaments: lifecycle + prize payout       every 60 s
//   - events: live events of events.json (read-only) every 5 min
//   - subscriptions: expiry notices + grants      every 5 min
//   - races: close sessions past their grace       every 15 s (plan T-06)
//   - race servers: free the session of servers
//     without heartbeat for 30 s                   every 15 s (with races)
//   - pass season: settle every player once the
//     battle pass season has ended                 every 5 min (plan T-19)
//   - club week: reward last week's winning club  every 5 min (plan B2)
// A storage lease (`tick_lock.ts`) makes sure only one tick runs at a
// time even with several matches or nodes.
//
// The match runs in its own goja VM: it re-evaluates the bundle but not
// `InitModule`, so `serviceTickerInit` loads the VM's runtime state (the
// catalogs the jobs read; plan T-29, `ensureRuntimeState`).
//
// Every handler is a top-level function so the 3.27 registration scanner
// can resolve them (`initializer.registerMatch` in main.ts).

import type { IContext, ILogger, INakama } from '../nkruntime';
import { ensureRuntimeState } from '../core/runtime_state';
import { runScannerTick as runTournamentTick } from '../tournaments/scanner';
import { runEventScannerTick } from '../events/scanner';
import { scanOnce as runSubscriptionTick } from '../iap/subscription_scanner';
import { runRaceCloseTick } from '../race/close';
import { runPassSeasonTick } from '../pass/season';
import { runClubWeekTick } from '../clubs/club_week_reset';
import { releaseStaleServers } from '../race_servers/registry_repo';
import { tryAcquireTickLock, releaseTickLock } from './tick_lock';

export const SERVICE_TICKER_MODULE = 'service_ticker';
/** Match label used to find (and not duplicate) the running ticker. */
export const SERVICE_TICKER_LABEL = 'service_ticker';
export const TOURNAMENT_TICK_MS = 60_000;
export const EVENT_TICK_MS = 5 * 60_000;
export const SUBSCRIPTION_TICK_MS = 5 * 60_000;
/** Race sessions past their grace (`CLOSE_GRACE_MS`, 30 s) close within this. */
export const RACE_CLOSE_TICK_MS = 15_000;
export const PASS_SEASON_TICK_MS = 5 * 60_000;
export const CLUB_WEEK_TICK_MS = 5 * 60_000;
/** Lease length: shorter than the fastest job interval. */
export const SERVICE_TICK_LOCK_TTL_MS = 55_000;
export const SERVICE_TICK_LOCK_NAME = 'service_tick';
/** Back-off after losing the lease to another ticker. */
export const LOCK_RETRY_MS = 15_000;

export interface ServiceTickerState {
  /** Epoch ms of the last run per job; 0 = never (runs on the first loop). */
  lastTournamentMs: number;
  lastEventMs: number;
  lastSubscriptionMs: number;
  lastRaceCloseMs: number;
  lastPassSeasonMs: number;
  lastClubWeekMs: number;
  /** Number of loops that ran at least one job. */
  runs: number;
  /** After a lost lease race, no attempt before this epoch ms. */
  nextAttemptMs: number;
}

export interface ServiceTickResult {
  ran: boolean;
  tournaments: string;
  events: string;
  subscriptions: string;
  races: string;
  raceServers: string;
  passSeason: string;
  clubWeek: string;
}

function runJob(logger: ILogger, name: string, job: () => string): string {
  try {
    return job();
  } catch (e) {
    logger.error('service ticker %s job failed: %s', name, e instanceof Error ? e.message : String(e));
    return 'error';
  }
}

/**
 * Run every due job once, under the storage lease. Pure scheduling logic:
 * the match loop and tests call it with an explicit `nowMs`.
 */
export function runServiceTick(
  nk: INakama,
  logger: ILogger,
  state: ServiceTickerState,
  nowMs: number,
  holder: string,
): ServiceTickResult {
  const dueTournament = nowMs - state.lastTournamentMs >= TOURNAMENT_TICK_MS;
  const dueEvent = nowMs - state.lastEventMs >= EVENT_TICK_MS;
  const dueSubscription = nowMs - state.lastSubscriptionMs >= SUBSCRIPTION_TICK_MS;
  const dueRaces = nowMs - (state.lastRaceCloseMs ?? 0) >= RACE_CLOSE_TICK_MS;
  const duePassSeason = nowMs - (state.lastPassSeasonMs ?? 0) >= PASS_SEASON_TICK_MS;
  const dueClubWeek = nowMs - (state.lastClubWeekMs ?? 0) >= CLUB_WEEK_TICK_MS;
  const idle: ServiceTickResult = { ran: false, tournaments: '-', events: '-', subscriptions: '-', races: '-', raceServers: '-', passSeason: '-', clubWeek: '-' };
  if (!dueTournament && !dueEvent && !dueSubscription && !dueRaces && !duePassSeason && !dueClubWeek) return idle;
  if (nowMs < state.nextAttemptMs) return idle;
  if (!tryAcquireTickLock(nk, SERVICE_TICK_LOCK_NAME, holder, nowMs, SERVICE_TICK_LOCK_TTL_MS)) {
    // Another ticker holds the lease; back off instead of retrying every loop.
    state.nextAttemptMs = nowMs + LOCK_RETRY_MS;
    return { ...idle, tournaments: 'locked', events: 'locked', subscriptions: 'locked', races: 'locked', raceServers: 'locked', passSeason: 'locked', clubWeek: 'locked' };
  }
  const result: ServiceTickResult = { ...idle, ran: true };
  try {
    if (dueTournament) {
      state.lastTournamentMs = nowMs;
      result.tournaments = runJob(logger, 'tournaments', () => {
        const r = runTournamentTick({ logger, nk });
        return `scanned=${r.scanned}/closed=${r.closed}/deleted=${r.deleted}`;
      });
    }
    if (dueEvent) {
      state.lastEventMs = nowMs;
      result.events = runJob(logger, 'events', () => {
        const r = runEventScannerTick({ logger, nk, nowFn: () => nowMs });
        return `live=${r.live}/offers=${r.desired.length}`;
      });
    }
    if (dueSubscription) {
      state.lastSubscriptionMs = nowMs;
      result.subscriptions = runJob(logger, 'subscriptions', () => {
        const r = runSubscriptionTick(nk, logger, nowMs);
        return `scanned=${r.scanned}/grants=${r.monthlyGrants}/errors=${r.errors}`;
      });
    }
    if (dueRaces) {
      state.lastRaceCloseMs = nowMs;
      result.races = runJob(logger, 'races', () => {
        const r = runRaceCloseTick(nk, logger, nowMs);
        return `open=${r.scanned}/closed=${r.closed}`;
      });
      result.raceServers = runJob(logger, 'race servers', () => `freed=${releaseStaleServers(nk, logger, nowMs)}`);
    }
    if (duePassSeason) {
      state.lastPassSeasonMs = nowMs;
      result.passSeason = runJob(logger, 'pass season', () => runPassSeasonTick(nk, logger, nowMs));
    }
    if (dueClubWeek) {
      state.lastClubWeekMs = nowMs;
      result.clubWeek = runJob(logger, 'club week', () => runClubWeekTick(nk, logger, nowMs));
    }
  } finally {
    releaseTickLock(nk, SERVICE_TICK_LOCK_NAME, holder);
  }
  state.runs += 1;
  // A races-only pass (every 15 s) logs at debug unless it closed something.
  const racesOnly = !dueTournament && !dueEvent && !dueSubscription && !duePassSeason && !dueClubWeek;
  if (!racesOnly || !/\/closed=0$/.test(result.races)) {
    logger.info(
      'service ticker tick n=%d tournaments=%s events=%s subscriptions=%s races=%s passSeason=%s clubWeek=%s',
      state.runs, result.tournaments, result.events, result.subscriptions, result.races, result.passSeason, result.clubWeek,
    );
  } else {
    logger.debug('service ticker races n=%d %s', state.runs, result.races);
  }
  return result;
}

/**
 * Create the ticker match unless one is already running on this node.
 * Called once from `InitModule`, after `registerMatch`.
 */
export function ensureServiceTicker(nk: INakama, logger: ILogger): string | null {
  try {
    const running: unknown = nk.matchList(10, true, SERVICE_TICKER_LABEL, null, null, null);
    const list = Array.isArray(running) ? running as Array<{ matchId: string }> : [];
    if (list.length > 0) {
      logger.info('service ticker already running matchId=%s', list[0]!.matchId);
      return list[0]!.matchId;
    }
    const matchId = nk.matchCreate(SERVICE_TICKER_MODULE, {});
    logger.info('service ticker created matchId=%s', matchId);
    return matchId;
  } catch (e) {
    logger.error('service ticker could not be created: %s', e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ─── Match handlers (registered in main.ts) ─────────────────────────────────

export function serviceTickerInit(
  _ctx: IContext,
  logger: ILogger,
  nk: INakama,
  _params: Record<string, unknown>,
): { state: ServiceTickerState; tickRate: number; label: string } {
  ensureRuntimeState(nk, logger);
  const state: ServiceTickerState = {
    lastTournamentMs: 0,
    lastEventMs: 0,
    lastSubscriptionMs: 0,
    lastRaceCloseMs: 0,
    lastPassSeasonMs: 0,
    lastClubWeekMs: 0,
    runs: 0,
    nextAttemptMs: 0,
  };
  return { state, tickRate: 1, label: SERVICE_TICKER_LABEL };
}

export function serviceTickerJoinAttempt(
  _ctx: IContext,
  _logger: ILogger,
  _nk: INakama,
  _dispatcher: unknown,
  _tick: number,
  state: ServiceTickerState,
): { state: ServiceTickerState; accept: boolean; rejectMessage: string } {
  return { state, accept: false, rejectMessage: 'service match' };
}

export function serviceTickerJoin(
  _ctx: IContext,
  _logger: ILogger,
  _nk: INakama,
  _dispatcher: unknown,
  _tick: number,
  state: ServiceTickerState,
): { state: ServiceTickerState } {
  return { state };
}

export function serviceTickerLeave(
  _ctx: IContext,
  _logger: ILogger,
  _nk: INakama,
  _dispatcher: unknown,
  _tick: number,
  state: ServiceTickerState,
): { state: ServiceTickerState } {
  return { state };
}

export function serviceTickerLoop(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  _dispatcher: unknown,
  _tick: number,
  state: ServiceTickerState,
): { state: ServiceTickerState } {
  const holder = `match:${ctx?.matchId ?? 'unknown'}`;
  runServiceTick(nk, logger, state, Date.now(), holder);
  return { state };
}

export function serviceTickerTerminate(
  _ctx: IContext,
  logger: ILogger,
  _nk: INakama,
  _dispatcher: unknown,
  _tick: number,
  state: ServiceTickerState,
): { state: ServiceTickerState } {
  logger.warn('service ticker terminating after %d runs', state.runs);
  return { state };
}

export function serviceTickerSignal(
  _ctx: IContext,
  _logger: ILogger,
  _nk: INakama,
  _dispatcher: unknown,
  _tick: number,
  state: ServiceTickerState,
): { state: ServiceTickerState; data: string } {
  return { state, data: JSON.stringify({ runs: state.runs }) };
}
