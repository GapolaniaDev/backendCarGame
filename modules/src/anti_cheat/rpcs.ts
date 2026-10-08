// Phase 8 Chunk 4 — 6 admin RPCs for the anti-cheat subsystem.
//
// All 6 share the same preamble as `admin/rpcs.ts`:
//   - `parseInput` → `assertAdminKey` (Phase 5 D7) → service call
//   - Bypass the maintenance gate (admin ops continue during pause)
//   - Each RPC is registered with a top-level `registerRpc` call in
//     `main.ts` (Nakama goja AST scanner requires top-level expr)
//
// Two patterns per RPC: `<name>_impl: RpcHandler` (testable directly
// with a hand-crafted ctx) and a bare
// `export const <name>: RpcHandler = <name>_impl` for the goja scanner.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { assertAdminKey, withoutAdminKey } from '../admin/auth';
import { emitAdminAction } from '../core/admin/analytics';
import { serverNowMs, utcDate } from '../core/time';
import {
  readMarks,
  confirmMark,
  dismissMark,
  setHiddenUntilUtc,
  clearHiddenUntilUtc,
  type AntiCheatMark,
} from './marks';
import {
  readRacePartials,
  validatePartials,
  type RacePartial,
} from './partials';
import {
  readDailyStats,
  ANTI_CHEAT_STATS_COLLECTION,
  ANTI_CHEAT_STATS_SYSTEM_USER,
  emptyStats,
  type DailyAntiCheatStats,
} from './stats';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

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

// ─── Shared types ─────────────────────────────────────────────────────────

export type MarkStatusFilter =
  | 'all'
  | 'pending'
  | 'confirmed'
  | 'dismissed'
  | 'hidden';

/**
 * Apply the status filter to a single mark.
 *  - 'all'        → every mark (dismissed included)
 *  - 'pending'    → NOT dismissed AND NOT confirmed
 *  - 'confirmed'  → NOT dismissed AND confirmed
 *  - 'dismissed'  → dismissed (regardless of confirmed)
 *  - 'hidden'     → NOT dismissed AND (severity=high OR hiddenUntilUtc > now)
 */
function matchesStatus(
  m: AntiCheatMark,
  status: MarkStatusFilter,
  nowUtc: number,
): boolean {
  if (status === 'all') return true;
  if (status === 'dismissed') return m.dismissed;
  // Non-dismissed filters below:
  if (m.dismissed) return false;
  if (status === 'pending') return !m.confirmed;
  if (status === 'confirmed') return m.confirmed;
  if (status === 'hidden') {
    const timed = typeof m.hiddenUntilUtc === 'number' && m.hiddenUntilUtc > nowUtc;
    return timed || m.severity === 'high';
  }
  return false;
}

// ─── admin_marks_list ────────────────────────────────────────────────────

export interface AdminMarksListInput {
  status?: MarkStatusFilter;
  /** Cursor for storageList pagination (Nakama opaque cursor string). */
  cursor?: string;
  /** Max marks returned per page. Server-clamped to <= 200. */
  limit?: number;
}

export interface AdminMarksListOutput {
  marks: AntiCheatMark[];
  /** Opaque cursor; empty string when no more pages. */
  nextCursor: string;
  /** Total marks before paging — useful for the admin UI footer. */
  total: number;
}

const ANTI_CHEAT_MARKS_COLLECTION = 'anti_cheat_marks';
const ANTI_CHEAT_MARKS_SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

export const admin_marks_list_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const statusRaw = raw['status'];
  const status: MarkStatusFilter = (
    statusRaw === 'pending' || statusRaw === 'confirmed' ||
    statusRaw === 'dismissed' || statusRaw === 'hidden'
  ) ? statusRaw : 'all';

  const cursorRaw = raw['cursor'];
  const cursor = typeof cursorRaw === 'string' ? cursorRaw : '';
  const limitRaw = raw['limit'];
  const limit = (
    typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
  ) ? Math.min(200, Math.floor(limitRaw)) : 100;

  // List server-side rows for the collection. permissionRead=1 / write=0
  // — server-side code can still iterate via storageList. Cursor +
  // limit are passed through verbatim.
  const list = nk.storageList({
    collection: ANTI_CHEAT_MARKS_COLLECTION,
    userId: ANTI_CHEAT_MARKS_SYSTEM_USER,
    ...(cursor !== '' ? { cursor } : {}),
    limit,
  });

  const nowUtc = serverNowMs();
  const out: AntiCheatMark[] = [];
  for (const obj of list.objects) {
    const v = obj.value as Partial<{ marks: AntiCheatMark[] }>;
    if (!v || !Array.isArray(v.marks)) continue;
    for (const m of v.marks) {
      if (matchesStatus(m, status, nowUtc)) {
        out.push(m);
      }
    }
  }
  // Newest first.
  out.sort((a, b) => b.detectedAt - a.detectedAt);
  // Truncate to limit (in case the per-row expansion pushed us over).
  const total = out.length;
  const paged = out.slice(0, limit);

  emitAdminAction(nk, logger, 'anti_cheat:marks_list', {
    status,
    limit,
    returned: paged.length,
    total,
  });

  const payload: AdminMarksListOutput = {
    marks: paged,
    nextCursor: typeof list.cursor === 'string' ? list.cursor : '',
    total,
  };
  return JSON.stringify(ok(payload));
};
export const admin_marks_list: RpcHandler = admin_marks_list_impl;

// ─── admin_marks_partials_view ───────────────────────────────────────────

export interface AdminMarksPartialsViewInput {
  raceId: string;
}

export interface AdminMarksPartialsViewOutput {
  raceId: string;
  partials: RacePartial[];
  /** Number of sectors walked. */
  sectorCount: number;
  /** True when at least one sector was below the track floor. */
  hasViolation: boolean;
  /** First violation (when `hasViolation=true`). */
  violationAt?: number;
  deltaTimeMs?: number;
  /** Whether the partials row was found at all. */
  found: boolean;
}

export const admin_marks_partials_view_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const raceIdRaw = raw['raceId'];
  if (typeof raceIdRaw !== 'string' || raceIdRaw.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'raceId is required'));
  }
  const raceId = raceIdRaw;

  const partials = readRacePartials(nk, raceId);
  const found = partials.length > 0;

  // We can't easily resolve the track from the raceId alone — the
  // validator only needs `minSectionTimeMs`. The admin tool is expected
  // to provide it (the admin tool already knows the race's trackId from
  // `race_session_get`).
  const minRaw = raw['minSectionTimeMs'];
  const minSectionTimeMs = (
    typeof minRaw === 'number' && Number.isFinite(minRaw) && minRaw > 0
  ) ? Math.floor(minRaw) : 0;

  let hasViolation = false;
  let violationAt: number | undefined;
  let deltaTimeMs: number | undefined;
  if (minSectionTimeMs > 0 && partials.length >= 2) {
    const v = validatePartials(partials, minSectionTimeMs);
    if (!v.ok) {
      hasViolation = true;
      violationAt = v.violationAt;
      deltaTimeMs = v.deltaTimeMs;
    }
  }

  emitAdminAction(nk, logger, 'anti_cheat:marks_partials_view', {
    raceId,
    found,
    hasViolation,
    sectors: partials.length,
  });

  const payload: AdminMarksPartialsViewOutput = {
    raceId,
    partials,
    sectorCount: partials.length,
    hasViolation,
    ...(violationAt !== undefined ? { violationAt } : {}),
    ...(deltaTimeMs !== undefined ? { deltaTimeMs } : {}),
    found,
  };
  return JSON.stringify(ok(payload));
};
export const admin_marks_partials_view: RpcHandler = admin_marks_partials_view_impl;

// ─── admin_marks_confirm ─────────────────────────────────────────────────

export interface AdminMarksConfirmInput {
  userId: string;
  markId: string;
}

export interface AdminMarksConfirmOutput {
  confirmed: true;
  markId: string;
}

export const admin_marks_confirm_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const userIdRaw = raw['userId'];
  const userId = typeof userIdRaw === 'string' ? userIdRaw : '';
  const markIdRaw = raw['markId'];
  const markId = typeof markIdRaw === 'string' ? markIdRaw : '';
  if (userId.length === 0 || markId.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'userId and markId are required'));
  }

  // Look up the mark first so we can sanity-check existence before mutating.
  const marks = readMarks(nk, userId);
  const m = marks.find((x) => x.id === markId);
  if (!m) {
    return JSON.stringify(err('NOT_FOUND', 'mark not found'));
  }
  if (m.dismissed) {
    return JSON.stringify(err('CONFLICT', 'cannot confirm a dismissed mark'));
  }

  confirmMark(nk, userId, markId);

  emitAdminAction(nk, logger, 'anti_cheat:marks_confirm', {
    userId, markId,
  });

  const payload: AdminMarksConfirmOutput = { confirmed: true, markId };
  return JSON.stringify(ok(payload));
};
export const admin_marks_confirm: RpcHandler = admin_marks_confirm_impl;

// ─── admin_marks_dismiss ─────────────────────────────────────────────────

export interface AdminMarksDismissInput {
  userId: string;
  markId: string;
  reason: string;
}

export interface AdminMarksDismissOutput {
  dismissed: true;
  markId: string;
}

export const admin_marks_dismiss_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const userIdRaw = raw['userId'];
  const userId = typeof userIdRaw === 'string' ? userIdRaw : '';
  const markIdRaw = raw['markId'];
  const markId = typeof markIdRaw === 'string' ? markIdRaw : '';
  const reasonRaw = raw['reason'];
  const reason = typeof reasonRaw === 'string' ? reasonRaw : '';
  if (userId.length === 0 || markId.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'userId and markId are required'));
  }
  if (reason.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'reason is required'));
  }

  const marks = readMarks(nk, userId);
  const m = marks.find((x) => x.id === markId);
  if (!m) {
    return JSON.stringify(err('NOT_FOUND', 'mark not found'));
  }

  dismissMark(nk, userId, markId);

  emitAdminAction(nk, logger, 'anti_cheat:marks_dismiss', {
    userId, markId, reason,
  });

  const payload: AdminMarksDismissOutput = { dismissed: true, markId };
  return JSON.stringify(ok(payload));
};
export const admin_marks_dismiss: RpcHandler = admin_marks_dismiss_impl;

// ─── admin_marks_sanction ────────────────────────────────────────────────

export interface AdminMarksSanctionInput {
  userId: string;
  markId: string;
  /** Hours to hide the user for. 0 (or omitted) clears the sanction. */
  durationHours?: number;
  reason: string;
}

export interface AdminMarksSanctionOutput {
  hidden: boolean;
  /** Epoch-ms until which the user is hidden. Absent when `hidden=false`. */
  untilUtc?: number;
}

export const admin_marks_sanction_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const userIdRaw = raw['userId'];
  const userId = typeof userIdRaw === 'string' ? userIdRaw : '';
  const markIdRaw = raw['markId'];
  const markId = typeof markIdRaw === 'string' ? markIdRaw : '';
  const reasonRaw = raw['reason'];
  const reason = typeof reasonRaw === 'string' ? reasonRaw : '';
  if (userId.length === 0 || markId.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'userId and markId are required'));
  }
  if (reason.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'reason is required'));
  }

  const durRaw = raw['durationHours'];
  let durationHours = 0;
  if (durRaw !== undefined) {
    if (typeof durRaw !== 'number' || !Number.isFinite(durRaw) || durRaw < 0 || durRaw > 24 * 90) {
      return JSON.stringify(err('BAD_REQUEST', 'durationHours must be 0..2160 (90 days)'));
    }
    durationHours = Math.floor(durRaw);
  }

  const marks = readMarks(nk, userId);
  const m = marks.find((x) => x.id === markId);
  if (!m) {
    return JSON.stringify(err('NOT_FOUND', 'mark not found'));
  }

  const hidden = durationHours > 0;
  const nowUtc = serverNowMs();
  let untilUtc: number | undefined;

  if (hidden) {
    untilUtc = nowUtc + durationHours * 60 * 60 * 1000;
    setHiddenUntilUtc(nk, userId, markId, untilUtc);
  } else {
    clearHiddenUntilUtc(nk, userId, markId);
  }

  emitAdminAction(nk, logger, 'anti_cheat:marks_sanction', {
    userId, markId, durationHours, hidden, reason,
    ...(untilUtc !== undefined ? { untilUtc } : {}),
  });

  const payload: AdminMarksSanctionOutput = {
    hidden,
    ...(untilUtc !== undefined ? { untilUtc } : {}),
  };
  return JSON.stringify(ok(payload));
};
export const admin_marks_sanction: RpcHandler = admin_marks_sanction_impl;

// ─── admin_anti_cheat_stats_get ──────────────────────────────────────────

export interface AdminAntiCheatStatsGetInput {
  /** Inclusive start date in `YYYY-MM-DD` UTC. */
  startDate: string;
  /** Inclusive end date in `YYYY-MM-DD` UTC. */
  endDate: string;
}

export interface AdminAntiCheatStatsGetOutput {
  startDate: string;
  endDate: string;
  days: DailyAntiCheatStats[];
}

function utcDateRange(startDate: string, endDate: string): string[] {
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  if (endMs < startMs) return [];
  const dayMs = 24 * 60 * 60 * 1000;
  const out: string[] = [];
  for (let t = startMs; t <= endMs; t += dayMs) {
    out.push(utcDate(t));
  }
  return out;
}

export const admin_anti_cheat_stats_get_impl: RpcHandler = (_ctx, logger, nk, body) => {
  const pre = adminPrelude(_ctx, logger, nk, body);
  if (!pre.ok) return pre.error;
  const raw = withoutAdminKey(pre.raw);

  const startRaw = raw['startDate'];
  const endRaw = raw['endDate'];
  if (typeof startRaw !== 'string' || typeof endRaw !== 'string') {
    return JSON.stringify(err('BAD_REQUEST', 'startDate and endDate are required'));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(endRaw)) {
    return JSON.stringify(err('BAD_REQUEST', 'startDate/endDate must be YYYY-MM-DD'));
  }

  const days = utcDateRange(startRaw, endRaw);
  if (days.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'invalid date range'));
  }
  // Hard ceiling: 366 days per request (one leap year).
  if (days.length > 366) {
    return JSON.stringify(err('BAD_REQUEST', 'range too large (max 366 days)'));
  }

  const out: DailyAntiCheatStats[] = [];
  for (const d of days) {
    // readDailyStats returns emptyStats for absent rows, so the UI sees
    // zero-fill rather than gaps.
    out.push(readDailyStats(nk, d));
  }

  emitAdminAction(nk, logger, 'anti_cheat:stats_get', {
    startDate: startRaw,
    endDate: endRaw,
    days: days.length,
  });

  const payload: AdminAntiCheatStatsGetOutput = {
    startDate: startRaw,
    endDate: endRaw,
    days: out,
  };
  return JSON.stringify(ok(payload));
};
export const admin_anti_cheat_stats_get: RpcHandler = admin_anti_cheat_stats_get_impl;

// Surface constants used by tests / future callers. Kept at the bottom
// so the RPC definitions stay clustered for the goja scanner.
export const ANTI_CHEAT_RPC_CONSTANTS = {
  collection: ANTI_CHEAT_MARKS_COLLECTION,
  systemUser: ANTI_CHEAT_MARKS_SYSTEM_USER,
  statsCollection: ANTI_CHEAT_STATS_COLLECTION,
  statsSystemUser: ANTI_CHEAT_STATS_SYSTEM_USER,
  emptyStats,
} as const;

// Type re-export used by the bundle scanner so goja sees the named
// exports of the response types.
export type { Resp };