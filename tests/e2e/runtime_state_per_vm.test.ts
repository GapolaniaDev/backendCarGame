// T-29 — per-VM runtime state (audit N8; PC-14 / Audit 04 f5).
//
// Nakama 3.27 runs `InitModule` once, in a throwaway goja VM. The VMs of
// the pool that serve RPCs and hooks (and every match VM) only evaluate
// the top level of the bundle, then look each handler up BY NAME on
// their own global object. `loadBundleForTest` cannot see N8: it calls
// the handlers of the very VM that ran `InitModule`.
//
// This suite reproduces the real layout with two `node:vm` contexts:
//   - boot VM: evaluates the bundle and runs `InitModule`;
//   - pool VM: only evaluates the bundle; handlers are resolved by the
//     global identifier the registration names (what the scanner records).
// Both share one FakeNakama, as pool VMs share the database and the
// process-wide localcache.
//
// Before the fix: catalog RPCs threw "… catalog not loaded", the
// after-auth hook could not create the profile or garage, and a valid
// race stayed `started` ("no EventBus installed").

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import {
  FakeContext,
  FakeInitializer,
  FakeLogger,
  FakeNakama,
  SYSTEM_USER_ID,
  seedRaceGarage,
} from './_stubs';
import type { IContext, ILogger, INakama } from '../../modules/src/nkruntime';

const BUNDLE = path.resolve(__dirname, '..', '..', 'modules', 'index.js');

type Handler = (ctx: IContext, logger: ILogger, nk: INakama, ...rest: unknown[]) => unknown;

interface Registrations {
  /** RPC id → global identifier. */
  rpcs: Map<string, string>;
  /** register* hook method → global identifier. */
  hooks: Map<string, string>;
  /** `matchInit` identifier of the service ticker. */
  tickerInit: string;
}

/** Read the registrations the way the 3.27 scanner does: by identifier. */
function readRegistrations(code: string): Registrations {
  const rpcs = new Map<string, string>();
  for (const m of code.matchAll(/initializer\.registerRpc\("([a-z0-9_]+)", ([A-Za-z0-9_$]+)\)/g)) {
    rpcs.set(m[1]!, m[2]!);
  }
  const hooks = new Map<string, string>();
  for (const m of code.matchAll(/initializer\.(register(?:After|Before)\w+|registerMatchmakerMatched)\(([A-Za-z0-9_$]+)\)/g)) {
    hooks.set(m[1]!, m[2]!);
  }
  const ticker = /registerMatch\("service_ticker", \{\s*matchInit: ([A-Za-z0-9_$]+)/.exec(code);
  if (!ticker) throw new Error('service_ticker registration not found in the bundle');
  return { rpcs, hooks, tickerInit: ticker[1]! };
}

/** A fresh goja-like VM: the bundle's top level evaluated, nothing else. */
function newVm(code: string): vm.Context {
  const context = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(code, context);
  return context;
}

function handlerIn(context: vm.Context, ident: string): Handler {
  const fn = (context as Record<string, unknown>)[ident];
  if (typeof fn !== 'function') throw new Error(`global ${ident} is not a function in this VM`);
  return fn as Handler;
}

const userCtx = (userId: string): IContext => ({ ...FakeContext, userId });

function parse(raw: unknown): { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } {
  return JSON.parse(raw as string);
}

describe('runtime state per VM (T-29, audit N8)', () => {
  const code = fs.readFileSync(BUNDLE, 'utf8');
  const regs = readRegistrations(code);
  let fake: FakeNakama;
  let poolVm: vm.Context;
  let poolLogger: FakeLogger;

  const rpcInPool = (id: string): Handler => {
    const ident = regs.rpcs.get(id);
    if (!ident) throw new Error(`rpc ${id} is not registered`);
    return handlerIn(poolVm, ident);
  };

  beforeEach(() => {
    fake = new FakeNakama();
    const bootVm = newVm(code);
    const InitModule = (bootVm as { InitModule?: unknown }).InitModule as (
      ctx: IContext, logger: ILogger, nk: INakama, init: unknown,
    ) => void;
    InitModule(FakeContext, new FakeLogger(), fake.nakama, new FakeInitializer().initializer);
    poolVm = newVm(code);
    poolLogger = new FakeLogger();
  });

  it('profile_get and garage_get answer ok from a VM that never ran InitModule', () => {
    const user = 'n8-reader';
    for (const id of ['profile_get', 'garage_get']) {
      const out = parse(rpcInPool(id)(userCtx(user), poolLogger, fake.nakama, JSON.stringify({ clientVersion: '0.1.0', platform: 'android' })));
      expect(out.error?.message ?? '', id).not.toMatch(/not loaded/);
      expect(out.ok, `${id}: ${JSON.stringify(out.error)}`).toBe(true);
    }
  });

  it('no registered RPC reports a missing catalog from a pool VM', () => {
    const notLoaded: string[] = [];
    for (const [id, ident] of regs.rpcs) {
      try {
        const raw = handlerIn(poolVm, ident)(userCtx('n8-sweep'), poolLogger, fake.nakama, '{}');
        const out = parse(raw);
        if (/not loaded/.test(out.error?.message ?? '')) notLoaded.push(`${id}: ${out.error!.message}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not loaded/.test(msg)) notLoaded.push(`${id} threw: ${msg}`);
      }
    }
    expect(regs.rpcs.size).toBeGreaterThanOrEqual(100);
    expect(notLoaded).toEqual([]);
  });

  it('the after-auth hook creates the profile and the garage in a pool VM', () => {
    const user = 'n8-new-player';
    const ident = regs.hooks.get('registerAfterAuthenticateDevice');
    expect(ident).toBeDefined();
    handlerIn(poolVm, ident!)(userCtx(user), poolLogger, fake.nakama, {}, {});
    expect(poolLogger.lines.filter((l) => /auto-create failed/.test(l))).toEqual([]);
    expect(fake.store.has(`profiles/${user}/${user}`)).toBe(true);
    expect(fake.store.has(`garage/${user}/${user}`)).toBe(true);
  });

  it('a valid 1-player private race submitted in a pool VM closes with rewards', () => {
    const host = 'n8-racer';
    const ctx = userCtx(host);
    seedRaceGarage(fake.nakama, host, 'S');
    const created = parse(rpcInPool('race_session_create')(ctx, poolLogger, fake.nakama, JSON.stringify({
      matchId: 'n8-match',
      mode: 'private',
      trackId: 'neon_blvd',
      size: 2,
      hostLoadout: { classId: 'S', bodyId: 'coupe' },
      hostUserId: host,
    })));
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const sessionId = created.data!.sessionId as string;
    const started = parse(rpcInPool('race_session_start')(ctx, poolLogger, fake.nakama, JSON.stringify({ sessionId })));
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    // Backdate the start so the clock check accepts a full-length race.
    const stored = fake.store.get(`race_sessions/${sessionId}/${SYSTEM_USER_ID}`);
    (stored!.value as { startedAt: number }).startedAt = Date.now() - 120_000;

    // neon_blvd private = 3 laps; class S minimum = 32 000 ms per lap.
    const laps = [32_100, 32_100, 32_100];
    const submitted = parse(rpcInPool('race_submit_result')(ctx, poolLogger, fake.nakama, JSON.stringify({
      sessionId,
      report: { userId: host, totalMs: laps.reduce((a, b) => a + b, 0), laps, isBotReport: false },
    })));
    expect(submitted.ok, JSON.stringify(submitted.error)).toBe(true);
    expect(poolLogger.lines.filter((l) => /no EventBus installed/.test(l))).toEqual([]);
    expect(submitted.data!.officialResults).toBeDefined();
    expect(submitted.data!.rewards).toBeDefined();

    const got = parse(rpcInPool('race_session_get')(ctx, poolLogger, fake.nakama, JSON.stringify({ sessionId })));
    expect(got.ok).toBe(true);
    expect((got.data!.session as { state: string }).state).toBe('closed');
  });

  it('loads the state once per VM, with one info line', () => {
    rpcInPool('profile_get')(userCtx('n8-once'), poolLogger, fake.nakama, '{}');
    rpcInPool('garage_get')(userCtx('n8-once'), poolLogger, fake.nakama, '{}');
    rpcInPool('store_get')(userCtx('n8-once'), poolLogger, fake.nakama, '{}');
    const ready = poolLogger.lines.filter((l) => l.startsWith('runtime state ready'));
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatch(/\(vm\)$/);
  });

  it('a match VM loads its state in the service ticker matchInit', () => {
    const matchVm = newVm(code);
    const matchLogger = new FakeLogger();
    handlerIn(matchVm, regs.tickerInit)(FakeContext, matchLogger, fake.nakama, {});
    expect(matchLogger.lines.filter((l) => l.startsWith('runtime state ready'))).toHaveLength(1);
  });
});
