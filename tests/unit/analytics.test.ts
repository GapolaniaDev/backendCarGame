// Phase 5 Chunk 7 — unit tests for the `emit` helper.
//
// Covers the 5 spec cases:
//   1. emit happy path without webhook → storage row written, NO
//      httpRequest fired.
//   2. emit with `analyticsWebhook` configured → storage row written,
//      httpRequest fired with the expected payload.
//   3. storage write failure → emit() logs warn, does not throw,
//      does not fire httpRequest.
//   4. emitAdminAction delegates to emit (storage row name =
//      'admin_action', props.rpcName set, other props preserved).
//   5. opts.userId → row ownerId and event.userId both reflect it.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, FakeLogger } from '../e2e/_stubs';
import {
  emit,
  emitAdminAction,
  ANALYTICS_COLLECTION,
} from '../../modules/src/core/admin/analytics';
import { bootEnsure as bootEnsureLiveops } from '../../modules/src/liveops/config';
import { SYSTEM_USER_ID } from '../../modules/src/race/constants';
import type { IStorageObject } from '../../modules/src/nkruntime';

function findEventRow(
  store: Map<string, IStorageObject>,
  name: string,
): IStorageObject | undefined {
  for (const obj of store.values()) {
    if (obj.collection !== ANALYTICS_COLLECTION) continue;
    const v = obj.value as Record<string, unknown>;
    if (v['name'] === name && v['webhook'] === undefined) return obj;
  }
  return undefined;
}

function findAllEventRows(
  store: Map<string, IStorageObject>,
  name: string,
): IStorageObject[] {
  const out: IStorageObject[] = [];
  for (const obj of store.values()) {
    if (obj.collection !== ANALYTICS_COLLECTION) continue;
    const v = obj.value as Record<string, unknown>;
    if (v['name'] === name) out.push(obj);
  }
  return out;
}

function setWebhook(fakeNakama: FakeNakama, url: string | undefined): void {
  const existing = fakeNakama.store.get('liveops/config/' + SYSTEM_USER_ID);
  const baseValue =
    existing?.value !== undefined
      ? (existing.value as Record<string, unknown>)
      : {
          schemaVersion: 1,
          version: 1,
          flags: { maintenance: false },
          minClientVersion: {
            ios: '0.1.0',
            android: '0.1.0',
            windows: '0.1.0',
            macos: '0.1.0',
            linux: '0.1.0',
          },
          regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
          calendar: [],
        };
  const next = { ...(baseValue as Record<string, unknown>) };
  if (url === undefined) {
    delete next['analyticsWebhook'];
  } else {
    next['analyticsWebhook'] = url;
  }
  fakeNakama.store.set('liveops/config/' + SYSTEM_USER_ID, {
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: next,
    version: 'v1',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
    expiresAt: null,
  });
}

describe('emit()', () => {
  let fakeNakama: FakeNakama;
  let logger: FakeLogger;

  beforeEach(() => {
    fakeNakama = new FakeNakama();
    logger = new FakeLogger();
    bootEnsureLiveops(fakeNakama.nakama, logger);
  });

  it('1. happy path without webhook — writes storage row, no httpRequest', () => {
    setWebhook(fakeNakama, undefined);
    expect(fakeNakama.httpRequests.length).toBe(0);

    emit(fakeNakama.nakama, logger, 'session_started', {
      sessionId: 's-1', hostId: 'u-1', mode: 'quick_bots', size: 4, trackId: 'track-1',
    });

    const row = findEventRow(fakeNakama.store, 'session_started');
    expect(row).toBeDefined();
    const v = row!.value as Record<string, unknown>;
    expect(v['schemaVersion']).toBe(1);
    expect(typeof v['id']).toBe('string');
    expect(typeof v['ts']).toBe('number');
    expect(v['name']).toBe('session_started');
    expect((v['props'] as Record<string, unknown>)['sessionId']).toBe('s-1');
    expect(row!.permissionRead).toBe(2);
    expect(row!.permissionWrite).toBe(0);
    expect(row!.userId).toBe(SYSTEM_USER_ID);

    // No webhook configured → no httpRequest and no follow-up patch.
    expect(fakeNakama.httpRequests.length).toBe(0);
    expect(findAllEventRows(fakeNakama.store, 'session_started').length).toBe(1);
  });

  it('2. with webhook configured — storage row + httpRequest fire', () => {
    setWebhook(fakeNakama, 'https://analytics.example.com/hook');
    emit(fakeNakama.nakama, logger, 'race_completed', {
      sessionId: 's-2', mode: 'quick', size: 2, durationMs: 60000, finisherCount: 2, abandonedCount: 0, confidence: 1,
    });

    expect(fakeNakama.httpRequests.length).toBe(1);
    const call = fakeNakama.httpRequests[0];
    expect(call.url).toBe('https://analytics.example.com/hook');
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/json');
    const payload = JSON.parse(call.body) as Record<string, unknown>;
    expect(payload['name']).toBe('race_completed');
    expect(payload['ts']).toBeTypeOf('number');
    expect(typeof payload['id']).toBe('string');
    expect((payload['props'] as Record<string, unknown>)['sessionId']).toBe('s-2');

    // After the webhook completes, the helper writes a follow-up row
    // that includes the `webhook` block.
    const patched = findAllEventRows(fakeNakama.store, 'race_completed').find(
      (o) => (o.value as Record<string, unknown>)['webhook'] !== undefined,
    );
    expect(patched).toBeDefined();
    const wb = (patched!.value as Record<string, unknown>)['webhook'] as Record<string, unknown>;
    expect(wb['url']).toBe('https://analytics.example.com/hook');
    expect(wb['status']).toBe(204);
    expect(wb['error']).toBeNull();
  });

  it('3. storage failure — log warn, do not throw, no httpRequest', () => {
    setWebhook(fakeNakama, 'https://analytics.example.com/hook');
    // Force storageWrite to throw by swapping the underlying map after init.
    const originalWrite = fakeNakama.nakama.storageWrite;
    let calls = 0;
    (fakeNakama.nakama as unknown as { storageWrite: typeof originalWrite }).storageWrite = (objs) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated storage outage');
      return originalWrite(objs);
    };

    expect(() =>
      emit(fakeNakama.nakama, logger, 'store_purchase', { userId: 'u-3', offerId: 'o-1' }),
    ).not.toThrow();
    expect(logger.lines.some((l) => l.includes('storage failed'))).toBe(true);
    expect(fakeNakama.httpRequests.length).toBe(0);
  });

  it('4. emitAdminAction delegates to emit — name=admin_action, rpcName preserved', () => {
    setWebhook(fakeNakama, undefined);
    emitAdminAction(fakeNakama.nakama, logger, 'admin_wallet_adjust', {
      adminId: 'u-admin-1', targetUserId: 'u-target', deltaCoins: 1000,
    });
    const row = findEventRow(fakeNakama.store, 'admin_action');
    expect(row).toBeDefined();
    const v = row!.value as Record<string, unknown>;
    expect(v['name']).toBe('admin_action');
    const props = v['props'] as Record<string, unknown>;
    expect(props['rpcName']).toBe('admin_wallet_adjust');
    expect(props['adminId']).toBe('u-admin-1');
    expect(props['targetUserId']).toBe('u-target');
    expect(props['deltaCoins']).toBe(1000);
  });

  it('5. opts.userId — row owner + event.userId reflect it', () => {
    setWebhook(fakeNakama, undefined);
    emit(fakeNakama.nakama, logger, 'wallet_moved', { kind: 'grant', coins: 500 }, {
      userId: 'u-7',
    });
    const row = findEventRow(fakeNakama.store, 'wallet_moved');
    expect(row).toBeDefined();
    expect(row!.userId).toBe('u-7');
    expect(((row!.value as Record<string, unknown>)['userId'])).toBe('u-7');
  });
});