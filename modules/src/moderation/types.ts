// Phase 7 Chunk 7 — Moderation types + storage helpers.
//
// Reports: players submit reports against another user (targetUserId).
// After 3 DISTINCT reporter userIds inside 24h, the target gets
// auto-silenced for 1h. Admins can manually silence/unsilence with an
// explicit duration.
//
// Storage layout:
//   reports/{reportId}        — system-owned (SYSTEM_USER), Read=1 Write=0
//                               Read via admin_view_reports RPC only.
//   reports_recent/{userId}   — owner-scoped (userId=target), Read=1 Write=0
//                               Stores a Map<reporterUserId, ts>.
//                               GC'd lazily on read for entries older
//                               than 24h.
//   reports_rate/{userId}     — owner-scoped (userId=reporter), Read=1 Write=0
//                               Per-reporter rate counter (5/hour).
//
// Reporter identity is server-only — targets NEVER see who reported
// them (D3 anonymous reports).

import type { IStorageObject } from '../nkruntime';
import { SYSTEM_USER_ID } from '../race/constants';

// ─── Enums ──────────────────────────────────────────────────────────────────

export const REPORT_REASONS = ['cheating', 'toxic_chat', 'username', 'other'] as const;
export type ReportReason = typeof REPORT_REASONS[number];

export const REPORT_STATUSES = ['open', 'reviewed', 'dismissed'] as const;
export type ReportStatus = typeof REPORT_STATUSES[number];

/** Default auto-silence: 3 distinct reporters in 24h → silence 1h. */
export const AUTO_SILENCE_DISTINCT_REPORTERS = 3;
export const AUTO_SILENCE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AUTO_SILENCE_DURATION_MS = 60 * 60 * 1000;

/** Per-reporter rate limit: max 5 reports / hour. */
export const REPORTS_PER_HOUR_LIMIT = 5;
export const REPORTS_RATE_WINDOW_MS = 60 * 60 * 1000;

// ─── Storage collection names ───────────────────────────────────────────────

export const REPORTS_COLLECTION = 'reports';
export const REPORTS_RECENT_COLLECTION = 'reports_recent';
export const REPORTS_RATE_COLLECTION = 'reports_rate';

// ─── Records ────────────────────────────────────────────────────────────────

/**
 * Optional context a reporter can attach to the report. Stored as-is
 * (shallow validation). Admin sees this verbatim.
 */
export interface ReportContext {
  /** Race session id when reporting in-race cheating. */
  sessionId?: string;
  /** Chat channelId when reporting toxic chat (already resolved). */
  channelId?: string;
  /** Last few chat messages (denormalized so the admin can judge). */
  lastMessages?: Array<{
    senderUserId: string;
    content: string;
    ts: number;
  }>;
}

export interface ReportRecord {
  schemaVersion: 1;
  /** Unique per-report id (nk.uuidv4()). */
  reportId: string;
  reporterUserId: string;
  targetUserId: string;
  reason: ReportReason;
  context: ReportContext;
  /** Epoch-ms when the report was filed. */
  createdAt: number;
  status: ReportStatus;
  /**
   * If the auto-silence threshold fired on this report, set to true.
   * (informational — admin can see "this report triggered action")
   */
  triggeredSilence: boolean;
}

/**
 * Rolling-window record of recent reports for auto-silence. Map from
 * reporter userId → epoch-ms of the most recent report they filed
 * against this target. Entries older than 24h are GC'd lazily on read.
 */
export interface ReportsRecentRecord {
  schemaVersion: 1;
  targetUserId: string;
  entries: Record<string, number>;
}

export interface ReportsRateRecord {
  schemaVersion: 1;
  reporterUserId: string;
  /** Epoch-ms when the current hour window started. */
  windowStartTs: number;
  /** Number of reports filed inside the current window. */
  count: number;
}

// ─── Cards (RPC outputs) ────────────────────────────────────────────────────

export interface ReportCard {
  reportId: string;
  reporterUserId: string;
  targetUserId: string;
  reason: ReportReason;
  context: ReportContext;
  createdAt: number;
  status: ReportStatus;
  triggeredSilence: boolean;
}

// ─── Storage write helpers ──────────────────────────────────────────────────

export function asReportWrite(rec: ReportRecord): IStorageObject {
  return {
    collection: REPORTS_COLLECTION,
    key: rec.reportId,
    userId: SYSTEM_USER_ID, // system-owned — clients must go through RPC
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 1, // system-only read (server-side check)
    permissionWrite: 0, // server-only writes
  };
}

export function asReportsRecentWrite(rec: ReportsRecentRecord): IStorageObject {
  return {
    collection: REPORTS_RECENT_COLLECTION,
    key: rec.targetUserId,
    userId: rec.targetUserId, // owner-scoped so storageList(userId=...) works
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  };
}

export function asReportsRateWrite(rec: ReportsRateRecord): IStorageObject {
  return {
    collection: REPORTS_RATE_COLLECTION,
    key: rec.reporterUserId,
    userId: rec.reporterUserId,
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  };
}

// ─── Pure validators (testable in isolation) ────────────────────────────────

export function isReportReason(v: unknown): v is ReportReason {
  return typeof v === 'string' && (REPORT_REASONS as readonly string[]).includes(v);
}

export function isReportStatus(v: unknown): v is ReportStatus {
  return typeof v === 'string' && (REPORT_STATUSES as readonly string[]).includes(v);
}