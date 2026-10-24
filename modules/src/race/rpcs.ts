// Race RPC handlers (Phase 1 — Chunk 6).
//
// Five handlers are real as of this chunk:
//   - config_get            (catalogs + serverTimeMs)
//   - race_session_create   (creates a fresh RaceSession)
//   - race_session_join     (appends a player to an open session's roster)
//   - race_session_start    (transitions created → started, stamps startedAt)
//   - race_session_get      (reads a session by id OR the caller's lastClosed)
//
// The remaining handler is still a stub:
//   - race_submit_result    (lands in Chunks 7-9)
//
// Each handler follows the same envelope:
//   `withSession()` → `checkRateLimit()` → parse → validate → work → `ok()`/`err()`
//
// Every RPC must be exported as a TOP-LEVEL global bound to a stable
// identifier that matches the RPC key. Nakama's goja runtime looks the
// function up on globalThis after InitModule returns (see
// server/runtime_javascript_init.go `checkFnScope`). The `raceRpcs` map
// is a convenience for unit/e2e tests.

import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import {
  assertMinClientVersion,
  assertNotInMaintenance,
  clientPlatformOf,
  minClientVersionFor,
} from '../core/liveops';
import { loadLiveopsConfig } from '../liveops/config';
import { emit } from '../core/admin/analytics';
import {
  getCatalogsHash,
  getModes,
  getTrack,
  getTracks,
} from '../core/catalog';
import { serverNowMs } from '../core/time';
import type { EventBus } from '../core/event_bus';
import { ensureRuntimeState, withRuntime } from '../core/runtime_state';
import type { IContext, ILogger, INakama } from '../nkruntime';
import { CREATED_SESSION_TTL_MS, RATE_LIMITS } from './constants';
import { canTransition } from './state';
import {
  allSubmitted,
  appendRosterEntry,
  claimHost as claimHostRepo,
  createSession,
  lookupLastClosed,
  markStarted,
  readActiveIndex,
  readPresence,
  readReport,
  readSession,
  saveReportResponse,
  submitReport,
  touchPresence,
} from './session_repo';
import { toPublicSessionOutput } from './session_view';
import { CloseConflictError, closeIfDue, closeRace, type ClosedRace } from './close';
import { validateHostClaim, validateSubmissionStep1, validateSubmissionStep2 } from './validation';
import { resolveServerLoadout } from './loadout';
import type {
  ConfigGetOutput,
  CarClassId,
  Loadout,
  RaceHostClaimInput,
  RaceHostClaimOutput,
  RaceReport,
  RaceSession,
  RaceSessionCreateInput,
  RaceSessionCreateOutput,
  RaceSessionJoinInput,
  RaceSessionJoinOutput,
  RaceSessionQuickBotsHuman,
  RaceSessionQuickBotsInput,
  RaceSessionQuickBotsOutput,
  RaceSessionQuickBotsRosterEntry,
  RaceSessionStartInput,
  RaceSessionStartOutput,
  RaceSessionGetInput,
  RaceSessionGetOutput,
  RaceSubmitResultInput,
  RaceSubmitResultOutput,
} from './types';
import {
  averageRating,
  buildBotRoster,
  pickBotDifficulty,
} from '../matchmaking/quick_bots';
import { pickTrack } from '../matchmaking/track_picker';
import { readEntry as readTournamentEntry, readTournamentInstance } from '../tournaments/repo';
import { requireCaller } from '../core/caller';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
) => string;

// ─── Event bus wiring ─────────────────────────────────────────────────────────

/**
 * The race bus of the VM serving this call. Every pool VM builds its own
 * on first use (`ensureRuntimeState`, plan T-29 / D-11): a bus set from
 * `InitModule` would only exist in the throwaway boot VM (audit N8,
 * PC-14), and races would never close.
 */
export function getRaceBus(nk: INakama, logger: ILogger): EventBus {
  return ensureRuntimeState(nk, logger);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sessions run by a dedicated race server (plan fishnet-nakama-server, D-07)
 * are driven by that server alone: the players neither join, start, claim
 * the host nor report. `null` when the session is a relay one.
 */
function rejectIfServerHosted(session: RaceSession): string | null {
  if (session.serverHosted !== true) return null;
  return toJson(err('FORBIDDEN', 'this race is run by a dedicated race server', { reason: 'SERVER_HOSTED' }));
}

/** Parse the JSON-string RPC body. Returns a `BAD_REQUEST` envelope on failure. */
function parsePayload<T>(payload: string): Resp<T> | null {
  if (payload === '' || payload === undefined) {
    // RPC contract: empty body is OK for `config_get`. For other handlers
    // that explicitly require fields, the handler does its own check.
    return null;
  }
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return err('BAD_REQUEST', 'payload must be a JSON object');
    }
    return { ok: true, data: parsed as T };
  } catch {
    return err('BAD_REQUEST', 'payload is not valid JSON');
  }
}

// ─── config_get ──────────────────────────────────────────────────────────────

function lenientObject(payload: string): { clientVersion?: unknown; platform?: unknown } {
  try {
    const v = JSON.parse(payload) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Returns the catalogs (read-only data the client needs at boot) plus the
 * server's wall clock and a content hash so the client can short-circuit
 * a full re-download when nothing changed.
 *
 * `minClientVersion` is the LiveOps minimum for the request's `platform`
 * (optional, default `ios`; plan T-14, audit 04 f14: it was a hard-coded
 * '1.0.0'). A request that declares a lower `clientVersion` gets
 * `UPGRADE_REQUIRED`; one without it passes, like every other gate.
 * `config_get` stays open during maintenance: the client needs its clock
 * and the minimum version to show the maintenance or update screen.
 *
 * The handler is intentionally cheap: one LiveOps config read besides
 * in-memory catalogs and a Date.now() call. No rate limit either —
 * clients may call it as often as they like.
 */
function config_get_impl(
  _ctx: IContext,
  logger: ILogger,
  _nk: INakama,
  payload: string,
): string {
  // The body used to be ignored, so any body is accepted (D-05): only an
  // object's `clientVersion` / `platform` are read.
  const input = lenientObject(payload);
  const liveops = loadLiveopsConfig(_nk, logger);
  const platform = clientPlatformOf(input.platform, liveops);
  const minClientVersion = minClientVersionFor(liveops, platform);
  const clientVersion = typeof input.clientVersion === 'string' ? input.clientVersion : undefined;
  const gate = assertMinClientVersion(clientVersion, platform, liveops);
  if (gate !== null) return toJson(gate);

  const data: ConfigGetOutput = {
    serverTimeMs: serverNowMs(),
    catalogsHash: getCatalogsHash(_nk),
    tracks: getTracks(_nk),
    modes: getModes(_nk),
    minClientVersion,
  };
  logger.debug('config_get served hash=%s', data.catalogsHash.slice(0, 12));
  return toJson(ok(data));
}

// ─── race_session_create ─────────────────────────────────────────────────────

/** `RaceSessionCreateInput` once validated: the declared loadout may be absent. */
type ValidatedCreateInput = Omit<RaceSessionCreateInput, 'hostLoadout'> & { hostLoadout: Loadout | null };

function validateCreateInput(raw: unknown, nk: INakama): Resp<ValidatedCreateInput> {
  if (raw === null || typeof raw !== 'object') {
    return err('BAD_REQUEST', 'payload must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const matchId = obj['matchId'];
  if (typeof matchId !== 'string' || matchId.length === 0) {
    return err('BAD_REQUEST', 'matchId must be a non-empty string');
  }
  const mode = obj['mode'];
  if (
    mode !== 'quick' &&
    mode !== 'ranked' &&
    mode !== 'private' &&
    mode !== 'time_trial'
  ) {
    return err('BAD_REQUEST', `mode must be quick|ranked|private|time_trial, got ${String(mode)}`);
  }
  const trackId = obj['trackId'];
  if (typeof trackId !== 'string' || trackId.length === 0) {
    return err('BAD_REQUEST', 'trackId must be a non-empty string');
  }
  const track = getTrack(trackId, nk);
  if (!track) {
    return err('BAD_REQUEST', `unknown trackId: ${trackId}`);
  }
  const size = obj['size'];
  if (size !== 1 && size !== 2 && size !== 4 && size !== 6) {
    return err('BAD_REQUEST', `size must be 1|2|4|6, got ${String(size)}`);
  }
  // Mode must allow this size.
  const modes = getModes(nk);
  const modeEntry = modes.find((m) => m.id === mode);
  if (!modeEntry) {
    return err('BAD_REQUEST', `unknown mode: ${String(mode)}`);
  }
  if (!modeEntry.allowedSizes.includes(size as 1 | 2 | 4 | 6)) {
    return err('CONFLICT', `mode ${mode} does not allow size ${size}`, {
      mode,
      size,
      allowedSizes: modeEntry.allowedSizes,
    });
  }

  return ok({
    matchId,
    mode,
    trackId,
    size: size as RaceSessionCreateInput['size'],
    hostLoadout: parseDeclaredLoadout(obj['hostLoadout']),
    hostUserId: typeof obj['hostUserId'] === 'string' ? obj['hostUserId'] : '',
  });
}

/**
 * The loadout a client declares is only a hint since T-10: the server
 * takes the car from the garage (`resolveServerLoadout`). A missing or
 * malformed declaration (e.g. a placeholder class id) is therefore
 * ignored instead of rejected.
 */
function parseDeclaredLoadout(obj: unknown): Loadout | null {
  const v = validateLoadout(obj);
  return v.ok ? v.data : null;
}

function race_session_create_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
): string {
  const parsed = parsePayload<RaceSessionCreateInput>(payload);
  if (parsed === null) {
    return toJson(err('BAD_REQUEST', 'payload is required'));
  }
  if (!parsed.ok) return toJson(parsed);

  // The host is the session user (D-03). The client still sends
  // `hostUserId`; when present it must be the session user.
  const caller = requireCaller(ctx, parsed.data, ['hostUserId', 'callerUserId']);
  if (!caller.ok) return toJson(caller.error);
  const hostId = caller.userId;

  // Maintenance gate (Phase 5 Chunk 9 — exhaustive LiveOps coverage).
  // Race RPCs don't carry clientVersion/platform, so we only check
  // maintenance (no min-version).
  const m = assertNotInMaintenance(logger, nk, hostId);
  if (m !== null) return toJson(m);

  const rl = checkRateLimit(nk, {
    rpcName: 'race_session_create',
    userId: hostId,
    ...RATE_LIMITS.race_session_create,
  });
  if (!rl.allowed) {
    return toJson(err('RATE_LIMITED', undefined, { limit: rl.limit, windowSec: rl.windowSec }));
  }

  const v = validateCreateInput(parsed.data, nk);
  if (!v.ok) return toJson(v);
  const input = v.data;

  // Build minimal session — host is the only roster entry, no reports yet.
  const sessionId = nk.uuidv4();
  const nowMs = serverNowMs();
  // The loadout comes from the host's garage, not from the body (T-10,
  // audit PC-16); ranked sessions get equalized stats (Phase 4 Chunk 8).
  const hostLoadout: Loadout = resolveServerLoadout(
    nk,
    logger,
    hostId,
    input.hostLoadout,
    input.mode === 'ranked' ? 'ranked' : 'normal',
    'race_session_create',
  );
  const session: RaceSession = {
    schemaVersion: 1,
    id: sessionId,
    matchId: input.matchId,
    mode: input.mode,
    trackId: input.trackId,
    size: input.size,
    roster: [
      {
        userId: hostId,
        loadout: hostLoadout,
        isBot: false,
      },
    ],
    host: hostId,
    hostSuccession: [hostId],
    state: 'created',
    createdAt: nowMs,
    startedAt: null,
    results: [],
    flags: { needsReview: false },
    version: 1,
  };

  try {
    createSession(nk, session, [hostId], nowMs);
  } catch (e) {
    logger.error(
      'race_session_create storage error: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to persist session'));
  }

  emit(nk, logger, 'session_started', {
    sessionId,
    hostId,
    mode: input.mode,
    size: input.size,
    trackId: input.trackId,
  });

  logger.info(
    'race_session_create sid=%s host=%s mode=%s track=%s size=%d',
    sessionId,
    hostId,
    input.mode,
    input.trackId,
    input.size,
  );

  const out: RaceSessionCreateOutput = {
    sessionId,
    rosterVersion: 1,
    hostSuccession: [hostId],
  };
  return toJson(ok(out));
}

// ─── race_session_get ────────────────────────────────────────────────────────

function race_session_get_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
): string {
  let sessionId: string | undefined;
  let body: unknown;
  logger.debug(
    'race_session_get ctx.userId=%s payloadBytes=%d',
    String(ctx.userId),
    payload.length,
  );

  if (payload !== '' && payload !== undefined) {
    const parsed = parsePayload<RaceSessionGetInput>(payload);
    if (parsed && !parsed.ok) return toJson(parsed);
    if (parsed && parsed.ok) {
      const sidField = parsed.data.sessionId;
      if (sidField !== undefined && (typeof sidField !== 'string' || sidField.length === 0)) {
        return toJson(err('BAD_REQUEST', 'sessionId must be a non-empty string'));
      }
      sessionId = sidField;
      body = parsed.data;
    }
  }

  // Caller identity from the session only (D-03; audit N2, N6). A body
  // `callerUserId` of another account is rejected instead of trusted.
  const caller = requireCaller(ctx, body);
  if (!caller.ok) return toJson(caller.error);
  const callerId = caller.userId;

  const rl = checkRateLimit(nk, {
    rpcName: 'race_session_get',
    userId: callerId,
    ...RATE_LIMITS.race_session_get,
  });
  if (!rl.allowed) {
    return toJson(err('RATE_LIMITED', undefined, { limit: rl.limit, windowSec: rl.windowSec }));
  }

  // No sessionId → the caller's active session (T-08, audit PC-08), so a
  // restarted client can rejoin; without one, the last closed session.
  if (!sessionId) {
    const active = resolveActiveSession(nk, callerId, serverNowMs());
    if (active !== null) {
      // Lazy close (T-06): a session past its grace closes on read.
      const { current } = closeIfDue(nk, logger, active, serverNowMs(), 'race_session_get');
      logger.debug('race_session_get caller=%s via active index sid=%s', callerId, current.session.id);
      const out: RaceSessionGetOutput = current.session.state === 'closed'
        ? { session: current.session, lastClosed: current.session }
        : { session: withContact(nk, logger, current.session, callerId) };
      return toJson(ok(toPublicSessionOutput(out, callerId)));
    }
    const last = lookupLastClosed(nk, callerId);
    if (!last) {
      return toJson(err('NOT_FOUND', 'caller has no active or closed race session'));
    }
    const result = readSession(nk, last.sessionId);
    if (!result) {
      return toJson(err('NOT_FOUND', `lastClosed index pointed to missing session ${last.sessionId}`));
    }
    const out: RaceSessionGetOutput = {
      session: result.session,
      lastClosed: result.session,
    };
    logger.debug('race_session_get caller=%s via lastClosed sid=%s', callerId, last.sessionId);
    return toJson(ok(toPublicSessionOutput(out, callerId)));
  }

  const found = readSession(nk, sessionId);
  if (!found) {
    return toJson(err('NOT_FOUND', `no session with id ${sessionId}`));
  }

  // Caller must be in the roster.
  const inRoster = found.session.roster.some((e) => e.userId === callerId);
  if (!inRoster) {
    logger.warn(
      'race_session_get sid=%s callerId=%s not in roster — denying',
      sessionId,
      callerId,
    );
    return toJson(err('NOT_FOUND', `no session with id ${sessionId}`));
  }

  // Lazy close (T-06): a session past its grace closes on read.
  const result = closeIfDue(nk, logger, found, serverNowMs(), 'race_session_get').current;
  logger.debug('race_session_get sid=%s caller=%s', sessionId, callerId);
  const out: RaceSessionGetOutput = { session: withContact(nk, logger, result.session, callerId) };
  return toJson(ok(toPublicSessionOutput(out, callerId)));
}

/**
 * Record the caller's contact with a running session (T-07, audit PC-07:
 * the host claim needs to know who is still there) and return the session
 * with each player's `lastSeenMs` for the response. Closed sessions are
 * returned as stored. A failed contact write never fails the read.
 */
function withContact(nk: INakama, logger: ILogger, session: RaceSession, callerId: string): RaceSession {
  if (session.state === 'closed') return session;
  const nowMs = serverNowMs();
  recordContact(nk, logger, session, callerId, nowMs);
  const seen = readPresence(nk, session);
  seen.set(callerId, nowMs);
  return {
    ...session,
    roster: session.roster.map((e) => {
      const lastSeenMs = seen.get(e.userId);
      return lastSeenMs === undefined ? e : { ...e, lastSeenMs };
    }),
  };
}

function recordContact(
  nk: INakama,
  logger: ILogger,
  session: RaceSession,
  userId: string,
  nowMs: number,
): void {
  if (session.state === 'closed' || !session.roster.some((e) => e.userId === userId)) return;
  try {
    touchPresence(nk, session.id, userId, nowMs);
  } catch (e) {
    logger.warn(
      'race contact sid=%s user=%s not recorded: %s',
      session.id,
      userId,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * The caller's live session from the `race_active` index, or `null` when
 * the index is empty or stale: the session is gone or closed, the caller
 * left its roster, or it sat in `created` longer than
 * `CREATED_SESSION_TTL_MS` (an unused matchmaker session).
 */
function resolveActiveSession(
  nk: INakama,
  callerId: string,
  nowMs: number,
): ReturnType<typeof readSession> {
  const pointer = readActiveIndex(nk, callerId);
  if (pointer === null) return null;
  const cur = readSession(nk, pointer.sessionId);
  if (cur === null) return null;
  const session = cur.session;
  if (session.state === 'closed') return null;
  if (!session.roster.some((e) => e.userId === callerId)) return null;
  if (session.state === 'created') {
    const since = session.createdAt ?? pointer.since;
    if (nowMs - since > CREATED_SESSION_TTL_MS) return null;
  }
  return cur;
}

// ─── race_session_join ───────────────────────────────────────────────────────

function validateLoadout(obj: unknown): Resp<Loadout> {
  if (!obj || typeof obj !== 'object') {
    return err('BAD_REQUEST', 'loadout must be an object');
  }
  const l = obj as Record<string, unknown>;
  const classId = l['classId'];
  if (classId !== 'D' && classId !== 'C' && classId !== 'B' && classId !== 'A' && classId !== 'S') {
    return err('BAD_REQUEST', 'loadout.classId must be D|C|B|A|S');
  }
  const bodyId = l['bodyId'];
  if (typeof bodyId !== 'string' || bodyId.length === 0) {
    return err('BAD_REQUEST', 'loadout.bodyId must be a non-empty string');
  }
  const out: Loadout = {
    classId: classId as CarClassId,
    bodyId,
    ...(typeof l['liveryId'] === 'string' ? { liveryId: l['liveryId'] } : {}),
  };
  return ok(out);
}

function race_session_join_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
): string {
  const parsed = parsePayload<RaceSessionJoinInput>(payload);
  if (parsed === null) return toJson(err('BAD_REQUEST', 'payload is required'));
  if (!parsed.ok) return toJson(parsed);

  // The joiner is the session user (D-03): nobody joins on behalf of
  // another player. Body `userId` / `callerUserId` must match when sent.
  const caller = requireCaller(ctx, parsed.data, ['userId', 'callerUserId']);
  if (!caller.ok) return toJson(caller.error);
  const joinerId = caller.userId;

  // Maintenance gate (Chunk 9).
  const m = assertNotInMaintenance(logger, nk, joinerId);
  if (m !== null) return toJson(m);

  const loadout = parseDeclaredLoadout(parsed.data.loadout);

  const rl = checkRateLimit(nk, {
    rpcName: 'race_session_join',
    userId: joinerId,
    ...RATE_LIMITS.race_session_join,
  });
  if (!rl.allowed) {
    return toJson(err('RATE_LIMITED', undefined, { limit: rl.limit, windowSec: rl.windowSec }));
  }

  const sessionId =
    typeof parsed.data.sessionId === 'string' && parsed.data.sessionId.length > 0
      ? parsed.data.sessionId
      : '';
  if (!sessionId) {
    return toJson(err('BAD_REQUEST', 'sessionId is required'));
  }

  const cur = readSession(nk, sessionId);
  if (!cur) {
    return toJson(err('NOT_FOUND', `no session with id ${sessionId}`));
  }
  const hostedJoin = rejectIfServerHosted(cur.session);
  if (hostedJoin !== null) return hostedJoin;
  if (cur.session.state !== 'created') {
    return toJson(
      err('CONFLICT', `cannot join session in state ${cur.session.state}`, {
        state: cur.session.state,
      }),
    );
  }
  if (cur.session.roster.some((e) => e.userId === joinerId)) {
    return toJson(err('CONFLICT', `user ${joinerId} is already in the roster`));
  }
  if (cur.session.roster.length >= cur.session.size) {
    return toJson(
      err(
        'CONFLICT',
        `roster is full (${cur.session.roster.length}/${cur.session.size})`,
        {
          size: cur.session.size,
          rosterSize: cur.session.roster.length,
        },
      ),
    );
  }

  // The loadout comes from the joiner's garage (T-10, audit PC-16); in a
  // ranked session its stats are clamped to the car's maxStats so the
  // race rewards driver skill, not wallet (Phase 4 Chunk 8).
  const joinerLoadout: Loadout = resolveServerLoadout(
    nk,
    logger,
    joinerId,
    loadout,
    cur.session.mode === 'ranked' ? 'ranked' : 'normal',
    'race_session_join',
  );

  try {
    appendRosterEntry(
      nk,
      cur.session,
      { userId: joinerId, loadout: joinerLoadout, isBot: false },
      cur.version,
      serverNowMs(),
    );
  } catch (e) {
    logger.warn(
      'race_session_join sid=%s joiner=%s CAS conflict: %s',
      sessionId,
      joinerId,
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('CONFLICT', 'concurrent join raced — please retry'));
  }

  logger.info(
    'race_session_join sid=%s joiner=%s rosterSize=%d',
    sessionId,
    joinerId,
    cur.session.roster.length + 1,
  );

  const out: RaceSessionJoinOutput = {
    rosterVersion: cur.session.version + 1,
    rosterSize: cur.session.roster.length + 1,
  };
  return toJson(ok(out));
}

// ─── race_session_start ──────────────────────────────────────────────────────

function race_session_start_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
): string {
  const parsed = parsePayload<RaceSessionStartInput>(payload);
  if (parsed === null) return toJson(err('BAD_REQUEST', 'payload is required'));
  if (!parsed.ok) return toJson(parsed);

  // Caller identity from the session only (D-03).
  const caller = requireCaller(ctx, parsed.data);
  if (!caller.ok) return toJson(caller.error);
  const callerId = caller.userId;

  // Maintenance gate (Chunk 9).
  const m = assertNotInMaintenance(logger, nk, callerId);
  if (m !== null) return toJson(m);

  const sessionId =
    typeof parsed.data.sessionId === 'string' && parsed.data.sessionId.length > 0
      ? parsed.data.sessionId
      : '';
  if (!sessionId) {
    return toJson(err('BAD_REQUEST', 'sessionId is required'));
  }

  const rl = checkRateLimit(nk, {
    rpcName: 'race_session_start',
    userId: callerId,
    ...RATE_LIMITS.race_session_start,
  });
  if (!rl.allowed) {
    return toJson(err('RATE_LIMITED', undefined, { limit: rl.limit, windowSec: rl.windowSec }));
  }

  const cur = readSession(nk, sessionId);
  if (!cur) {
    return toJson(err('NOT_FOUND', `no session with id ${sessionId}`));
  }
  const hostedStart = rejectIfServerHosted(cur.session);
  if (hostedStart !== null) return hostedStart;
  if (cur.session.host !== callerId) {
    logger.warn(
      'race_session_start sid=%s callerId=%s != host=%s — denying',
      sessionId,
      callerId,
      cur.session.host,
    );
    return toJson(err('FORBIDDEN', 'only the host can start the session'));
  }
  if (!canTransition(cur.session.state, 'started')) {
    return toJson(
      err('CONFLICT', `cannot start session in state ${cur.session.state}`, {
        state: cur.session.state,
      }),
    );
  }

  const startedAt = serverNowMs();
  let newVersion: string;
  try {
    const r = markStarted(nk, cur.session, cur.version, startedAt);
    newVersion = r.version;
  } catch (e) {
    logger.warn(
      'race_session_start sid=%s CAS conflict: %s',
      sessionId,
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('CONFLICT', 'concurrent write raced — please retry'));
  }

  logger.info(
    'race_session_start sid=%s host=%s startedAt=%d version=%s',
    sessionId,
    callerId,
    startedAt,
    newVersion,
  );

  const out: RaceSessionStartOutput = { startedAt };
  return toJson(ok(out));
}

// ─── race_submit_result (Chunk 7: step-1 + idempotency) ───────────────────────

/**
 * `validateReport` checks the shape of a `RaceReport` payload. Step-1
 * validations (membership / state / dup) live in `validation.ts` and
 * run AFTER this passes. Step-2 validations (clock / min / lap-sum /
 * bot-auth) land in Chunk 8 — for now we accept any well-formed
 * payload.
 */
function validateReport(raw: unknown): Resp<RaceReport> {
  if (raw === null || typeof raw !== 'object') {
    return err('BAD_REQUEST', 'report must be an object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['userId'] !== 'string' || r['userId'].length === 0) {
    return err('BAD_REQUEST', 'report.userId must be a non-empty string');
  }
  if (typeof r['totalMs'] !== 'number' || !Number.isFinite(r['totalMs']) || r['totalMs'] <= 0) {
    return err('BAD_REQUEST', 'report.totalMs must be a positive number');
  }
  if (!Array.isArray(r['laps']) || r['laps'].length === 0) {
    return err('BAD_REQUEST', 'report.laps must be a non-empty array');
  }
  for (const lap of r['laps']) {
    if (typeof lap !== 'number' || !Number.isFinite(lap) || lap <= 0) {
      return err('BAD_REQUEST', 'every lap must be a positive number');
    }
  }
  if (typeof r['isBotReport'] !== 'boolean') {
    return err('BAD_REQUEST', 'report.isBotReport must be a boolean');
  }
  return ok({
    userId: r['userId'],
    totalMs: r['totalMs'],
    laps: (r['laps'] as number[]).slice(),
    isBotReport: r['isBotReport'],
  });
}

function race_submit_result_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
): string {
  const parsed = parsePayload<RaceSubmitResultInput>(payload);
  if (parsed === null) return toJson(err('BAD_REQUEST', 'payload is required'));
  if (!parsed.ok) return toJson(parsed);

  // Caller authz:
  //   1. The caller is the session user (D-03); a body callerUserId
  //      must match it. Checked before anything else.
  //   2. For HUMAN reports, the caller must equal report.userId —
  //      clients can't impersonate.
  //   3. For BOT reports, the host is the actual submitter; we defer
  //      the host-check until after the session read because we need
  //      session.host.
  const caller = requireCaller(ctx, parsed.data);
  if (!caller.ok) return toJson(caller.error);
  const callerId = caller.userId;

  const reportV = validateReport(parsed.data.report);
  if (!reportV.ok) return toJson(reportV);
  const report = reportV.data;
  if (!report.isBotReport && callerId !== report.userId) {
    return toJson(err('FORBIDDEN', 'reporterId must match report.userId'));
  }
  // The reporterId recorded in the roster is always the report's userId
  // (which is the bot's roster-slot id for bot reports, or the human's
  // userId for human reports). This is what the storage write targets.
  const reporterId = report.userId;

  const sessionId =
    typeof parsed.data.sessionId === 'string' && parsed.data.sessionId.length > 0
      ? parsed.data.sessionId
      : '';
  if (!sessionId) {
    return toJson(err('BAD_REQUEST', 'sessionId is required'));
  }

  // Idempotency: cache the response keyed by (sessionId, reporterId) for
  // 60s. Retries with the same payload (e.g. transient network error)
  // return the cached outcome without re-appending.
  const idempKey = `${sessionId}:${reporterId}`;
  // NOTE: Nakama 3.27.0 returns "" (empty string) for missing keys, NOT
  // null — verify before treating a hit as a replay.
  const cached = nk.localcacheGet<string>(`submit_result:${idempKey}`);
  if (typeof cached === 'string' && cached.length > 0) {
    logger.info('race_submit_result sid=%s reporter=%s replayed', sessionId, reporterId);
    return cached;
  }

  // Durable retries (plan T-09, X5-a): a submission that carries a
  // requestId is stored with its report, so a retry with the same id
  // replays the accepted outcome at any later time instead of CONFLICT.
  const rawRequestId = parsed.data.requestId;
  if (
    rawRequestId !== undefined &&
    (typeof rawRequestId !== 'string' || rawRequestId.length === 0 || rawRequestId.length > 128)
  ) {
    return toJson(err('BAD_REQUEST', 'requestId must be a string of 1-128 characters'));
  }
  const requestId = rawRequestId;
  if (requestId !== undefined) {
    const stored = readReport(nk, sessionId, reporterId);
    if (stored !== null && stored.requestId === requestId) {
      logger.info('race_submit_result sid=%s reporter=%s replayed requestId', sessionId, reporterId);
      return typeof stored.response === 'string' && stored.response.length > 0
        ? stored.response
        : replayedSubmitResponse(nk, sessionId);
    }
  }

  const rl = checkRateLimit(nk, {
    rpcName: 'race_submit_result',
    userId: callerId,
    ...RATE_LIMITS.race_submit_result,
  });
  if (!rl.allowed) {
    return toJson(err('RATE_LIMITED', undefined, { limit: rl.limit, windowSec: rl.windowSec }));
  }

  const found = readSession(nk, sessionId);
  if (!found) {
    return toJson(err('NOT_FOUND', `no session with id ${sessionId}`));
  }
  const hostedSubmit = rejectIfServerHosted(found.session);
  if (hostedSubmit !== null) return hostedSubmit;
  // A session past its grace closes first (T-06), so a late report meets
  // a closed session and gets CONFLICT from step-1.
  const cur = closeIfDue(nk, logger, found, serverNowMs(), 'race_submit_result').current;
  // Any submit is a sign of life for the host claim (T-07).
  recordContact(nk, logger, cur.session, callerId, serverNowMs());

  // Bot-auth gate (Chunk 8): only the host may submit reports on
  // behalf of bots. Bots are relay-pure so the host is the only auth'd
  // user that can attest their finish time.
  if (report.isBotReport && callerId !== cur.session.host) {
    logger.warn(
      'race_submit_result sid=%s bot report by non-host caller=%s host=%s',
      sessionId,
      callerId,
      cur.session.host,
    );
    return toJson(err('FORBIDDEN', 'only the host may submit bot reports'));
  }

  // Step-1: roster / state / dup
  const v1 = validateSubmissionStep1({ session: cur.session, reporterId });
  if (!v1.ok) return toJson(v1);
  const rosterEntry = cur.session.roster.find((e) => e.userId === reporterId);
  if (!rosterEntry) {
    // Defensive — step-1 should have caught this; treat as INTERNAL.
    return toJson(err('INTERNAL', 'roster entry vanished between step-1 and step-2'));
  }

  // Step-2: clock / min-time / lap-count / lap-sum
  const track = getTrack(cur.session.trackId, nk);
  if (!track) {
    // Should never happen — create validates trackId exists.
    return toJson(err('INTERNAL', `track ${cur.session.trackId} missing from catalog`));
  }
  const v2 = validateSubmissionStep2({
    session: cur.session,
    reporter: rosterEntry,
    report,
    track,
    nowMs: serverNowMs(),
  });
  if (!v2.ok) return toJson(v2);

  // Phase 8 Chunk 6: optional tournamentId stamp. When provided,
  // verify the tournament instance exists + the player has joined +
  // has attempts remaining. Bots never carry a tournament stamp.
  let stampTournamentId: string | undefined;
  if (typeof parsed.data.tournamentId === 'string' && parsed.data.tournamentId.length > 0) {
    if (report.isBotReport) {
      return toJson(err('BAD_REQUEST', 'bots cannot carry a tournamentId'));
    }
    const tid = parsed.data.tournamentId;
    const t = readTournamentInstance(nk, tid);
    if (t === null) {
      return toJson(err('NOT_FOUND', `tournament ${tid} not found`));
    }
    if (t.trackId !== cur.session.trackId) {
      return toJson(err('FORBIDDEN', 'tournament track mismatch', {
        tournamentId: tid, tournamentTrack: t.trackId, raceTrack: cur.session.trackId,
      }));
    }
    const entry = readTournamentEntry(nk, tid, reporterId);
    if (entry === null) {
      return toJson(err('FORBIDDEN', 'caller has not joined the tournament', {
        tournamentId: tid,
      }));
    }
    if (entry.attemptsRemaining <= 0) {
      return toJson(err('FORBIDDEN', 'no tournament attempts remaining', {
        tournamentId: tid, attemptsRemaining: entry.attemptsRemaining,
      }));
    }
    stampTournamentId = tid;
  }

  // Atomically write report + bump roster (CAS on session.version).
  // Throws on version conflict (another concurrent submission); the
  // outer race_submit_result call from the other request will likely
  // be the duplicate one — its idempotency cache will pick up our
  // result via the read-back, OR this request gets CONFLICT.
  let newSessionVersion: string;
  try {
    const r = submitReport(
      nk, cur.session, reporterId, report, cur.version, serverNowMs(),
      stampTournamentId, requestId,
    );
    newSessionVersion = r.version;
  } catch (e) {
    logger.warn(
      'race_submit_result sid=%s reporter=%s CAS conflict: %s',
      sessionId,
      reporterId,
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('CONFLICT', 'concurrent write raced — please retry'));
  }

  // Re-read the post-write session so the close logic sees the
  // up-to-date roster (with this reporter's `reportedAt` set).
  const updated = readSession(nk, sessionId);
  if (!updated) {
    // Vanished between write and re-read — bail out without closing.
    logger.warn('race_submit_result sid=%s disappeared after submit', sessionId);
    return toJson(err('INTERNAL', 'session vanished after submit'));
  }

  logger.info(
    'race_submit_result sid=%s reporter=%s totalMs=%d laps=%d bot=%s',
    sessionId,
    reporterId,
    report.totalMs,
    report.laps.length,
    report.isBotReport ? 'true' : 'false',
  );

  // If every roster entry has now submitted, transition the session to
  // `closed` atomically. The CAS on `version` guards against a second
  // concurrent submit racing us — only the winner closes and pays; the
  // loser leaves the close to the next submit, read or ticker pass.
  let closed: ClosedRace | null = null;
  if (allSubmitted(updated.session.roster)) {
    try {
      closed = closeRace(nk, logger, updated.session, newSessionVersion, serverNowMs(), 'all_reported', 'throw');
    } catch (e) {
      if (!(e instanceof CloseConflictError)) throw e;
      logger.warn(
        'race_submit_result sid=%s close CAS conflict: %s',
        sessionId,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  const closeOutcome = closed?.outcome ?? null;
  const rewardsOut = closed?.rewards;

  const out: RaceSubmitResultOutput = {
    accepted: true,
    confidence: closeOutcome?.confidence ?? 'client',
    ...(closeOutcome !== null && closeOutcome.closed
      ? {
          officialResults: closeOutcome.results,
          flags: {
            needsReview: closeOutcome.needsReview,
            ...(closeOutcome.reviewReason !== undefined
              ? { reviewReason: closeOutcome.reviewReason }
              : {}),
          },
        }
      : {
          flags: { needsReview: false },
        }),
    ...(rewardsOut !== undefined ? { rewards: rewardsOut } : {}),
  };
  const serialized = toJson(ok(out));
  // 60 s is enough to absorb in-flight retries without forcing clients
  // to re-submit long after a transient error.
  nk.localcachePut(`submit_result:${idempKey}`, serialized, 60);
  if (requestId !== undefined) {
    const stored = readReport(nk, sessionId, reporterId);
    if (stored !== null) {
      try {
        saveReportResponse(nk, sessionId, stored, serialized);
      } catch (e) {
        // The replay then rebuilds the response from the session.
        logger.warn(
          'race_submit_result sid=%s reporter=%s response not stored: %s',
          sessionId,
          reporterId,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }
  return serialized;
}

/**
 * Response for a `requestId` retry whose original response was not stored
 * (the RPC failed after the report was written, e.g. on the payout): the
 * report was accepted; the session tells whether the race has closed.
 */
function replayedSubmitResponse(nk: INakama, sessionId: string): string {
  const cur = readSession(nk, sessionId);
  const session = cur?.session;
  if (session === undefined || session.state !== 'closed') {
    const pending: RaceSubmitResultOutput = { accepted: true, confidence: 'client', flags: { needsReview: false } };
    return toJson(ok(pending));
  }
  const out: RaceSubmitResultOutput = {
    accepted: true,
    confidence: session.flags.needsReview ? 'client' : 'quorum',
    officialResults: session.results,
    flags: {
      needsReview: session.flags.needsReview,
      ...(session.flags.reviewReason !== undefined ? { reviewReason: session.flags.reviewReason } : {}),
    },
  };
  return toJson(ok(out));
}

// ─── race_session_quick_bots (Phase 4 Chunk 3) ────────────────────────────────

/**
 * Quick-bots session creator. Builds a `RaceSession` with the caller
 * (and optional pre-paired humans) + AI-synthesized bots to fill the
 * lobby. The session is auto-started in state `'started'` with
 * `startedAt = now` so the client can immediately begin the simulation
 * and submit reports via `race_submit_result`.
 *
 * Decisions enforced:
 *   - D2 (track picker): if `trackId` is omitted, `pickTrack()` excludes
 *     the last 2 tracks per player.
 *   - D3 (bot difficulty): clamp(round(avgHumanRating/400)-1, 0, 4).
 *   - D10 (bot count): `size - humanCount`.
 *
 * Storage uses `mode: 'quick'` (the catalog only knows the four core
 * modes) and adds `flags.botSession = true` so the close path can
 * distinguish bot-fill sessions from real multi-player quick races.
 */
function race_session_quick_bots_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
): string {
  const parsed = parsePayload<RaceSessionQuickBotsInput>(payload);
  if (parsed === null) return toJson(err('BAD_REQUEST', 'payload is required'));
  if (!parsed.ok) return toJson(parsed);
  const input = parsed.data;

  // Caller identity from the session only (D-03).
  const caller = requireCaller(ctx, input);
  if (!caller.ok) return toJson(caller.error);
  const callerId = caller.userId;

  // Maintenance gate (Chunk 9).
  const m = assertNotInMaintenance(logger, nk, callerId);
  if (m !== null) return toJson(m);

  // size validation
  if (input.size !== 2 && input.size !== 4 && input.size !== 6) {
    return toJson(err('BAD_REQUEST', `size must be 2|4|6, got ${String(input.size)}`));
  }

  // The loadout comes from the caller's garage (T-10, audit PC-16); the
  // declared one is only a hint, and the bots reuse the host's class.
  const hostLoadout = resolveServerLoadout(
    nk,
    logger,
    callerId,
    parseDeclaredLoadout(input.hostLoadout),
    'normal',
    'race_session_quick_bots',
  );

  // callerRating defaults
  const callerRating =
    typeof input.callerRating === 'number' && Number.isFinite(input.callerRating)
      ? input.callerRating
      : 1000;
  const callerRttMs =
    typeof input.callerRttMs === 'number' && Number.isFinite(input.callerRttMs)
      ? input.callerRttMs
      : 50;

  // Build the human roster — default to [caller] when omitted.
  const humansInput: RaceSessionQuickBotsHuman[] = (() => {
    if (!Array.isArray(input.humanRoster) || input.humanRoster.length === 0) {
      return [{ userId: callerId, rttMs: callerRttMs, rating: callerRating }];
    }
    // Replace any caller slot with the resolved callerId (the input
    // might have the caller's userId under a different field).
    const roster = input.humanRoster.map((h) => ({
      userId: h.userId,
      ...(h.rttMs !== undefined ? { rttMs: h.rttMs } : {}),
      ...(h.rating !== undefined ? { rating: h.rating } : {}),
    }));
    // Ensure caller is present at least once (defense against a
    // humanRoster that omits the caller themselves).
    if (!roster.some((h) => h.userId === callerId)) {
      roster.unshift({ userId: callerId, rttMs: callerRttMs, rating: callerRating });
    }
    return roster;
  })();

  // Cross-user defense: caller must be the first entry in the human
  // roster (so the host is always the caller — bots can never host).
  if (humansInput[0]?.userId !== callerId) {
    return toJson(
      err('FORBIDDEN', 'caller must be the first entry in humanRoster (host is always the caller)'),
    );
  }
  // No duplicate userIds.
  const seen = new Set<string>();
  for (const h of humansInput) {
    if (typeof h.userId !== 'string' || h.userId.length === 0) {
      return toJson(err('BAD_REQUEST', 'every humanRoster entry needs a non-empty userId'));
    }
    if (seen.has(h.userId)) {
      return toJson(err('BAD_REQUEST', `duplicate userId in humanRoster: ${h.userId}`));
    }
    seen.add(h.userId);
  }

  // Rate limit per caller.
  const rl = checkRateLimit(nk, {
    rpcName: 'race_session_quick_bots',
    userId: callerId,
    ...RATE_LIMITS.race_session_quick_bots,
  });
  if (!rl.allowed) {
    return toJson(err('RATE_LIMITED', undefined, { limit: rl.limit, windowSec: rl.windowSec }));
  }

  // Track resolution — honor an explicit trackId, otherwise run pickTrack.
  const allTracks = getTracks(nk);
  const allowedTrackIds = allTracks
    .filter((t) => {
      const tAny = t as { modes?: Record<string, number | undefined> };
      const laps = tAny.modes?.['quick'];
      return typeof laps === 'number' && laps > 0;
    })
    .map((t) => (t as { id: string }).id);

  let trackId: string;
  if (typeof input.trackId === 'string' && input.trackId.length > 0) {
    if (!getTrack(input.trackId, nk)) {
      return toJson(err('NOT_FOUND', `unknown trackId: ${input.trackId}`));
    }
    trackId = input.trackId;
  } else {
    const exclude = Array.isArray(input.excludeTrackIds)
      ? input.excludeTrackIds.filter((x): x is string => typeof x === 'string')
      : [];
    const matchId = typeof input.matchId === 'string' && input.matchId.length > 0
      ? input.matchId
      : nk.uuidv4();
    trackId = pickTrack(allowedTrackIds, exclude, matchId);
    if (trackId === '') {
      return toJson(err('INTERNAL', 'track catalog is empty'));
    }
  }

  // Build roster.
  let built;
  try {
    built = buildBotRoster({
      size: input.size,
      humans: humansInput,
      hostLoadout,
    });
  } catch (e) {
    return toJson(
      err('BAD_REQUEST', e instanceof Error ? e.message : String(e)),
    );
  }

  // Re-derive difficulty from the final average so it matches the
  // helper's output exactly (single source of truth).
  const avg = averageRating(humansInput);
  const botDifficulty = pickBotDifficulty(avg);

  // Persist the session. Storage uses mode:'quick' (catalog-known) and
  // flags.botSession=true to mark the bot-fill variant. The RPC output
  // returns mode:'quick_bots' for the client to display.
  const sessionId = nk.uuidv4();
  const startedAt = serverNowMs();
  const session: RaceSession = {
    schemaVersion: 1,
    id: sessionId,
    matchId: typeof input.matchId === 'string' && input.matchId.length > 0
      ? input.matchId
      : sessionId,
    mode: 'quick',
    trackId,
    size: input.size,
    roster: built.roster,
    host: built.host,
    hostSuccession: built.hostSuccession,
    state: 'started',
    createdAt: startedAt,
    startedAt,
    results: [],
    flags: { needsReview: false, botSession: true },
    version: 1,
  };

  try {
    createSession(
      nk,
      session,
      built.roster.filter((e) => !e.isBot).map((e) => e.userId),
      startedAt,
    );
  } catch (e) {
    logger.error(
      'race_session_quick_bots sid=%s storage error: %s',
      sessionId,
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to persist session'));
  }

  // Build the response roster (mirrors the storage shape + rtt for
  // each entry). Bots get a synthetic rtt + their difficulty.
  const responseRoster: RaceSessionQuickBotsRosterEntry[] = built.roster.map((entry, i) => {
    if (entry.isBot) {
      const slotIdx = i - humansInput.length;
      return {
        userId: entry.userId,
        isBot: true,
        rttMs: 50 + botDifficulty * 10 + slotIdx * 5,
        botDifficulty,
        loadout: entry.loadout,
      };
    }
    // Human — use the rtt we passed in (or default 50).
    const humanInput = humansInput.find((h) => h.userId === entry.userId);
    return {
      userId: entry.userId,
      isBot: false,
      rttMs: humanInput?.rttMs ?? 50,
      loadout: entry.loadout,
    };
  });

  const out: RaceSessionQuickBotsOutput = {
    sessionId,
    mode: 'quick_bots',
    trackId,
    size: input.size,
    host: built.host,
    startedAt,
    roster: responseRoster,
    botDifficulty,
    botCount: built.botCount,
  };

  logger.info(
    'race_session_quick_bots sid=%s caller=%s size=%d humans=%d bots=%d difficulty=%d track=%s',
    sessionId,
    callerId,
    input.size,
    humansInput.length,
    built.botCount,
    botDifficulty,
    trackId,
  );

  // The matchmaker hook fired `matchmaker_matched` with
  // `ratingSpread: null` because the per-human rating isn't on the
  // envelope. Here we have the full humansInput — emit a follow-up so
  // dashboards can correlate matchmaker activity with the eventual
  // session characteristics.
  const rated = humansInput
    .map((h) => h.rating)
    .filter((r): r is number => typeof r === 'number');
  const ratingSpread =
    rated.length >= 2 ? Math.max(...rated) - Math.min(...rated) : rated.length === 1 ? 0 : null;
  emit(nk, logger, 'matchmaker_matched', {
    sessionId,
    humanCount: humansInput.length,
    botCount: built.botCount,
    ticketCount: humansInput.length,
    ratingSpread,
  });

  return toJson(ok(out));
}

// ─── race_host_claim (Phase 4 Chunk 4) ─────────────────────────────────────────

/**
 * Host-claim RPC. Called by a player in `hostSuccession[1]` (or
 * later) when the current host has disconnected. Validates:
 *   - session exists and is in state 'started'
 *   - caller is in the roster (FORBIDDEN otherwise)
 *   - the current host is gone: no contact for `HOST_STALE_MS` (plan
 *     T-07, audit PC-07); otherwise FORBIDDEN with
 *     `details.reason = 'NOT_HOST'`
 *   - caller is the first live entry after the current host in
 *     `hostSuccession`
 *
 * On success: CAS-writes the new `host`, stamps `claimedAt = nowMs`,
 * and returns the new state. Idempotent: re-claims by the same caller
 * return the existing `claimedAt` unchanged.
 *
 * Decision D5 (per plan): the RPC rejects with CONFLICT only when
 * ANOTHER caller has claimed the host between two consecutive
 * attempts. Replays by the same caller are NOT conflicts.
 */
function race_host_claim_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
): string {
  const parsed = parsePayload<RaceHostClaimInput>(payload);
  if (parsed === null) return toJson(err('BAD_REQUEST', 'payload is required'));
  if (!parsed.ok) return toJson(parsed);
  const input = parsed.data;

  // Caller identity from the session only (D-03).
  const caller = requireCaller(ctx, input);
  if (!caller.ok) return toJson(caller.error);
  const callerId = caller.userId;

  // Maintenance gate (Chunk 9).
  const m = assertNotInMaintenance(logger, nk, callerId);
  if (m !== null) return toJson(m);

  const sessionId =
    typeof input.sessionId === 'string' && input.sessionId.length > 0
      ? input.sessionId
      : '';
  if (!sessionId) {
    return toJson(err('BAD_REQUEST', 'sessionId is required'));
  }

  const rl = checkRateLimit(nk, {
    rpcName: 'race_host_claim',
    userId: callerId,
    ...RATE_LIMITS.race_host_claim,
  });
  if (!rl.allowed) {
    return toJson(err('RATE_LIMITED', undefined, { limit: rl.limit, windowSec: rl.windowSec }));
  }

  const cur = readSession(nk, sessionId);
  if (!cur) {
    return toJson(err('NOT_FOUND', `no session with id ${sessionId}`));
  }

  const hostedClaim = rejectIfServerHosted(cur.session);
  if (hostedClaim !== null) return hostedClaim;
  // The claimant is alive; the host is judged by its last contact (T-07).
  const nowMs = serverNowMs();
  recordContact(nk, logger, cur.session, callerId, nowMs);
  const lastSeenMs = readPresence(nk, cur.session);
  const v = validateHostClaim({ session: cur.session, callerUserId: callerId, nowMs, lastSeenMs });
  if (!v.ok) {
    return toJson(err(v.code, v.reason, v.details));
  }

  // Idempotent re-claim — no storage write needed.
  if (v.idempotent) {
    logger.info(
      'race_host_claim sid=%s caller=%s idempotent (already host) claimedAt=%d',
      sessionId,
      callerId,
      v.claimedAt,
    );
    const out: RaceHostClaimOutput = {
      sessionId,
      newHost: callerId,
      claimedAt: v.claimedAt,
      ...(cur.session.startedAt !== null ? { startedAt: cur.session.startedAt } : {}),
      rosterVersion: cur.session.version,
    };
    return toJson(ok(out));
  }

  // Fresh claim — CAS write.
  let newVersion: string;
  let newClaimedAt: number;
  try {
    const r = claimHostRepo(nk, cur.session, callerId, cur.version, v.claimedAt);
    newVersion = r.version;
    newClaimedAt = r.claimedAt;
  } catch (e) {
    logger.warn(
      'race_host_claim sid=%s caller=%s CAS conflict: %s',
      sessionId,
      callerId,
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('CONFLICT', 'concurrent host-claim raced — please retry'));
  }

  logger.info(
    'race_host_claim sid=%s newHost=%s (was %s) claimedAt=%d',
    sessionId,
    callerId,
    cur.session.host,
    newClaimedAt,
  );

  emit(nk, logger, 'host_claimed', {
    sessionId,
    newHost: callerId,
    oldHost: cur.session.host,
    withinGrace: true,
  });

  const out: RaceHostClaimOutput = {
    sessionId,
    newHost: callerId,
    claimedAt: newClaimedAt,
    ...(cur.session.startedAt !== null ? { startedAt: cur.session.startedAt } : {}),
    rosterVersion: parseInt(newVersion.replace(/^v/, ''), 10) || cur.session.version + 1,
  };
  return toJson(ok(out));
}

// ─── Top-level exports ────────────────────────────────────────────────────────

// goja resolver first looks the RPC fn up by NAME on the global object after
// InitModule runs. We export each RPC as a top-level const so the AST
// scanner sees it as a top-level binding. The names below MUST match the
// strings passed to `initializer.registerRpc(...)` in main.ts. `withRuntime`
// loads the serving VM's catalogs and race bus first (plan T-29, audit N8).

export const config_get: RpcHandler = withRuntime(config_get_impl);
export const race_session_create: RpcHandler = withRuntime(race_session_create_impl);
export const race_session_join: RpcHandler = withRuntime(race_session_join_impl);
export const race_session_start: RpcHandler = withRuntime(race_session_start_impl);
export const race_session_get: RpcHandler = withRuntime(race_session_get_impl);
// Chunk 7 lands step-1 + idempotency. Step-2 (clock / min / lap-sum)
// and the bot-auth gate land in Chunk 8.
export const race_submit_result: RpcHandler = withRuntime(race_submit_result_impl);
// Phase 4 Chunk 3 — quick-mode bot fill.
export const race_session_quick_bots: RpcHandler = withRuntime(race_session_quick_bots_impl);
// Phase 4 Chunk 4 — host claim on disconnect.
export const race_host_claim: RpcHandler = withRuntime(race_host_claim_impl);

/**
 * Stable name → handler map for tests. The keys here MUST match the
 * global function names above.
 */
export const raceRpcs: Readonly<Record<string, RpcHandler>> = Object.freeze({
  config_get,
  race_session_create,
  race_session_join,
  race_session_start,
  race_session_get,
  race_submit_result,
  race_session_quick_bots,
  race_host_claim,
});

export const RACE_RPC_KEYS: readonly string[] = Object.freeze(Object.keys(raceRpcs));