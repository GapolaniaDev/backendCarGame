// Server-to-server RPCs of the dedicated race servers (D-01, D-02).
//
//   rs_heartbeat   server-to-server, `http_key` + `serverKey`: the server
//     registers itself or refreshes its row every few seconds. If it
//     declares no active session and the registry still holds one that is
//     closed (or gone), the row is freed. The reply carries the pending
//     assignment (T-05, D-04): the `created` session of this server, that
//     the matchmaker reserved for it.
//   rs_join_validate   a player connected to the server: checks the join
//     ticket against the roster of the assigned session (T-06, D-01).
//   rs_session_start   `created -> started` (idempotent).
//   rs_submit_results  the official results of the race: closes the
//     session with confidence `server`, pays and frees the server (D-07,
//     D-10); idempotent by `requestId`.
//   rs_session_release the server gives the session up: closes it as
//     abandoned, without payouts, and frees the server.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok } from '../core/response';
import { parseInput } from '../core/parse_input';
import { serverNowMs } from '../core/time';
import { withRuntime } from '../core/runtime_state';
import { getTrack } from '../core/catalog';
import { SCHEMA_VERSION } from '../core/storage';
import { SYSTEM_USER_ID } from '../race/constants';
import { CloseConflictError, closeRace, type ClosedRace } from '../race/close';
import {
  markStarted,
  readReport,
  readSession,
  saveReportResponse,
  type CloseOverride,
  type PersistedReport,
  type ReadSessionResult,
} from '../race/session_repo';
import type { RaceResult, RaceSession, RaceSubmitResultRewardEntry, RosterEntry } from '../race/types';
import { requireRaceServer, secretsMatch } from './auth';
import { readServer, releaseServerOfSession, writeServer } from './registry_repo';
import { RACE_SERVER_CAPACITY_MAX, RACE_SERVER_PORT_MAX, type RaceServerRecord } from './types';

export type RpcHandler = (ctx: IContext, logger: ILogger, nk: INakama, body: string) => string;

const ATTEMPTS = 3;
/** Players have this long, from the creation of the session, to join the race server (D-01). */
export const JOIN_WINDOW_MS = 30_000;
const BUILD_VERSION_MAX_LENGTH = 64;

export interface RaceServerAssignment {
  sessionId: string;
  mode: string;
  trackId: string;
  laps: number;
  expectedUserIds: string[];
  joinDeadlineMs: number;
  /** Milliseconds left until joinDeadlineMs by the server clock, never negative. */
  joinRemainingMs: number;
}

export interface RsHeartbeatOutput {
  assignment: RaceServerAssignment | null;
}

interface HeartbeatInput {
  host: string;
  port: number;
  capacity: number;
  activeSessionId: string | null;
  buildVersion: string;
}

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function parseHeartbeat(raw: Record<string, unknown>): { ok: true; value: HeartbeatInput } | { ok: false; reason: string } {
  const host = raw['host'];
  if (typeof host !== 'string' || host.trim().length === 0) return { ok: false, reason: 'host must be a non-empty string' };
  if (!isIntInRange(raw['port'], 1, RACE_SERVER_PORT_MAX)) {
    return { ok: false, reason: `port must be an integer in [1, ${RACE_SERVER_PORT_MAX}]` };
  }
  if (!isIntInRange(raw['capacity'], 1, RACE_SERVER_CAPACITY_MAX)) {
    return { ok: false, reason: `capacity must be an integer in [1, ${RACE_SERVER_CAPACITY_MAX}]` };
  }
  const active = raw['activeSessionId'];
  if (active !== null && active !== undefined && (typeof active !== 'string' || active.length === 0)) {
    return { ok: false, reason: 'activeSessionId must be a non-empty string or null' };
  }
  const build = raw['buildVersion'];
  if (build !== undefined && (typeof build !== 'string' || build.length > BUILD_VERSION_MAX_LENGTH)) {
    return { ok: false, reason: `buildVersion must be a string of at most ${BUILD_VERSION_MAX_LENGTH} characters` };
  }
  return {
    ok: true,
    value: {
      host: host.trim(),
      port: raw['port'] as number,
      capacity: raw['capacity'] as number,
      activeSessionId: typeof active === 'string' ? active : null,
      buildVersion: typeof build === 'string' ? build : '',
    },
  };
}

/**
 * The assignment of `serverId` (D-01, D-04): its held session while that is
 * still `created`, hosted by this very server. The expected players are the
 * humans of the roster; they must join before the window closes.
 */
function pendingAssignment(serverId: string, session: RaceSession | null, nowMs: number): RaceServerAssignment | null {
  if (session === null || session.state !== 'created') return null;
  if (session.serverHosted !== true || session.server?.serverId !== serverId) return null;
  const joinDeadlineMs = (session.createdAt ?? 0) + JOIN_WINDOW_MS;
  return {
    sessionId: session.id,
    mode: session.mode,
    trackId: session.trackId,
    laps: session.laps ?? 0,
    expectedUserIds: session.roster.filter((e) => !e.isBot).map((e) => e.userId),
    joinDeadlineMs,
    joinRemainingMs: Math.max(0, joinDeadlineMs - nowMs),
  };
}

export const rs_heartbeat_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const auth = requireRaceServer(ctx, parsed.raw);
  if (!auth.ok) return auth.error;
  const input = parseHeartbeat(parsed.raw);
  if (!input.ok) return JSON.stringify(err('BAD_REQUEST', input.reason));
  const hb = input.value;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const nowMs = serverNowMs();
    const current = readServer(nk, auth.serverId);
    let sessionId = current?.record.sessionId ?? null;
    let held = sessionId === null ? null : readSession(nk, sessionId);
    if (hb.activeSessionId === null && sessionId !== null) {
      if (held === null || held.session.state === 'closed') {
        logger.info('race server %s: session %s is %s, released', auth.serverId, sessionId, held === null ? 'gone' : 'closed');
        sessionId = null;
        held = null;
      }
    }
    const record: RaceServerRecord = {
      schemaVersion: 1,
      host: hb.host,
      port: hb.port,
      capacity: hb.capacity,
      lastSeenMs: nowMs,
      sessionId,
      assignedAtMs: current?.record.assignedAtMs ?? 0,
      buildVersion: hb.buildVersion,
    };
    try {
      writeServer(nk, auth.serverId, record, current?.version ?? null);
    } catch {
      continue; // a concurrent writer won: re-read
    }
    const out: RsHeartbeatOutput = { assignment: pendingAssignment(auth.serverId, held?.session ?? null, serverNowMs()) };
    return JSON.stringify(ok(out));
  }
  return JSON.stringify(err('CONFLICT', 'concurrent update; please retry', { reason: 'VERSION_CONFLICT' }));
};

export const rs_heartbeat: RpcHandler = withRuntime(rs_heartbeat_impl);

// ─── Shared by the session RPCs (T-06) ────────────────────────────────────────

const SESSION_ATTEMPTS = 3;
const SESSION_ID_MAX_LENGTH = 128;
const REQUEST_ID_MAX_LENGTH = 128;
const MAX_RESULTS = 16;
const MAX_LAPS = 100;
const NAME_MAX_LENGTH = 64;
const REASON_MAX_LENGTH = 256;
/** Review reason when a human lap is faster than the class minimum of the track. */
export const REVIEW_LAP_BELOW_MIN = 'lap_below_min';
/** Ids given to bots that come without one. */
const BOT_ID_PREFIX = 'bot_ds_';

type Failure = { ok: false; error: string };
type Parsed<T> = { ok: true; value: T } | Failure;

function fail(code: Parameters<typeof err>[0], message: string, details?: unknown): Failure {
  return { ok: false, error: JSON.stringify(err(code, message, details)) };
}

function forbidden(reason: string, message: string): Failure {
  return fail('FORBIDDEN', message, { reason });
}

/** The session id of a call, validated. */
function parseSessionId(raw: Record<string, unknown>): Parsed<string> {
  const id = raw['sessionId'];
  if (typeof id !== 'string' || id.length === 0 || id.length > SESSION_ID_MAX_LENGTH) {
    return fail('BAD_REQUEST', `sessionId must be a string of 1-${SESSION_ID_MAX_LENGTH} characters`);
  }
  return { ok: true, value: id };
}

/** `true` when the session is a dedicated-server one assigned to `serverId`. */
function isAssignedTo(session: RaceSession, serverId: string): boolean {
  return session.serverHosted === true && session.server?.serverId === serverId;
}

type LoadedSession =
  | { ok: true; serverId: string; sessionId: string; raw: Record<string, unknown>; cur: ReadSessionResult | null }
  | Failure;

/**
 * Authenticates the call and reads the session assigned to the calling
 * server. A session that does not exist comes back as `cur: null` (not as
 * an error), so each RPC decides what that means; one assigned to another
 * server (or not hosted by a server) is `FORBIDDEN` `NOT_ASSIGNED`.
 */
function loadAssignedSession(ctx: IContext, nk: INakama, body: string): LoadedSession {
  const parsed = parseInput(body);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const auth = requireRaceServer(ctx, parsed.raw);
  if (!auth.ok) return { ok: false, error: auth.error };
  const sessionId = parseSessionId(parsed.raw);
  if (!sessionId.ok) return sessionId;
  const cur = readSession(nk, sessionId.value);
  if (cur !== null && !isAssignedTo(cur.session, auth.serverId)) {
    return forbidden('NOT_ASSIGNED', 'the session is not assigned to this server');
  }
  return { ok: true, serverId: auth.serverId, sessionId: sessionId.value, raw: parsed.raw, cur };
}

// ─── rs_join_validate ─────────────────────────────────────────────────────────

export interface RsJoinValidateOutput {
  userId: string;
  displayName: string;
  classId: string;
  bodyId: string;
}

/** Account `display_name`, else `username`, else the user id itself. */
function displayNameOf(nk: INakama, userId: string): string {
  try {
    const account = nk.accountGetId(userId) as { user?: { displayName?: unknown; username?: unknown } } | null;
    const display = account?.user?.displayName;
    if (typeof display === 'string' && display.length > 0) return display;
    const username = account?.user?.username;
    if (typeof username === 'string' && username.length > 0) return username;
  } catch {
    // The account is gone: the race still needs a name for the player.
  }
  return userId;
}

/** The human whose ticket is `ticket`; every ticket is compared, in constant time. */
function rosterEntryByTicket(roster: readonly RosterEntry[], ticket: string): RosterEntry | null {
  let found: RosterEntry | null = null;
  for (const entry of roster) {
    if (entry.isBot || typeof entry.joinTicket !== 'string') continue;
    if (secretsMatch(entry.joinTicket, ticket) && found === null) found = entry;
  }
  return found;
}

export const rs_join_validate_impl: RpcHandler = (ctx, logger, nk, body) => {
  const loaded = loadAssignedSession(ctx, nk, body);
  if (!loaded.ok) return loaded.error;
  if (loaded.cur === null) return forbidden('NOT_ASSIGNED', 'the session is not assigned to this server').error;
  const { session } = loaded.cur;
  if (session.state !== 'created' && session.state !== 'started') {
    return forbidden('BAD_STATE', `the session is ${session.state}`).error;
  }
  const ticket = loaded.raw['joinTicket'];
  if (typeof ticket !== 'string') return JSON.stringify(err('BAD_REQUEST', 'joinTicket must be a string'));
  const entry = rosterEntryByTicket(session.roster, ticket);
  if (entry === null) {
    logger.warn('rs_join_validate sid=%s server=%s: bad join ticket', session.id, loaded.serverId);
    return forbidden('BAD_TICKET', 'the join ticket does not match any player of the session').error;
  }
  const out: RsJoinValidateOutput = {
    userId: entry.userId,
    displayName: displayNameOf(nk, entry.userId),
    classId: entry.loadout.classId,
    bodyId: entry.loadout.bodyId,
  };
  return JSON.stringify(ok(out));
};

export const rs_join_validate: RpcHandler = withRuntime(rs_join_validate_impl);

// ─── rs_session_start ─────────────────────────────────────────────────────────

export interface RsSessionStartOutput {
  startedAt: number;
}

export const rs_session_start_impl: RpcHandler = (ctx, logger, nk, body) => {
  for (let attempt = 0; attempt < SESSION_ATTEMPTS; attempt += 1) {
    const loaded = loadAssignedSession(ctx, nk, body);
    if (!loaded.ok) return loaded.error;
    if (loaded.cur === null) return JSON.stringify(err('NOT_FOUND', `no session with id ${loaded.sessionId}`));
    const { session, version } = loaded.cur;
    if (session.state === 'started') {
      const already: RsSessionStartOutput = { startedAt: session.startedAt ?? serverNowMs() };
      return JSON.stringify(ok(already));
    }
    if (session.state !== 'created') {
      return JSON.stringify(err('CONFLICT', `cannot start a session in state ${session.state}`, { reason: 'BAD_STATE', state: session.state }));
    }
    const startedAt = serverNowMs();
    try {
      markStarted(nk, session, version, startedAt);
    } catch (e) {
      logger.warn('rs_session_start sid=%s CAS conflict: %s', session.id, e instanceof Error ? e.message : String(e));
      continue; // a concurrent writer won: re-read
    }
    logger.info('rs_session_start sid=%s server=%s startedAt=%d', session.id, loaded.serverId, startedAt);
    const out: RsSessionStartOutput = { startedAt };
    return JSON.stringify(ok(out));
  }
  return JSON.stringify(err('CONFLICT', 'concurrent update; please retry', { reason: 'VERSION_CONFLICT' }));
};

export const rs_session_start: RpcHandler = withRuntime(rs_session_start_impl);

// ─── rs_submit_results ────────────────────────────────────────────────────────

/** One entry of `results` as the race server sends it. */
interface ServerResultInput {
  userId: string | null;
  isBot: boolean;
  totalMs: number;
  laps: number[];
  dnf: boolean;
}

export interface RsSubmitResultsOutput {
  officialResults: Array<Pick<RaceResult, 'rank' | 'userId' | 'isBot' | 'totalMs' | 'abandoned'>>;
  rewards: Record<string, RaceSubmitResultRewardEntry>;
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function parseResultEntry(raw: unknown, index: number): Parsed<ServerResultInput> {
  const at = `results[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('BAD_REQUEST', `${at} must be an object`);
  const r = raw as Record<string, unknown>;
  const userId = r['userId'];
  if (userId !== null && (typeof userId !== 'string' || userId.length === 0 || userId.length > SESSION_ID_MAX_LENGTH)) {
    return fail('BAD_REQUEST', `${at}.userId must be a non-empty string or null`);
  }
  if (typeof r['isBot'] !== 'boolean') return fail('BAD_REQUEST', `${at}.isBot must be a boolean`);
  if (typeof r['dnf'] !== 'boolean') return fail('BAD_REQUEST', `${at}.dnf must be a boolean`);
  const name = r['displayName'];
  if (name !== undefined && (typeof name !== 'string' || name.length > NAME_MAX_LENGTH)) {
    return fail('BAD_REQUEST', `${at}.displayName must be a string of at most ${NAME_MAX_LENGTH} characters`);
  }
  if (!isNonNegativeNumber(r['totalMs'])) return fail('BAD_REQUEST', `${at}.totalMs must be a non-negative number`);
  const laps = r['laps'];
  if (!Array.isArray(laps) || laps.length > MAX_LAPS || !laps.every(isNonNegativeNumber)) {
    return fail('BAD_REQUEST', `${at}.laps must be an array of at most ${MAX_LAPS} non-negative numbers`);
  }
  return {
    ok: true,
    value: { userId, isBot: r['isBot'], totalMs: r['totalMs'], laps: laps.slice(), dnf: r['dnf'] },
  };
}

function parseResults(raw: unknown): Parsed<ServerResultInput[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RESULTS) {
    return fail('BAD_REQUEST', `results must be an array of 1-${MAX_RESULTS} entries`);
  }
  const out: ServerResultInput[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = parseResultEntry(raw[i], i);
    if (!entry.ok) return entry;
    out.push(entry.value);
  }
  return { ok: true, value: out };
}

function invalidResult(reason: string, message: string, details: Record<string, unknown> = {}): Failure {
  return fail('INVALID_RESULT', message, { reason, ...details });
}

/** A finished entry: the laps must be the laps of the race and add up to `totalMs` (D-07). */
function validateFinisher(entry: ServerResultInput, index: number, laps: number): Failure | null {
  if (entry.laps.length !== laps) {
    return invalidResult('LAP_COUNT_MISMATCH', `results[${index}].laps has ${entry.laps.length} laps, the race has ${laps}`, {
      actual: entry.laps.length, expected: laps,
    });
  }
  if (!entry.laps.every((lap) => lap > 0) || entry.totalMs <= 0) {
    return invalidResult('LAP_NOT_POSITIVE', `results[${index}] has a lap or a total that is not positive`);
  }
  const sum = entry.laps.reduce((a, b) => a + b, 0);
  if (sum !== entry.totalMs) {
    return invalidResult('LAP_SUM_MISMATCH', `results[${index}]: sum(laps) ${sum} !== totalMs ${entry.totalMs}`, {
      actualSum: sum, totalMs: entry.totalMs,
    });
  }
  return null;
}

interface Placement {
  userId: string;
  isBot: boolean;
  totalMs: number;
  laps: number[];
  /** Position in the submitted list, the tie-break of equal times. */
  order: number;
}

/**
 * Checks `inputs` against the session (D-07) and builds how it closes:
 * finishers by time (ties keep the submitted order), then the DNFs: the
 * humans who reported `dnf` or did not appear, in roster order, then the
 * bots who did not finish. Humans must be in the roster, once each; a lap
 * faster than the minimum of the class does not reject the result, it
 * flags the race for review. Confidence is `server` (D-10).
 */
function buildOutcome(
  nk: INakama,
  session: RaceSession,
  inputs: readonly ServerResultInput[],
  nowMs: number,
): Parsed<CloseOverride> {
  const track = getTrack(session.trackId, nk);
  const laps = session.laps ?? track?.modes[session.mode] ?? 0;
  if (laps <= 0) return fail('INTERNAL', `session ${session.id} has no lap count`);

  const humanById = new Map<string, RosterEntry>();
  for (const e of session.roster) if (!e.isBot) humanById.set(e.userId, e);
  const seen = new Set<string>();
  const finishers: Placement[] = [];
  const botDnf: Placement[] = [];
  let needsReview = false;

  for (let i = 0; i < inputs.length; i += 1) {
    const entry = inputs[i]!;
    let userId: string;
    if (entry.isBot) {
      userId = entry.userId ?? `${BOT_ID_PREFIX}${i}`;
      if (humanById.has(userId)) return invalidResult('BOT_ID_CLASH', `results[${i}]: a bot uses the id of a player`);
    } else {
      if (entry.userId === null || !humanById.has(entry.userId)) {
        return invalidResult('NOT_IN_ROSTER', `results[${i}]: ${String(entry.userId)} is not a human of the session`);
      }
      userId = entry.userId;
    }
    if (seen.has(userId)) return invalidResult('DUPLICATE_RESULT', `results[${i}]: ${userId} appears twice`);
    seen.add(userId);

    if (entry.dnf) {
      if (entry.isBot) botDnf.push({ userId, isBot: true, totalMs: 0, laps: [], order: i });
      continue;
    }
    const invalid = validateFinisher(entry, i, laps);
    if (invalid !== null) return invalid;
    if (!entry.isBot) {
      const minLap = track?.minTimeMsByClass[humanById.get(userId)!.loadout.classId];
      if (minLap !== undefined && entry.laps.some((lap) => lap < minLap)) needsReview = true;
    }
    finishers.push({ userId, isBot: entry.isBot, totalMs: entry.totalMs, laps: entry.laps.slice(), order: i });
  }

  finishers.sort((a, b) => a.totalMs - b.totalMs || a.order - b.order);
  const results: RaceResult[] = finishers.map((f, i) => ({
    rank: i + 1, userId: f.userId, isBot: f.isBot, totalMs: f.totalMs, abandoned: false, laps: f.laps,
  }));
  const finishedById = new Map(finishers.map((f) => [f.userId, f]));
  const dnfIds = [
    ...session.roster.filter((e) => !e.isBot && !finishedById.has(e.userId)).map((e) => ({ userId: e.userId, isBot: false })),
    ...botDnf.map((b) => ({ userId: b.userId, isBot: true })),
  ];
  for (const d of dnfIds) {
    results.push({ rank: results.length + 1, userId: d.userId, isBot: d.isBot, totalMs: 0, abandoned: true });
  }

  const roster: RosterEntry[] = session.roster.map((e) => {
    const f = finishedById.get(e.userId);
    if (f === undefined || e.isBot) return { ...e, abandoned: true };
    return { ...e, reportedAt: nowMs, totalMs: f.totalMs, laps: f.laps.slice() };
  });
  return {
    ok: true,
    value: {
      roster,
      results,
      confidence: 'server',
      needsReview,
      ...(needsReview ? { reviewReason: REVIEW_LAP_BELOW_MIN } : {}),
    },
  };
}

/** The stored answer to `requestId`: a report-shaped row owned by the system user. */
function storedSubmission(nk: INakama, sessionId: string, requestId: string): string | null {
  const stored = readReport(nk, sessionId, SYSTEM_USER_ID);
  if (stored === null || stored.requestId !== requestId) return null;
  return typeof stored.response === 'string' && stored.response.length > 0 ? stored.response : null;
}

function saveSubmission(nk: INakama, logger: ILogger, sessionId: string, requestId: string, response: string): void {
  const marker: PersistedReport = {
    schemaVersion: SCHEMA_VERSION,
    userId: SYSTEM_USER_ID,
    totalMs: 0,
    laps: [],
    isBotReport: true,
    requestId,
  };
  try {
    saveReportResponse(nk, sessionId, marker, response);
  } catch (e) {
    logger.warn('rs_submit_results sid=%s: response not stored: %s', sessionId, e instanceof Error ? e.message : String(e));
  }
}

export const rs_submit_results_impl: RpcHandler = (ctx, logger, nk, body) => {
  const loaded = loadAssignedSession(ctx, nk, body);
  if (!loaded.ok) return loaded.error;
  const requestId = loaded.raw['requestId'];
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > REQUEST_ID_MAX_LENGTH) {
    return JSON.stringify(err('BAD_REQUEST', `requestId must be a string of 1-${REQUEST_ID_MAX_LENGTH} characters`));
  }
  const inputs = parseResults(loaded.raw['results']);
  if (!inputs.ok) return inputs.error;
  if (loaded.cur === null) return JSON.stringify(err('NOT_FOUND', `no session with id ${loaded.sessionId}`));
  const replay = storedSubmission(nk, loaded.sessionId, requestId);
  if (replay !== null) {
    logger.info('rs_submit_results sid=%s replayed requestId', loaded.sessionId);
    return replay;
  }
  const { version } = loaded.cur;
  const nowMs = serverNowMs();
  // A `created` session is started implicitly, as `rs_session_start` would: the server may have
  // failed to call it and the results must not be lost for that (D-12).
  const session: RaceSession = loaded.cur.session.state === 'created'
    ? { ...loaded.cur.session, state: 'started', startedAt: nowMs, claimedAt: nowMs }
    : loaded.cur.session;
  if (session.state !== 'started') {
    return JSON.stringify(err('CONFLICT', `cannot submit results to a session in state ${session.state}`, { reason: 'BAD_STATE', state: session.state }));
  }

  const override = buildOutcome(nk, session, inputs.value, nowMs);
  if (!override.ok) return override.error;
  let closed: ClosedRace;
  try {
    closed = closeRace(nk, logger, session, version, nowMs, 'server_results', 'throw', override.value);
  } catch (e) {
    if (!(e instanceof CloseConflictError)) throw e;
    logger.warn('rs_submit_results sid=%s close CAS conflict: %s', session.id, e.message);
    return JSON.stringify(err('CONFLICT', 'concurrent update; please retry', { reason: 'VERSION_CONFLICT' }));
  }
  const out: RsSubmitResultsOutput = {
    officialResults: closed.outcome.results.map((r) => ({
      rank: r.rank, userId: r.userId, isBot: r.isBot, totalMs: r.totalMs, abandoned: r.abandoned,
    })),
    rewards: closed.rewards ?? {},
  };
  const serialized = JSON.stringify(ok(out));
  saveSubmission(nk, logger, session.id, requestId, serialized);
  logger.info('rs_submit_results sid=%s server=%s results=%d needsReview=%s', session.id, loaded.serverId,
    out.officialResults.length, String(override.value.needsReview));
  return serialized;
};

export const rs_submit_results: RpcHandler = withRuntime(rs_submit_results_impl);

// ─── rs_session_release ───────────────────────────────────────────────────────

export interface RsSessionReleaseOutput {
  released: true;
}

export const rs_session_release_impl: RpcHandler = (ctx, logger, nk, body) => {
  const releasedReply = JSON.stringify(ok<RsSessionReleaseOutput>({ released: true }));
  for (let attempt = 0; attempt < SESSION_ATTEMPTS; attempt += 1) {
    const loaded = loadAssignedSession(ctx, nk, body);
    if (!loaded.ok) return loaded.error;
    const reason = loaded.raw['reason'];
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > REASON_MAX_LENGTH)) {
      return JSON.stringify(err('BAD_REQUEST', `reason must be a string of at most ${REASON_MAX_LENGTH} characters`));
    }
    const { serverId, sessionId, cur } = loaded;
    // Nothing to close for a session that is gone or already closed: the server is only freed.
    if (cur === null || cur.session.state === 'closed') {
      releaseServerOfSession(nk, serverId, sessionId);
      return releasedReply;
    }
    try {
      closeRace(nk, logger, cur.session, cur.version, serverNowMs(), 'abandoned', 'log');
    } catch (e) {
      if (!(e instanceof CloseConflictError)) throw e;
      logger.warn('rs_session_release sid=%s close CAS conflict: %s', sessionId, e.message);
      continue; // a concurrent writer won: re-read
    }
    releaseServerOfSession(nk, serverId, sessionId);
    logger.info('rs_session_release sid=%s server=%s reason=%s', sessionId, serverId, typeof reason === 'string' ? reason : '');
    return releasedReply;
  }
  return JSON.stringify(err('CONFLICT', 'concurrent update; please retry', { reason: 'VERSION_CONFLICT' }));
};

export const rs_session_release: RpcHandler = withRuntime(rs_session_release_impl);
