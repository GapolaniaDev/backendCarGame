// Hand-written TypeScript typings for the Nakama 3.27 JavaScript runtime.
//
// Reference (verified against v3.27.0 source):
//   https://github.com/heroiclabs/nakama/tree/v3.27.0/server/runtime_javascript_nakama.go
//   https://github.com/heroiclabs/nakama/tree/v3.27.0/server/runtime_javascript_init.go
//   https://github.com/heroiclabs/nakama/tree/v3.27.0/server/runtime_javascript_logger.go
//   https://github.com/heroiclabs/nakama/tree/v3.27.0/server/runtime_multi_update.go
//
// This file deliberately covers only the surface used by Phase 1 of the
// racing-game backend. Extend with care when later phases add new APIs.

// ─── InitModule parameter types ──────────────────────────────────────────────

/**
 * Per-RPC invocation context. Carries the authenticated user's id when
 * the call arrived over an authenticated transport (HTTP session token,
 * socket session, etc.); `null` when the caller is anonymous.
 *
 * Verified against v3.27.0: `server/runtime_javascript.go` injects the
 * caller userId onto the context object before invoking the handler.
 */
export interface IContext {
  readonly _brand: 'NakamaContext';
  userId: string | null;
  /** Match id when the call originated from a match (Phase 2+). */
  matchId?: string;
  /** Nakama session token string (null when called without auth). */
  sessionId?: string;
}

/** Server-side structured logger (mirrors zerolog's API). */
export interface ILogger {
  debug(format: string, ...args: unknown[]): void;
  info(format: string, ...args: unknown[]): void;
  warn(format: string, ...args: unknown[]): void;
  error(format: string, ...args: unknown[]): void;
  withField(format: string, key: string, value: unknown): ILogger;
  withFields(format: string, fields: Record<string, unknown>): ILogger;
  getFields(): Record<string, unknown>;
}

/** InitModule's third parameter is the "initializer" — registration helpers. */
export interface IInitializer {
  // ── RPC ──
  // Signature verified against v3.27.0 source: registerRpc takes
  // (name, fn) — no runtime arg. The Go side closes over the runtime
  // internally.
  registerRpc(key: string, fn: RpcFunction): void;

  // ── Hooks ──
  registerBeforeAuthenticateApple(fn: BeforeAuthFn): void;
  registerAfterAuthenticateApple(fn: AfterAuthFn): void;
  registerBeforeAuthenticateCustom(fn: BeforeAuthFn): void;
  registerAfterAuthenticateCustom(fn: AfterAuthFn): void;
  registerBeforeAuthenticateDevice(fn: BeforeAuthFn): void;
  registerAfterAuthenticateDevice(fn: AfterAuthFn): void;
  registerBeforeAuthenticateEmail(fn: BeforeAuthFn): void;
  registerAfterAuthenticateEmail(fn: AfterAuthFn): void;
  registerBeforeSessionRefresh(fn: BeforeReqFn): void;
  registerAfterSessionRefresh(fn: AfterReqFn): void;

  registerBeforeWriteStorageObjects(fn: BeforeStorageFnEnvelope): void;
  registerAfterWriteStorageObjects(fn: AfterStorageFnEnvelope): void;

  // Names verified against v3.27.0 `mappings()`: the client API is
  // `WriteLeaderboardRecord`, so the hooks are
  // `register{Before,After}WriteLeaderboardRecord`.
  registerBeforeWriteLeaderboardRecord(fn: BeforeReqFn): void;
  registerAfterWriteLeaderboardRecord(fn: AfterReqFn): void;

  registerMatchmakerMatched(fn: MatchmakerMatchedFn): void;

  // ── Match lifecycle ──
  registerMatch(name: string, handler: IMatchHandler): void;

  // ── Lifecycle ──
  registerShutdown(runtime: INakama, fn: ShutdownFn): void;
}

// ─── Hook and RPC function signatures ────────────────────────────────────────

export type RpcFunction = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
) => string;

export type BeforeAuthFn = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: { username: string; userId: string; vars: Record<string, string> },
) => void;

/**
 * After-auth hook. v3.27.0 passes `(ctx, logger, nk, session, request)`:
 * the authenticated user id is on `ctx.userId`, the session object
 * carries only the tokens.
 */
export type AfterAuthFn = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  data?: unknown,
  request?: unknown,
) => void;

export type BeforeReqFn = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: unknown,
) => unknown;

export type AfterReqFn = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: unknown,
) => void;

export interface IStorageObjectEnvelope {
  writes: IStorageObject[];
}

export type BeforeStorageFnEnvelope = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: IStorageObjectEnvelope,
) => void;
export type AfterStorageFnEnvelope = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: IStorageObjectEnvelope,
) => void;

/**
 * Candidate grouping used by the pure validator (`pickCandidate`,
 * `validateCandidate`). NOT what the runtime passes to the hook: see
 * `IMatchmakerResult`.
 */
export interface IMatchmakerMatchedEnvelope {
  matches: {
    sessionId: string;
    tickets: Array<{
      ticket: string;
      metadata: Record<string, string>;
    }>;
    matched: Array<{
      sessionId: string;
      userId: string;
      username: string;
      vars: Record<string, string>;
    }>;
  }[];
}

/**
 * One matched entry as the v3.27.0 JS runtime passes it to the
 * matchmakerMatched hook (one per matched presence; a party ticket yields
 * one entry per member). `properties` merges the ticket's string and
 * numeric properties.
 */
export interface IMatchmakerResult {
  properties: Record<string, unknown>;
  presence: { userId: string; sessionId: string; username: string; node: string; status?: string };
  partyId?: string;
}

/**
 * v3.27.0 contract: the hook receives the matched entries of ONE group and
 * returns an authoritative match id, or nothing for the default relayed
 * match. It cannot reject the group (the tickets are already removed).
 */
export type MatchmakerMatchedFn = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  matches: IMatchmakerResult[],
) => string | void;

/**
 * Authoritative match handler (v3.27.0 `runtime_javascript_match_core.go`).
 * Every handler after `matchInit` receives
 * `(ctx, logger, nk, dispatcher, tick, state, ...)`; `state` must be an
 * object. Returning `null` from `matchLoop` ends the match.
 */
export interface IMatchHandler {
  matchInit: (
    ctx: IContext,
    logger: ILogger,
    nk: INakama,
    params: Record<string, unknown>,
  ) => { state: unknown; tickRate: number; label: string };
  matchJoinAttempt: (
    ctx: IContext, logger: ILogger, nk: INakama, dispatcher: unknown, tick: number,
    state: any, presence: unknown, metadata: unknown,
  ) => { state: unknown; accept: boolean; rejectMessage?: string } | null;
  matchJoin: (
    ctx: IContext, logger: ILogger, nk: INakama, dispatcher: unknown, tick: number,
    state: any, presences: unknown[],
  ) => { state: unknown } | null;
  matchLeave: (
    ctx: IContext, logger: ILogger, nk: INakama, dispatcher: unknown, tick: number,
    state: any, presences: unknown[],
  ) => { state: unknown } | null;
  matchLoop: (
    ctx: IContext, logger: ILogger, nk: INakama, dispatcher: unknown, tick: number,
    state: any, messages: unknown[],
  ) => { state: unknown } | null;
  matchTerminate: (
    ctx: IContext, logger: ILogger, nk: INakama, dispatcher: unknown, tick: number,
    state: any, graceSeconds: number,
  ) => { state: unknown } | null;
  matchSignal: (
    ctx: IContext, logger: ILogger, nk: INakama, dispatcher: unknown, tick: number,
    state: any, data: string,
  ) => { state: unknown; data?: string } | null;
}

export type ShutdownFn = () => void;

// ─── Main runtime API ──────────────────────────────────────────────────────────

export interface INakama {
  // ── Storage ──
  /**
   * v3.27.0 JS binding (positional): `userId` null/undefined lists every
   * owner; `limit` defaults to 100; `cursor` null for the first page.
   * Returns `cursor: null` on the last page. Use `listStorage` from
   * core/storage.ts instead of calling this directly.
   */
  storageList(
    userId: string | null | undefined,
    collection: string,
    limit?: number,
    cursor?: string | null,
    callerId?: string | null,
  ): { objects: IStorageObject[]; cursor: string | null };
  storageRead(keys: IStorageKey[]): IStorageObject[];
  storageWrite(objs: IStorageObject[]): IStorageObjectAck[];
  storageDelete(keys: IStorageKey[]): void;

  /**
   * Atomic multi-update (storage + wallet + ledger in a single transaction).
   *
   * JS runtime signature (verified v3.27.0, `runtime_javascript_nakama.go`
   * `multiUpdate`): all five args are positional arrays/values. The
   * `{storage_write: ...}` envelope shape is the nakama-common Go API, NOT
   * what the JS runtime accepts. Storage writes run first, then the wallet
   * updates (`SELECT ... FOR UPDATE`, a negative balance aborts the whole
   * transaction with "wallet update rejected negative value"); a storage
   * version mismatch aborts it with "version check failed". With
   * `updateLedger` each wallet update also inserts a ledger row carrying
   * its `metadata`.
   *
   * Pass `undefined` for any slot you don't need.
   */
  multiUpdate(
    accountUpdates: undefined,
    storageWrites: IStorageObject[] | undefined,
    storageDeletes: undefined,
    walletUpdates: IWalletUpdate[] | undefined,
    updateLedger: boolean | undefined,
  ): IMultiUpdateResult;

  // ── Local cache (per-process, in-memory) ──
  localcacheGet<T = unknown>(key: string): T | null;
  localcachePut<T = unknown>(key: string, value: T, ttlSec?: number): void;
  localcacheDelete(key: string): void;
  localcacheClear(): void;

  // ── Leaderboards ──
  leaderboardCreate(
    id: string,
    authoritative: boolean,
    sortOrder: 'asc' | 'ascending' | 'desc' | 'descending',
    operator: 'best' | 'set' | 'incr' | 'decr',
    resetSchedule: string,
    metadata: Record<string, unknown>,
    enableRanks: boolean,
  ): { leaderboard: ILeaderboard; created: boolean };
  leaderboardDelete(id: string): void;
  /** 3.27: `limit` 1-100 (default 10); `cursor` is null on the last page. */
  leaderboardList(
    limit?: number,
    cursor?: string,
  ): { leaderboards: ILeaderboard[]; cursor: string | null };
  leaderboardRecordWrite(
    id: string,
    ownerId: string,
    username: string,
    score: number,
    subscore: number,
    metadata: Record<string, unknown>,
    operatorOverride?: 'best' | 'set' | 'incr' | 'decr',
  ): { record: ILeaderboardRecord };
  leaderboardRecordDelete(id: string, ownerId: string): void;
  /**
   * 3.27: records come in the table's own sort order with their `rank`.
   * `limit` 0/absent lists no page (only `ownerRecords`). The 5th
   * argument is `overrideExpiry` (unix seconds), NOT a sort order.
   * Throws "leaderboard not found" for an unknown table.
   */
  leaderboardRecordsList(
    id: string,
    ownerIds: string[],
    limit?: number,
    cursor?: string,
    overrideExpiry?: number,
  ): ILeaderboardRecordList;
  /** 3.27: the page around `ownerId` (limit 1-100); empty when the owner has no record. */
  leaderboardRecordsHaystack(
    id: string,
    ownerId: string,
    limit?: number,
    cursor?: string,
    overrideExpiry?: number,
  ): ILeaderboardRecordList;
  /** 3.27: definitions of the existing tables among `ids` (unknown ids are skipped). */
  leaderboardsGetId(ids: string[]): ILeaderboardInfo[];

  // ── Matchmaker (programmatic) ──
  matchmakerAdd(
    minCount: number,
    maxCount: number,
    query: Record<string, unknown>,
    countMultiple: number,
    authoritative: boolean,
    label: string,
    metadata: Record<string, string>,
  ): string;
  matchmakerRemove(ticket: string): void;
  matchCreate(
    moduleName: string,
    params: Record<string, unknown>,
  ): string;
  matchGet(matchId: string): IMatch | null;
  /** v3.27.0: returns an array of `{matchId, authoritative, size, label}`. */
  matchList(
    limit: number,
    authoritative?: boolean | null,
    label?: string | null,
    minSize?: number | null,
    maxSize?: number | null,
    query?: string | null,
  ): Array<{ matchId: string; authoritative: boolean; size: number; label: string | null }>;

  // ── Wallet ── (verified v3.27.0, `runtime_javascript_nakama.go`)
  /**
   * Apply a signed changeset; `updateLedger` also inserts a ledger row
   * with `metadata`. Throws "wallet update rejected negative value" when a
   * balance would go below zero.
   */
  walletUpdate(
    userId: string,
    changeset: Record<string, number>,
    metadata?: Record<string, unknown>,
    updateLedger?: boolean,
  ): IWalletUpdateResult;
  walletsUpdate(updates: IWalletUpdate[], updateLedger?: boolean): IWalletUpdateResult[];
  /**
   * Merge `metadata` into an EXISTING ledger row, found by its id. It does
   * not move money nor create a row (an unknown id fails with
   * "sql: no rows in result set").
   */
  walletLedgerUpdate(itemId: string, metadata: Record<string, unknown>): Record<string, unknown>;
  /** Newest first: `{ items, cursor }` (`cursor` null on the last page). */
  walletLedgerList(
    userId: string,
    limit?: number,
    cursor?: string,
  ): { items: Record<string, unknown>[]; cursor: string | null };

  // ── Notifications ──
  notificationSend(
    userId: string,
    subject: string,
    content: Record<string, unknown>,
    code: number,
    senderId: string,
    persistent?: boolean
  ): void;
  notificationSendAll(
    userIds: string[],
    subject: string,
    content: Record<string, unknown>,
    code: number,
    senderId: string,
    persistent?: boolean,
  ): void;
  notificationsList(
    userId: string,
    limit?: number,
    cursor?: string,
  ): { notifications: unknown[]; cacheableCursor: string };

  // ── Account ──
  accountGetId(userId: string): unknown;
  accountsGetId(userIds: string[]): unknown[];
  accountUpdateId(
    userId: string,
    metadata: Record<string, unknown>,
    username?: string,
  ): void;
  accountDeleteId(userId: string, recorded: boolean): void;
  /**
   * 3.27 server-side links (`linkCustom(userId, customId)`, …). Unused:
   * players link natively from the client (plan T-15, P-02). Each one
   * throws "error linking: … is already in use." when the identity
   * belongs to another account.
   */
  linkCustom(userId: string, customId: string): void;
  unlinkCustom(userId: string, customId?: string): void;
  usersGetId(userIds: string[]): IUser[];
  usersGetUsername(username: string[]): unknown;
  usersGetRandom(count: number): unknown;

  // ── Group CRUD (for clubs) ──
  groupCreate(
    name: string,
    description: string,
    lang: string,
    metadata: Record<string, unknown>,
    maxCount: number,
    open: boolean,
  ): { group: IGroup; creator: IUser };
  groupUpdate(
    groupId: string,
    name: string,
    description: string,
    lang: string,
    metadata: Record<string, unknown>,
    open: boolean,
  ): void;
  groupDelete(groupId: string): void;
  groupUsersList(groupId: string, limit?: number, cursor?: string): unknown;
  groupUserJoin(groupId: string, userId: string): void;
  groupUsersAdd(groupId: string, userIds: string[]): void;
  groupsList(limit?: number, cursor?: string, name?: string): unknown;

  // ── Auth helpers ──
  authenticateDevice(
    id: string,
    opts?: { username?: string; create?: boolean },
  ): { token: string; userId: string; username?: string };
  linkDevice(userId: string, id: string): void;

  // ── Misc helpers ──
  uuidv4(): string;
  cronNext(prev: string, cron: string): string;
  cronPrev(prev: string, cron: string): string;
  metricsCounterAdd(name: string, labels: Record<string, string>, value: number): void;
  metricsGaugeSet(name: string, labels: Record<string, string>, value: number): void;
  metricsTimerRecord(name: string, labels: Record<string, string>, valueMs: number): void;
  sha256Hash(input: string): string;
  hmacSha256Hash(input: string, key: string): string;
  base64UrlEncode(input: string): string;
  base64UrlDecode(input: string): string;
  base64Encode(input: string | Uint8Array): string;
  base64Decode(input: string): Uint8Array;
  aes128Encrypt(input: string, key: string): string;
  aes128Decrypt(input: string, key: string): string;
  aes256Encrypt(input: string, key: string): string;
  aes256Decrypt(input: string, key: string): string;
  jwtGenerate(
    claims: Record<string, unknown>,
    signingKey: string,
    algo: 'HS256' | 'HS512' | 'RS256',
    secondsUntilExpiry: number,
  ): string;
  httpRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string,
  ): { code: number; content: string; headers: Record<string, string> };

  // ── Direct SQL — used only by migrations/admin, NOT for runtime game state ──
  sqlExec(query: string, args?: unknown[]): unknown;
  sqlQuery(query: string, args?: unknown[]): unknown[];
}

// ─── Sub-interfaces ──────────────────────────────────────────────────────────

export interface IStorageKey {
  collection: string;
  key: string;
  userId: string;
}

export interface IStorageObject {
  collection: string;
  key: string;
  userId: string;
  value: unknown;
  /**
   * Required for CAS updates (set to the version returned by the
   * previous read). Omit on fresh writes — the runtime assigns one.
   */
  version?: string;
  permissionRead: number; // 0 = server-only, 1 = owner, 2 = public
  permissionWrite: number;
  /**
   * Server-managed timestamps. Populated by the runtime on reads;
   * writes MUST leave them unset — empty strings cause
   * `multiUpdate` to reject the write with "No fields to update".
   */
  createTime?: string;
  updateTime?: string;
  expiresAt?: string | null;
}

export interface IStorageObjectAck {
  collection: string;
  key: string;
  userId: string;
  version: string;
}

export interface IStorageListRequest {
  collection: string;
  userId?: string;
  limit?: number;
  cursor?: string;
  index?: string;
}

export interface IMultiUpdateResult {
  /** Per-storage-write acks (collection, key, userId, version). */
  storageWriteAcks: IStorageObjectAck[];
  /** Per-wallet-update results, in the order of the updates. */
  walletUpdateAcks: IWalletUpdateResult[];
}

/** One wallet update for `multiUpdate` / `walletsUpdate`. */
export interface IWalletUpdate {
  userId: string;
  /** Signed deltas (whole numbers). */
  changeset: Record<string, number>;
  /** Stored on the ledger row when the call records the ledger. */
  metadata?: Record<string, unknown>;
}

export interface IWalletUpdateResult {
  userId: string;
  /** Wallet after the update. */
  updated: Record<string, number>;
  /** Wallet before the update. */
  previous: Record<string, number>;
}

export interface ILeaderboard {
  id: string;
  authoritative: boolean;
  sortOrder: number;
  operator: number;
  resetSchedule: string;
  metadata: Record<string, unknown>;
  createTime: string;
  category: number;
  description: string;
  duration: number;
  endTime: string;
  joinRequired: boolean;
  maxSize: number;
  maxNumScore: number;
  title: string;
  size: number;
  startTime: string;
  enableRanks: boolean;
}

/** `leaderboardsGetId` row (3.27 `leaderboardToJsObject`). */
export interface ILeaderboardInfo {
  id: string;
  /** 0 = ascending, 1 = descending. */
  sortOrder: number;
  /** Lower-case operator name: 'best' | 'set' | 'increment' | 'decrement'. */
  operator: string;
  metadata: Record<string, unknown>;
  createTime: number;
  prevReset?: number;
  nextReset?: number;
  authoritative: boolean;
}

export interface ILeaderboardRecordList {
  records: ILeaderboardRecord[];
  ownerRecords: ILeaderboardRecord[];
  nextCursor: string | null;
  prevCursor: string | null;
  /** Ranked records in the table (rank cache count). */
  rankCount: number;
}

export interface ILeaderboardRecord {
  leaderboardId: string;
  ownerId: string;
  username: string | null;
  score: number;
  subscore: number;
  numScore: number;
  metadata: Record<string, unknown>;
  createTime: string;
  updateTime: string;
  expiryTime: string | null;
  rank: number | null;
  maxNumScore: number;
}

export interface IMatch {
  matchId: string;
  authoritative: boolean;
  label: string | null;
  size: number;
  tickRate: number;
  handlerName: string;
}

export interface IUser {
  userId: string;
  username: string;
  createTime: string;
  updateTime: string;
  disableTime: true;
  metadata: Record<string, unknown>;
}

export interface IGroup {
  groupId: string;
  creatorUserId: string;
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  maxCount: number;
  open: boolean;
}

// ─── Global function injected by the runtime ─────────────────────────────────

declare global {
  /**
   * Called once at server startup. Registers RPCs, hooks, matches, etc.
   *
   * The Go runtime invokes the JS function with this positional order
   * (see `server/runtime_javascript.go` line 2467 in v3.27.0):
   *   `initModFn(goja.Null(), ctx, jsLoggerInst, nk, init)`
   *
   * So in JS the params are:
   *   ctx         — init context (node, version, env)
   *   logger      — zap-backed logger (info, warn, error, debug, withField, withFields)
   *   nk          — Nakama module (storageRead/Write, leaderboardCreate, sha256Hash, …)
   *   initializer — register* hooks (registerRpc, registerBeforeWriteStorageObjects, …)
   *
   * Older docs (and the existing `modules/leaderboards.js` stub) use
   * the 3-arg form `(ctx, logger, nk)`, which still works in v3.27
   * because extras are silently dropped — but the `initializer` is
   * required for `registerRpc` and hook registration.
   */
  function InitModule(ctx: IContext, logger: ILogger, nk: INakama, initializer: IInitializer): void;
}