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
//   - events: special-offer reconciliation        every 5 min
//   - subscriptions: expiry notices + grants      every 5 min
// A storage lease (`tick_lock.ts`) makes sure only one tick runs at a
// time even with several matches or nodes.
//
// The match runs in its own goja VM: it re-evaluates the bundle but not
// `InitModule`, so `serviceTickerInit` loads the catalogs the jobs read.
//
// Every handler is a top-level function so the 3.27 registration scanner
// can resolve them (`initializer.registerMatch` in main.ts).

import type { IContext, ILogger, INakama } from '../nkruntime';
import { loadTournamentsCatalog } from '../tournaments/catalog';
import { loadEventsCatalog } from '../core/active_events';
import { loadIapPacksCatalog } from '../iap/catalog';
import { runScannerTick as runTournamentTick } from '../tournaments/scanner';
import { runEventScannerTick } from '../events/scanner';
import { scanOnce as runSubscriptionTick } from '../iap/subscription_scanner';
import { tryAcquireTickLock, releaseTickLock } from './tick_lock';
import tournamentsJson from '../catalogs/tournaments.json';
import eventsJson from '../catalogs/events.json';
import iapPacksJson from '../catalogs/iap_packs.json';

export const SERVICE_TICKER_MODULE = 'service_ticker';
/** Match label used to find (and not duplicate) the running ticker. */
export const SERVICE_TICKER_LABEL = 'service_ticker';
export const TOURNAMENT_TICK_MS = 60_000;
export const EVENT_TICK_MS = 5 * 60_000;
export const SUBSCRIPTION_TICK_MS = 5 * 60_000;
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
}

/** Load the catalogs the jobs read into the current VM. Idempotent. */
export function loadServiceTickerCatalogs(logger: ILogger, nk: INakama): void {
  loadTournamentsCatalog(logger, tournamentsJson);
  loadEventsCatalog(logger, eventsJson as unknown as Parameters<typeof loadEventsCatalog>[1], nk);
  loadIapPacksCatalog(logger, iapPacksJson);
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
  const idle: ServiceTickResult = { ran: false, tournaments: '-', events: '-', subscriptions: '-' };
  if (!dueTournament && !dueEvent && !dueSubscription) return idle;
  if (nowMs < state.nextAttemptMs) return idle;
  if (!tryAcquireTickLock(nk, SERVICE_TICK_LOCK_NAME, holder, nowMs, SERVICE_TICK_LOCK_TTL_MS)) {
    // Another ticker holds the lease; back off instead of retrying every loop.
    state.nextAttemptMs = nowMs + LOCK_RETRY_MS;
    return { ...idle, tournaments: 'locked', events: 'locked', subscriptions: 'locked' };
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
        return `scanned=${r.scanned}/updated=${r.updated}`;
      });
    }
    if (dueSubscription) {
      state.lastSubscriptionMs = nowMs;
      result.subscriptions = runJob(logger, 'subscriptions', () => {
        const r = runSubscriptionTick(nk, logger, nowMs);
        return `scanned=${r.scanned}/grants=${r.monthlyGrants}/errors=${r.errors}`;
      });
    }
  } finally {
    releaseTickLock(nk, SERVICE_TICK_LOCK_NAME, holder);
  }
  state.runs += 1;
  logger.info(
    'service ticker tick n=%d tournaments=%s events=%s subscriptions=%s',
    state.runs, result.tournaments, result.events, result.subscriptions,
  );
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
  loadServiceTickerCatalogs(logger, nk);
  const state: ServiceTickerState = {
    lastTournamentMs: 0,
    lastEventMs: 0,
    lastSubscriptionMs: 0,
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
