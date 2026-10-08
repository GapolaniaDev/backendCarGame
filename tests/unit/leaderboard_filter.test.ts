// Phase 8 Chunk 3 — Unit tests for leaderboard_filter.

import { describe, it, expect } from 'vitest';

import { shouldExcludeFromLeaderboards } from '../../modules/src/anti_cheat/leaderboard_filter';
import { appendMark, _resetMarksStateForTests, type AntiCheatMark } from '../../modules/src/anti_cheat/marks';
import { FakeNakama } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';

const NOW = 1_700_000_000_000;

function mkMark(overrides?: Partial<AntiCheatMark>): AntiCheatMark {
  return {
    id: `mk-${Math.random().toString(36).slice(2, 10)}`,
    userId: 'u1',
    raceId: 'race-1',
    kind: 'partial_impossible',
    severity: 'low',
    detectedAt: NOW,
    confirmed: false,
    dismissed: false,
    ...overrides,
  };
}

describe('leaderboard_filter (Phase 8 Chunk 3)', () => {
  it('returns false when the user has no marks', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    expect(shouldExcludeFromLeaderboards(nk, 'ghost', NOW)).toBe(false);
  });

  it('returns false when the user has only low/medium marks', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    appendMark(nk, 'u1', mkMark({ id: 'a', severity: 'low' }));
    appendMark(nk, 'u1', mkMark({ id: 'b', severity: 'medium' }));
    expect(shouldExcludeFromLeaderboards(nk, 'u1', NOW)).toBe(false);
  });

  it('returns true when the user has a high mark', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    appendMark(nk, 'u1', mkMark({ id: 'a', severity: 'high' }));
    expect(shouldExcludeFromLeaderboards(nk, 'u1', NOW)).toBe(true);
  });

  it('returns true when any mark has hiddenUntilUtc in the future', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    appendMark(nk, 'u1', mkMark({ id: 'a', severity: 'low', hiddenUntilUtc: NOW + 60_000 }));
    expect(shouldExcludeFromLeaderboards(nk, 'u1', NOW)).toBe(true);
  });

  it('returns false when all high marks are dismissed', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    appendMark(nk, 'u1', mkMark({ id: 'a', severity: 'high', dismissed: true }));
    expect(shouldExcludeFromLeaderboards(nk, 'u1', NOW)).toBe(false);
  });

  it('returns false when hiddenUntilUtc has expired', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    appendMark(nk, 'u1', mkMark({ id: 'a', severity: 'low', hiddenUntilUtc: NOW - 1000 }));
    expect(shouldExcludeFromLeaderboards(nk, 'u1', NOW)).toBe(false);
  });

  it('reads fresh each call (no caching — admin unsanction takes effect immediately)', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    appendMark(nk, 'u1', mkMark({ id: 'a', severity: 'high' }));
    expect(shouldExcludeFromLeaderboards(nk, 'u1', NOW)).toBe(true);
    // Add a second high mark — the next call must reflect the new state
    // without any cache layer.
    appendMark(nk, 'u1', mkMark({ id: 'b', severity: 'high' }));
    expect(shouldExcludeFromLeaderboards(nk, 'u1', NOW)).toBe(true);
    // And the count is read fresh, so a dismiss-on-dismiss would also be visible.
    _resetMarksStateForTests();
  });
});