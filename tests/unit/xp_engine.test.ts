// Phase 6 Chunk 7 — xp_engine pure helpers.

import { describe, it, expect } from 'vitest';
import {
  RACE_XP_BASE,
  RACE_XP_MULTIPLIER,
  PASS_XP_SOURCES,
  passXPSourceForRace,
  raceXPFor,
  missionXPFor,
  achievementXPFor,
} from '../../modules/src/pass/xp_engine';

describe('xp_engine (Phase 6 Chunk 7) — raceXPFor', () => {
  it('quick race → 20 XP (base × 1)', () => {
    expect(raceXPFor('quick')).toBe(20);
  });

  it('ranked race → 25 XP (floor(20 × 1.25))', () => {
    expect(raceXPFor('ranked')).toBe(25);
  });

  it('private race → 5 XP (floor(20 × 0.25))', () => {
    expect(raceXPFor('private')).toBe(5);
  });

  it('time_trial race → 10 XP (floor(20 × 0.5))', () => {
    expect(raceXPFor('time_trial')).toBe(10);
  });

  it('RACE_XP_BASE is 20 (D7 base value)', () => {
    expect(RACE_XP_BASE).toBe(20);
  });

  it('RACE_XP_MULTIPLIER covers every MissionRaceMode', () => {
    expect(Object.keys(RACE_XP_MULTIPLIER).sort()).toEqual(
      ['private', 'quick', 'ranked', 'time_trial'],
    );
  });
});

describe('xp_engine (Phase 6 Chunk 7) — passXPSourceForRace', () => {
  it('maps quick → race_quick', () => {
    expect(passXPSourceForRace('quick')).toBe('race_quick');
  });
  it('maps ranked → race_ranked', () => {
    expect(passXPSourceForRace('ranked')).toBe('race_ranked');
  });
  it('maps private → race_private', () => {
    expect(passXPSourceForRace('private')).toBe('race_private');
  });
  it('maps time_trial → race_time_trial', () => {
    expect(passXPSourceForRace('time_trial')).toBe('race_time_trial');
  });
});

describe('xp_engine (Phase 6 Chunk 7) — missionXPFor / achievementXPFor', () => {
  it('returns reward.xp when positive integer', () => {
    expect(missionXPFor({ xp: 100 })).toBe(100);
  });
  it('returns 0 when xp is missing', () => {
    expect(missionXPFor({})).toBe(0);
  });
  it('returns 0 when xp is zero', () => {
    expect(missionXPFor({ xp: 0 })).toBe(0);
  });
  it('returns 0 when xp is negative (defensive)', () => {
    expect(missionXPFor({ xp: -5 })).toBe(0);
  });
  it('returns 0 when xp is non-integer (defensive)', () => {
    expect(missionXPFor({ xp: 1.5 })).toBe(0);
    expect(missionXPFor({ xp: 99.9 })).toBe(0);
  });
  it('achievementXPFor matches missionXPFor', () => {
    expect(achievementXPFor({ xp: 200 })).toBe(200);
    expect(achievementXPFor({})).toBe(0);
  });
});

describe('xp_engine (Phase 6 Chunk 7) — PASS_XP_SOURCES', () => {
  it('contains the 6 expected source tags', () => {
    expect(PASS_XP_SOURCES).toEqual([
      'race_quick',
      'race_ranked',
      'race_private',
      'race_time_trial',
      'mission_claim',
      'achievement_claim',
    ]);
  });
});