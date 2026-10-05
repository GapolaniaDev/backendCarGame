import { describe, it, expect } from 'vitest';
import {
  canTransition,
  allowedFrom,
  acceptsReports,
} from '../../modules/src/race/state';
import type { RaceState } from '../../modules/src/race/types';

describe('race/state.ts', () => {
  describe('canTransition', () => {
    it.each([
      ['created', 'started', true],
      ['created', 'closed', false],
      ['started', 'closing', true],
      ['started', 'created', false],
      ['closing', 'closed', true],
      ['closing', 'started', false],
      ['closed', 'created', false],
      ['closed', 'started', false],
    ] as Array<[RaceState, RaceState, boolean]>)(
      'allows %s → %s? %s',
      (from, to, expected) => {
        expect(canTransition(from, to)).toBe(expected);
      },
    );

    it('is purely forward — no self-loops', () => {
      const states: RaceState[] = ['created', 'started', 'closing', 'closed'];
      for (const s of states) {
        expect(canTransition(s, s)).toBe(false);
      }
    });
  });

  describe('allowedFrom', () => {
    it('returns the next reachable states', () => {
      expect(allowedFrom('created')).toEqual(['started']);
      expect(allowedFrom('started')).toEqual(['closing']);
      expect(allowedFrom('closing')).toEqual(['closed']);
      expect(allowedFrom('closed')).toEqual([]);
    });
  });

  describe('acceptsReports', () => {
    it('is true only for started', () => {
      expect(acceptsReports('started')).toBe(true);
      expect(acceptsReports('created')).toBe(false);
      expect(acceptsReports('closing')).toBe(false);
      expect(acceptsReports('closed')).toBe(false);
    });
  });
});