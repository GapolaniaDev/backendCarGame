// Phase 4 matchmaking ticket_params builder. Pure functions that
// turn a player request into the query string + properties that
// `nk.matchmakerAdd` consumes.
//
// Phase 4 plan decisions enforced here:
//   - D1: ticket_params input shape — caller sends mode, size, input,
//     platform; server stamps version/region.
//   - D8: `mm.segmentBy` defaults to 'none'; the liveops override is
//     applied by `liveops/mm_config.ts` (Chunk 8) before this
//     function returns, so the segment field is one of the values
//     the client can influence only via liveops, not via ticket
//     payload.
//   - D9: rating window — `ratingWindowFor(config, 0)` gives the
//     tightest band (±100) for the first 30s after lastRatedAt, so
//     the query always lands in the player's current band unless the
//     caller explicitly widens.
//
// The matchmaker query is a JSON-serialisable object keyed by
// attribute name. The runtime applies the equality semantics at the
// ticket-add layer; we just produce the keys.

import type { RaceModeId } from '../race/types';
import { ratingWindowFor, type RankedConfig } from '../ranked/config';
import {
  DEDICATED_MAX_COUNT,
  DEDICATED_MIN_COUNT,
  type MmHosting,
  type MmTicketParamsInput,
  type MmTicketParamsOutput,
} from './types';

export type TicketSegment = 'none' | 'rating';

export interface TicketOptions {
  /** Client-stamped app version (e.g. "1.4.2"). Required. */
  version: string;
  /** Server-stamped region (e.g. "eu-west-1"). Required. */
  region: string;
  /**
   * Player's current rating (ranked modes only). When undefined the
   * matchmaker applies the initial rating from `RankedConfig.initialRating`.
   */
  rating?: number;
  /**
   * UTC epoch-ms when the player last finished a rated race. Used
   * to pick the rating window. Defaults to 0 (new player).
   */
  lastRatedAt?: number;
  /**
   * Override for `mm.segmentBy`. Defaults to 'none'. The liveops
   * subsystem (Chunk 8) overrides this when its flag is on.
   */
  segmentBy?: TicketSegment;
  /**
   * Phase 7 Chunk 8: when the caller is a party leader, the resolved
   * party size (always >= 1, <= 6). Stamp this into the ticket's
   * metadata so the matched-hook can correlate the party.
   */
  partySize?: number;
  /**
   * Phase 7 Chunk 8: party id, stamped into metadata. The matchmaker
   * keeps entries with the same `partyId` together; the matched-hook
   * verifies every member of each party is present.
   */
  partyId?: string;
}

export interface BuiltTicket {
  /** Properties that go into `nk.matchmakerAdd(... query ...)`. */
  query: Record<string, unknown>;
  /** Properties that go into `nk.matchmakerAdd(... metadata ...)`. */
  metadata: Record<string, string>;
  /** Server-stamped fields returned to the client for echo. */
  stamped: { mode: string; size: 2 | 4 | 6; version: string; region: string };
}

const VALID_SIZES: ReadonlySet<2 | 4 | 6> = new Set([2, 4, 6]);
/** `size` stamped on dedicated-server tickets (D-03). */
const DEDICATED_QUEUE_SIZE = 4;
const VALID_MODES: ReadonlySet<RaceModeId> = new Set([
  'quick',
  'ranked',
  'private',
  'time_trial',
]);

/**
 * Validate the caller's payload. Returns the canonical `{ mode, size }`
 * pair on success, or a list of validation errors otherwise. Pure
 * function — no Nakama calls.
 */
export function validateTicketInput(
  input: MmTicketParamsInput,
): { ok: true; mode: RaceModeId; size: 2 | 4 | 6; hosting?: MmHosting } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const mode = input.mode;
  if (!VALID_MODES.has(mode)) {
    errors.push(`invalid mode: ${String(mode)}`);
  }
  let size: 2 | 4 | 6 = 4;
  if (input.size !== undefined) {
    if (!VALID_SIZES.has(input.size)) {
      errors.push(`invalid size: ${String(input.size)} (must be 2, 4, or 6)`);
    } else {
      size = input.size;
    }
  } else if (mode !== 'time_trial') {
    // Default to 4 for non-time-trial; time_trial ignores size.
    size = 4;
  }
  if (input.platform !== undefined && input.platform !== 'mobile' && input.platform !== 'console' && input.platform !== 'pc') {
    errors.push(`invalid platform: ${String(input.platform)}`);
  }
  if (input.input !== undefined && typeof input.input !== 'object') {
    errors.push(`input must be an object`);
  }
  // D-03: a dedicated-server ticket is `quick` only and always queues with
  // size 4 (the group is 2..4, so `size` no longer decides the roster).
  if (input.hosting !== undefined) {
    if (input.hosting !== 'dedicated') {
      errors.push(`invalid hosting: ${String(input.hosting)} (only "dedicated" is supported)`);
    } else if (mode !== 'quick') {
      errors.push(`hosting "dedicated" is only available for mode quick (got ${String(mode)})`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  if (input.hosting === 'dedicated') return { ok: true, mode, size: DEDICATED_QUEUE_SIZE, hosting: 'dedicated' };
  return { ok: true, mode, size };
}

/**
 * Build the matchmaker ticket properties + metadata from the
 * validated input + server-stamped options. Pure function.
 *
 * Query keys are kept short so the encoded JSON stays below Nakama's
 * 1KB ticket limit even with 4 metadata entries.
 */
export function buildTicket(
  validated: { mode: RaceModeId; size: 2 | 4 | 6; hosting?: MmHosting },
  options: TicketOptions,
  config: RankedConfig,
): BuiltTicket {
  const query: Record<string, unknown> = {
    mode: validated.mode,
    size: validated.size,
    version: options.version,
    region: options.region,
    segmentBy: options.segmentBy ?? 'none',
  };

  // Ranked mode carries the rating band — let the matchmaker pick
  // anyone within the same band. For non-ranked modes we use a
  // sentinel so the matchmaker doesn't accidentally match ranked
  // tickets (the band is different).
  if (validated.mode === 'ranked') {
    const elapsedSec = options.lastRatedAt !== undefined
      ? Math.max(0, Math.floor((Date.now() - options.lastRatedAt) / 1000))
      : 0;
    const window = ratingWindowFor(config, elapsedSec);
    const rating = options.rating ?? config.initialRating;
    query['ratingBand'] = `${Math.max(0, rating - window)}-${rating + window}`;
  } else {
    query['ratingBand'] = 'unrated';
  }

  const metadata: Record<string, string> = {
    mode: validated.mode,
    size: String(validated.size),
    version: options.version,
    region: options.region,
    segmentBy: query['segmentBy'] as string,
  };
  // Phase 7 Chunk 8: stamp party metadata so the matched-hook can
  // verify the full party lands in one session.
  if (options.partyId !== undefined) {
    metadata['partyId'] = options.partyId;
  }
  if (options.partySize !== undefined) {
    metadata['partySize'] = String(options.partySize);
  }
  // D-03: only the dedicated-server tickets carry `hosting`, so they queue
  // among themselves and never with relayed-match tickets.
  if (validated.hosting !== undefined) {
    query['hosting'] = validated.hosting;
    metadata['hosting'] = validated.hosting;
  }

  return {
    query,
    metadata,
    stamped: { mode: validated.mode, size: validated.size, version: options.version, region: options.region },
  };
}

/**
 * Final shape the RPC returns to the client. Re-exported here so
 * the unit tests don't need to reach into the RPC module.
 */
export function buildOutput(
  validated: { mode: RaceModeId; size: 2 | 4 | 6; hosting?: MmHosting },
  ticket: BuiltTicket,
  options: TicketOptions,
): MmTicketParamsOutput {
  const output: MmTicketParamsOutput = {
    mode: validated.mode,
    size: validated.size,
    version: ticket.stamped.version,
    region: ticket.stamped.region,
    mm: { segmentBy: options.segmentBy ?? 'none' },
    constraints: {
      // Chunk 2 ships the empty list; Chunk 5 fills this from
      // `tracks/recent_tracks.json` per-player.
      excludeTrackIds: [],
    },
  };
  if (validated.hosting !== undefined) {
    output.hosting = validated.hosting;
    output.minCount = DEDICATED_MIN_COUNT;
    output.maxCount = DEDICATED_MAX_COUNT;
  }
  return output;
}

// (No additional module-level helpers — the imported `ratingWindowFor`
// from `../ranked/config` is the canonical implementation.)