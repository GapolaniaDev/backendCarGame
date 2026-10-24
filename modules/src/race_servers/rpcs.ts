// Server-to-server RPCs of the dedicated race servers (D-01, D-02).
//
//   rs_heartbeat   server-to-server, `http_key` + `serverKey`: the server
//     registers itself or refreshes its row every few seconds. If it
//     declares no active session and the registry still holds one that is
//     closed (or gone), the row is freed. The reply carries the pending
//     assignment (T-05, D-04): the `created` session of this server, that
//     the matchmaker reserved for it.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok } from '../core/response';
import { parseInput } from '../core/parse_input';
import { serverNowMs } from '../core/time';
import { withRuntime } from '../core/runtime_state';
import { readSession } from '../race/session_repo';
import type { RaceSession } from '../race/types';
import { requireRaceServer } from './auth';
import { readServer, writeServer } from './registry_repo';
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
function pendingAssignment(serverId: string, session: RaceSession | null): RaceServerAssignment | null {
  if (session === null || session.state !== 'created') return null;
  if (session.serverHosted !== true || session.server?.serverId !== serverId) return null;
  return {
    sessionId: session.id,
    mode: session.mode,
    trackId: session.trackId,
    laps: session.laps ?? 0,
    expectedUserIds: session.roster.filter((e) => !e.isBot).map((e) => e.userId),
    joinDeadlineMs: (session.createdAt ?? 0) + JOIN_WINDOW_MS,
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
    const out: RsHeartbeatOutput = { assignment: pendingAssignment(auth.serverId, held?.session ?? null) };
    return JSON.stringify(ok(out));
  }
  return JSON.stringify(err('CONFLICT', 'concurrent update; please retry', { reason: 'VERSION_CONFLICT' }));
};

export const rs_heartbeat: RpcHandler = withRuntime(rs_heartbeat_impl);
