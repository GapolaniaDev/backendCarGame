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

/** Opaque Go context.Context — discarded by the JS bridge. */
export interface IContext {
  readonly _brand: 'NakamaContext';
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
  registerRpc(runtime: INakama, key: string, fn: RpcFunction): void;

  // ── Hooks ──
  registerBeforeAuthenticateApple(runtime: INakama, fn: BeforeAuthFn): void;
  registerAfterAuthenticateApple(runtime: INakama, fn: AfterAuthFn): void;
  registerBeforeSessionRefresh(runtime: INakama, fn: BeforeReqFn): void;
  registerAfterSessionRefresh(runtime: INakama, fn: AfterReqFn): void;

  registerBeforeWriteStorageObjects(
    runtime: INakama,
    fn: BeforeStorageFnEnvelope,
  ): void;
  registerAfterWriteStorageObjects(
    runtime: INakama,
    fn: AfterStorageFnEnvelope,
  ): void;

  registerBeforeLeaderboardRecordWrite(
    runtime: INakama,
    fn: BeforeLeaderboardRecordFn,
  ): void;
  registerAfterLeaderboardRecordWrite(
    runtime: INakama,
    fn: AfterLeaderboardRecordFn,
  ): void;

  registerMatchmakerMatched(runtime: INakama, fn: MatchmakerMatchedFn): void;

  // ── Match lifecycle ──
  registerMatch(runtime: INakama, name: string, handler: IMatchHandler): void;

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

export type AfterAuthFn = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: { username: string; userId: string; vars: Record<string, string> },
) => void;

export type BeforeReqFn = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: unknown,
) => void;

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

export interface ILeaderboardRecordEnvelope {
  leaderboardId: string;
  leaderboard: ILeaderboard;
  record: ILeaderboardRecord | null;
  update: {
    prevRank: number | null;
    prevScore: number | null;
    prevSubscore: number | null;
    prevMetadata: Record<string, unknown> | null;
    rank: number | null;
    score: number;
    subscore: number;
    metadata: Record<string, unknown> | null;
    operator: 'best' | 'set' | 'incr' | 'decr';
  };
}

export type BeforeLeaderboardRecordFn = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: ILeaderboardRecordEnvelope,
) => void;
export type AfterLeaderboardRecordFn = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: ILeaderboardRecordEnvelope,
) => void;

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

export type MatchmakerMatchedFn = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: IMatchmakerMatchedEnvelope,
) => { matched: boolean } | null;

export interface IMatchHandler {
  matchInit?: (
    ctx: IContext,
    logger: ILogger,
    nk: INakama,
    params: { matchId: string },
  ) => { state: unknown; tickRate: number; label: string };
  matchJoinAttempt?: (
    ctx: IContext,
    logger: ILogger,
    nk: INakama,
    message: unknown,
    userId: string,
    sessionId: string,
    sessionVars: Record<string, string>,
  ) => { accept: boolean; reason?: string } | { state: unknown };
  matchJoin?: (
    ctx: IContext,
    logger: ILogger,
    nk: INakama,
    state: unknown,
    userId: string,
    sessionId: string,
    sessionVars: Record<string, string>,
  ) => { state: unknown; accepts: unknown[] };
  matchLeave?: (
    ctx: IContext,
    logger: ILogger,
    nk: INakama,
    state: unknown,
    userId: string,
    sessionId: string,
    sessionVars: Record<string, string>,
  ) => { state: unknown; accepts: unknown[] };
  matchLoop?: (
    ctx: IContext,
    logger: ILogger,
    nk: INakama,
    state: unknown,
    messageSenders: unknown[],
    tickDispatchSec: number,
  ) => { state: unknown };
  matchTerminate?: (
    ctx: IContext,
    logger: ILogger,
    nk: INakama,
    state: unknown,
    graceSec: number,
  ) => { state: unknown };
  matchSignal?: (
    ctx: IContext,
    logger: ILogger,
    nk: INakama,
    state: unknown,
    data: string,
  ) => { state: unknown; data: string | null };
}

export type ShutdownFn = () => void;

// ─── Main runtime API ──────────────────────────────────────────────────────────

export interface INakama {
  // ── Storage ──
  storageList(
    req: IStorageListRequest,
  ): { objects: IStorageObject[]; cursor: string };
  storageRead(keys: IStorageKey[]): IStorageObject[];
  storageWrite(objs: IStorageObject[]): IStorageObjectAck[];
  storageDelete(keys: IStorageKey[]): void;

  // ── Atomic multi-update (storage + wallet + ledger in a single transaction) ──
  multiUpdate(ops: IMultiUpdateOp[]): IMultiUpdateResult;

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
  leaderboardList(
    category: string,
    limit?: number,
    cursor?: string,
  ): { leaderboards: ILeaderboard[]; cursor: string };
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
  leaderboardRecordsList(
    id: string,
    ownerIds: string[],
    limit?: number,
    cursor?: string,
    sortOrder?: 'asc' | 'desc',
  ): {
    records: ILeaderboardRecord[];
    ownerRecords: ILeaderboardRecord[];
    nextCursor: string;
    prevCursor: string;
  };

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
  matchList(
    limit: number,
    authoritative: boolean,
    label: string,
    minSize: number,
    maxSize: number,
  ): { matches: IMatch[] };

  // ── Wallet ──
  walletUpdate(userId: string, changeset: Record<string, number>): Record<string, number>;
  walletsUpdate(changesets: Record<string, Record<string, number>>): Record<string, Record<string, number>>;
  walletLedgerUpdate(
    userId: string,
    changeset: Record<string, number>,
    metadata?: Record<string, unknown>,
    idempotencyKey?: string,
  ): void;
  walletLedgerList(
    userId: string,
    limit?: number,
    cursor?: string,
  ): { entries: Record<string, unknown>[]; cursor: string };

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
  version: string;
  permissionRead: number; // 0 = server-only, 1 = owner, 2 = public
  permissionWrite: number;
  createTime: string;
  updateTime: string;
  expiresAt: string | null;
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

export type IMultiUpdateOp =
  | { storage_write: IStorageObject; storage_delete?: never; wallet_update?: never; wallet_ledger_update?: never }
  | { storage_delete: IStorageKey & { version?: string }; storage_write?: never; wallet_update?: never; wallet_ledger_update?: never }
  | { wallet_update: { user_id: string; changeset: Record<string, number> }; storage_write?: never; storage_delete?: never; wallet_ledger_update?: never }
  | {
      wallet_ledger_update: {
        user_id: string;
        changeset: Record<string, number>;
        metadata?: Record<string, unknown>;
        idempotency_key?: string;
      };
      storage_write?: never;
      storage_delete?: never;
      wallet_update?: never;
    };

export interface IMultiUpdateResult {
  storage_updates: IStorageObjectAck[];
  wallet_updates: unknown[];
  ledger_updates: unknown[];
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
   * Reference: https://github.com/heroiclabs/nakama/blob/v3.27.0/server/runtime_javascript_init.go
   */
  function InitModule(ctx: IContext, logger: ILogger, initializer: IInitializer, nk: INakama): void;
}