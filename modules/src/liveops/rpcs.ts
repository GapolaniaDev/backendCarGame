// Phase 5 Chunk 2 — `liveops_config_get` RPC.
//
// Authenticated players call this on startup to fetch:
//   - the current `flags` (so the client can show a maintenance splash)
//   - the per-platform `minClientVersion` (so the client can prompt for
//     an update before issuing any other RPC)
//   - the `regions` list (so the client can pick a relay)
//   - the upcoming `calendar` (for the events screen)
//   - a `configHash` (sha256 of the canonical config minus the hash
//     itself) so the client can skip a re-render when nothing changed.
//
// Auth required (callerUserId) so we can attribute polls and rate-limit
// spam. NOT gated by maintenance — players need to read this while the
// server is in maintenance to display the splash.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { loadLiveopsConfig, type LiveopsConfig } from './config';
import type { ClientPlatform, LiveopsRegion, LiveopsCalendarEntry } from './types';

export interface LiveopsConfigGetInput {
  /** Required when called via HTTP gateway; the socket path reads it from ctx.userId. */
  callerUserId: string;
}

export interface LiveopsConfigGetOutput {
  /** Version of the liveops payload — bumped when an admin publishes an override. */
  version: number;
  flags: LiveopsConfig['flags'];
  minClientVersion: Record<ClientPlatform, string>;
  regions: ReadonlyArray<LiveopsRegion>;
  calendar: ReadonlyArray<LiveopsCalendarEntry>;
  /** sha256 hex of JSON.stringify(payload-without-configHash). */
  configHash: string;
}

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

export const liveops_config_get_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
  if (!callerId.ok) return callerId.error;

  const cfg = loadLiveopsConfig(nk, logger);

  // Strip the hash field (if present) before stringifying — the hash
  // can't include itself.
  const hashSource = stripHash({
    version: cfg.version,
    flags: cfg.flags,
    minClientVersion: cfg.minClientVersion,
    regions: cfg.regions,
    calendar: cfg.calendar,
  });
  const configHash = nk.sha256Hash(JSON.stringify(hashSource));

  logger.info(
    'liveops_config_get caller=%s version=%d hash=%s',
    callerId.id,
    cfg.version,
    configHash,
  );

  return toJson(
    ok({
      version: cfg.version,
      flags: {
        maintenance: cfg.flags.maintenance,
        ...(cfg.flags.maintenanceMessage !== undefined
          ? { maintenanceMessage: cfg.flags.maintenanceMessage }
          : {}),
        // maintenanceExemptUserIds is server-only — don't leak to clients.
      },
      minClientVersion: { ...cfg.minClientVersion },
      regions: cfg.regions.map((r) => ({ ...r })),
      calendar: cfg.calendar.map((c) => ({ ...c })),
      configHash,
    }),
  );
};

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ParseOk<T> {
  ok: true;
  value: T;
}
interface ParseErr {
  ok: false;
  error: string;
}
function parseInput(body: string): ParseOk<LiveopsConfigGetInput> | ParseErr {
  const t = body.trim();
  let raw: unknown = {};
  if (t.length > 0) {
    try {
      raw = JSON.parse(t);
    } catch {
      return { ok: false, error: toJson(err('BAD_REQUEST', 'payload is not valid JSON')) };
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: toJson(err('BAD_REQUEST', 'payload must be an object')) };
  }
  const obj = raw as Record<string, unknown>;
  const out: LiveopsConfigGetInput = {
    callerUserId: typeof obj['callerUserId'] === 'string' ? (obj['callerUserId'] as string) : '',
  };
  return { ok: true, value: out };
}

interface CallerOk {
  ok: true;
  id: string;
}
interface CallerErr {
  ok: false;
  error: string;
}
function resolveCaller(
  ctx: IContext,
  declared: string,
  logger: ILogger,
): CallerOk | CallerErr {
  const socketCaller = ctx.userId ?? null;
  const declaredCaller = declared.length > 0 ? declared : null;
  if (socketCaller !== null) {
    if (declaredCaller !== null && declaredCaller !== socketCaller) {
      return {
        ok: false,
        error: toJson(err('FORBIDDEN', 'callerUserId does not match authenticated user')),
      };
    }
    return { ok: true, id: socketCaller };
  }
  if (declaredCaller !== null) return { ok: true, id: declaredCaller };
  logger.warn('liveops_config_get RPC called with no caller identity');
  return { ok: false, error: toJson(err('UNAUTHENTICATED', 'no caller identity')) };
}

function stripHash<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  // Remove the `configHash` key if present (defensive — currently we never
  // include it in the source, but this keeps the function robust against a
  // future payload that does).
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'configHash') continue;
    out[k] = v;
  }
  return out;
}

function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

// Top-level binding for the goja AST scanner.
export const liveops_config_get: RpcHandler = liveops_config_get_impl;