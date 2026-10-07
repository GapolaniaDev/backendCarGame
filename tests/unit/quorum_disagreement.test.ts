// Phase 8 Chunk 2 — Unit tests for quorum-disagreement detection.

import { describe, it, expect } from 'vitest';

import {
  detectQuorumDisagreement,
  readRecentQuorumMarks,
  appendQuorumMark,
  QUORUM_MARKS_COLLECTION,
  QUORUM_WINDOW_DAYS,
  QUORUM_THRESHOLD,
  type QuorumMark,
} from '../../modules/src/anti_cheat/quorum_disagreement';
import { FakeNakama } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function mark(daysAgo: number): QuorumMark {
  return { ts: NOW - daysAgo * DAY_MS, kind: 'quorum_disagreement' };
}

describe('quorum_disagreement (Phase 8 Chunk 2)', () => {
  describe('detectQuorumDisagreement — pure', () => {
    it('returns ok=true for empty marks', () => {
      const r = detectQuorumDisagreement([], NOW);
      expect(r.ok).toBe(true);
    });

    it('returns ok=true with 4 marks (one short of threshold)', () => {
      const r = detectQuorumDisagreement(
        [mark(1), mark(2), mark(3), mark(4)],
        NOW,
      );
      expect(r.ok).toBe(true);
    });

    it('returns ok=false with exactly 5 marks in the window', () => {
      const r = detectQuorumDisagreement(
        [mark(0.5), mark(1), mark(2), mark(3), mark(5)],
        NOW,
      );
      expect(r.ok).toBe(false);
      expect(r.count).toBe(5);
      expect(r.windowStartUtc).toBe(NOW - QUORUM_WINDOW_DAYS * DAY_MS);
    });

    it('returns ok=false with 10 marks in 1 day', () => {
      const r = detectQuorumDisagreement(
        Array.from({ length: 10 }, (_, i) => mark(0.1 * (i + 1))),
        NOW,
      );
      expect(r.ok).toBe(false);
      expect(r.count).toBe(10);
    });

    it('returns ok=true when only 4 of 5 marks are inside the 7d window', () => {
      const r = detectQuorumDisagreement(
        [mark(1), mark(2), mark(3), mark(4), mark(8)], // last is outside
        NOW,
      );
      expect(r.ok).toBe(true);
    });

    it('returns ok=true when marks are all OUTSIDE the 7d window', () => {
      const r = detectQuorumDisagreement(
        [mark(10), mark(15), mark(20), mark(30), mark(40)],
        NOW,
      );
      expect(r.ok).toBe(true);
    });

    it('handles boundary marks (exactly 7 days ago counts as inside)', () => {
      // The detector uses `ts >= nowUtc - windowMs`, so exactly 7d ago
      // is at the boundary and INCLUDED.
      const exactly7d = { ts: NOW - QUORUM_WINDOW_DAYS * DAY_MS, kind: 'quorum_disagreement' as const };
      const r = detectQuorumDisagreement(
        [exactly7d, mark(5), mark(3), mark(2), mark(1)],
        NOW,
      );
      expect(r.ok).toBe(false);
      expect(r.count).toBe(5);
    });

    it('ignores non-quorum-disagreement kinds', () => {
      const r = detectQuorumDisagreement(
        [
          { ts: NOW - 1000, kind: 'abrupt_improvement' as QuorumMark['kind'] },
          { ts: NOW - 1000, kind: 'partial_impossible' as QuorumMark['kind'] },
        ],
        NOW,
      );
      expect(r.ok).toBe(true);
    });
  });

  describe('readRecentQuorumMarks + appendQuorumMark — storage', () => {
    it('round-trips marks', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendQuorumMark(nk, 'u1', mark(1));
      appendQuorumMark(nk, 'u1', mark(2));
      const list = readRecentQuorumMarks(nk, 'u1');
      expect(list).toHaveLength(2);
    });

    it('returns [] for a missing user', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      expect(readRecentQuorumMarks(nk, 'ghost')).toEqual([]);
    });

    it('appending preserves prior entries (CAS retry path)', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      // Seed the row directly, then append.
      fake.store.set(`${QUORUM_MARKS_COLLECTION}/u1/u1`, {
        collection: QUORUM_MARKS_COLLECTION,
        key: 'u1',
        userId: 'u1',
        value: {
          schemaVersion: 1,
          userId: 'u1',
          marks: [mark(10)],
        },
        version: 'v00000099',
        permissionRead: 1,
        permissionWrite: 0,
        createTime: new Date(0).toISOString(),
        updateTime: new Date(0).toISOString(),
        expiresAt: null,
      });
      appendQuorumMark(nk, 'u1', mark(1));
      const list = readRecentQuorumMarks(nk, 'u1');
      expect(list).toHaveLength(2);
      expect(list[0]?.ts).toBe(mark(10).ts);
      expect(list[1]?.ts).toBe(mark(1).ts);
    });

    it('writes are server-only (Read=1, Write=0)', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendQuorumMark(nk, 'u1', mark(1));
      const stored = fake.store.get(`${QUORUM_MARKS_COLLECTION}/u1/u1`);
      expect(stored).toBeDefined();
      expect(stored?.permissionRead).toBe(1);
      expect(stored?.permissionWrite).toBe(0);
    });
  });
});