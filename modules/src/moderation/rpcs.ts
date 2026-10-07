// Phase 7 Chunk 7 — Moderation RPCs.
//
// report_player        (player-facing)         — file a report against a target user.
//                                            Self-report FORBIDDEN. 5/hour per reporter.
//                                            Auto-silences target on the 3rd distinct
//                                            reporter inside 24h.
// admin_view_reports   (admin RPC)            — paginated list, newest first.
// admin_silence        (admin RPC)            — manual silence with explicit duration.
// admin_unsilence      (admin RPC)            — clear silenced row.
//
// Admin RPCs are shared-secret gated by `assertAdminKey` and NOT
// maintenance-gated (admin ops continue during a maintenance pause).
// `report_player` is maintenance-gated (player surface).
//
// Pattern matches `admin/rpcs.ts`: each handler exports both
// `<name>_impl: RpcHandler` (testable directly with a hand-crafted
// ctx) and a bare `export const <name>: RpcHandler = <name>_impl` for
// the goja AST scanner (`initializer.registerRpc('report_*', fn)`).

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, toJson, type Resp } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { checkRateLimit } from '../core/rate_limit';
import { parseInput } from '../core/parse_input';
import { assertNotInMaintenance } from '../core/liveops';
import { assertAdminKey, withoutAdminKey } from '../admin/auth';
import { emit, emitAdminAction } from '../core/admin/analytics';
import {
  asReportWrite,
  isReportReason,
  isReportStatus,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORTS_COLLECTION,
  type ReportCard,
  type ReportContext,
  type ReportReason,
  type ReportRecord,
  type ReportStatus,
} from './types';
import { checkReportsRateLimit } from './reports_repo';
import { addReportAndCheckSilence } from './auto_silence';
import { silenceUser, writeSilencedUpdate } from '../chat/silenced';
import { readSilenced } from '../chat/silenced';

const ERR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
  'RATE_LIMITED', 'INVALID_RESULT', 'INTERNAL', 'CATALOG_INVALID',
  'INSUFFICIENT_FUNDS', 'SERVICE_UNAVAILABLE', 'UPGRADE_REQUIRED',
  'NOT_IMPLEMENTED',
]);
function asCode(code: string | undefined): ErrorCode {
  if (code !== undefined && (ERR_CODES as Set<string>).has(code)) return code as ErrorCode;
  return 'INTERNAL';
}

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

// ─── Caller plumbing (report_player only) ──────────────────────────────────

interface CallerOk { ok: true; id: string; }
interface CallerErr { ok: false; error: string; }

function resolveCaller(
  ctx: IContext,
  declared: unknown,
  logger: ILogger,
): CallerOk | CallerErr {
  const socketCaller = ctx.userId ?? null;
  const declaredCaller =
    typeof declared === 'string' && declared.length > 0 ? declared : null;
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
  logger.warn('moderation RPC called with no caller identity');
  return {
    ok: false,
    error: toJson(err('UNAUTHENTICATED', 'no caller identity')),
  };
}

// ─── Admin preamble ────────────────────────────────────────────────────────

function adminPrelude(
  _ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
):
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string } {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed;
  const raw = parsed.raw;
  const auth = assertAdminKey(logger, nk, raw);
  if (!auth.ok) return auth;
  return { ok: true, raw };
}

// ─── Context validator (pure) ──────────────────────────────────────────────

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{4,128}$/;

/**
 * Validate + normalize a report's context blob. Every field is
 * optional; when present, must match the shape. Returns a typed
 * `ReportContext` or a `{ ok: false, message }` for the caller.
 */
function parseContext(raw: unknown): ReportContext | { ok: false; message: string } {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'context must be an object' };
  }
  const ctx = raw as Record<string, unknown>;
  const out: ReportContext = {};
  if (ctx['sessionId'] !== undefined) {
    if (typeof ctx['sessionId'] !== 'string' || !SESSION_ID_RE.test(ctx['sessionId'] as string)) {
      return { ok: false, message: 'context.sessionId must match [A-Za-z0-9._:-]{4,128}' };
    }
    out.sessionId = ctx['sessionId'] as string;
  }
  if (ctx['channelId'] !== undefined) {
    if (typeof ctx['channelId'] !== 'string' || (ctx['channelId'] as string).length === 0) {
      return { ok: false, message: 'context.channelId must be a non-empty string' };
    }
    out.channelId = ctx['channelId'] as string;
  }
  if (ctx['lastMessages'] !== undefined) {
    if (!Array.isArray(ctx['lastMessages']) || (ctx['lastMessages'] as unknown[]).length > 20) {
      return { ok: false, message: 'context.lastMessages must be an array of at most 20 entries' };
    }
    const list: NonNullable<ReportContext['lastMessages']> = [];
    for (const m of ctx['lastMessages'] as unknown[]) {
      if (typeof m !== 'object' || m === null || Array.isArray(m)) {
        return { ok: false, message: 'context.lastMessages entries must be objects' };
      }
      const mm = m as Record<string, unknown>;
      if (typeof mm['senderUserId'] !== 'string' || (mm['senderUserId'] as string).length === 0) {
        return { ok: false, message: 'context.lastMessages[].senderUserId must be a non-empty string' };
      }
      if (typeof mm['content'] !== 'string' || (mm['content'] as string).length === 0) {
        return { ok: false, message: 'context.lastMessages[].content must be a non-empty string' };
      }
      if (typeof mm['ts'] !== 'number' || !Number.isFinite(mm['ts'] as number)) {
        return { ok: false, message: 'context.lastMessages[].ts must be a finite number' };
      }
      list.push({
        senderUserId: mm['senderUserId'] as string,
        content: mm['content'] as string,
        ts: mm['ts'] as number,
      });
    }
    out.lastMessages = list;
  }
  return out;
}

/** Test-only re-export of `parseContext` (kept private at module scope). */
export const _parseContextForTests = parseContext;

// ─── report_player ─────────────────────────────────────────────────────────

const REPORT_PLAYER_RPC_RATE = { maxPerWindow: 30, windowSec: 60 };

export interface ReportPlayerRpcInput {
  callerUserId: string;
  targetUserId: string;
  reason: ReportReason;
  context?: ReportContext;
}

export interface ReportPlayerRpcOutput {
  reportId: string;
  silenced: boolean;
  untilUtc?: number;
  /** How many DISTINCT reporters are inside the 24h window (after this insert). */
  distinctCount: number;
  triggeredSilence: boolean;
}

export const report_player_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const caller = resolveCaller(ctx, parsed.raw['callerUserId'], logger);
  if (!caller.ok) return caller.error;

  const rl = checkRateLimit(nk, {
    rpcName: 'report_player',
    userId: caller.id,
    ...REPORT_PLAYER_RPC_RATE,
  });
  if (!rl.allowed) {
    logger.warn(
      'report_player rate limit exceeded user=%s %d/%d',
      caller.id, rl.count, rl.limit,
    );
    return toJson(err('RATE_LIMITED', `report_player rate limit exceeded (${rl.count}/${rl.limit})`));
  }

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const raw = parsed.raw;
  const targetUserId = raw['targetUserId'];
  if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'targetUserId is required'));
  }
  if (targetUserId === caller.id) {
    return toJson(err('FORBIDDEN', 'cannot report yourself'));
  }

  const reasonRaw = raw['reason'];
  if (!isReportReason(reasonRaw)) {
    return toJson(err('BAD_REQUEST', `reason must be one of: ${REPORT_REASONS.join(', ')}`));
  }

  const ctxResult = parseContext(raw['context']);
  if ('ok' in ctxResult && ctxResult.ok === false) {
    return toJson(err('BAD_REQUEST', ctxResult.message));
  }
  const context = ctxResult as ReportContext;

  const nowMs = Date.now();

  // Per-reporter rate limit (5/hour).
  const rate = checkReportsRateLimit(nk, caller.id, nowMs);
  if (!rate.allowed) {
    logger.warn(
      'report_player per-reporter rate exceeded user=%s %d/%d',
      caller.id, rate.count, rate.limit,
    );
    return toJson(err(
      'RATE_LIMITED',
      `reports rate limit exceeded (${rate.count}/${rate.limit})`,
      { resetHint: '1 hour window' },
    ));
  }

  const verdict = addReportAndCheckSilence(nk, targetUserId, caller.id, nowMs);
  if (verdict.distinctCount === 0) {
    // Reports repo CAS exhausted — treat as INTERNAL.
    return toJson(err('INTERNAL', 'reports repo write failed'));
  }

  // Persist the report row.
  const reportId = nk.uuidv4();
  const record: ReportRecord = {
    schemaVersion: 1,
    reportId,
    reporterUserId: caller.id,
    targetUserId,
    reason: reasonRaw,
    context,
    createdAt: nowMs,
    status: verdict.triggeredSilence ? 'reviewed' : 'open',
    triggeredSilence: verdict.triggeredSilence,
  };
  try {
    nk.storageWrite([asReportWrite(record)]);
  } catch (e) {
    logger.error('report_player storage write failed: %s', e instanceof Error ? e.message : String(e));
    return toJson(err('INTERNAL', 'report write failed'));
  }

  emit(nk, logger, 'report_filed', {
    reportId,
    targetUserId,
    reason: reasonRaw,
    triggeredSilence: verdict.triggeredSilence,
    distinctCount: verdict.distinctCount,
  }, { userId: caller.id });

  const out: ReportPlayerRpcOutput = {
    reportId,
    silenced: verdict.triggeredSilence,
    ...(verdict.silencedUntilUtc !== null ? { untilUtc: verdict.silencedUntilUtc } : {}),
    distinctCount: verdict.distinctCount,
    triggeredSilence: verdict.triggeredSilence,
  };
  return toJson(ok(out));
};
export const report_player: RpcHandler = report_player_impl;

// ─── admin_view_reports ────────────────────────────────────────────────────

export interface AdminViewReportsRpcInput {
  status?: ReportStatus;
  limit?: number;
  cursor?: string;
}

export interface AdminViewReportsRpcOutput {
  reports: ReportCard[];
  nextCursor: string;
}

export const admin_view_reports_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;

  const raw = withoutAdminKey(pre.raw);
  const status = raw['status'];
  if (status !== undefined && !isReportStatus(status)) {
    return JSON.stringify(err('BAD_REQUEST', `status must be one of: ${REPORT_STATUSES.join(', ')}`));
  }
  const limit = typeof raw['limit'] === 'number'
    ? Math.min(200, Math.max(1, Math.floor(raw['limit'] as number)))
    : 50;
  const cursor = typeof raw['cursor'] === 'string' ? (raw['cursor'] as string) : '';

  // List reports. Reports are system-owned (SYSTEM_USER), so we list
  // with no userId filter.
  const res = nk.storageList({
    collection: REPORTS_COLLECTION,
    limit: 1000,
    cursor,
  });

  const cards: ReportCard[] = [];
  for (const o of res.objects) {
    const v = o.value as Partial<ReportRecord>;
    if (
      !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
      typeof v.reportId !== 'string' ||
      typeof v.reporterUserId !== 'string' ||
      typeof v.targetUserId !== 'string' ||
      typeof v.reason !== 'string' ||
      typeof v.createdAt !== 'number'
    ) {
      continue;
    }
    if (status !== undefined && v.status !== status) continue;
    cards.push({
      reportId: v.reportId,
      reporterUserId: v.reporterUserId,
      targetUserId: v.targetUserId,
      reason: v.reason as ReportReason,
      context: (typeof v.context === 'object' && v.context !== null
        ? (v.context as ReportContext)
        : {}),
      createdAt: v.createdAt,
      status: (v.status ?? 'open') as ReportStatus,
      triggeredSilence: v.triggeredSilence === true,
    });
  }

  // Newest first; tie-break on reportId desc for stable ordering
  // (createdAt is epoch-ms — reports filed in the same ms keep a
  // deterministic position).
  cards.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return b.reportId.localeCompare(a.reportId);
  });
  const page = cards.slice(0, limit);

  emitAdminAction(nk, logger, 'admin_view_reports', {
    status: status ?? 'all',
    returned: page.length,
  });

  const out: AdminViewReportsRpcOutput = {
    reports: page,
    nextCursor: res.cursor ?? '',
  };
  return JSON.stringify(ok(out));
};
export const admin_view_reports: RpcHandler = admin_view_reports_impl;

// ─── admin_silence ─────────────────────────────────────────────────────────

export interface AdminSilenceRpcInput {
  targetUserId: string;
  durationHours?: number;
  reason: string;
}

export interface AdminSilenceRpcOutput {
  silenced: true;
  untilUtc: number;
}

export const admin_silence_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;

  const raw = withoutAdminKey(pre.raw);
  const targetUserId = raw['targetUserId'];
  if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'targetUserId is required'));
  }
  const reason = raw['reason'];
  if (typeof reason !== 'string' || reason.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'reason is required'));
  }
  const dur = raw['durationHours'];
  if (dur !== undefined && (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0 || dur > 24 * 30)) {
    return JSON.stringify(err('BAD_REQUEST', 'durationHours must be a finite number > 0 and <= 720'));
  }
  const durationMs = (typeof dur === 'number' ? dur : 1) * 60 * 60 * 1000;

  const untilUtc = silenceUser(nk, targetUserId, reason, durationMs, Date.now());

  emitAdminAction(nk, logger, 'admin_silence', {
    targetUserId,
    durationHours: dur ?? 1,
    reason,
    untilUtc,
  });

  const out: AdminSilenceRpcOutput = { silenced: true, untilUtc };
  return JSON.stringify(ok(out));
};
export const admin_silence: RpcHandler = admin_silence_impl;

// ─── admin_unsilence ───────────────────────────────────────────────────────

export interface AdminUnsilenceRpcInput {
  targetUserId: string;
}

export interface AdminUnsilenceRpcOutput {
  silenced: false;
}

export const admin_unsilence_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;

  const raw = withoutAdminKey(pre.raw);
  const targetUserId = raw['targetUserId'];
  if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'targetUserId is required'));
  }

  // Clear the silenced row by writing an expired untilUtc (lazy check
  // — chat_send already gates on untilUtc > nowMs, so this is enough).
  // We preserve the row so audit history isn't lost (admin can still
  // see that the user WAS silenced via reports_recent).
  const existing = readSilenced(nk, targetUserId);
  if (existing !== null) {
    const cleared = {
      ...existing.record,
      untilUtc: 0,
      reason: 'manual_unsilence',
    };
    try {
      writeSilencedUpdate(nk, cleared, existing.version);
    } catch (e) {
      logger.error(
        'admin_unsilence update failed user=%s: %s',
        targetUserId, e instanceof Error ? e.message : String(e),
      );
      return JSON.stringify(err('INTERNAL', 'silenced update failed'));
    }
  }

  emitAdminAction(nk, logger, 'admin_unsilence', {
    targetUserId,
    hadExisting: existing !== null,
  });

  const out: AdminUnsilenceRpcOutput = { silenced: false };
  return JSON.stringify(ok(out));
};
export const admin_unsilence: RpcHandler = admin_unsilence_impl;

// Type re-export used by the bundle scanner so goja sees the named
// exports of the response types.
export type { Resp };