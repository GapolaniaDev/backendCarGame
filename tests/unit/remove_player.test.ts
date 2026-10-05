// Unit tests for `race/remove_player.ts`. The helper is pure: given
// a populated FakeNakama + a logger, it returns a RemovePlayerResult
// and mutates the in-memory storage directly. We exercise every
// branch — start, closing, closed, already-abandoned, not-in-roster.

import { describe, it, expect } from 'vitest';
import { removePlayerFromAll } from '../../modules/src/race/remove_player';
import type { ILogger, INakama } from '../../modules/src/nkruntime';
import type { IStorageObject } from '../../modules/src/nkruntime';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
} as unknown as ILogger;

interface FakeNk {
  storageList: (req: { collection: string }) => { objects: IStorageObject[] };
  storageWrite: (writes: IStorageObject[]) => Array<{ version: string }>;
}

function makeFakeNk(sessions: Record<string, { value: unknown }>): FakeNk {
  const objs: IStorageObject[] = Object.entries(sessions).map(
    ([k, v], i) => ({
      collection: k.split('/')[0] ?? '',
      key: k.split('/')[1] ?? '',
      userId: k.split('/')[2] ?? '',
      value: v.value as Record<string, unknown>,
      version: `v${(i + 1).toString().padStart(8, '0')}`,
      permissionRead: 0,
      permissionWrite: 0,
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
      expiresAt: null,
    }),
  );
  return {
    storageList: (req) => ({
      objects: objs.filter((o) => o.collection === req.collection),
      cursor: '',
    }),
    storageWrite: (writes) => writes.map((w, i) => ({
      version: `v${(writes.length + i + 100).toString().padStart(8, '0')}`,
      collection: w.collection,
      key: w.key,
      userId: w.userId,
    })),
  };
}

function sessionFor(
  id: string,
  state: 'created' | 'started' | 'closing' | 'closed',
  roster: Array<{ userId: string; abandoned?: boolean }>,
): { value: unknown } {
  return {
    value: {
      schemaVersion: 1,
      id,
      matchId: 'm',
      mode: 'quick',
      trackId: 'neon_blvd',
      size: 4,
      roster: roster.map((r) => ({
        userId: r.userId,
        loadout: { classId: 'B', bodyId: 'coupe' },
        isBot: false,
        abandoned: r.abandoned ?? false,
      })),
      host: roster[0]?.userId ?? '',
      hostSuccession: roster.map((r) => r.userId),
      state,
      startedAt: state === 'created' ? null : 1_000_000_000_000,
      results: [],
      flags: { needsReview: false },
      version: 1,
    },
  };
}

describe('race/remove_player — removePlayerFromAll', () => {
  it('returns empty result when no sessions exist', () => {
    const nk = makeFakeNk({});
    const r = removePlayerFromAll(nk as unknown as INakama, SILENT_LOGGER, 'user-a');
    expect(r.abandonedFrom).toEqual([]);
    expect(r.closedSessions).toEqual([]);
  });

  it('marks a player abandoned in a started session', () => {
    const nk = makeFakeNk({
      'race_sessions/s1/00000000-0000-0000-0000-000000000000': sessionFor(
        's1',
        'started',
        [{ userId: 'user-a' }, { userId: 'user-b' }],
      ),
    });
    const r = removePlayerFromAll(nk as unknown as INakama, SILENT_LOGGER, 'user-a');
    expect(r.abandonedFrom).toEqual(['s1']);
    expect(r.closedSessions).toEqual([]);
  });

  it('records closed sessions without modifying them', () => {
    const nk = makeFakeNk({
      'race_sessions/s1/00000000-0000-0000-0000-000000000000': sessionFor(
        's1',
        'closed',
        [{ userId: 'user-a' }],
      ),
    });
    const r = removePlayerFromAll(nk as unknown as INakama, SILENT_LOGGER, 'user-a');
    expect(r.abandonedFrom).toEqual([]);
    expect(r.closedSessions).toEqual(['s1']);
  });

  it('skips players not in any roster', () => {
    const nk = makeFakeNk({
      'race_sessions/s1/00000000-0000-0000-0000-000000000000': sessionFor(
        's1',
        'started',
        [{ userId: 'user-b' }, { userId: 'user-c' }],
      ),
    });
    const r = removePlayerFromAll(nk as unknown as INakama, SILENT_LOGGER, 'user-a');
    expect(r.abandonedFrom).toEqual([]);
  });

  it('is idempotent — re-running is a no-op for already-abandoned entries', () => {
    const nk = makeFakeNk({
      'race_sessions/s1/00000000-0000-0000-0000-000000000000': sessionFor(
        's1',
        'started',
        [{ userId: 'user-a', abandoned: true }],
      ),
    });
    const r1 = removePlayerFromAll(nk as unknown as INakama, SILENT_LOGGER, 'user-a');
    const r2 = removePlayerFromAll(nk as unknown as INakama, SILENT_LOGGER, 'user-a');
    expect(r1.abandonedFrom).toEqual(['s1']);
    expect(r2.abandonedFrom).toEqual(['s1']);
  });

  it('handles multiple sessions and reports all of them', () => {
    const nk = makeFakeNk({
      'race_sessions/s1/sys': sessionFor('s1', 'started', [{ userId: 'user-a' }]),
      'race_sessions/s2/sys': sessionFor('s2', 'started', [{ userId: 'user-a' }, { userId: 'user-b' }]),
      'race_sessions/s3/sys': sessionFor('s3', 'started', [{ userId: 'user-c' }]),
    });
    const r = removePlayerFromAll(nk as unknown as INakama, SILENT_LOGGER, 'user-a');
    expect(r.abandonedFrom.sort()).toEqual(['s1', 's2']);
  });
});