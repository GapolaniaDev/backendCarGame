// Race RPC handlers (Phase 1 — Chunk 5).
//
// Three handlers are real in this chunk:
//   - config_get            (catalogs + serverTimeMs)
//   - race_session_create   (creates a fresh RaceSession)
//   - race_session_get      (reads a session by id or the caller's live one)
//
// The other three are still stubs and land in Chunks 6-9:
//   - race_session_join     (Chunk 6)
//   - race_session_start    (Chunk 6)
//   - race_submit_result    (Chunks 7-9)
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
import type { IContext, ILogger, INakama } from '../nkruntime';
import { SYSTEM_USER_ID, RATE_LIMITS } from './constants';
import { createSession, readSession } from './session_repo';
import type {
  ConfigGetOutput,
  RaceSession,
  RaceSessionCreateInput,
  RaceSessionCreateOutput,
  RaceSessionGetInput,
  RaceSessionGetOutput,
} from './types';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
) => string;

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

/** Stub handler used for handlers not implemented in this chunk. */
function makeStub(name: string): RpcHandler {
  return (_ctx, logger, _nk, payload): string => {
    logger.info('rpc %s (stub) called payload=%s', name, payload);
    return toJson(err('INTERNAL', `TODO: ${name} not implemented yet`));
  };
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

  if (!sessionId) {
    return toJson(
      err('NOT_FOUND', 'sessionId is required (no live-session lookup in Phase 1)'),
    );
  }

  const result = readSession(nk, sessionId);
  if (!result) {
    return toJson(err('NOT_FOUND', `no session with id ${sessionId}`));
  }

  // Caller must be in the roster. SYSTEM_USER_ID is allowed only when
  // the caller is a server-side admin tool that doesn't have a userId —
  // and the host should NEVER be SYSTEM_USER_ID for a legitimate
  // create-session flow.
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

// ─── Top-level exports ────────────────────────────────────────────────────────

// goja resolver first looks the RPC fn up by NAME on the global object after
// InitModule runs. We export each RPC as a top-level const so the AST
// scanner sees it as a top-level binding. The names below MUST match the
// strings passed to `initializer.registerRpc(...)` in main.ts.

export const config_get: RpcHandler = config_get_impl;
export const race_session_create: RpcHandler = race_session_create_impl;
export const race_session_get: RpcHandler = race_session_get_impl;
// Stubs for handlers that arrive in 6/8/9:
export const race_session_join: RpcHandler = makeStub('race_session_join');
export const race_session_start: RpcHandler = makeStub('race_session_start');
export const race_submit_result: RpcHandler = makeStub('race_submit_result');

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