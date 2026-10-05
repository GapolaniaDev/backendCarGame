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

import { createHash as cryptoCreateHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import type {
  IContext,
  ILogger,
  IInitializer,
  IStorageKey,
  IStorageListRequest,
  IStorageObject,
  IStorageObjectAck,
  IMultiUpdateOp,
  IMultiUpdateResult,
  INakama,
  IUser,
  RpcFunction,
  ShutdownFn,
} from '../../modules/src/nkruntime';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Sentinel user ID reserved by Nakama for system actions. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// ─── FakeContext ─────────────────────────────────────────────────────────────

/** Constant IContext value — the `_brand` is the only required discriminator. */
export const FakeContext: IContext = { _brand: 'NakamaContext' };

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
class FakeNakamaCore {
  readonly store = new Map<string, IStorageObject>();
  readonly cache = new Map<string, unknown>();
  readonly users = new Map<string, IUser>();
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
        permissionRead: obj.permissionRead ?? 0,
        permissionWrite: obj.permissionWrite ?? 0,
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

  storageList(
    req: IStorageListRequest,
  ): { objects: IStorageObject[]; cursor: string } {
    const objs: IStorageObject[] = [];
    for (const obj of this.store.values()) {
      if (obj.collection !== req.collection) continue;
      if (req.userId !== undefined && obj.userId !== req.userId) continue;
      objs.push(obj);
    }
    return { objects: objs, cursor: '' };
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

  multiUpdate(
    _accountUpdates: unknown,
    storageWrites: IStorageObject[] | undefined,
    _storageDeletes: unknown,
    _walletUpdates: unknown,
    _updateLedger: unknown,
  ): IMultiUpdateResult {
    const storageWriteAcks: IStorageObjectAck[] = [];
    const now = new Date().toISOString();

    if (storageWrites) {
      for (const obj of storageWrites) {
        this.versionCounter += 1;
        const version = formatVersion(this.versionCounter);
        const stored: IStorageObject = {
          collection: obj.collection,
          key: obj.key,
          userId: obj.userId,
          value: obj.value,
          version,
          permissionRead: obj.permissionRead ?? 0,
          permissionWrite: obj.permissionWrite ?? 0,
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
    }

    return { storageWriteAcks, walletUpdateAcks: [] };
  }

  sha256Hash(input: string): string {
    return cryptoCreateHash('sha256').update(input).digest('hex');
  }

  uuidv4(): string {
    return randomUUID();
  }

  accountGetId(userId: string): unknown {
    if (userId === SYSTEM_USER_ID) return null;
    const now = new Date().toISOString();
    // The IUser d.ts declares `disableTime: true` (literal), but the real
    // Nakama JS runtime returns a unix-seconds number or null. The spec
    // for this stub asks for `null`; we cast through `unknown` to satisfy
    // the type without lying at runtime.
    const fake = {
      userId,
      username: 'fake-user',
      createTime: now,
      updateTime: now,
      disableTime: null,
      metadata: {},
    };
    return fake;
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
  /** INakama view — pass this into InitModule / RPC handlers. */
  readonly nakama: INakama;

  constructor() {
    const core = new FakeNakamaCore();
    this.store = core.store;
    this.cache = core.cache;
    this.users = core.users;
    this.nakama = wrapWithNotStubbedThrow(core) as INakama;
  }
}

// ─── FakeInitializer ────────────────────────────────────────────────────────

/** Backing store for the initializer — RPC and shutdown handlers. */
class FakeInitializerCore {
  readonly rpcs: Array<{ key: string; fn: RpcFunction }> = [];
  readonly shutdowns: Array<ShutdownFn> = [];

  registerRpc(key: string, fn: RpcFunction): void {
    this.rpcs.push({ key, fn });
  }

  registerShutdown(_runtime: INakama, fn: ShutdownFn): void {
    this.shutdowns.push(fn);
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
  readonly initializer: IInitializer;

  constructor() {
    const core = new FakeInitializerCore();
    this.rpcs = core.rpcs;
    this.shutdowns = core.shutdowns;
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

  const sandbox: Record<string, unknown> = {};
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
  };
}

// ─── TODO: buildSession ─────────────────────────────────────────────────────
//
// The `buildSession({ hostId, ...overrides })` helper that returns a minimal
// RaceSession payload for tests will be added once `modules/src/race/types.ts`
// (defining `RaceSession`) lands in Chunk 5. Stays as a placeholder for now.
