// Phase 4 Chunk 3 unit tests for the track-picker (pure helper).

import { describe, it, expect } from 'vitest';
import { pickTrack, fnv1a } from '../../modules/src/matchmaking/track_picker';

describe('track_picker (Phase 4 Chunk 3)', () => {
  it('pickTrack returns a track from the allowed set when no exclusions are present', () => {
    const allowed = ['neon_blvd', 'reef_run', 'mountain_pass'];
    const pick = pickTrack(allowed, [], 'sid-1');
    expect(allowed).toContain(pick);
  });

  it('pickTrack avoids every track in the exclude set when the intersection is non-empty', () => {
    const allowed = ['neon_blvd', 'reef_run', 'mountain_pass'];
    const exclude = ['neon_blvd'];
    const pick = pickTrack(allowed, exclude, 'sid-1');
    expect(pick).not.toBe('neon_blvd');
    expect(allowed).toContain(pick);
  });

  it('pickTrack excludes the last 2 recent tracks (D2) when the caller passes them in', () => {
    const allowed = ['a', 'b', 'c', 'd'];
    const exclude = ['a', 'b'];
    const pick = pickTrack(allowed, exclude, 'sid-1');
    expect(['c', 'd']).toContain(pick);
  });

  it('pickTrack falls back to the full set when the intersection is empty (D2 graceful)', () => {
    const allowed = ['a', 'b'];
    const exclude = ['a', 'b'];
    const pick = pickTrack(allowed, exclude, 'sid-1');
    expect(['a', 'b']).toContain(pick);
  });

  it('pickTrack returns the empty string when the allowed set is empty', () => {
    expect(pickTrack([], [], 'sid-1')).toBe('');
  });

  it('pickTrack is deterministic per seed (no Math.random — same seed picks same track)', () => {
    const allowed = ['a', 'b', 'c', 'd', 'e'];
    const exclude: string[] = [];
    const pick1 = pickTrack(allowed, exclude, 'seed-xyz');
    const pick2 = pickTrack(allowed, exclude, 'seed-xyz');
    expect(pick1).toBe(pick2);
  });

  it('pickTrack produces a stable distribution across seeds (no constant return)', () => {
    const allowed = ['a', 'b', 'c', 'd'];
    const exclude: string[] = [];
    const picks = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      picks.add(pickTrack(allowed, exclude, `seed-${i}`));
    }
    // At least 2 distinct picks across 20 seeds — sanity check on the
    // FNV hash distribution. (Not a strict uniformity test.)
    expect(picks.size).toBeGreaterThanOrEqual(2);
  });

  it('fnv1a is deterministic and produces different hashes for different inputs', () => {
    expect(fnv1a('a')).toBe(fnv1a('a'));
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
  });

  it('fnv1a returns an int32 (within JS safe-int range)', () => {
    const h = fnv1a('long-input-string-for-testing');
    expect(Number.isInteger(h)).toBe(true);
    expect(Math.abs(h)).toBeLessThanOrEqual(0x7fffffff);
  });
});