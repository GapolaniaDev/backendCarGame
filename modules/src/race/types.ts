// Race module types — single source of truth for the racing protocol.
//
// All persisted objects carry `schemaVersion: 1`. Bump the number and add
// a migrator in `core/storage.ts` consumers if the shape ever changes.

import type { ModeId } from '../core/catalog';
import type { CatalogCarView, CatalogCosmeticView, UpgradesView } from '../garage/types';

// ─── Mode / state / confidence enums (string unions, kept narrow) ─────────────

export type RaceModeId = ModeId;

export type RaceState = 'created' | 'started' | 'closing' | 'closed';

/**
 * How the final results were computed:
 * - `'quorum'`  — at least ⌈n/2⌉ of the human players reported (plan T-09)
 * - `'client'`  — fewer humans reported (e.g. grace close); flagged for review
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
  /**
   * Server-populated effective stats (post-upgrades, clamped per
   * mode). Present for ranked sessions (equalized to the car's
   * `maxStats`) and for non-ranked sessions (base + upgrades). The
   * client ignores the field when constructing the local render; the
   * server uses it to validate per-lap plausibility.
   */
  stats?: {
    speed: number;
    acceleration: number;
    handling: number;
    nitro: number;
  };
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
  /**
   * Plan T-07: server epoch-ms of this player's last contact
   * (`race_session_get`, `race_submit_result`, `race_host_claim`). Only in
   * `race_session_get` responses of running sessions; never stored on
   * the session (it lives in `race_presence`).
   */
  lastSeenMs?: number;
  /**
   * Server epoch-ms at which the host reported this player as
   * disconnected. Phase 4 Chunk 4 — used to gate `race_host_claim`.
   * The field is server-managed (set by `reportDisconnect`, never by
   * the client) and stays on the entry for audit even after a claim
   * succeeds (so Chunk 9's abandon tracker can detect a player who
   * never came back).
   */
  disconnectReportedAt?: number;
  /**
   * Phase 8 Chunk 6 — optional tournament id stamp. Set on the first
   * `race_submit_result` call that carries `tournamentId` in the
   * payload. Propagated to the resulting `RaceResult` so the
   * tournament subscriber can pair the result with the player's
   * entry. Server-managed (never accepted from the client directly).
   */
  tournamentId?: string;
  /**
   * Dedicated-server sessions (plan fishnet-nakama-server, D-04): single-use
   * entry ticket of this player (32 hex chars), checked by `rs_join_validate`.
   * Server-managed and secret: `race_session_get` never returns it in the
   * roster; the owner only gets theirs as `myJoinTicket`.
   */
  joinTicket?: string;
}

/** Where the clients of a dedicated-server session connect (D-04). */
export interface RaceSessionServer {
  /** Registry id of the race server process (`race_servers/{serverId}`). */
  serverId: string;
  host: string;
  port: number;
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
  /**
   * Server epoch-ms at which the session was created (plan T-08). Absent
   * on sessions written before F1.
   */
  createdAt?: number;
  /** Server epoch-ms at which `race_session_start` was accepted. */
  startedAt: number | null;
  /**
   * Server epoch-ms at which the current `host` last took ownership.
   * Phase 4 Chunk 4 — initial value is `startedAt` (set by
   * `markStarted`), updated by `claimHost` on every successful claim.
   * Distinct from `startedAt` so a re-claim after the race clock has
   * been running keeps the original start time but records the new
   * host's takeover moment.
   */
  claimedAt?: number;
  /** Populated when state moves to 'closed'. Sorted by rank (DNFs last). */
  results: RaceResult[];
  flags: { needsReview: boolean; reviewReason?: string; botSession?: boolean };
  /**
   * Confidence the session was closed with (D-06). Absent on open sessions
   * and on sessions closed before this field existed.
   */
  confidence?: Confidence;
  /**
   * True when a dedicated race server runs this session (D-04). Absent on
   * relay sessions. The clients then neither start nor report the race.
   */
  serverHosted?: boolean;
  /** Race server assigned to the session. Present when `serverHosted`. */
  server?: RaceSessionServer;
  /** Laps of the race (the `quick` mode laps of the track). Present when `serverHosted`. */
  laps?: number;
  /**
   * Bot difficulty 0..4 (same vocabulary as `quick_bots`) for the bots the race server fills in.
   * Present on dedicated sessions created after plan fishnet-fixes D-03; absent on older ones.
   */
  botDifficulty?: number;
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
  /**
   * Accepted per-lap times in ms (finishers only; plan T-23, additive).
   * The anti-cheat subscriber turns them into the race's partials.
   */
  laps?: number[];
  /**
   * Phase 8 Chunk 6 — tournament id when this race was a tournament
   * attempt. Carried through from the RosterEntry stamp on
   * `race_submit_result`. Subscribers (the tournament subscriber
   * specifically) use this to pair the result with the player's
   * entry. Undefined for non-tournament races.
   */
  tournamentId?: string;
}

// ─── RaceCompleted event payload ─────────────────────────────────────────────

export interface RaceCompletedEvent {
  schemaVersion: 1;
  sessionId: string;
  mode: RaceModeId;
  trackId: string;
  size: 2 | 4 | 6 | 1;
  results: RaceResult[];
  /**
   * `botSession` marks a humans-vs-bots race (`race_session_quick_bots`):
   * per P-01 it counts for missions and XP, not for ranked or `wins_week`
   * (plan T-09).
   */
  flags: { needsReview: boolean; reviewReason?: string; botSession?: boolean };
  /** Close confidence (plan T-09, audit 05 f4). Absent on older events. */
  confidence?: Confidence;
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
   * userId of the player creating the session. Optional (plan D-03): the caller is the session user (`ctx.userId`);
   * when present this field must equal it, otherwise `FORBIDDEN`.
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
   * userId of the player joining. Optional (plan D-03): the caller is the session user (`ctx.userId`);
   * when present this field must equal it, otherwise `FORBIDDEN`.
   */
  userId: string;
  /**
   * userId of the caller. Optional (plan D-03): the caller is the session user (`ctx.userId`);
   * when present this field must equal it, otherwise `FORBIDDEN`.
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
   * userId of the caller. Optional (plan D-03): the caller is the session user (`ctx.userId`);
   * when present this field must equal it, otherwise `FORBIDDEN`.
   * The session user must be `session.host`.
   */
  callerUserId: string;
}

export interface RaceSessionStartOutput {
  startedAt: number;
}

export interface RaceSessionGetInput {
  /**
   * If omitted, the RPC returns the caller's active session (the
   * `race_active` index, plan T-08) or, when there is none, the last
   * closed one.
   */
  sessionId?: string;
  /**
   * userId of the caller. Optional (plan D-03): the caller is the session user (`ctx.userId`);
   * when present this field must equal it, otherwise `FORBIDDEN`.
   * The session user must be in the roster.
   */
  callerUserId: string;
}

export interface RaceSessionGetOutput {
  session: RaceSession;
  /** The most recent closed session the caller participated in (if any). */
  lastClosed?: RaceSession;
  /**
   * Dedicated-server sessions that are not closed (D-05, additive): where
   * to connect.
   */
  server?: { host: string; port: number };
  /** Dedicated-server sessions that are not closed (D-05): the CALLER's own join ticket only. */
  myJoinTicket?: string;
}

export interface RaceSubmitResultInput {
  sessionId: string;
  report: RaceReport;
  /**
   * userId of the caller. Optional (plan D-03): the caller is the session user (`ctx.userId`);
   * when present this field must equal it, otherwise `FORBIDDEN`.
   * A human report's `report.userId` must be the session user.
   */
  callerUserId: string;
  /**
   * Phase 8 Chunk 6 — optional tournament id. When set, the server
   * stamps the corresponding RosterEntry (and propagated RaceResult)
   * with this id so the tournament subscriber can pair the result
   * with the player's entry. The RPC verifies the caller has joined
   * the tournament; mismatches return FORBIDDEN. Omitted for
   * non-tournament races.
   */
  tournamentId?: string;
  /**
   * Plan T-09 (X5-a): optional client id of this submission (1-128
   * chars). Stored with the report; a retry with the same id, at any
   * later time, returns the response of the accepted submission instead
   * of CONFLICT. Additive (D-05).
   */
  requestId?: string;
}

export type ConfidenceOutcome = 'quorum' | 'client' | 'server';

export interface RaceSubmitResultRewardEntry {
  /** Cumulative coins credited for this race (incl. position, bonuses). */
  coins: number;
  /** Cumulative gems credited (typically zero; only first-win-of-day may grant). */
  gems: number;
  /** XP awarded by this race (zero if no progression). */
  xp: number;
  /** True if this win stamped the player's first-win-of-day flag. */
  isFirstWinOfDay: boolean;
  /** True if the player crossed at least one level boundary this race. */
  leveledUp: boolean;
  /** Player level AFTER applying the race's XP. */
  newLevel: number;
  /** Snapshot of the player's wallet after the race's grants. */
  newBalance: { coins: number; gems: number };
  /** Level-up coin/gem stamps applied during this race (cumulative across levels). */
  levelUpRewards: ReadonlyArray<{ kind: 'coins' | 'gems'; amount: number }>;
}

export interface RaceSubmitResultOutput {
  accepted: true;
  confidence: ConfidenceOutcome;
  /** Present only when the submit causes the session to close. */
  officialResults?: RaceResult[];
  flags: { needsReview: boolean; reviewReason?: string };
  /**
   * Phase 3 additive (Decision 6): per-player reward snapshot. Present
   * only when the submit caused a close AND the player was a paying
   * participant. Players who didn't race (joined but never reported)
   * are absent from the map. Existing Phase 1/2 clients that ignore
   * unknown fields remain compatible.
   *
   * Keyed by userId; the caller of `race_submit_result` will be one
   * of the keys when they reported before close.
   */
  rewards?: Record<string, RaceSubmitResultRewardEntry>;
}

export interface ConfigGetOutput {
  serverTimeMs: number;
  catalogsHash: string;
  tracks: ReadonlyArray<unknown>;
  modes: ReadonlyArray<unknown>;
  cars: ReadonlyArray<CatalogCarView>;
  upgrades: UpgradesView;
  cosmetics: ReadonlyArray<CatalogCosmeticView>;
  minClientVersion: string;
}

// ─── Phase 4 Chunk 3: race_session_quick_bots ─────────────────────────────────

/**
 * Roster of human players that will join a quick-bots session. The
 * first entry is the caller's slot; additional entries represent
 * already-paired humans (e.g. a 2v2 against AI). When omitted the
 * roster defaults to a single entry — the caller themselves.
 */
export interface RaceSessionQuickBotsHuman {
  userId: string;
  rttMs?: number;
  /** Player rating — used to derive the bot difficulty (D3). */
  rating?: number;
}

export interface RaceSessionQuickBotsInput {
  /** Session size — must be 2, 4, or 6. */
  size: 2 | 4 | 6;
  /**
   * Optional explicit trackId. When omitted the server picks one via
   * `matchmaking/track_picker.ts` honouring D2 (exclude last 2 recent
   * tracks per player).
   */
  trackId?: string;
  /** Optional (plan D-03): the caller is the session user (`ctx.userId`);
   * when present this field must equal it, otherwise `FORBIDDEN`. */
  callerUserId: string;
  /** Caller's current rating — used for D3 bot difficulty. Defaults to 1000. */
  callerRating?: number;
  /** Caller's measured round-trip-time in ms. Defaults to 50. */
  callerRttMs?: number;
  /** Caller's loadout. Required — bots reuse the same classId. */
  hostLoadout: Loadout;
  /** Optional D2 exclusion list (last 2 tracks raced per player). */
  excludeTrackIds?: string[];
  /**
   * Optional pre-paired humans. When omitted the session is a
   * single-player-vs-bots lobby; when provided the bot count is
   * `size - humans.length` (D10).
   */
  humanRoster?: RaceSessionQuickBotsHuman[];
  /**
   * Nakama matchId — opaque relay reference. When omitted the server
   * generates a uuidv4.
   */
  matchId?: string;
}

export interface RaceSessionQuickBotsRosterEntry {
  userId: string;
  isBot: boolean;
  /** Round-trip-time used for host selection. Bots get a synthetic value. */
  rttMs: number;
  /** Present only when isBot === true. */
  botDifficulty?: number;
  loadout: Loadout;
}

export interface RaceSessionQuickBotsOutput {
  sessionId: string;
  /** Always 'quick_bots' for the client (storage uses 'quick' for catalog lookup). */
  mode: 'quick_bots';
  trackId: string;
  size: 2 | 4 | 6;
  host: string;
  /** Server epoch-ms — the race clock starts here. */
  startedAt: number;
  roster: RaceSessionQuickBotsRosterEntry[];
  /** The bot difficulty applied to every bot (D3). */
  botDifficulty: number;
  /** Total bot count (D10 = size - humanCount). */
  botCount: number;
}

// ─── Phase 4 Chunk 4: race_host_claim ────────────────────────────────────────

export interface RaceHostClaimInput {
  sessionId: string;
  /**
   * userId of the caller. Optional (plan D-03): the caller is the session user (`ctx.userId`);
   * when present this field must equal it, otherwise `FORBIDDEN`.
   * The session user must be in the roster AND the first live entry of
   * `hostSuccession` after a stale host (plan T-07).
   */
  callerUserId: string;
}

export interface RaceHostClaimOutput {
  sessionId: string;
  newHost: string;
  /** Server epoch-ms at which this claim was recorded (== previous claimedAt for replays). */
  claimedAt: number;
  /** Echoed for the client's clock-sync. Undefined when the session hasn't started. */
  startedAt?: number;
  /** New monotonic roster version after the claim was accepted. */
  rosterVersion: number;
}