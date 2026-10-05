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
  getCatalogsHash,
  getModes,
  getTrack,
  getTracks,
} from '../core/catalog';
import { serverNowMs } from '../core/time';
import type { EventBus } from '../core/event_bus';
import type { IContext, ILogger, INakama } from '../nkruntime';
import { SYSTEM_USER_ID, RATE_LIMITS } from './constants';
import { canTransition } from './state';
import {
  allSubmitted,
  appendRosterEntry,
  createSession,
  lookupLastClosed,
  markStarted,
  readSession,
  submitReport,
  tryCloseAndPublish,
} from './session_repo';
import { validateSubmissionStep1, validateSubmissionStep2 } from './validation';
import type {
  ConfigGetOutput,
  CarClassId,
  Loadout,
  RaceCompletedEvent,
  RaceReport,
  RaceSession,
  RaceSessionCreateInput,
  RaceSessionCreateOutput,
  RaceSessionJoinInput,
  RaceSessionJoinOutput,
  RaceSessionStartInput,
  RaceSessionStartOutput,
  RaceSessionGetInput,
  RaceSessionGetOutput,
  RaceSubmitResultInput,
  RaceSubmitResultOutput,
  RaceSubmitResultRewardEntry,
} from './types';
import {
  handleRaceCompletedForEconomy,
  type RaceCompletedRewardSummary,
} from '../economy/subscriber';
import {
  handleRaceCompletedForProgression,
  type RaceCompletedProgressionSummary,
} from '../progression/subscriber';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
) => string;

// ─── Event bus wiring ─────────────────────────────────────────────────────────

/**
 * Module-level reference to the EventBus, set by `main.ts` after
 * InitModule constructs it. The race handlers read this on every
 * submit so tests don't need to plumb the bus through the RPC
 * signature. Defaults to `null` — submit handlers skip publishing
 * when no bus is installed (unit/e2e tests that don't exercise close).
 */
let raceBus: EventBus | null = null;

/** Called once by `InitModule` after the EventBus is constructed. */
export function setRaceBus(bus: EventBus): void {
  raceBus = bus;
}

/** Test/diagnostic accessor. */
export function getRaceBus(): EventBus | null {
  return raceBus;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Returns the catalogs (read-only data the client needs at boot) plus the
 * server's wall clock and a content hash so the client can short-circuit
 * a full re-download when nothing changed.
 *
 * The handler is intentionally cheap: it does no I/O beyond an in-memory
 * hash lookup and a Date.now() call. No rate limit either — clients may
 * call it as often as they like (configurable in env `RATE_LIMITS`).
 */
function config_get_impl(
  _ctx: IContext,
  logger: ILogger,
  _nk: INakama,
  _payload: string,
): string {
  const data: ConfigGetOutput = {
    serverTimeMs: serverNowMs(),
    catalogsHash: getCatalogsHash(_nk),
    tracks: getTracks(_nk),
    modes: getModes(_nk),
    minClientVersion: '1.0.0',
  };
  logger.debug('config_get served hash=%s', data.catalogsHash.slice(0, 12));
  return toJson(ok(data));
}

// ─── race_session_create ─────────────────────────────────────────────────────

function validateCreateInput(raw: unknown, nk: INakama): Resp<RaceSessionCreateInput> {
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
  const hostLoadout = obj['hostLoadout'] as Record<string, unknown> | undefined;
  if (!hostLoadout || typeof hostLoadout !== 'object') {
    return err('BAD_REQUEST', 'hostLoadout must be an object');
  }
  const classId = hostLoadout['classId'];
  if (
    classId !== 'D' && classId !== 'C' && classId !== 'B' && classId !== 'A' && classId !== 'S'
  ) {
    return err('BAD_REQUEST', 'hostLoadout.classId must be D|C|B|A|S');
  }
  const bodyId = hostLoadout['bodyId'];
  if (typeof bodyId !== 'string' || bodyId.length === 0) {
    return err('BAD_REQUEST', 'hostLoadout.bodyId must be a non-empty string');
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
    hostLoadout: {
      classId: classId as RaceSessionCreateInput['hostLoadout']['classId'],
      bodyId,
      ...(typeof hostLoadout['liveryId'] === 'string'
        ? { liveryId: hostLoadout['liveryId'] }
        : {}),
    },
    hostUserId: typeof obj['hostUserId'] === 'string' ? obj['hostUserId'] : '',
  });
}

function race_session_create_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
): string {
  // Parse the JSON body once. We need it both for `hostUserId` (when ctx
  // doesn't carry userId) and for the rest of the input validation.
  const parsed = parsePayload<RaceSessionCreateInput>(payload);
  if (parsed === null) {
    return toJson(err('BAD_REQUEST', 'payload is required'));
  }
  if (!parsed.ok) return toJson(parsed);

  // Resolve hostId:
  //   1. ctx.userId when set (authenticated socket call — trusted)
  //   2. otherwise payload.hostUserId (HTTP gateway / scripts)
  // The HTTP gateway in v3.27.0 always leaves `ctx.userId` null even
  // when the client sent a Bearer session token, so we fall back to
  // the explicit field. Authenticity is enforced via the rate limit being
  // scoped to whatever was claimed.
  let hostId: string;
  if (ctx.userId) {
    hostId = ctx.userId;
  } else {
    const candidate = parsed.data.hostUserId;
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return toJson(
        err(
          'BAD_REQUEST',
          'hostUserId is required when ctx.userId is null (HTTP gateway call)',
        ),
      );
    }
    hostId = candidate;
  }

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
        loadout: input.hostLoadout,
        isBot: false,
      },
    ],
    host: hostId,
    hostSuccession: [hostId],
    state: 'created',
    startedAt: null,
    results: [],
    flags: { needsReview: false },
    version: 1,
  };

  try {
    createSession(nk, session);
  } catch (e) {
    logger.error(
      'race_session_create storage error: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to persist session'));
  }

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
  let callerId: string;
  let sessionId: string | undefined;
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
      const callerField = parsed.data.callerUserId;
      if (typeof callerField !== 'string' || callerField.length === 0) {
        return toJson(
          err(
            'BAD_REQUEST',
            'callerUserId is required when ctx.userId is null (HTTP gateway call)',
          ),
        );
      }
      callerId = callerField;
    } else {
      callerId = ctx.userId ?? SYSTEM_USER_ID;
    }
  } else {
    callerId = ctx.userId ?? SYSTEM_USER_ID;
  }

  // Override with ctx.userId if set (authenticated socket — trusted).
  if (ctx.userId) callerId = ctx.userId;

  const rl = checkRateLimit(nk, {
    rpcName: 'race_session_get',
    userId: callerId,
    ...RATE_LIMITS.race_session_get,
  });
  if (!rl.allowed) {
    return toJson(err('RATE_LIMITED', undefined, { limit: rl.limit, windowSec: rl.windowSec }));
  }

  // No sessionId → look up the caller's lastClosed index. Chunk 9 will
  // populate this index on session close. Until then, the lookup
  // returns null and we surface NOT_FOUND.
  if (!sessionId) {
    const last = lookupLastClosed(nk, callerId);
    if (!last) {
      return toJson(
        err('NOT_FOUND', 'no lastClosed index for caller (live-session lookup not yet implemented)'),
      );
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
    return toJson(ok(out));
  }

  const result = readSession(nk, sessionId);
  if (!result) {
    return toJson(err('NOT_FOUND', `no session with id ${sessionId}`));
  }

  // Caller must be in the roster.
  const inRoster = result.session.roster.some((e) => e.userId === callerId);
  if (!inRoster) {
    logger.warn(
      'race_session_get sid=%s callerId=%s not in roster — denying',
      sessionId,
      callerId,
    );
    return toJson(err('NOT_FOUND', `no session with id ${sessionId}`));
  }

  logger.debug('race_session_get sid=%s caller=%s', sessionId, callerId);
  const out: RaceSessionGetOutput = { session: result.session };
  return toJson(ok(out));
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

  // Resolve the joiner (the player being added to the roster).
  //   - ctx.userId (socket) wins over payload.userId
  //   - HTTP gateway falls back to payload.userId
  let joinerId: string;
  if (ctx.userId) {
    joinerId = ctx.userId;
  } else {
    if (typeof parsed.data.userId !== 'string' || parsed.data.userId.length === 0) {
      return toJson(
        err('BAD_REQUEST', 'userId is required when ctx.userId is null (HTTP gateway call)'),
      );
    }
    joinerId = parsed.data.userId;
  }

  // Caller authz: the RPC caller must be the joiner themselves (or
  // the system for admin tooling). Defense against a malicious client
  // joining on behalf of another player via HTTP.
  if (typeof parsed.data.callerUserId !== 'string' || parsed.data.callerUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'callerUserId is required'));
  }
  const declaredCaller = parsed.data.callerUserId;
  if (ctx.userId && declaredCaller !== ctx.userId) {
    return toJson(err('FORBIDDEN', 'callerUserId does not match ctx.userId'));
  }
  if (!ctx.userId && declaredCaller !== joinerId) {
    return toJson(err('FORBIDDEN', 'callerUserId must match userId'));
  }

  const loadoutV = validateLoadout(parsed.data.loadout);
  if (!loadoutV.ok) return toJson(loadoutV);
  const loadout = loadoutV.data;

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

  try {
    appendRosterEntry(
      nk,
      cur.session,
      { userId: joinerId, loadout, isBot: false },
      cur.version,
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

  let callerId: string;
  if (ctx.userId) {
    callerId = ctx.userId;
  } else {
    if (
      typeof parsed.data.callerUserId !== 'string' ||
      parsed.data.callerUserId.length === 0
    ) {
      return toJson(
        err('BAD_REQUEST', 'callerUserId is required when ctx.userId is null (HTTP gateway call)'),
      );
    }
    callerId = parsed.data.callerUserId;
  }

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

  const reportV = validateReport(parsed.data.report);
  if (!reportV.ok) return toJson(reportV);
  const report = reportV.data;

  // Caller authz:
  //   1. Socket ctx.userId (when set) MUST equal declaredCaller
  //   2. For HUMAN reports, caller (ctx.userId ?? declaredCaller) must
  //      equal report.userId — clients can't impersonate.
  //   3. For BOT reports, the host is the actual submitter; we defer
  //      the host-check until after the session read because we need
  //      session.host.
  if (typeof parsed.data.callerUserId !== 'string' || parsed.data.callerUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'callerUserId is required'));
  }
  const declaredCaller = parsed.data.callerUserId;
  const callerId = ctx.userId ?? declaredCaller;
  if (ctx.userId && declaredCaller !== ctx.userId) {
    return toJson(err('FORBIDDEN', 'callerUserId does not match ctx.userId'));
  }
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

  const rl = checkRateLimit(nk, {
    rpcName: 'race_submit_result',
    userId: callerId,
    ...RATE_LIMITS.race_submit_result,
  });
  if (!rl.allowed) {
    return toJson(err('RATE_LIMITED', undefined, { limit: rl.limit, windowSec: rl.windowSec }));
  }

  const cur = readSession(nk, sessionId);
  if (!cur) {
    return toJson(err('NOT_FOUND', `no session with id ${sessionId}`));
  }

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

  // Atomically write report + bump roster (CAS on session.version).
  // Throws on version conflict (another concurrent submission); the
  // outer race_submit_result call from the other request will likely
  // be the duplicate one — its idempotency cache will pick up our
  // result via the read-back, OR this request gets CONFLICT.
  let newSessionVersion: string;
  try {
    const r = submitReport(nk, cur.session, reporterId, report, cur.version, serverNowMs());
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
  // concurrent submit racing us — only the winner closes, the loser
  // sees `closed: false` from the idempotency check below on retry.
  let closeOutcome: ReturnType<typeof tryCloseAndPublish> | null = null;
  let closedEvent: RaceCompletedEvent | null = null;
  if (allSubmitted(updated.session.roster)) {
    if (raceBus === null) {
      logger.warn(
        'race_submit_result sid=%s: all submitted but no EventBus installed — skipping close',
        sessionId,
      );
    } else {
      try {
        closeOutcome = tryCloseAndPublish(
          nk,
          raceBus,
          updated.session,
          newSessionVersion,
          serverNowMs(),
        );
        logger.info(
          'race_submit_result sid=%s closed confidence=%s needsReview=%s',
          sessionId,
          closeOutcome.confidence,
          String(closeOutcome.needsReview),
        );
        // Synthesize the closed event so the RPC can synchronously
        // compute the per-player reward summary (Decision 6) without
        // waiting on the async subscribers. The async subscribers
        // (economy, progression) also run; their grant() / XP updates
        // are idempotent via the wallet helper's localcache keys.
        closedEvent = {
          schemaVersion: 1,
          sessionId,
          mode: updated.session.mode,
          trackId: updated.session.trackId,
          size: updated.session.size,
          results: closeOutcome.results,
          flags: {
            needsReview: closeOutcome.needsReview,
            ...(closeOutcome.reviewReason !== undefined
              ? { reviewReason: closeOutcome.reviewReason }
              : {}),
          },
          closedAt: serverNowMs(),
        };
      } catch (e) {
        logger.warn(
          'race_submit_result sid=%s close CAS conflict: %s',
          sessionId,
          e instanceof Error ? e.message : String(e),
        );
        // Not fatal — the next submit (or the next-chance goroutine)
        // will retry the close.
      }
    }
  }

  // Phase 3 (Decision 6): compute per-player rewards synchronously so
  // the RPC client sees them in the response without waiting on the
  // async event subscribers. The subscribers still run for redundancy
  // and for sessions closed by other paths (admin, force-close).
  let rewardsOut: Record<string, RaceSubmitResultRewardEntry> | undefined = undefined;
  if (closedEvent !== null) {
    const econSummary: RaceCompletedRewardSummary = handleRaceCompletedForEconomy(
      { logger, nk, bus: raceBus ?? dummyBus },
      closedEvent,
    );
    const progSummary: RaceCompletedProgressionSummary = handleRaceCompletedForProgression(
      { logger, nk, bus: raceBus ?? dummyBus },
      closedEvent,
    );
    rewardsOut = mergeRewardSummaries(econSummary, progSummary);
  }

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
  return serialized;
}

// ─── Reward merging (Phase 3, Decision 6) ────────────────────────────────────

const dummyBus: EventBus = {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  subscribe: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  publish: async () => {},
  subscriberCount: () => 0,
} as unknown as EventBus;

function mergeRewardSummaries(
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

// ─── Top-level exports ────────────────────────────────────────────────────────

// goja resolver first looks the RPC fn up by NAME on the global object after
// InitModule runs. We export each RPC as a top-level const so the AST
// scanner sees it as a top-level binding. The names below MUST match the
// strings passed to `initializer.registerRpc(...)` in main.ts.

export const config_get: RpcHandler = config_get_impl;
export const race_session_create: RpcHandler = race_session_create_impl;
export const race_session_join: RpcHandler = race_session_join_impl;
export const race_session_start: RpcHandler = race_session_start_impl;
export const race_session_get: RpcHandler = race_session_get_impl;
// Chunk 7 lands step-1 + idempotency. Step-2 (clock / min / lap-sum)
// and the bot-auth gate land in Chunk 8.
export const race_submit_result: RpcHandler = race_submit_result_impl;

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
});

export const RACE_RPC_KEYS: readonly string[] = Object.freeze(Object.keys(raceRpcs));