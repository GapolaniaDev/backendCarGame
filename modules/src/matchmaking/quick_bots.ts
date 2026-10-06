// Phase 4 Chunk 3 — quick_bots (pure helpers + roster builder).
//
// Decision D3: bot difficulty ∈ {0, 1, 2, 3, 4}. Derived from the
//   average rating of every human in the roster so the bot field
//   matches the player's skill band. Formula:
//     clamp(round(avgRating / 400) - 1, 0, 4)
//   - rating < 400 → 0 (bronze)
//   - rating 1000  → 2 (silver)
//   - rating 2000 → 4 (diamond)
//   - rating > 2000 → clamp 4
//   - rating < 200 → clamp 0
//
// Decision D10: bot count = size - humanCount. A quick_bots session
//   with size=4 and one human gets 3 bots. With size=4 and four humans
//   it gets 0 bots (full human lobby).
//
// The roster builder composes `pickHost` (human with lowest rtt) +
// `pickHostSuccession` (RTT-sorted human list) and fills the bot
// slots with synthetic bot entries. Each bot carries a stable id
// (`bot_<difficulty>_<n>`), `isBot: true`, a synthetic rttMs, and the
// same loadout class as the host human (so all cars share the same
// min-time band — keeps lap-sum validation honest).

import { pickHost, pickHostSuccession } from './host_choice';
import type { CarClassId, Loadout, RosterEntry } from '../race/types';

export interface HumanPlayer {
  userId: string;
  rttMs?: number;
  rating?: number;
}

export interface BuildBotRosterInput {
  /** Session size (2 / 4 / 6). */
  size: 2 | 4 | 6;
  /** Human players that will join the session. Must contain at least 1. */
  humans: ReadonlyArray<HumanPlayer>;
  /** Loadout the host human will use — bots reuse its classId. */
  hostLoadout: Loadout;
  /** `clamped` difficulty cap (e.g. liveops override). Optional. */
  difficultyCap?: number;
  /** Salt for stable bot ids (default 'qb'). Useful in tests. */
  botIdSalt?: string;
}

export interface BuiltBotRoster {
  roster: RosterEntry[];
  host: string;
  hostSuccession: string[];
  botCount: number;
  botDifficulty: number;
}

/**
 * Compute the bot difficulty from the average rating of every human
 * player. Defaults to the initial rating (1000) when no humans supply
 * a rating (defensive — the RPC layer always supplies one).
 *
 * Decision D3 formula:
 *   clamp(round(avgRating / 400) - 1, 0, difficultyCap ?? 4)
 *
 * Pass `difficultyCap` < 0 or > 4 to use the default cap of 4.
 */
export function pickBotDifficulty(
  avgRating: number,
  difficultyCap: number = 4,
): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(avgRating) || avgRating < 0) avgRating = 0;
  const cap = difficultyCap >= 0 && difficultyCap <= 4 ? Math.floor(difficultyCap) : 4;
  const raw = Math.round(avgRating / 400) - 1;
  const clamped = Math.max(0, Math.min(cap, raw));
  return clamped as 0 | 1 | 2 | 3 | 4;
}

/**
 * Compute the bot count for a session of `size` seats when `humanCount`
 * humans are already in the roster. Returns 0 when humans fill the
 * session (D10).
 */
export function pickBotCount(humanCount: number, size: 2 | 4 | 6): number {
  if (humanCount <= 0) return size;
  if (humanCount >= size) return 0;
  return size - humanCount;
}

/** Average rating across the supplied humans, ignoring undefined values. */
export function averageRating(humans: ReadonlyArray<HumanPlayer>): number {
  const rated = humans.filter((h) => typeof h.rating === 'number');
  if (rated.length === 0) return 1000; // defensive default
  let sum = 0;
  for (const h of rated) sum += h.rating as number;
  return sum / rated.length;
}

/**
 * Build the full roster (humans + bots) and return the host /
 * succession list. Bots reuse the host's `classId` so every car shares
 * the same min-time band; `bodyId` is the synthetic `bot-<n>-body`.
 */
export function buildBotRoster(input: BuildBotRosterInput): BuiltBotRoster {
  const { size, humans, hostLoadout, difficultyCap, botIdSalt } = input;
  if (humans.length < 1) {
    throw new Error('buildBotRoster: at least one human is required');
  }
  if (humans.length > size) {
    throw new Error(
      `buildBotRoster: human count ${humans.length} exceeds size ${size}`,
    );
  }

  const avg = averageRating(humans);
  const botDifficulty = pickBotDifficulty(avg, difficultyCap ?? 4);
  const botCount = pickBotCount(humans.length, size);
  const salt = botIdSalt ?? 'qb';

  // Convert humans → roster entries first. Bots append after so the host
  // (lowest-rtt human) ends up at the top of the roster list — this
  // matches the visual order the Unity lobby screen expects.
  const humanEntries: RosterEntry[] = humans.map((h) => ({
    userId: h.userId,
    loadout: hostLoadout,
    isBot: false,
  }));
  const botEntries: RosterEntry[] = [];
  for (let i = 0; i < botCount; i += 1) {
    const botUserId = `bot_${salt}_d${botDifficulty}_${i}`;
    const botRtt = 50 + botDifficulty * 10 + i * 5;
    botEntries.push({
      userId: botUserId,
      loadout: {
        classId: hostLoadout.classId,
        bodyId: `bot-body-${botDifficulty}`,
        ...(hostLoadout.liveryId !== undefined ? { liveryId: hostLoadout.liveryId } : {}),
      },
      isBot: true,
    });
    // hostChoice uses rtt; bots don't influence host selection but we
    // could later thread rttMs through the roster shape. For now
    // hostChoice picks from `humans` only.
    void botRtt;
  }

  const roster = [...humanEntries, ...botEntries];
  const hostEntry = humans.map((h) => ({ userId: h.userId, ...(h.rttMs !== undefined ? { rttMs: h.rttMs } : {}) }));
  const host = pickHost(hostEntry);
  const hostSuccession = pickHostSuccession(hostEntry);

  return {
    roster,
    host,
    hostSuccession,
    botCount,
    botDifficulty,
  };
}

/** Convenience: only the host's classId is needed for shared min-time band. */
export function hostClassId(loadout: Loadout): CarClassId {
  return loadout.classId;
}