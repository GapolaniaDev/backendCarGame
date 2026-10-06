// Phase 4 Chunk 3 unit tests for the host_choice helpers.

import { describe, it, expect } from 'vitest';
import { pickHost, pickHostSuccession } from '../../modules/src/matchmaking/host_choice';

describe('host_choice (Phase 4 Chunk 3)', () => {
  it('pickHost returns the only human when the roster is a single human', () => {
    expect(pickHost([{ userId: 'a', rttMs: 200 }])).toBe('a');
  });

  it('pickHost picks the human with the lowest rtt', () => {
    const r = pickHost([
      { userId: 'a', rttMs: 200 },
      { userId: 'b', rttMs: 50 },
      { userId: 'c', rttMs: 120 },
    ]);
    expect(r).toBe('b');
  });

  it('pickHost resolves ties by lexicographically smallest userId', () => {
    const r = pickHost([
      { userId: 'b', rttMs: 50 },
      { userId: 'a', rttMs: 50 },
      { userId: 'c', rttMs: 50 },
    ]);
    expect(r).toBe('a');
  });

  it('pickHost treats undefined rtt as the maximum (falls back to other entries)', () => {
    const r = pickHost([
      { userId: 'a' }, // rtt undefined → treated as 9999
      { userId: 'b', rttMs: 100 },
      { userId: 'c', rttMs: 50 },
    ]);
    expect(r).toBe('c');
  });

  it('pickHost throws on empty roster', () => {
    expect(() => pickHost([])).toThrow(/empty roster/);
  });

  it('pickHostSuccession orders humans ascending by rtt (host candidate first)', () => {
    const s = pickHostSuccession([
      { userId: 'a', rttMs: 200 },
      { userId: 'b', rttMs: 50 },
      { userId: 'c', rttMs: 120 },
    ]);
    expect(s).toEqual(['b', 'c', 'a']);
  });

  it('pickHostSuccession resolves ties by userId (lex asc)', () => {
    const s = pickHostSuccession([
      { userId: 'c', rttMs: 50 },
      { userId: 'a', rttMs: 50 },
      { userId: 'b', rttMs: 50 },
    ]);
    expect(s).toEqual(['a', 'b', 'c']);
  });

  it('pickHostSuccession returns the single user when roster has one entry', () => {
    expect(pickHostSuccession([{ userId: 'only', rttMs: 9999 }])).toEqual(['only']);
  });

  it('pickHostSuccession returns empty for empty input', () => {
    expect(pickHostSuccession([])).toEqual([]);
  });
});