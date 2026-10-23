// Test harness for Nakama 3.27 JS runtime RPC handlers.
//
// This file provides lightweight stand-ins for the runtime surface the
// racing-game backend actually touches (storage, localcache, account,
// hash helpers), so tests can load `modules/index.js` (the post-build
// artifact) in an isolated VM context, invoke InitModule, and then drive
// the registered RPC functions directly — without spinning up a real
// Nakama server.
//
// Reused across Chunks 5-9 of the racing-game backend.

import { createHash as cryptoCreateHash, createHmac as cryptoCreateHmac, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import type {
  IContext,
  IInitializer,
  ILeaderboard,
  ILeaderboardInfo,
  ILeaderboardRecord,
  ILeaderboardRecordList,
  ILogger,
  IMatchmakerMatchedEnvelope,
  IMatchmakerResult,
  IMultiUpdateResult,
  INakama,
  IStorageKey,
  IStorageObject,
  IStorageObjectAck,
  IUser,
  IWalletUpdate,
  IWalletUpdateResult,
  RpcFunction,
  ShutdownFn,
} from '../../modules/src/nkruntime';

/** Client `WriteLeaderboardRecord` request as seen by a before-hook. */
type LeaderboardWriteRequest = unknown;

// ─── Constants ───────────────────────────────────────────────────────────────

/** Sentinel user ID reserved by Nakama for system actions. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// ─── Storage permissions (plan T-18, D-10) ──────────────────────────────────

/** The cloud-save collections a client writes itself (`core/storage_permissions.ts`). */
const CLIENT_WRITABLE = new Set(['save', 'public']);

/**
 * Every server write must leave its object server-only: `permissionWrite`
 * 0 (an omitted field is 1 in 3.27, owner-writable). Throwing here makes
 * every e2e suite a check of D-10.
 */
function assertServerOnlyWrite(obj: IStorageObject): void {
  if (CLIENT_WRITABLE.has(obj.collection)) return;
  const write = obj.permissionWrite ?? 1;
  if (write !== 0) {
    throw new Error(`D-10: server write to ${obj.collection}/${obj.key} with permissionWrite=${String(write)} (must be 0)`);
  }
  if (obj.collection === 'analytics_events' && (obj.permissionRead ?? 1) !== 0) {
    throw new Error(`D-10: analytics_events/${obj.key} written with permissionRead=${String(obj.permissionRead ?? 1)} (must be 0)`);
  }
}

// ─── FakeContext ─────────────────────────────────────────────────────────────

/** Constant IContext value — the `_brand` is the only required discriminator. */
export const FakeContext: IContext = { _brand: 'NakamaContext' };

/**
 * Context of a Bearer-authenticated call whose session user is the identity
 * the payload declares (`callerUserId`, else `hostUserId`, else `userId`) --
 * what the Unity client sends (plan D-03 / D-05: identity comes from
 * `ctx.userId`; body fields are only cross-checked). Returns `FakeContext`
 * (no session) when the payload declares no identity.
 */
export function sessionCtxFor(payload: unknown): IContext {
  let obj: unknown = payload;
  if (typeof payload === 'string') {
    try {
      obj = JSON.parse(payload);
    } catch {
      return FakeContext;
    }
  }
  if (obj === null || typeof obj !== 'object') return FakeContext;
  const r = obj as Record<string, unknown>;
  for (const field of ['callerUserId', 'hostUserId', 'userId']) {
    const v = r[field];
    if (typeof v === 'string' && v.length > 0) return { ...FakeContext, userId: v };
  }
  return FakeContext;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Composite key for the storage map. */
function storageKeyString(k: { collection: string; key: string; userId: string }): string {
  return `${k.collection}/${k.key}/${k.userId}`;
}

/** Render an 8-digit zero-padded version, e.g. `v00000001`. */
function formatVersion(n: number): string {
  return `v${n.toString().padStart(8, '0')}`;
}

// ─── FakeLogger ──────────────────────────────────────────────────────────────

/**
 * Captures printf-style formatted messages into `lines`. `withField` and
 * `withFields` return a *new* logger whose messages are tagged with the
 * accumulated structured fields. The format string supports `%s` and `%d`
 * (matching the convention used in the existing event_bus / catalog tests);
 * richer conversions like `%v` are not implemented.
 */
export class FakeLogger implements ILogger {
  readonly lines: string[] = [];
  private readonly fields: Record<string, unknown> = {};

  private static sub(format: string, args: unknown[]): string {
    let i = 0;
    return format.replace(/%[sd]/g, () => String(args[i++] ?? ''));
  }

  private formatLine(format: string, args: unknown[]): string {
    const substituted = FakeLogger.sub(format, args);
    const keys = Object.keys(this.fields);
    if (keys.length === 0) return substituted;
    const tag = keys.map((k) => `${k}=${String(this.fields[k])}`).join(' ');
    return `${substituted} {${tag}}`;
  }

  debug(format: string, ...args: unknown[]): void {
    this.lines.push(this.formatLine(format, args));
  }
  info(format: string, ...args: unknown[]): void {
    this.lines.push(this.formatLine(format, args));
  }
  warn(format: string, ...args: unknown[]): void {
    this.lines.push(this.formatLine(format, args));
  }
  error(format: string, ...args: unknown[]): void {
    this.lines.push(this.formatLine(format, args));
  }

  withField(_format: string, key: string, value: unknown): FakeLogger {
    const child = new FakeLogger();
    Object.assign(child.fields, this.fields, { [key]: value });
    return child;
  }

  withFields(_format: string, fields: Record<string, unknown>): FakeLogger {
    const child = new FakeLogger();
    Object.assign(child.fields, this.fields, fields);
    return child;
  }

  getFields(): Record<string, unknown> {
    return { ...this.fields };
  }
}

// ─── FakeNakama ──────────────────────────────────────────────────────────────

/**
 * Concrete implementation of the INakama surface the race module uses.
 * Lives in a separate class so the Proxy that throws on unknown methods
 * has a real backing object to forward to.
 */
/** Identities linked to a fake account (`accountGetId` fields). */
export interface FakeIdentities {
  appleId?: string;
  googleId?: string;
  facebookId?: string;
  facebookInstantGameId?: string;
  gamecenterId?: string;
  steamId?: string;
  email?: string;
  customId?: string;
  devices?: string[];
}

class FakeNakamaCore {
  readonly store = new Map<string, IStorageObject>();
  readonly cache = new Map<string, unknown>();
  readonly users = new Map<string, IUser>();
  /** userId → currency balances. Lazily populated by walletUpdate. */
  readonly wallets = new Map<string, Record<string, number>>();
  /** userId → ledger entries (oldest first). Appended by wallet updates with `updateLedger`. */
  readonly ledger = new Map<string, Record<string, unknown>[]>();
  /**
   * userId → identities linked natively (what `accountGetId` reports).
   * Tests link with `FakeNakama.linkIdentity`, standing in for the
   * client's `LinkGoogleAsync` & co. (plan T-15).
   */
  readonly identities = new Map<string, FakeIdentities>();
  /** Accounts removed by `accountDeleteId`: `accountGetId` throws for them. */
  readonly deletedAccounts = new Set<string>();
  private versionCounter = 0;

  storageRead(keys: IStorageKey[]): IStorageObject[] {
    const result: IStorageObject[] = [];
    for (const k of keys) {
      const obj = this.store.get(storageKeyString(k));
      if (obj !== undefined) result.push(obj);
    }
    return result;
  }

  storageWrite(objs: IStorageObject[]): IStorageObjectAck[] {
    // Like v3.27.0: the batch is one transaction, a `version` must match
    // (`*` = must not exist), and nothing is written when one fails.
    for (const obj of objs) {
      assertServerOnlyWrite(obj);
      const cur = this.store.get(storageKeyString(obj));
      const v = obj.version;
      if (v === '*' ? cur !== undefined : (v !== undefined && v !== '' && cur?.version !== v)) {
        throw new Error('Storage write rejected - version check failed.');
      }
    }
    const acks: IStorageObjectAck[] = [];
    const now = new Date().toISOString();
    for (const obj of objs) {
      this.versionCounter += 1;
      const version = formatVersion(this.versionCounter);
      const stored: IStorageObject = {
        collection: obj.collection,
        key: obj.key,
        userId: obj.userId,
        value: obj.value,
        version,
        // v3.27.0 defaults an omitted permission to 1 (owner).
        permissionRead: obj.permissionRead ?? 1,
        permissionWrite: obj.permissionWrite ?? 1,
        createTime: now,
        updateTime: now,
        expiresAt: obj.expiresAt ?? null,
      };
      this.store.set(storageKeyString(obj), stored);
      acks.push({
        collection: obj.collection,
        key: obj.key,
        userId: obj.userId,
        version,
      });
    }
    return acks;
  }

  storageDelete(keys: IStorageKey[]): void {
    for (const k of keys) {
      this.store.delete(storageKeyString(k));
    }
  }

  /**
   * Positional, like the v3.27.0 JS binding. Rejects the object form the
   * real runtime rejects ("expects string", audit N7), so a regression to
   * `nk.storageList({...})` fails the e2e suite instead of production.
   */
  storageList(
    userId: string | null | undefined,
    collection: string,
    limit?: number,
    cursor?: string | null,
  ): { objects: IStorageObject[]; cursor: string | null } {
    if (userId !== null && userId !== undefined && typeof userId !== 'string') {
      throw new TypeError('expects string');
    }
    if (typeof collection !== 'string') throw new TypeError('expects string');
    const objs: IStorageObject[] = [];
    for (const obj of this.store.values()) {
      if (obj.collection !== collection) continue;
      if (userId !== null && userId !== undefined && obj.userId !== userId) continue;
      objs.push(obj);
    }
    // Pages like v3.27.0 (default limit 100); the cursor is an opaque offset.
    const size = limit === undefined || limit === null ? 100 : limit;
    const from = cursor !== undefined && cursor !== null && cursor !== '' ? Number(cursor) : 0;
    const page = objs.slice(from, from + size);
    const next = from + size < objs.length ? String(from + size) : null;
    return { objects: page, cursor: next };
  }

  localcacheGet<T>(key: string): T | null {
    return this.cache.has(key) ? (this.cache.get(key) as T) : null;
  }

  localcachePut<T>(key: string, value: T, _ttlSec?: number): void {
    this.cache.set(key, value);
  }

  localcacheDelete(key: string): void {
    this.cache.delete(key);
  }

  localcacheClear(): void {
    this.cache.clear();
  }

  // ── Wallet ── (mirrors the v3.27.0 JS bindings, `runtime_javascript_nakama.go`)
  /**
   * Apply a signed changeset. Like production, a balance that would go
   * negative throws "wallet update rejected negative value at path '<id>'"
   * and changes nothing; with `updateLedger` a ledger row is appended.
   * Returns `{ userId, updated, previous }`.
   */
  walletUpdate(
    userId: string,
    changeset: Record<string, number>,
    metadata?: Record<string, unknown>,
    updateLedger?: boolean,
  ): IWalletUpdateResult {
    const [result] = this.applyWalletUpdates([{ userId, changeset, ...(metadata ? { metadata } : {}) }], updateLedger === true);
    return result as IWalletUpdateResult;
  }

  walletsUpdate(updates: IWalletUpdate[], updateLedger?: boolean): IWalletUpdateResult[] {
    return this.applyWalletUpdates(updates, updateLedger === true);
  }

  /**
   * Production semantics: merge `metadata` into the EXISTING ledger row
   * `itemId`; an unknown id fails like Postgres does ("sql: no rows in
   * result set"). It never moves money.
   */
  walletLedgerUpdate(itemId: string, metadata: Record<string, unknown>): Record<string, unknown> {
    for (const bucket of this.ledger.values()) {
      const row = bucket.find((r) => r['id'] === itemId);
      if (row) {
        row['metadata'] = { ...(row['metadata'] as Record<string, unknown>), ...metadata };
        return { ...row };
      }
    }
    throw new Error('failed to update user wallet ledger: sql: no rows in result set');
  }

  /**
   * Newest first, like production (`{ items, cursor }`; the stub does
   * not paginate).
   */
  walletLedgerList(
    userId: string,
    limit?: number,
    _cursor?: string,
  ): { items: Record<string, unknown>[]; cursor: string | null } {
    const bucket = (this.ledger.get(userId) ?? []).slice().reverse();
    const slice = limit !== undefined ? bucket.slice(0, limit) : bucket;
    return { items: slice.map((r) => ({ ...r })), cursor: null };
  }

  /**
   * One transaction, like production: every storage version is checked
   * (`*` = must not exist, any other = must match) and every wallet
   * update is computed before anything is applied, so a lost CAS or a
   * negative balance changes nothing ("version check failed" /
   * "rejected negative value").
   */
  multiUpdate(
    _accountUpdates: unknown,
    storageWrites: IStorageObject[] | undefined,
    _storageDeletes: unknown,
    walletUpdates: IWalletUpdate[] | undefined,
    updateLedger: boolean | undefined,
  ): IMultiUpdateResult {
    for (const obj of storageWrites ?? []) {
      assertServerOnlyWrite(obj);
      const cur = this.store.get(storageKeyString(obj));
      const v = obj.version;
      if (v === '*' ? cur !== undefined : (v !== undefined && v !== '' && cur?.version !== v)) {
        throw new Error('error running multi update: Storage write rejected - version check failed.');
      }
    }
    // Computes (and validates) the wallets first; applies them below.
    const planned = this.planWalletUpdates(walletUpdates ?? []);

    const storageWriteAcks: IStorageObjectAck[] = [];
    const now = new Date().toISOString();
    for (const obj of storageWrites ?? []) {
      this.versionCounter += 1;
      const version = formatVersion(this.versionCounter);
      const stored: IStorageObject = {
        collection: obj.collection,
        key: obj.key,
        userId: obj.userId,
        value: obj.value,
        version,
        permissionRead: obj.permissionRead ?? 1,
        permissionWrite: obj.permissionWrite ?? 1,
        createTime: now,
        updateTime: now,
        expiresAt: obj.expiresAt ?? null,
      };
      this.store.set(storageKeyString(obj), stored);
      storageWriteAcks.push({
        collection: obj.collection,
        key: obj.key,
        userId: obj.userId,
        version,
      });
    }
    const walletUpdateAcks = this.commitWalletUpdates(planned, updateLedger === true);
    return { storageWriteAcks, walletUpdateAcks };
  }

  private applyWalletUpdates(updates: IWalletUpdate[], updateLedger: boolean): IWalletUpdateResult[] {
    return this.commitWalletUpdates(this.planWalletUpdates(updates), updateLedger);
  }

  /** Sequential per user, as in `updateWallets`; throws before any write. */
  private planWalletUpdates(updates: IWalletUpdate[]): Array<{ update: IWalletUpdate; result: IWalletUpdateResult }> {
    const working = new Map<string, Record<string, number>>();
    const out: Array<{ update: IWalletUpdate; result: IWalletUpdateResult }> = [];
    for (const update of updates) {
      const before = working.get(update.userId) ?? { ...(this.wallets.get(update.userId) ?? {}) };
      const after = { ...before };
      for (const [currency, delta] of Object.entries(update.changeset)) {
        if (typeof delta !== 'number' || !Number.isInteger(delta)) {
          throw new TypeError('expects changeset values to be whole numbers');
        }
        const next = (after[currency] ?? 0) + delta;
        if (next < 0) {
          throw new Error(`error running multi update: wallet update rejected negative value at path '${currency}'`);
        }
        after[currency] = next;
      }
      working.set(update.userId, after);
      out.push({ update, result: { userId: update.userId, previous: { ...before }, updated: { ...after } } });
    }
    return out;
  }

  private commitWalletUpdates(
    planned: Array<{ update: IWalletUpdate; result: IWalletUpdateResult }>,
    updateLedger: boolean,
  ): IWalletUpdateResult[] {
    for (const { update, result } of planned) {
      // A new object per update: a balance a test read earlier stays a
      // snapshot (the old stub mutated the map entry in place, audit 05 f14).
      this.wallets.set(update.userId, { ...result.updated });
      if (updateLedger) {
        let bucket = this.ledger.get(update.userId);
        if (!bucket) {
          bucket = [];
          this.ledger.set(update.userId, bucket);
        }
        bucket.push({
          id: randomUUID(),
          userId: update.userId,
          changeset: { ...update.changeset },
          metadata: { ...(update.metadata ?? {}) },
          createTime: Math.floor(Date.now() / 1000),
          updateTime: Math.floor(Date.now() / 1000),
        });
      }
    }
    return planned.map((p) => p.result);
  }

  /** 3.27 `md5Hash`: lower-case hex (T-25, LevelPlay signatures). */
  md5Hash(input: string): string {
    return cryptoCreateHash('md5').update(input, 'utf8').digest('hex');
  }

  sha256Hash(input: string): string {
    return cryptoCreateHash('sha256').update(input).digest('hex');
  }

  uuidv4(): string {
    return randomUUID();
  }

  hmacSha256Hash(input: string, key: string): string {
    // Real Nakama returns the raw HMAC bytes via goja `ArrayBuffer`;
    // `r.ToValue(r.NewArrayBuffer(mac.Sum(nil)))`. The .d.ts type says
    // `string` (which the runtime-side verifier treats as a Uint8Array
    // via goja's array-buffer passthrough). The verifier normalises via
    // `bytesToBase64Url` regardless of whether it received raw bytes or
    // a string.
    //
    // The test stub returns base64url so the verifier's byte-detection
    // path is exercised by a stable ASCII form. The string compares
    // directly against the token's base64url signature, so both sides
    // must agree on the encoding.
    return cryptoCreateHmac('sha256', key).update(input).digest('base64url');
  }

  base64UrlEncode(input: string): string {
    return Buffer.from(input, 'utf8').toString('base64url');
  }

  base64UrlDecode(input: string): string {
    return Buffer.from(input, 'base64url').toString('utf8');
  }

  // ── HTTP ──
  /**
   * Outbound HTTP via the Nakama runtime. In production this is a
   * synchronous goja call into `runtime_javascript.go`. In tests we
   * capture every invocation in `httpRequests` and return a default
   * `{code: 204, content: '', headers: {}}` so the caller sees the
   * happy path. Tests can override `httpResponse` (and
   * `httpRequestThrow`) to simulate failure modes.
   */
  readonly httpRequests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  httpResponse: { code: number; content: string; headers: Record<string, string> } = {
    code: 204, content: '', headers: {},
  };
  /** When set, `httpRequest` throws instead of returning — for failure tests. */
  httpRequestThrow: Error | null = null;
  httpRequest(
    url: string,
    method: string,
    headers: Record<string, string> = {},
    body = '',
  ): { code: number; body: string; headers: Record<string, string[]> } {
    this.httpRequests.push({ url, method, headers, body });
    if (this.httpRequestThrow !== null) throw this.httpRequestThrow;
    // 3.27 shape (T-24): the response text is `body`; header values are arrays.
    const h: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(this.httpResponse.headers)) h[k] = [v];
    return { code: this.httpResponse.code, body: this.httpResponse.content, headers: h };
  }

  // ── Leaderboards ──
  /** id → leaderboard. Created via `leaderboardCreate`. */
  readonly leaderboards = new Map<string, ILeaderboard>();
  /** id → map(ownerId → record). Populated via `leaderboardRecordWrite`. */
  readonly leaderboardRecords = new Map<string, Map<string, ILeaderboardRecord>>();
  /** ids that have been deleted via `leaderboardDelete` (so we can re-delete safely). */
  readonly deletedLeaderboards = new Set<string>();
  /**
   * Installed before-hook for leaderboardRecordWrite. Tests can replace
   * this with their own function (e.g. to assert it's called).
   * Signature mirrors IInitializer.registerBeforeWriteLeaderboardRecord.
   */
  beforeLeaderboardRecordWrite:
    | ((ctx: unknown, logger: ILogger, nk: INakama, envelope: LeaderboardWriteRequest) => void)
    | null = null;

  /** Matches created via `matchCreate` (module name + params). */
  readonly createdMatches: Array<{ matchId: string; module: string; params: Record<string, unknown> }> = [];

  matchCreate(module: string, params?: Record<string, unknown>): string {
    const matchId = `fake-match-${this.createdMatches.length + 1}.nakama`;
    this.createdMatches.push({ matchId, module, params: params ?? {} });
    return matchId;
  }

  /** v3.27 shape: an array; `label` filters on the exact label. */
  matchList(
    _limit: number,
    _authoritative?: boolean | null,
    label?: string | null,
  ): Array<{ matchId: string; authoritative: boolean; size: number; label: string | null }> {
    return this.createdMatches
      .filter((m) => label === undefined || label === null || m.module === label)
      .map((m) => ({ matchId: m.matchId, authoritative: true, size: 0, label: m.module }));
  }

  leaderboardCreate(
    id: string,
    authoritative: boolean,
    sortOrder: 'asc' | 'ascending' | 'desc' | 'descending',
    operator: 'best' | 'set' | 'incr' | 'decr',
    resetSchedule: string,
    metadata: Record<string, unknown>,
    _enableRanks: boolean,
  ): { leaderboard: ILeaderboard; created: boolean } {
    const existing = this.leaderboards.get(id);
    if (existing !== undefined) {
      // Re-creating with the same id is a no-op (matches INSERT-IF-NOT-EXISTS).
      return { leaderboard: existing, created: false };
    }
    const lb = {
      id,
      authoritative,
      sortOrder: sortOrder === 'desc' || sortOrder === 'descending' ? 'desc' : 'asc',
      operator,
      resetSchedule,
      metadata,
    } as unknown as ILeaderboard;
    this.leaderboards.set(id, lb);
    this.deletedLeaderboards.delete(id);
    return { leaderboard: lb, created: true };
  }

  leaderboardDelete(id: string): void {
    if (!this.leaderboards.has(id) && !this.deletedLeaderboards.has(id)) {
      throw new Error(`leaderboard not found: ${id}`);
    }
    this.leaderboards.delete(id);
    this.leaderboardRecords.delete(id);
    this.deletedLeaderboards.add(id);
  }

  /** 3.27: `leaderboardList(limit 1-100, cursor)`; one page, `cursor` null. */
  leaderboardList(limit?: number, _cursor?: string): { leaderboards: ILeaderboard[]; cursor: string | null } {
    if (limit !== undefined && (typeof limit !== 'number' || limit < 1 || limit > 100)) {
      throw new TypeError('limit must be 1-100');
    }
    return { leaderboards: Array.from(this.leaderboards.values()), cursor: null };
  }

  /** 3.27 shape: sortOrder 0 asc / 1 desc, operator by its proto name. Unknown ids are skipped. */
  leaderboardsGetId(ids: string[]): ILeaderboardInfo[] {
    const opName: Record<string, string> = { best: 'best', set: 'set', incr: 'increment', decr: 'decrement' };
    const out: ILeaderboardInfo[] = [];
    for (const id of ids) {
      const lb = this.leaderboards.get(id) as unknown as
        | { id: string; sortOrder: string; operator: string; metadata: Record<string, unknown>; authoritative: boolean }
        | undefined;
      if (!lb) continue;
      out.push({
        id,
        sortOrder: lb.sortOrder === 'desc' ? 1 : 0,
        operator: opName[lb.operator] ?? lb.operator,
        metadata: lb.metadata,
        createTime: 0,
        authoritative: lb.authoritative,
      });
    }
    return out;
  }

  /**
   * Simulate the runtime's weekly reset: drop every record on the
   * given table.  Only operates on tables that  exist (  so a missing
   * id throws — same as the Go runtime). The leaderboard definition
   * itself is left in place; only records are cleared.
   */
  leaderboardReset(id: string): void {
    if (!this.leaderboards.has(id)) {
      throw new Error(`leaderboardReset: unknown leaderboard "${id}"`);
    }
    this.leaderboardRecords.delete(id);
  }

  leaderboardRecordWrite(
    id: string,
    ownerId: string,
    username: string,
    score: number,
    subscore: number,
    metadata: Record<string, unknown>,
    operatorOverride?: 'best' | 'set' | 'incr' | 'decr',
  ): { record: ILeaderboardRecord } {
    const lb = this.leaderboards.get(id);
    if (!lb) {
      throw new Error(`leaderboardRecordWrite: unknown leaderboard "${id}"`);
    }
    const prev = this.leaderboardRecords.get(id)?.get(ownerId);
    const operator = operatorOverride ?? (lb.operator as unknown as string);
    const desc = this.isDesc(id);

    // Honor the operator: 'best' keeps the better score for the table's
    // order, 'incr' adds, 'set' replaces.
    let next = score;
    if (operator === 'best' && prev !== undefined) {
      const better = desc ? score > prev.score : score < prev.score;
      if (!better) {
        return { record: prev };
      }
      next = score;
    } else if (operator === 'incr' && prev !== undefined) {
      next = prev.score + score;
    } else if (operator === 'decr' && prev !== undefined) {
      next = prev.score - score;
    }

    const now = new Date().toISOString();
    const rec: ILeaderboardRecord = {
      leaderboardId: id,
      ownerId,
      // 3.27 stores '' as NULL and keeps the previous name (COALESCE).
      username: username !== '' ? username : prev?.username ?? null,
      score: next,
      subscore,
      numScore: (prev?.numScore ?? 0) + 1,
      metadata,
      createTime: prev?.createTime ?? now,
      updateTime: now,
      expiryTime: null,
      rank: null,
      maxNumScore: 1,
    };
    let bucket = this.leaderboardRecords.get(id);
    if (!bucket) {
      bucket = new Map();
      this.leaderboardRecords.set(id, bucket);
    }
    bucket.set(ownerId, rec);
    return { record: rec };
  }

  leaderboardRecordDelete(id: string, ownerId: string): void {
    this.leaderboardRecords.get(id)?.delete(ownerId);
  }

  /**
   * 3.27 semantics: the table's own order (score, subscore, owner id),
   * ranks from 1, `limit` 0/absent → no page (only `ownerRecords`),
   * opaque cursors, `rankCount`, and "leaderboard not found" for an
   * unknown table. The 5th argument is `overrideExpiry` (ignored).
   */
  leaderboardRecordsList(
    id: string,
    ownerIds: string[] | null,
    limit?: number,
    cursor?: string,
    _overrideExpiry?: number,
  ): ILeaderboardRecordList {
    const sorted = this.rankedRecords(id);
    let records: ILeaderboardRecord[] = [];
    let nextCursor: string | null = null;
    let prevCursor: string | null = null;
    if (limit !== undefined && limit !== null && limit !== 0) {
      const start = this.cursorStart(id, cursor ?? '');
      records = sorted.slice(start, start + limit);
      nextCursor = start + limit < sorted.length ? this.cursorAt(id, start + limit) : null;
      prevCursor = start > 0 ? this.cursorAt(id, Math.max(0, start - limit)) : null;
    }
    const owners = new Set(ownerIds ?? []);
    const ownerRecords = sorted.filter((r) => owners.has(r.ownerId));
    return { records, ownerRecords, nextCursor, prevCursor, rankCount: sorted.length };
  }

  /** 3.27 `getLeaderboardRecordsHaystack` window (no cursor); empty when the owner has no record. */
  leaderboardRecordsHaystack(
    id: string,
    ownerId: string,
    limit = 10,
    cursor?: string,
    _overrideExpiry?: number,
  ): ILeaderboardRecordList {
    if (limit < 1 || limit > 100) throw new TypeError('limit must be 1-100');
    if (cursor) return this.leaderboardRecordsList(id, [], limit, cursor);
    const sorted = this.rankedRecords(id);
    const idx = sorted.findIndex((r) => r.ownerId === ownerId);
    if (idx === -1) {
      return { records: [], ownerRecords: [], nextCursor: null, prevCursor: null, rankCount: 0 };
    }
    const above = sorted.slice(Math.max(0, idx - limit), idx);
    let secondLimit = Math.floor(limit / 2);
    if (above.length < secondLimit) secondLimit = limit - above.length;
    const below = sorted.slice(idx + 1, idx + 1 + secondLimit);
    const window = [...above, sorted[idx]!, ...below];
    let start = window.length - limit;
    if (start < 0 || above.length < secondLimit) start = 0;
    const records = window.slice(start, start + limit);
    const first = sorted.indexOf(records[0]!);
    const last = sorted.indexOf(records[records.length - 1]!);
    return {
      records,
      ownerRecords: [],
      nextCursor: last + 1 < sorted.length ? this.cursorAt(id, last + 1) : null,
      prevCursor: first > 0 ? this.cursorAt(id, Math.max(0, first - limit)) : null,
      rankCount: sorted.length,
    };
  }

  /** 3.27 `usersGetId`: every non-system id is an account named `name-<id>` unless `users` says otherwise. */
  usersGetId(userIds: string[]): IUser[] {
    const now = new Date().toISOString();
    return userIds
      .filter((id) => id !== SYSTEM_USER_ID)
      .map((id) => this.users.get(id) ?? {
        userId: id,
        username: `name-${id}`,
        createTime: now,
        updateTime: now,
        disableTime: null,
        metadata: {},
      } as unknown as IUser);
  }

  private isDesc(id: string): boolean {
    const lb = this.leaderboards.get(id) as unknown as { sortOrder: string } | undefined;
    return lb?.sortOrder === 'desc';
  }

  /** Every record of `id` in table order with its rank; throws like 3.27 for an unknown table. */
  private rankedRecords(id: string): ILeaderboardRecord[] {
    if (!this.leaderboards.has(id)) {
      throw new Error('error listing leaderboard records: leaderboard not found');
    }
    const sign = this.isDesc(id) ? -1 : 1;
    const records = Array.from(this.leaderboardRecords.get(id)?.values() ?? []);
    records.sort((a, b) => {
      if (a.score !== b.score) return sign * (a.score - b.score);
      if (a.subscore !== b.subscore) return sign * (a.subscore - b.subscore);
      return sign * (a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0);
    });
    return records.map((r, i) => ({ ...r, rank: i + 1 }));
  }

  private cursorAt(id: string, index: number): string {
    return Buffer.from(JSON.stringify({ id, index })).toString('base64');
  }

  private cursorStart(id: string, cursor: string): number {
    if (cursor === '') return 0;
    let parsed: { id?: unknown; index?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as { id?: unknown; index?: unknown };
    } catch {
      throw new Error('error listing leaderboard records: invalid cursor');
    }
    if (parsed.id !== id || typeof parsed.index !== 'number') {
      throw new Error('error listing leaderboard records: invalid cursor');
    }
    return parsed.index;
  }

  // ── Groups (for clubs) — v3.27.0 semantics (core_group.go) ──
  /** groupId → IGroup. Populated via `groupCreate`. */
  readonly groups = new Map<string, IGroup>();
  /**
   * groupId → member userIds in join order. Populated via `groupCreate`
   * (the creator, superadmin) and `groupUsersAdd`.
   */
  readonly groupMembers = new Map<string, Set<string>>();
  /** groupId → userId → state (0 superadmin, 1 admin, 2 member). */
  readonly groupStates = new Map<string, Map<string, number>>();

  private groupCounter = 0;

  private touchGroup(id: string): IGroup {
    const g = this.groups.get(id);
    if (!g) throw new Error('group not found');
    g.edgeCount = this.groupMembers.get(id)?.size ?? 0;
    return g;
  }

  groupCreate(
    userId: string,
    name: string,
    creatorId?: string | null,
    langTag?: string | null,
    description?: string | null,
    avatarUrl?: string | null,
    open?: boolean | null,
    metadata?: Record<string, unknown> | null,
    maxCount?: number | null,
  ): IGroup {
    // 3.27 parses the first argument as the superadmin's user id (the old
    // call passed the club name there and threw on the real runtime).
    if (typeof userId !== 'string' || userId.length === 0 || /\s/.test(userId)) {
      throw new TypeError('expects user ID to be a valid identifier');
    }
    if (!name) throw new TypeError('expects group name to not be empty');
    for (const g of this.groups.values()) {
      if (g.name.toLowerCase() === name.toLowerCase()) {
        throw new Error('did not create group as a group already exists with the same name');
      }
    }
    this.groupCounter += 1;
    const id = `grp-${this.groupCounter.toString().padStart(8, '0')}`;
    const group: IGroup = {
      id,
      creatorId: creatorId ?? SYSTEM_USER_ID,
      name,
      description: description ?? '',
      avatarUrl: avatarUrl ?? '',
      langTag: langTag ?? '',
      metadata: { ...(metadata ?? {}) },
      open: open === true,
      edgeCount: 1,
      maxCount: maxCount ?? 100,
      createTime: Math.floor(Date.now() / 1000),
      updateTime: Math.floor(Date.now() / 1000),
    };
    this.groups.set(id, group);
    this.groupMembers.set(id, new Set<string>([userId]));
    this.groupStates.set(id, new Map<string, number>([[userId, 0]]));
    return { ...group };
  }

  groupsGetId(groupIds: string[]): IGroup[] {
    return groupIds
      .filter((id) => this.groups.has(id))
      .map((id) => ({ ...this.touchGroup(id) }));
  }

  /** Cursor = base64 offset; state 0 first, then join order (like `ORDER BY state, position`). */
  groupUsersList(groupId: string, limit?: number, state?: number | null, cursor?: string | null): unknown {
    const n = limit ?? 100;
    if (n < 1 || n > 10000) throw new TypeError('expects limit to be 1-10000');
    if (!this.groups.has(groupId)) return { groupUsers: [], cursor: null };
    const states = this.groupStates.get(groupId)!;
    const order = Array.from(this.groupMembers.get(groupId) ?? [])
      .map((userId, position) => ({ userId, position, state: states.get(userId) ?? 2 }))
      .filter((e) => state === undefined || state === null || state === -1 || e.state === state)
      .sort((a, b) => a.state - b.state || a.position - b.position);
    const start = cursor ? Number(Buffer.from(cursor, 'base64').toString('utf8')) : 0;
    const page = order.slice(start, start + n);
    const users = this.usersGetId(page.map((e) => e.userId));
    const groupUsers = page.map((e, i) => ({
      user: { userId: e.userId, username: (users[i] as unknown as { username?: string })?.username ?? `name-${e.userId}` },
      state: e.state,
    }));
    const next = start + page.length < order.length ? Buffer.from(String(start + page.length)).toString('base64') : null;
    return { groupUsers, cursor: next };
  }

  /** ILIKE name pattern (`%` wildcard); cursor = base64 offset over name order. */
  groupsList(
    name?: string | null,
    langTag?: string | null,
    open?: boolean | null,
    edgeCount?: number | null,
    limit?: number,
    cursor?: string | null,
  ): unknown {
    if (name && (langTag || (open !== undefined && open !== null) || (edgeCount !== undefined && edgeCount !== null && edgeCount > -1))) {
      throw new Error('error listing groups: name filter cannot be combined with any other filter');
    }
    const n = limit ?? 100;
    if (n < 1 || n > 100) throw new TypeError('expects limit to be 1-100');
    let list = Array.from(this.groups.keys()).map((id) => this.touchGroup(id));
    if (name) {
      const trimmed = name.replace(/^[% ]+/, '');
      const escaped = trimmed.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
      const re = new RegExp(`^${escaped}$`);
      list = list.filter((g) => re.test(g.name.toLowerCase()));
      list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    let start = 0;
    if (cursor) {
      start = Number(Buffer.from(cursor, 'base64').toString('utf8'));
      if (!Number.isInteger(start)) throw new Error('error listing groups: Malformed cursor was used.');
    }
    const page = list.slice(start, start + n).map((g) => ({ ...g }));
    const next = start + page.length < list.length ? Buffer.from(String(start + page.length)).toString('base64') : null;
    return { groups: page, cursor: next };
  }

  groupDelete(groupId: string): void {
    this.groups.delete(groupId);
    this.groupMembers.delete(groupId);
    this.groupStates.delete(groupId);
  }

  groupUpdate(
    groupId: string,
    _userId: string | null,
    name?: string | null,
    _creatorId?: string | null,
    _langTag?: string | null,
    description?: string | null,
    _avatarUrl?: string | null,
    open?: boolean | null,
    metadata?: Record<string, unknown> | null,
  ): void {
    const g = this.groups.get(groupId);
    if (!g) throw new Error('group not found');
    if (name) g.name = name;
    if (description) g.description = description;
    if (metadata) g.metadata = metadata;
    if (open !== undefined && open !== null) g.open = open;
  }

  /** System add: no permission check, `maxCount` enforced (ErrGroupFull). */
  groupUsersAdd(groupId: string, userIds: string[], _callerId?: string | null): void {
    const g = this.groups.get(groupId);
    if (!g) throw new Error('error while trying to add users into group: group not found');
    const bucket = this.groupMembers.get(groupId)!;
    const states = this.groupStates.get(groupId)!;
    const fresh = userIds.filter((id) => !bucket.has(id));
    if (bucket.size + fresh.length > g.maxCount) {
      throw new Error('error while trying to add users into group: group is full');
    }
    for (const id of fresh) {
      bucket.add(id);
      states.set(id, 2);
    }
  }

  groupUsersKick(groupId: string, userIds: string[], _callerId?: string | null): void {
    const bucket = this.groupMembers.get(groupId);
    const states = this.groupStates.get(groupId);
    if (!bucket || !states) throw new Error('error while trying to kick users from a group: group not found');
    for (const id of userIds) {
      const otherSuper = Array.from(states.entries()).some(([u, st]) => u !== id && st === 0);
      if (states.get(id) === 0 && !otherSuper) {
        throw new Error('error while trying to kick users from a group: cannot kick the last superadmin');
      }
      bucket.delete(id);
      states.delete(id);
    }
  }

  groupUsersPromote(groupId: string, userIds: string[], _callerId?: string | null): void {
    const states = this.groupStates.get(groupId);
    if (!states) throw new Error('group not found');
    for (const id of userIds) {
      const st = states.get(id);
      if (st !== undefined && st > 0) states.set(id, st - 1);
    }
  }

  groupUsersDemote(groupId: string, userIds: string[], _callerId?: string | null): void {
    const states = this.groupStates.get(groupId);
    if (!states) throw new Error('group not found');
    for (const id of userIds) {
      const st = states.get(id);
      if (st !== undefined && st < 2) states.set(id, st + 1);
    }
  }

  /**
   * 3.27 shape (`accountToJsObject`): `user` with the provider ids,
   * `wallet`, `email`, `customId`, `devices`. The flat `userId` /
   * `username` of the older stub stay for callers that read them.
   */
  accountGetId(userId: string): unknown {
    if (userId === SYSTEM_USER_ID) return null;
    if (this.deletedAccounts.has(userId)) throw new Error('error getting account: user not found');
    const now = new Date().toISOString();
    // The IUser d.ts declares `disableTime: true` (literal), but the real
    // Nakama JS runtime returns a unix-seconds number or null. The spec
    // for this stub asks for `null`; we cast through `unknown` to satisfy
    // the type without lying at runtime.
    const wallet = this.wallets.get(userId);
    const ids = this.identities.get(userId) ?? {};
    const user: Record<string, unknown> = { userId, username: 'fake-user', displayName: '', createTime: 0, updateTime: 0 };
    for (const f of ['appleId', 'googleId', 'facebookId', 'facebookInstantGameId', 'gamecenterId', 'steamId'] as const) {
      if (ids[f] !== undefined) user[f] = ids[f];
    }
    const fake = {
      userId,
      username: 'fake-user',
      createTime: now,
      updateTime: now,
      disableTime: null,
      metadata: {},
      wallet: wallet ? { ...wallet } : {},
      user,
      ...(ids.email !== undefined ? { email: ids.email } : {}),
      ...(ids.customId !== undefined ? { customId: ids.customId } : {}),
      ...(ids.devices !== undefined ? { devices: ids.devices.map((id) => ({ id })) } : {}),
    };
    return fake;
  }

  /** 3.27 `linkCustom(userId, customId)`: "already in use" when another account owns it. */
  linkCustom(userId: string, customId: string): void {
    this.linkIdentity(userId, 'customId', customId);
  }

  /** Native link (test helper). Throws like 3.27 when another account owns the identity. */
  linkIdentity(userId: string, field: keyof FakeIdentities, value: string): void {
    for (const [owner, ids] of this.identities) {
      if (owner === userId) continue;
      const v = ids[field];
      if (v === value || (Array.isArray(v) && v.includes(value))) {
        throw new Error('error linking: identity is already in use.');
      }
    }
    const ids = this.identities.get(userId) ?? {};
    if (field === 'devices') ids.devices = [...(ids.devices ?? []), value];
    else ids[field] = value;
    this.identities.set(userId, ids);
  }

  /** Owner of an identity (test helper, like an `authenticate*` with `create: false`). */
  findIdentityOwner(field: keyof FakeIdentities, value: string): string | null {
    for (const [owner, ids] of this.identities) {
      const v = ids[field];
      if (v === value || (Array.isArray(v) && v.includes(value))) return owner;
    }
    return null;
  }

  /**
   * Like 3.27 `DeleteAccount`: the user row (identities), wallet, ledger,
   * owned storage (FK cascade), leaderboard records and group edges.
   */
  accountDeleteId(userId: string, _recorded: boolean): void {
    this.wallets.delete(userId);
    this.ledger.delete(userId);
    this.users.delete(userId);
    this.identities.delete(userId);
    this.deletedAccounts.add(userId);
    for (const k of Array.from(this.store.keys())) {
      if (k.endsWith(`/${userId}`)) this.store.delete(k);
    }
    for (const records of this.leaderboardRecords.values()) records.delete(userId);
    // GroupDeleteAll: a group whose only superadmin goes is deleted.
    for (const [gid, members] of Array.from(this.groupMembers.entries())) {
      if (!members.has(userId)) continue;
      const states = this.groupStates.get(gid)!;
      const otherSuper = Array.from(states.entries()).some(([u, st]) => u !== userId && st === 0);
      if (states.get(userId) === 0 && !otherSuper) {
        this.groupDelete(gid);
      } else {
        members.delete(userId);
        states.delete(userId);
      }
    }
  }
}

/**
 * Wrap any object in a Proxy that returns `Reflect.get(target, prop)` for
 * known properties and a throwing function for unknown ones — so accidental
 * dependencies on un-stubbed INakama surface fail loudly.
 */
function wrapWithNotStubbedThrow<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, _receiver) {
      if (typeof prop === 'symbol' || prop in t) {
        return Reflect.get(t, prop);
      }
      return () => {
        throw new Error(`not stubbed: ${String(prop)}`);
      };
    },
  });
}

/**
 * In-memory stub for the runtime surface the race module uses.
 *
 * Construction creates a fresh, isolated backing store. Use `.nakama`
 * as the INakama to pass into InitModule / RPC handlers; use `.store`,
 * `.cache`, and `.users` for test assertions on persisted state.
 */
export class FakeNakama {
  /** Persisted storage objects, keyed by `collection/key/userId`. */
  readonly store: Map<string, IStorageObject>;
  /** Localcache map (TTL ignored). */
  readonly cache: Map<string, unknown>;
  /** Fake user accounts keyed by userId. */
  readonly users: Map<string, IUser>;
  /** userId → wallet balances. Populated by `walletUpdate`. */
  readonly wallets: Map<string, Record<string, number>>;
  /** userId → ledger entries (insertion order). Appended by wallet updates with `updateLedger`. */
  readonly ledger: Map<string, Record<string, unknown>[]>;
  /** userId → natively linked identities. See `linkIdentity`. */
  readonly identities: Map<string, FakeIdentities>;
  /** Accounts removed by `accountDeleteId`. */
  readonly deletedAccounts: Set<string>;
  /** Leaderboard id → ILeaderboard. Populated by `leaderboardCreate`. */
  readonly leaderboards: Map<string, ILeaderboard>;
  /** Leaderboard id → map(ownerId → ILeaderboardRecord). */
  readonly leaderboardRecords: Map<string, Map<string, ILeaderboardRecord>>;
  /** Leaderboard ids that have been deleted via `leaderboardDelete`. */
  readonly deletedLeaderboards: Set<string>;
  /** Group id → IGroup. Populated via `groupCreate`. */
  readonly groups: Map<string, IGroup>;
  /** Group id → set of member userIds. */
  readonly groupMembers: Map<string, Set<string>>;
  /** Group id → userId → group state. */
  readonly groupStates: Map<string, Map<string, number>>;
  /** Matches created via `matchCreate`. */
  readonly createdMatches: Array<{ matchId: string; module: string; params: Record<string, unknown> }>;
  /** Installed before-hook for `leaderboardRecordWrite`. Tests can replace. */
  beforeLeaderboardRecordWrite:
    | ((
        ctx: unknown,
        logger: ILogger,
        nk: INakama,
        envelope: LeaderboardWriteRequest,
      ) => void)
    | null;
  /** Outbound HTTP calls captured by the stub. See `httpRequest`. */
  readonly httpRequests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }>;
  /** Per-call response override. Defaults to 204 No Content. */
  httpResponse: { code: number; content: string; headers: Record<string, string> };
  /** When set, `httpRequest` throws instead of returning. */
  httpRequestThrow: Error | null;
  /** INakama view — pass this into InitModule / RPC handlers. */
  readonly nakama: INakama;

  constructor() {
    const core = new FakeNakamaCore();
    this.store = core.store;
    this.cache = core.cache;
    this.users = core.users;
    this.wallets = core.wallets;
    this.ledger = core.ledger;
    this.identities = core.identities;
    this.deletedAccounts = core.deletedAccounts;
    this.createdMatches = core.createdMatches;
    this.leaderboards = core.leaderboards;
    this.leaderboardRecords = core.leaderboardRecords;
    this.deletedLeaderboards = core.deletedLeaderboards;
    this.groups = core.groups;
    this.groupMembers = core.groupMembers;
    this.groupStates = core.groupStates;
    this.beforeLeaderboardRecordWrite = core.beforeLeaderboardRecordWrite;
    this.httpRequests = core.httpRequests;
    this.httpResponse = core.httpResponse;
    this.httpRequestThrow = core.httpRequestThrow;
    this.nakama = wrapWithNotStubbedThrow(core) as INakama;
    this.linkIdentity = core.linkIdentity.bind(core);
    this.findIdentityOwner = core.findIdentityOwner.bind(core);
  }

  /** Native link, as the client's `Link*Async` (plan T-15). */
  readonly linkIdentity: (userId: string, field: keyof FakeIdentities, value: string) => void;
  /** Owner of an identity, as an `authenticate*` with `create: false`. */
  readonly findIdentityOwner: (field: keyof FakeIdentities, value: string) => string | null;
}

// ─── FakeInitializer ────────────────────────────────────────────────────────

/** Backing store for the initializer — RPC and shutdown handlers. */
type GroupHookFn = (ctx: unknown, logger: ILogger, nk: INakama, data: unknown) => unknown;

class FakeInitializerCore {
  readonly rpcs: Array<{ key: string; fn: RpcFunction }> = [];
  readonly shutdowns: Array<ShutdownFn> = [];
  readonly beforeLeaderboardRecordWrites: Array<
    (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: LeaderboardWriteRequest,
    ) => void
  > = [];
  readonly afterLeaderboardRecordWrites: Array<
    (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: LeaderboardWriteRequest,
    ) => void
  > = [];
  readonly afterAuthenticates: Array<
    (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: { username: string; userId: string; vars: Record<string, string> },
    ) => void
  > = [];
  readonly beforeAuthenticateDevices: Array<
    (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: { username: string; userId: string; vars: Record<string, string> },
    ) => void
  > = [];

  registerRpc(key: string, fn: RpcFunction): void {
    this.rpcs.push({ key, fn });
  }

  registerShutdown(_runtime: INakama, fn: ShutdownFn): void {
    this.shutdowns.push(fn);
  }

  registerBeforeAuthenticateDevice(
    fn: (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: { username: string; userId: string; vars: Record<string, string> },
    ) => void,
  ): void {
    this.beforeAuthenticateDevices.push(fn);
  }

  registerAfterAuthenticateDevice(
    fn: (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: { username: string; userId: string; vars: Record<string, string> },
    ) => void,
  ): void {
    this.afterAuthenticates.push(fn);
  }
  registerAfterAuthenticateCustom(
    fn: (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: { username: string; userId: string; vars: Record<string, string> },
    ) => void,
  ): void {
    this.afterAuthenticates.push(fn);
  }
  registerAfterAuthenticateEmail(
    fn: (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: { username: string; userId: string; vars: Record<string, string> },
    ) => void,
  ): void {
    this.afterAuthenticates.push(fn);
  }
  registerAfterAuthenticateApple(
    fn: (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: { username: string; userId: string; vars: Record<string, string> },
    ) => void,
  ): void {
    this.afterAuthenticates.push(fn);
  }

  registerBeforeWriteLeaderboardRecord(
    fn: (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: LeaderboardWriteRequest,
    ) => void,
  ): void {
    this.beforeLeaderboardRecordWrites.push(fn);
  }

  registerAfterWriteLeaderboardRecord(
    fn: (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: LeaderboardWriteRequest,
    ) => void,
  ): void {
    this.afterLeaderboardRecordWrites.push(fn);
  }

  /** Before-hooks of the client `WriteStorageObjects` API (plan T-18). */
  readonly beforeWriteStorageObjects: Array<
    (ctx: unknown, logger: ILogger, nk: INakama, envelope: unknown) => unknown
  > = [];

  registerBeforeWriteStorageObjects(
    fn: (ctx: unknown, logger: ILogger, nk: INakama, envelope: unknown) => unknown,
  ): void {
    this.beforeWriteStorageObjects.push(fn);
  }

  /** Before-hooks of the client group APIs by API name (plan T-21). */
  readonly groupHooks = new Map<string, GroupHookFn>();

  registerBeforeJoinGroup(fn: GroupHookFn): void {
    this.groupHooks.set('JoinGroup', fn);
  }

  registerBeforeCreateGroup(fn: GroupHookFn): void {
    this.groupHooks.set('CreateGroup', fn);
  }

  registerBeforeUpdateGroup(fn: GroupHookFn): void {
    this.groupHooks.set('UpdateGroup', fn);
  }

  registerBeforeDeleteGroup(fn: GroupHookFn): void {
    this.groupHooks.set('DeleteGroup', fn);
  }

  registerBeforeLeaveGroup(fn: GroupHookFn): void {
    this.groupHooks.set('LeaveGroup', fn);
  }

  registerBeforeAddGroupUsers(fn: GroupHookFn): void {
    this.groupHooks.set('AddGroupUsers', fn);
  }

  registerBeforeBanGroupUsers(fn: GroupHookFn): void {
    this.groupHooks.set('BanGroupUsers', fn);
  }

  registerBeforeKickGroupUsers(fn: GroupHookFn): void {
    this.groupHooks.set('KickGroupUsers', fn);
  }

  registerBeforePromoteGroupUsers(fn: GroupHookFn): void {
    this.groupHooks.set('PromoteGroupUsers', fn);
  }

  registerBeforeDemoteGroupUsers(fn: GroupHookFn): void {
    this.groupHooks.set('DemoteGroupUsers', fn);
  }

  /** Match handlers by module name (`registerMatch`). */
  readonly matches = new Map<string, Record<string, unknown>>();

  registerMatch(name: string, handlers: Record<string, unknown>): void {
    this.matches.set(name, handlers);
  }

  registerMatchmakerMatched(
    fn: (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      matches: IMatchmakerResult[],
    ) => string | void,
  ): void {
    // Captured by the FakeInitializer wrapper; tests can inspect
    // `.fakeInitializer.matchmakerMatchedHook` to assert behaviour.
    (this as unknown as { _mmHook: unknown })._mmHook = fn;
  }
}

/**
 * Captures RPC and shutdown registrations. Pass `.initializer` to
 * InitModule; after it returns, `.rpcs` contains every registered handler
 * and `.resolve(key)` returns the handler for a given key (or undefined).
 */
export class FakeInitializer {
  readonly rpcs: ReadonlyArray<{ key: string; fn: RpcFunction }>;
  readonly shutdowns: ReadonlyArray<ShutdownFn>;
  readonly beforeLeaderboardRecordWrites: ReadonlyArray<
    (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: LeaderboardWriteRequest,
    ) => void
  >;
  readonly afterLeaderboardRecordWrites: ReadonlyArray<
    (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: LeaderboardWriteRequest,
    ) => void
  >;
  readonly afterAuthenticates: ReadonlyArray<
    (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: { username: string; userId: string; vars: Record<string, string> },
    ) => void
  >;
  readonly beforeAuthenticateDevices: ReadonlyArray<
    (
      ctx: unknown,
      logger: ILogger,
      nk: INakama,
      envelope: { username: string; userId: string; vars: Record<string, string> },
    ) => void
  >;
  readonly beforeWriteStorageObjects: ReadonlyArray<
    (ctx: unknown, logger: ILogger, nk: INakama, envelope: unknown) => unknown
  >;
  /** Before-hooks of the client group APIs by API name (`JoinGroup`, …). */
  readonly groupHooks: ReadonlyMap<string, GroupHookFn>;
  readonly initializer: IInitializer;

  private readonly _core: FakeInitializerCore;

  constructor() {
    const core = new FakeInitializerCore();
    this._core = core;
    this.rpcs = core.rpcs;
    this.shutdowns = core.shutdowns;
    this.beforeLeaderboardRecordWrites = core.beforeLeaderboardRecordWrites;
    this.afterLeaderboardRecordWrites = core.afterLeaderboardRecordWrites;
    this.afterAuthenticates = core.afterAuthenticates;
    this.beforeAuthenticateDevices = core.beforeAuthenticateDevices;
    this.beforeWriteStorageObjects = core.beforeWriteStorageObjects;
    this.groupHooks = core.groupHooks;
    this.initializer = wrapWithNotStubbedThrow(core) as IInitializer;
  }

  /** Look up a registered RPC handler by key. Returns `undefined` if absent. */
  resolve(key: string): RpcFunction | undefined {
    return this.rpcs.find((r) => r.key === key)?.fn;
  }
}

// ─── Loaded bundle ──────────────────────────────────────────────────────────

/**
 * What `loadBundleForTest` returns. Bundles the INakama-shaped stubs
 * (what RPC handlers consume) together with the class-shaped stubs
 * (what tests assert against) plus a `resolver` for grabbing handlers
 * by their RPC key.
 */
export interface LoadedBundle {
  /** INakama passed to handlers — same as `fakeNakama.nakama`. */
  nak: INakama;
  /** ILogger passed to handlers — same as `fakeLogger`. */
  logger: ILogger;
  /** IInitializer passed to InitModule — same as `fakeInitializer.initializer`. */
  initializer: IInitializer;
  /** Snapshot of registered RPCs after InitModule has run. */
  rpcs: ReadonlyArray<{ key: string; fn: RpcFunction }>;
  /** Look up a registered RPC handler by key. */
  resolver(key: string): RpcFunction | undefined;
  /** The FakeNakama — exposes `.store` / `.cache` / `.users` for assertions. */
  fakeNakama: FakeNakama;
  /** The FakeLogger — exposes `.lines` for assertions. */
  fakeLogger: FakeLogger;
  /** The FakeInitializer — exposes `.rpcs` / `.shutdowns` for assertions. */
  fakeInitializer: FakeInitializer;
  /** The matchmaker matched-hook installed via `registerMatchmakerMatched`. */
  matchmakerMatchedHook?: (
    ctx: unknown,
    logger: ILogger,
    nk: INakama,
    matches: IMatchmakerResult[],
  ) => string | void;
}

/**
 * Loads the post-build bundle `modules/index.js` in an isolated VM
 * context, invokes `InitModule` with fresh fakes, and returns the
 * registered handlers plus the fakes themselves.
 *
 * Synchronous because the bundle performs only top-level work — no
 * async imports, no top-level await — and `vm.runInContext` is itself
 * synchronous.
 */
export function loadBundleForTest(): LoadedBundle {
  const bundlePath = path.resolve(__dirname, '..', '..', 'modules', 'index.js');
  const code = fs.readFileSync(bundlePath, 'utf8');

  const sandbox: Record<string, unknown> = {
    // Phase 8 Chunk 6: tournament scanner uses setInterval/clearInterval.
    // goja doesn't expose Node's timer globals by default in a vm
    // context, so we inject the same surface the runtime would.
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  };
  const context = vm.createContext(sandbox);
  // The bundle ends with `globalThis.InitModule = InitModule;`, so the
  // value returned by `vm.runInContext` is the InitModule function itself.
  const result = vm.runInContext(code, context);
  if (typeof result !== 'function') {
    throw new Error(
      `InitModule not found in bundle at ${bundlePath}; did you run \`npm run build\`?`,
    );
  }
  const InitModule = result as (
    ctx: IContext,
    logger: ILogger,
    nk: INakama,
    init: IInitializer,
  ) => void;

  const fakeNakama = new FakeNakama();
  const fakeLogger = new FakeLogger();
  const fakeInitializer = new FakeInitializer();

  InitModule(FakeContext, fakeLogger, fakeNakama.nakama, fakeInitializer.initializer);

  return {
    nak: fakeNakama.nakama,
    logger: fakeLogger,
    initializer: fakeInitializer.initializer,
    rpcs: fakeInitializer.rpcs,
    resolver: (key: string) => fakeInitializer.resolve(key),
    fakeNakama,
    fakeLogger,
    fakeInitializer,
    matchmakerMatchedHook: (fakeInitializer as unknown as { _core: { _mmHook?: unknown } })._core._mmHook as LoadedBundle['matchmakerMatchedHook'],
  };
}

// ─── TODO: buildSession ─────────────────────────────────────────────────────
//
// The `buildSession({ hostId, ...overrides })` helper that returns a minimal
// RaceSession payload for tests will be added once `modules/src/race/types.ts`
// (defining `RaceSession`) lands in Chunk 5. Stays as a placeholder for now.

// ─── Race garages (plan T-10) ───────────────────────────────────────────────

/** One catalog car per class (`modules/src/catalogs/cars.json`). */
export const RACE_CAR_BY_CLASS: Readonly<Record<'D' | 'C' | 'B' | 'A' | 'S', string>> = {
  D: 'starter_viper',
  C: 'coupe_gt',
  B: 'phantom_rsx',
  A: 'aurora_aero',
  S: 'titan_s1',
};

/**
 * Make the catalog car of `classId` the active car of `userId`'s garage,
 * adding it to the garage (or creating the garage) when needed. Race
 * loadouts come from the garage since T-10, not from the RPC body.
 */
export function seedRaceGarage(
  nk: INakama,
  userId: string,
  classId: keyof typeof RACE_CAR_BY_CLASS = 'S',
): string {
  const carId = RACE_CAR_BY_CLASS[classId];
  const stats = { speed: 50, acceleration: 50, handling: 50, nitro: 50 };
  const existing = nk.storageRead([{ collection: 'garage', key: userId, userId }])[0];
  const garage = (existing?.value as Record<string, unknown> | undefined) ?? {
    schemaVersion: 1,
    userId,
    cars: [],
    cosmeticsBag: [],
    purchasedPacks: [],
    loadout: null,
    lastDailyWin: 0,
    dailyPrivateCount: 0,
    dailyResetAt: 0,
  };
  const cars = (garage['cars'] as Array<{ carId: string }>).slice();
  if (!cars.some((c) => c.carId === carId)) {
    cars.push({
      carId,
      classId,
      upgrades: { engine: 0, tires: 0, nitro: 0, handling: 0 },
      cosmetics: {},
      computedStats: stats,
    } as { carId: string });
  }
  nk.storageWrite([{
    collection: 'garage',
    key: userId,
    userId,
    value: { ...garage, cars, loadout: { activeCarId: carId, equipped: {}, stats } },
    permissionRead: 1,
    permissionWrite: 0,
  }]);
  return carId;
}

const RACE_LOADOUT_RPCS = new Set(['race_session_create', 'race_session_join', 'race_session_quick_bots']);

/**
 * Fixtures written before T-10 declare any class with made-up body ids.
 * This wraps `env.resolver` so `race_session_create|join|quick_bots` first
 * make the caller's active garage car match the declared class; the
 * declared body id itself is still ignored by the server.
 */
export function autoSeedRaceGarages(env: LoadedBundle): void {
  const resolve = env.resolver.bind(env);
  env.resolver = (key: string) => {
    const handler = resolve(key);
    if (!handler || !RACE_LOADOUT_RPCS.has(key)) return handler;
    return (ctx, logger, nk, payload) => {
      try {
        const body = JSON.parse(payload) as Record<string, unknown>;
        const loadout = (body['hostLoadout'] ?? body['loadout']) as { classId?: string } | undefined;
        const userId = ctx.userId
          ?? (body['hostUserId'] ?? body['userId'] ?? body['callerUserId']) as string | undefined;
        const classId = loadout?.classId;
        if (typeof userId === 'string' && classId !== undefined && classId in RACE_CAR_BY_CLASS) {
          seedRaceGarage(nk, userId, classId as keyof typeof RACE_CAR_BY_CLASS);
        }
      } catch {
        // Malformed payloads reach the handler untouched.
      }
      return handler(ctx, logger, nk, payload);
    };
  };
}

// ─── Matchmaker hook (plan T-09) ────────────────────────────────────────────

/**
 * The 3.27 matchmakerMatched entries for the first candidate of a legacy
 * fixture envelope (tickets[i].metadata + matched[i].vars become the
 * entry's properties).
 */
export function matchesFromEnvelope(envelope: IMatchmakerMatchedEnvelope): IMatchmakerResult[] {
  const c = envelope.matches[0];
  if (!c) return [];
  return c.matched.map((m, i) => ({
    properties: { ...(c.tickets[i]?.metadata ?? {}), ...(m.vars ?? {}) },
    presence: { userId: m.userId, sessionId: m.sessionId ?? `${m.userId}-socket`, username: m.username ?? m.userId, node: 'test' },
    ...(m.vars?.['partyId'] !== undefined ? { partyId: m.vars['partyId'] } : {}),
  }));
}

/**
 * Run the registered hook on a legacy fixture envelope. `matched` is true
 * when the hook created a race session (the first matched player's
 * active-session index points at it).
 */
export function runMatchedHook(
  env: LoadedBundle,
  envelope: IMatchmakerMatchedEnvelope,
): { matched: boolean; sessionId?: string; returned: string | void } {
  const hook = env.matchmakerMatchedHook;
  if (!hook) throw new Error('matchmakerMatchedHook not registered');
  const matches = matchesFromEnvelope(envelope);
  const returned = hook(FakeContext, env.logger, env.nak, matches);
  const first = matches[0]?.presence.userId;
  const pointer = first === undefined
    ? undefined
    : env.nak.storageRead([{ collection: 'race_active', key: first, userId: SYSTEM_USER_ID }])[0];
  const sessionId = (pointer?.value as { sessionId?: string } | undefined)?.sessionId;
  return sessionId === undefined ? { matched: false, returned } : { matched: true, sessionId, returned };
}
