// displayNamesById — profile name, else username, else id (plan B2, D-03).

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { FakeNakama, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';
import { displayNamesById } from '../../modules/src/profiles/display_names';
import { PROFILES_COLLECTION } from '../../modules/src/profiles/storage';
import type { ILogger, IUser } from '../../modules/src/nkruntime';

function silentLogger(): ILogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    withField: (() => silentLogger()) as unknown as ILogger['withField'],
    withFields: (() => silentLogger()) as unknown as ILogger['withFields'],
    getFields: (): Record<string, unknown> => ({}),
  };
}

describe('displayNamesById', () => {
  let fake: FakeNakamaType;
  beforeEach(() => { fake = new FakeNakama(); });

  function seedProfile(userId: string, displayName: unknown): void {
    fake.store.set(`${PROFILES_COLLECTION}/${userId}/${userId}`, {
      collection: PROFILES_COLLECTION,
      key: userId,
      userId,
      value: { displayName },
      version: 'v00000001',
      permissionRead: 2,
      permissionWrite: 0,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    } as never);
  }

  function seedAccount(userId: string, username: string): void {
    fake.users.set(userId, { userId, username } as unknown as IUser);
  }

  it('uses the profile displayName when present', () => {
    seedProfile('u1', 'Captain');
    const names = displayNamesById(silentLogger(), fake.nakama, ['u1']);
    expect(names.get('u1')).toBe('Captain');
  });

  it('falls back to the username when the profile name is blank', () => {
    seedProfile('u1', '  ');
    seedAccount('u1', 'acc1');
    const names = displayNamesById(silentLogger(), fake.nakama, ['u1']);
    expect(names.get('u1')).toBe('acc1');
  });

  it('falls back to the id without profile or account', () => {
    vi.spyOn(fake.nakama, 'usersGetId').mockReturnValue([]);
    const names = displayNamesById(silentLogger(), fake.nakama, ['u1']);
    expect(names.get('u1')).toBe('u1');
  });

  it('falls through to the username when storageRead throws', () => {
    seedAccount('u1', 'acc1');
    vi.spyOn(fake.nakama, 'storageRead').mockImplementation(() => { throw new Error('boom'); });
    const names = displayNamesById(silentLogger(), fake.nakama, ['u1']);
    expect(names.get('u1')).toBe('acc1');
  });

  it('ignores repeated and empty ids', () => {
    seedProfile('u1', 'Captain');
    const names = displayNamesById(silentLogger(), fake.nakama, ['u1', '', 'u1']);
    expect(names.size).toBe(1);
    expect(names.has('')).toBe(false);
  });

  it('reads storage once and accounts at most once for three ids', () => {
    seedProfile('u1', 'Captain');
    const read = vi.spyOn(fake.nakama, 'storageRead');
    const users = vi.spyOn(fake.nakama, 'usersGetId');
    const names = displayNamesById(silentLogger(), fake.nakama, ['u1', 'u2', 'u3']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(users.mock.calls.length).toBeLessThanOrEqual(1);
    expect(names.get('u1')).toBe('Captain');
    expect(names.size).toBe(3);
  });
});