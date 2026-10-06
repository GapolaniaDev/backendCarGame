// Phase 4 Chunk 3 unit tests for the quick_bots helpers (D3 + D10).

import { describe, it, expect } from 'vitest';
import {
  averageRating,
  buildBotRoster,
  pickBotCount,
  pickBotDifficulty,
} from '../../modules/src/matchmaking/quick_bots';
import type { Loadout } from '../../modules/src/race/types';

const LOADOUT: Loadout = { classId: 'C', bodyId: 'viper' };

describe('quick_bots (Phase 4 Chunk 3)', () => {
  // ─── D3 difficulty formula ─────────────────────────────────────────────────
  it('pickBotDifficulty: 1000 → 2 (silver)', () => {
    expect(pickBotDifficulty(1000)).toBe(2);
  });

  it('pickBotDifficulty: 400 → 0 (bronze)', () => {
    expect(pickBotDifficulty(400)).toBe(0);
  });

  it('pickBotDifficulty: 2000 → 4 (diamond)', () => {
    expect(pickBotDifficulty(2000)).toBe(4);
  });

  it('pickBotDifficulty: 2200 → clamps to 4', () => {
    expect(pickBotDifficulty(2200)).toBe(4);
  });

  it('pickBotDifficulty: 50 → clamps to 0', () => {
    expect(pickBotDifficulty(50)).toBe(0);
  });

  it('pickBotDifficulty: 0 → clamps to 0', () => {
    expect(pickBotDifficulty(0)).toBe(0);
  });

  it('pickBotDifficulty: honours difficultyCap argument', () => {
    expect(pickBotDifficulty(2000, 2)).toBe(2);
  });

  it('pickBotDifficulty: ignores NaN / negative input (falls back to 0)', () => {
    expect(pickBotDifficulty(Number.NaN)).toBe(0);
    expect(pickBotDifficulty(-100)).toBe(0);
  });

  // ─── D10 bot count ─────────────────────────────────────────────────────────
  it('pickBotCount: size=4, humans=1 → 3 bots', () => {
    expect(pickBotCount(1, 4)).toBe(3);
  });

  it('pickBotCount: size=6, humans=4 → 2 bots', () => {
    expect(pickBotCount(4, 6)).toBe(2);
  });

  it('pickBotCount: size=2, humans=2 → 0 bots (full human lobby)', () => {
    expect(pickBotCount(2, 2)).toBe(0);
  });

  it('pickBotCount: humans=0 → size bots (all-bot fallback)', () => {
    expect(pickBotCount(0, 4)).toBe(4);
  });

  it('pickBotCount: humans>size → returns 0 (defensive)', () => {
    expect(pickBotCount(5, 4)).toBe(0);
  });

  // ─── averageRating ─────────────────────────────────────────────────────────
  it('averageRating averages across all rated humans', () => {
    expect(averageRating([
      { userId: 'a', rating: 1000 },
      { userId: 'b', rating: 1400 },
    ])).toBe(1200);
  });

  it('averageRating ignores humans without a rating', () => {
    expect(averageRating([
      { userId: 'a' },
      { userId: 'b', rating: 800 },
    ])).toBe(800);
  });

  it('averageRating returns 1000 (initial rating) when no humans have a rating', () => {
    expect(averageRating([{ userId: 'a' }, { userId: 'b' }])).toBe(1000);
  });

  // ─── buildBotRoster composition ────────────────────────────────────────────
  it('buildBotRoster fills size-1 bots when there is 1 human and size=4', () => {
    const r = buildBotRoster({
      size: 4,
      humans: [{ userId: 'host', rttMs: 50, rating: 1200 }],
      hostLoadout: LOADOUT,
    });
    expect(r.roster).toHaveLength(4);
    expect(r.botCount).toBe(3);
    const bots = r.roster.filter((e) => e.isBot);
    expect(bots).toHaveLength(3);
    expect(r.host).toBe('host');
    expect(r.hostSuccession).toEqual(['host']);
    // Bot difficulty at rating 1200 → round(3)-1 = 2.
    expect(r.botDifficulty).toBe(2);
  });

  it('buildBotRoster produces 0 bots when the roster is full of humans', () => {
    const r = buildBotRoster({
      size: 2,
      humans: [
        { userId: 'a', rttMs: 50, rating: 1000 },
        { userId: 'b', rttMs: 80, rating: 1100 },
      ],
      hostLoadout: LOADOUT,
    });
    expect(r.botCount).toBe(0);
    expect(r.roster).toHaveLength(2);
    expect(r.roster.every((e) => !e.isBot)).toBe(true);
    // Average rating 1050 → round(2.625)-1 = 3-1 = 2
    expect(r.botDifficulty).toBe(2);
  });

  it('buildBotRoster picks the lowest-rtt human as host when there are several', () => {
    const r = buildBotRoster({
      size: 4,
      humans: [
        { userId: 'a', rttMs: 120, rating: 1000 },
        { userId: 'b', rttMs: 30, rating: 1000 },
      ],
      hostLoadout: LOADOUT,
    });
    expect(r.host).toBe('b');
    expect(r.hostSuccession).toEqual(['b', 'a']);
  });

  it('buildBotRoster assigns bots a stable synthetic id with the difficulty and index', () => {
    const r = buildBotRoster({
      size: 4,
      humans: [{ userId: 'host', rttMs: 50, rating: 2000 }],
      hostLoadout: LOADOUT,
    });
    expect(r.roster[1]?.userId).toBe('bot_qb_d4_0');
    expect(r.roster[2]?.userId).toBe('bot_qb_d4_1');
    expect(r.roster[3]?.userId).toBe('bot_qb_d4_2');
  });

  it('buildBotRoster throws when there are zero humans', () => {
    expect(() =>
      buildBotRoster({
        size: 4,
        humans: [],
        hostLoadout: LOADOUT,
      }),
    ).toThrow(/at least one human/);
  });

  it('buildBotRoster throws when humans exceed size', () => {
    expect(() =>
      buildBotRoster({
        size: 2,
        humans: [
          { userId: 'a', rating: 1000 },
          { userId: 'b', rating: 1000 },
          { userId: 'c', rating: 1000 },
        ],
        hostLoadout: LOADOUT,
      }),
    ).toThrow(/exceeds size/);
  });

  it('buildBotRoster reuses the host classId for every bot', () => {
    const r = buildBotRoster({
      size: 4,
      humans: [{ userId: 'host', rating: 1000 }],
      hostLoadout: { classId: 'A', bodyId: 'phantom' },
    });
    for (const e of r.roster) {
      expect(e.loadout.classId).toBe('A');
    }
  });
});