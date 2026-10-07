// Phase 8 Chunk 2 — Unit tests for anti-cheat history storage helpers.

import { describe, it, expect } from 'vitest';

import {
  readHistory,
  appendHistory,
  pruneHistory,
  ANTI_CHEAT_HISTORY_COLLECTION,
  ANTI_CHEAT_HISTORY_MAX_ENTRIES,
  type AntiCheatHistoryEntry,
} from '../../modules/src/anti_cheat/history';
import { FakeNakama } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';

function entry(raceId: string, ts: number, ok = true): AntiCheatHistoryEntry {
  return {
    raceId,
    ts,
    checks: [{ kind: 'abrupt_improvement', ok }],
  };
}

describe('anti_cheat_history (Phase 8 Chunk 2)', () => {
  describe('readHistory + appendHistory', () => {
    it('returns [] when no history exists', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      expect(readHistory(nk, 'u1')).toEqual([]);
    });

    it('append + read returns the entry', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendHistory(nk, 'u1', entry('r1', 1000));
      expect(readHistory(nk, 'u1')).toEqual([entry('r1', 1000)]);
    });

    it('two appends produce two entries', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendHistory(nk, 'u1', entry('r1', 1000));
      appendHistory(nk, 'u1', entry('r2', 2000));
      const list = readHistory(nk, 'u1');
      expect(list).toHaveLength(2);
      expect(list[0]?.raceId).toBe('r1');
      expect(list[1]?.raceId).toBe('r2');
    });

    it('caps at ANTI_CHEAT_HISTORY_MAX_ENTRIES (ring trim)', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      const N = ANTI_CHEAT_HISTORY_MAX_ENTRIES + 10;
      for (let i = 0; i < N; i += 1) {
        appendHistory(nk, 'u1', entry(`r${i}`, i));
      }
      const list = readHistory(nk, 'u1');
      expect(list).toHaveLength(ANTI_CHEAT_HISTORY_MAX_ENTRIES);
      // First 10 dropped; first kept is r10.
      expect(list[0]?.raceId).toBe('r10');
      expect(list[list.length - 1]?.raceId).toBe(`r${N - 1}`);
    });

    it('writes are server-only (Read=1, Write=0)', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendHistory(nk, 'u1', entry('r1', 1000));
      const stored = fake.store.get(`${ANTI_CHEAT_HISTORY_COLLECTION}/u1/u1`);
      expect(stored).toBeDefined();
      expect(stored?.permissionRead).toBe(1);
      expect(stored?.permissionWrite).toBe(0);
    });
  });

  describe('pruneHistory', () => {
    it('drops entries older than the cutoff', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendHistory(nk, 'u1', entry('old', 1000));    // older
      appendHistory(nk, 'u1', entry('mid', 5000));    // older
      appendHistory(nk, 'u1', entry('new', 9000));    // newer
      pruneHistory(nk, 'u1', 6000); // cutoff = 6000
      const list = readHistory(nk, 'u1');
      expect(list.map((e) => e.raceId)).toEqual(['new']);
    });

    it('keeps entries at-or-after the cutoff', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendHistory(nk, 'u1', entry('r1', 5000));
      appendHistory(nk, 'u1', entry('r2', 6000)); // exactly at cutoff
      appendHistory(nk, 'u1', entry('r3', 7000));
      pruneHistory(nk, 'u1', 6000);
      const list = readHistory(nk, 'u1');
      expect(list.map((e) => e.raceId).sort()).toEqual(['r2', 'r3']);
    });

    it('is a no-op when there is nothing to prune', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendHistory(nk, 'u1', entry('r1', 5000));
      appendHistory(nk, 'u1', entry('r2', 6000));
      // Capture version before prune.
      const before = fake.store.get(`${ANTI_CHEAT_HISTORY_COLLECTION}/u1/u1`)?.version;
      pruneHistory(nk, 'u1', 1000); // everything is newer
      const after = fake.store.get(`${ANTI_CHEAT_HISTORY_COLLECTION}/u1/u1`)?.version;
      expect(after).toBe(before); // no write happened
      const list = readHistory(nk, 'u1');
      expect(list).toHaveLength(2);
    });

    it('is a no-op when the row is missing entirely', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      expect(() => pruneHistory(nk, 'ghost', 0)).not.toThrow();
    });
  });
});