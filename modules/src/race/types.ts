// Race module types — single source of truth for the racing protocol.
//
// All persisted objects carry `schemaVersion: 1`. Bump the number and add
// a migrator in `core/storage.ts` consumers if the shape ever changes.

import type { ModeId } from '../core/catalog';

// ─── Mode / state / confidence enums (string unions, kept narrow) ─────────────

export type RaceModeId = ModeId;

export type RaceState = 'created' | 'started' | 'closing' | 'closed';

/**
 * How the final results were computed:
 * - `'quorum'`  — all human reports agree on the ordering (no flags)
 * - `'client'`  — humans disagree on ordering, host's order is taken, flagged
 * - `'server'`  — no humans reported; order is the host's bot roster by totalMs
 */
export type Confidence = 'quorum' | 'client' | 'server';

// ─── Player / roster ─────────────────────────────────────────────────────────

export type CarClassId = 'D' | 'C' | 'B' | 'A' | 'S';

export interface Loadout {
  /** Car class — drives min-time plausibility per track. */
  classId: CarClassId;
  /** Free-form identifier of the specific car body (UI only). */
  bodyId: string;
  /** Optional paint / livery identifier (UI only). */
  liveryId?: string;
}

export interface RosterEntry {
  userId: string;
  loadout: Loadout;
  /** True for AI-driven opponents; reports for bots are accepted only from host. */
  isBot: boolean;
  /** Server epoch-ms at which this player submitted a report (set on submit). */
  reportedAt?: number;
  /** Per-lap times in ms. Set on submit. Length === mode.laps. */
  laps?: number[];
  /** Aggregate finish time in ms. Sum of laps. Set on submit. */
  totalMs?: number;
  /** True if grace expired with no report. Set at close-time. */
  abandoned?: boolean;
}

// ─── Reports (per-user submissions) ──────────────────────────────────────────

export interface RaceReport {
  userId: string;
  /** Aggregate finish time in ms. */
  totalMs: number;
  /** Per-lap times in ms; length === number of laps for the mode/track. */
  laps: number[];
  /** True when the host is reporting on a bot's behalf. */
  isBotReport: boolean;
}

// ─── Session (persisted at race_sessions/{sessionId}) ─────────────────────────

export interface RaceSession {
  schemaVersion: 1;
  id: string;
  /** Nakama match ID — opaque reference to the relay transport. */
  matchId: string;
  mode: RaceModeId;
  trackId: string;
  size: 2 | 4 | 6 | 1;
  roster: RosterEntry[];
  /** userId of the current host (set on create, may rotate on move out). */
  host: string;
  /**
   * Stack of host-succession candidates in ascending round-trip-time order.
   * `host` is always `hostSuccession[0]`. Populated on create; not used in
   * Phase 1 (host-claim logic lands later).
   */
  hostSuccession: string[];
  state: RaceState;
  /** Server epoch-ms at which `race_session_start` was accepted. */
  startedAt: number | null;
  /** Populated when state moves to 'closed'. Sorted by rank (DNFs last). */
  results: RaceResult[];
  flags: { needsReview: boolean; reviewReason?: string };
  /**
   * Monotonic counter incremented on every conditional write. Used as
   * the optimistic-concurrency token in `multiUpdate` at close-time.
   */
  version: number;
}

export interface RaceResult {
  /** 1-indexed rank. DNFs share the next rank after the last finisher. */
  rank: number;
  userId: string;
  isBot: boolean;
  totalMs: number;
  /** True if the player did not submit before grace expired. */
  abandoned: boolean;
  /** True if the player finished but their individual laps failed validation. */
  lapSumInvalid?: boolean;
}

// ─── RaceCompleted event payload ─────────────────────────────────────────────

export interface RaceCompletedEvent {
  schemaVersion: 1;
  sessionId: string;
  mode: RaceModeId;
  trackId: string;
  size: 2 | 4 | 6 | 1;
  results: RaceResult[];
  flags: { needsReview: boolean; reviewReason?: string };
  closedAt: number;
}

// ─── RPC input / output shapes ───────────────────────────────────────────────

export interface RaceSessionCreateInput {
  matchId: string;
  mode: RaceModeId;
  trackId: string;
  size: 2 | 4 | 6 | 1;
  hostLoadout: Loadout;
  /**
   * userId of the player creating the session. Required when calling
   * via the HTTP gateway (where `ctx.userId` is null). When calling
   * via an authenticated socket, `ctx.userId` takes precedence and
   * this field is ignored.
   */
  hostUserId: string;
}

export interface RaceSessionCreateOutput {
  sessionId: string;
  /** Always 1 immediately after create. */
  rosterVersion: 1;
  hostSuccession: string[];
}

export interface RaceSessionJoinInput {
  sessionId: string;
  /**
   * userId of the player joining. Same contract as `hostUserId` in
   * create — required when calling over the HTTP gateway (where
   * `ctx.userId` is null); ignored when `ctx.userId` is set.
   */
  userId: string;
  /**
   * userId of the caller. Required when calling over HTTP gateway to
   * prevent a malicious client from joining on behalf of another
   * player. When `ctx.userId` is set, this field must match it or the
   * RPC returns `FORBIDDEN`.
   */
  callerUserId: string;
  loadout: Loadout;
}

export interface RaceSessionJoinOutput {
  /** New monotonic roster version after the join was accepted. */
  rosterVersion: number;
  rosterSize: number;
}

export interface RaceSessionStartInput {
  sessionId: string;
  /**
   * userId of the caller. Required when calling over HTTP gateway.
   * The RPC verifies that this userId matches `session.host`; on
   * mismatch it returns `FORBIDDEN`.
   */
  callerUserId: string;
}

export interface RaceSessionStartOutput {
  startedAt: number;
}

export interface RaceSessionGetInput {
  /** If omitted, the RPC returns the live session the caller is currently in. */
  sessionId?: string;
  /**
   * userId of the caller. Required when calling via the HTTP gateway
   * (where `ctx.userId` is null). The RPC verifies that this userId
   * is in the session roster.
   */
  callerUserId: string;
}

export interface RaceSessionGetOutput {
  session: RaceSession;
  /** The most recent closed session the caller participated in (if any). */
  lastClosed?: RaceSession;
}

export interface RaceSubmitResultInput {
  sessionId: string;
  report: RaceReport;
  /**
   * userId of the caller. Required when calling over HTTP gateway
   * (where `ctx.userId` is null). When `ctx.userId` is set, the
   * RPC verifies it matches `report.userId` (defense against
   * impersonation); on mismatch it returns `FORBIDDEN`.
   */
  callerUserId: string;
}

export type ConfidenceOutcome = 'quorum' | 'client' | 'server';

export interface RaceSubmitResultOutput {
  accepted: true;
  confidence: ConfidenceOutcome;
  /** Present only when the submit causes the session to close. */
  officialResults?: RaceResult[];
  flags: { needsReview: boolean; reviewReason?: string };
}

export interface ConfigGetOutput {
  serverTimeMs: number;
  catalogsHash: string;
  tracks: ReadonlyArray<unknown>;
  modes: ReadonlyArray<unknown>;
  minClientVersion: string;
}