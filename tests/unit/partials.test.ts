// Phase 8 Chunk 2 — Unit tests for race partials detection.

import { describe, it, expect } from 'vitest';

import {
  validatePartials,
  readRacePartials,
  writeRacePartials,
  RACE_PARTIALS_COLLECTION,
  RACE_PARTIALS_SYSTEM_USER,
  type RacePartial,
} from '../../modules/src/anti_cheat/partials';
import { FakeNakama } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';

const MIN_MS = 1500; // realistic per-track min section time

function cp(index: number, timeMs: number): RacePartial {
  return { index, timeMs };
}

describe('partials (Phase 8 Chunk 2)', () => {
  describe('validatePartials — pure', () => {
    it('returns ok=true for an empty array', () => {
      expect(validatePartials([], MIN_MS)).toEqual({ ok: true });
    });

    it('returns ok=true for a single checkpoint (insufficient data)', () => {
      expect(validatePartials([cp(0, 1000)], MIN_MS)).toEqual({ ok: true });
    });

    it('accepts two checkpoints with delta above the floor', () => {
      const r = validatePartials(
        [cp(0, 1000), cp(1, 1000 + 5000)], // delta = 5000ms
        MIN_MS,
      );
      expect(r.ok).toBe(true);
    });

    it('rejects two checkpoints with delta below the floor', () => {
      const r = validatePartials(
        [cp(0, 1000), cp(1, 1000 + 800)], // delta = 800ms
        MIN_MS,
      );
      expect(r.ok).toBe(false);
      expect(r.violationAt).toBe(1);
      expect(r.deltaTimeMs).toBe(800);
    });

    it('rejects when a violation is in the middle of the array', () => {
      const r = validatePartials(
        [
          cp(0, 1000),
          cp(1, 1000 + 5000),  // ok (5000ms)
          cp(2, 1000 + 8000),  // ok (3000ms)
          cp(3, 1000 + 8300),  // VIOLATION (300ms < 1500ms)
        ],
        MIN_MS,
      );
      expect(r.ok).toBe(false);
      expect(r.violationAt).toBe(3);
      expect(r.deltaTimeMs).toBe(300);
    });

    it('rejects zero delta (duplicate timestamps / clock stuck)', () => {
      const r = validatePartials(
        [cp(0, 1000), cp(1, 1000)], // delta = 0
        MIN_MS,
      );
      expect(r.ok).toBe(false);
      expect(r.violationAt).toBe(1);
      expect(r.deltaTimeMs).toBe(0);
    });

    it('rejects negative delta (out-of-order checkpoints)', () => {
      const r = validatePartials(
        [cp(0, 5000), cp(1, 1000)], // delta = -4000
        MIN_MS,
      );
      expect(r.ok).toBe(false);
      expect(r.violationAt).toBe(1);
      expect(r.deltaTimeMs).toBe(-4000);
    });

    it('returns ok=true when 5 consecutive checkpoints are all above the floor', () => {
      const r = validatePartials(
        [
          cp(0, 1000),
          cp(1, 2600), // +1600
          cp(2, 4200), // +1600
          cp(3, 5800), // +1600
          cp(4, 7400), // +1600
        ],
        MIN_MS,
      );
      expect(r.ok).toBe(true);
    });

    it('rejects when minSectionTimeMs is non-positive (defensive)', () => {
      const r = validatePartials(
        [cp(0, 0), cp(1, 1)],
        0,
      );
      expect(r.ok).toBe(false);
    });
  });

  describe('readRacePartials + writeRacePartials — storage', () => {
    it('round-trips a partials list', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      const partials: RacePartial[] = [cp(0, 1000), cp(1, 2600), cp(2, 4200)];
      writeRacePartials(nk, 'race-1', partials);
      const read = readRacePartials(nk, 'race-1');
      expect(read).toEqual(partials);
    });

    it('returns an empty array for a missing raceId', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      expect(readRacePartials(nk, 'missing')).toEqual([]);
    });

    it('writes are server-only (Read=1, Write=0)', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      writeRacePartials(nk, 'race-1', [cp(0, 1000)]);
      const key = `${RACE_PARTIALS_COLLECTION}/race-1/${RACE_PARTIALS_SYSTEM_USER}`;
      const stored = fake.store.get(key);
      expect(stored).toBeDefined();
      expect(stored?.permissionRead).toBe(1);
      expect(stored?.permissionWrite).toBe(0);
      expect(stored?.userId).toBe(RACE_PARTIALS_SYSTEM_USER);
    });

    it('overwrites an existing race row (CAS retry path)', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      writeRacePartials(nk, 'race-1', [cp(0, 1000), cp(1, 2600)]);
      writeRacePartials(nk, 'race-1', [cp(0, 1000), cp(1, 2600), cp(2, 4200)]);
      const read = readRacePartials(nk, 'race-1');
      expect(read).toHaveLength(3);
    });
  });
});