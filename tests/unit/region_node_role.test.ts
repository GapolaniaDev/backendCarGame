// Phase 5 Chunk 8 unit tests — `isHome` / `isRelay` against
// `LiveopsConfig.nodeRole`.

import { describe, it, expect } from 'vitest';
import { FakeNakama, FakeLogger } from '../e2e/_stubs';
import { isHome, isRelay } from '../../modules/src/core/region';
import {
  bootEnsure as bootEnsureLiveops,
  validate as validateLiveops,
} from '../../modules/src/liveops/config';
import { SYSTEM_USER_ID } from '../../modules/src/race/constants';
import type { IStorageObject } from '../../modules/src/nkruntime';

function setLiveopsValue(
  fakeNakama: FakeNakama,
  patch: Record<string, unknown>,
): void {
  const base = {
    schemaVersion: 1,
    version: 1,
    flags: { maintenance: false },
    minClientVersion: {
      ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0',
    },
    regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
    calendar: [],
  };
  const key = `liveops/config/${SYSTEM_USER_ID}`;
  const next = { ...base, ...patch };
  const obj: IStorageObject = {
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: next,
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
    expiresAt: null,
  };
  fakeNakama.store.set(key, obj);
}

describe('region node role', () => {
  function setupFake(patch: Record<string, unknown> = {}): FakeNakama {
    const fake = new FakeNakama();
    const logger = new FakeLogger();
    bootEnsureLiveops(fake.nakama, logger);
    if (Object.keys(patch).length > 0) setLiveopsValue(fake, patch);
    return fake;
  }

  it('1. isHome when nodeRole="home"', () => {
    const fake = setupFake({ nodeRole: 'home' });
    expect(isHome(fake.nakama)).toBe(true);
    expect(isRelay(fake.nakama)).toBe(false);
  });

  it('2. isHome when nodeRole="relay"', () => {
    const fake = setupFake({ nodeRole: 'relay' });
    expect(isHome(fake.nakama)).toBe(false);
    expect(isRelay(fake.nakama)).toBe(true);
  });

  it('3. isHome default true when nodeRole absent', () => {
    // Bundled default sets nodeRole='home'. Absence is reachable
    // only when the override removes it; we simulate by deleting
    // the storage row and rebooting — bootEnsure re-inserts with
    // nodeRole='home' from the bundled default.
    const fake = new FakeNakama();
    const logger = new FakeLogger();
    bootEnsureLiveops(fake.nakama, logger);
    fake.store.delete(`liveops/config/${SYSTEM_USER_ID}`);
    bootEnsureLiveops(fake.nakama, logger);
    expect(isHome(fake.nakama)).toBe(true);
  });

  it('4. validate() rejects nodeRole !== home/relay', () => {
    expect(() => validateLiveops({
      schemaVersion: 1,
      version: 1,
      flags: { maintenance: false },
      minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      nodeRole: 'gateway' as unknown as 'home',
    })).toThrowError(/nodeRole/);
    expect(() => validateLiveops({
      schemaVersion: 1,
      version: 1,
      flags: { maintenance: false },
      minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      nodeRole: 42 as unknown as 'home',
    })).toThrowError(/nodeRole/);
  });
});