// T-03 — service ticker (periodic jobs without setInterval) and its
// storage lease. The live boot check (the match is created and ticks)
// is in `npm run smoke:live`.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, FakeContext } from '../e2e/_stubs';
import type { ILogger, INakama, IStorageObject } from '../../modules/src/nkruntime';
import {
  EVENT_TICK_MS,
  LOCK_RETRY_MS,
  SERVICE_TICKER_LABEL,
  SERVICE_TICKER_MODULE,
  SERVICE_TICK_LOCK_NAME,
  TOURNAMENT_TICK_MS,
  ensureServiceTicker,
  runServiceTick,
  serviceTickerInit,
  serviceTickerJoinAttempt,
  serviceTickerLoop,
  type ServiceTickerState,
} from '../../modules/src/scheduler/service_ticker';
import { ensureRuntimeState } from '../../modules/src/core/runtime_state';
import {
  TICK_LOCK_COLLECTION,
  TICK_LOCK_OWNER_ID,
  releaseTickLock,
  tryAcquireTickLock,
} from '../../modules/src/scheduler/tick_lock';

function makeLogger(): ILogger & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  const fmt = (f: string, args: unknown[]): string => {
    let i = 0;
    return f.replace(/%[sd]/g, () => String(args[i++]));
  };
  const logger = {
    infos,
    errors,
    debug: () => {},
    info: (f: string, ...a: unknown[]) => { infos.push(fmt(f, a)); },
    warn: () => {},
    error: (f: string, ...a: unknown[]) => { errors.push(fmt(f, a)); },
    withField: () => logger,
    withFields: () => logger,
    getFields: () => ({}),
  };
  return logger as unknown as ILogger & { infos: string[]; errors: string[] };
}

/** Minimal storage with Nakama's conditional-write rules ('*' / version). */
function makeCasNk(): INakama & { rows: Map<string, IStorageObject> } {
  const rows = new Map<string, IStorageObject>();
  let seq = 0;
  const key = (o: { collection: string; key: string; userId: string }) => `${o.collection}/${o.key}/${o.userId}`;
  return {
    rows,
    storageRead: (keys: Array<{ collection: string; key: string; userId: string }>) =>
      keys.map((k) => rows.get(key(k))).filter((o): o is IStorageObject => o !== undefined),
    storageWrite: (objs: IStorageObject[]) => objs.map((o) => {
      const cur = rows.get(key(o));
      if (o.version === '*' && cur) throw new Error('Storage write rejected - version check failed.');
      if (o.version && o.version !== '*' && cur?.version !== o.version) {
        throw new Error('Storage write rejected - version check failed.');
      }
      seq += 1;
      const version = `v${seq}`;
      rows.set(key(o), { ...o, version });
      return { collection: o.collection, key: o.key, userId: o.userId, version };
    }),
  } as unknown as INakama & { rows: Map<string, IStorageObject> };
}

describe('tick lock (storage lease)', () => {
  const NOW = 1_800_000_000_000;

  it('first holder acquires with a create-only write; a second holder is refused', () => {
    const nk = makeCasNk();
    expect(tryAcquireTickLock(nk, 'job', 'a', NOW, 55_000)).toBe(true);
    expect(tryAcquireTickLock(nk, 'job', 'b', NOW + 1_000, 55_000)).toBe(false);
  });

  it('the holder can renew; another holder gets it after expiry', () => {
    const nk = makeCasNk();
    expect(tryAcquireTickLock(nk, 'job', 'a', NOW, 55_000)).toBe(true);
    expect(tryAcquireTickLock(nk, 'job', 'a', NOW + 1_000, 55_000)).toBe(true);
    expect(tryAcquireTickLock(nk, 'job', 'b', NOW + 57_000, 55_000)).toBe(true);
  });

  it('release lets the next holder in immediately; a stranger cannot release', () => {
    const nk = makeCasNk();
    tryAcquireTickLock(nk, 'job', 'a', NOW, 55_000);
    releaseTickLock(nk, 'job', 'b');
    expect(tryAcquireTickLock(nk, 'job', 'b', NOW + 1, 55_000)).toBe(false);
    releaseTickLock(nk, 'job', 'a');
    expect(tryAcquireTickLock(nk, 'job', 'b', NOW + 2, 55_000)).toBe(true);
  });

  it('of two writers racing on the same read, exactly one wins', () => {
    const nk = makeCasNk();
    tryAcquireTickLock(nk, 'job', 'a', NOW, 1_000);
    // Both read the expired lease (same version), then both write.
    const stale = nk.storageRead([{ collection: TICK_LOCK_COLLECTION, key: 'job', userId: TICK_LOCK_OWNER_ID }]);
    const realRead = nk.storageRead;
    (nk as { storageRead: unknown }).storageRead = () => stale;
    const results = [
      tryAcquireTickLock(nk, 'job', 'b', NOW + 5_000, 55_000),
      tryAcquireTickLock(nk, 'job', 'c', NOW + 5_000, 55_000),
    ];
    (nk as { storageRead: unknown }).storageRead = realRead;
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('service ticker scheduling', () => {
  const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
  let fake: FakeNakama;
  let nk: INakama;
  let logger: ReturnType<typeof makeLogger>;
  let state: ServiceTickerState;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
    logger = makeLogger();
    ensureRuntimeState(nk, logger);
    state = { lastTournamentMs: 0, lastEventMs: 0, lastSubscriptionMs: 0, runs: 0, nextAttemptMs: 0 };
  });

  it('runs every job on the first loop and logs one tick line', () => {
    const r = runServiceTick(nk, logger, state, NOW, 'match:t');
    expect(r.ran).toBe(true);
    expect(r.tournaments).toMatch(/^scanned=/);
    expect(r.events).toMatch(/^scanned=/);
    expect(r.subscriptions).toMatch(/^scanned=/);
    expect(logger.errors).toEqual([]);
    expect(logger.infos.filter((l) => l.startsWith('service ticker tick n=1'))).toHaveLength(1);
  });

  it('then waits: tournaments every 60 s, events and subscriptions every 5 min', () => {
    runServiceTick(nk, logger, state, NOW, 'match:t');
    expect(runServiceTick(nk, logger, state, NOW + 1_000, 'match:t').ran).toBe(false);
    const t1 = runServiceTick(nk, logger, state, NOW + TOURNAMENT_TICK_MS, 'match:t');
    expect(t1.ran).toBe(true);
    expect(t1.tournaments).not.toBe('-');
    expect(t1.events).toBe('-');
    const t5 = runServiceTick(nk, logger, state, NOW + EVENT_TICK_MS, 'match:t');
    expect(t5.events).not.toBe('-');
    expect(t5.subscriptions).not.toBe('-');
    expect(state.runs).toBe(3);
  });

  it('skips and backs off while another ticker holds the lease', () => {
    tryAcquireTickLock(nk, SERVICE_TICK_LOCK_NAME, 'match:other', NOW, 55_000);
    const r = runServiceTick(nk, logger, state, NOW + 1, 'match:t');
    expect(r.ran).toBe(false);
    expect(r.tournaments).toBe('locked');
    expect(state.nextAttemptMs).toBe(NOW + 1 + LOCK_RETRY_MS);
    expect(runServiceTick(nk, logger, state, NOW + 2, 'match:t').tournaments).toBe('-');
    expect(state.runs).toBe(0);
  });

  it('releases the lease after a tick', () => {
    runServiceTick(nk, logger, state, NOW, 'match:t');
    expect(tryAcquireTickLock(nk, SERVICE_TICK_LOCK_NAME, 'admin', NOW + 1, 55_000)).toBe(true);
  });
});

describe('service ticker match handlers', () => {
  it('matchInit loads the catalogs and asks for 1 tick/s with the ticker label', () => {
    const fake = new FakeNakama();
    const init = serviceTickerInit(FakeContext, makeLogger(), fake.nakama, {});
    expect(init.tickRate).toBe(1);
    expect(init.label).toBe(SERVICE_TICKER_LABEL);
    expect(init.state.runs).toBe(0);
  });

  it('rejects every join attempt (no players in a service match)', () => {
    const fake = new FakeNakama();
    const { state } = serviceTickerInit(FakeContext, makeLogger(), fake.nakama, {});
    const r = serviceTickerJoinAttempt(FakeContext, makeLogger(), fake.nakama, null, 0, state);
    expect(r.accept).toBe(false);
  });

  it('matchLoop keeps the match alive (returns state, never null)', () => {
    const fake = new FakeNakama();
    const { state } = serviceTickerInit(FakeContext, makeLogger(), fake.nakama, {});
    const r = serviceTickerLoop({ ...FakeContext, matchId: 'm1' }, makeLogger(), fake.nakama, null, 1, state);
    expect(r).not.toBeNull();
    expect(r.state.runs).toBe(1);
  });

  it('ensureServiceTicker creates one match and reuses it afterwards', () => {
    const fake = new FakeNakama();
    const logger = makeLogger();
    const first = ensureServiceTicker(fake.nakama, logger);
    const second = ensureServiceTicker(fake.nakama, logger);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(fake.createdMatches.filter((m) => m.module === SERVICE_TICKER_MODULE)).toHaveLength(1);
  });
});
