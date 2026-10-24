// Phase 4 matchmaking types. Public input/output shapes for the
// future `mm_ticket_params` RPC (Chunk 2) and the matchmaker hook
// (Chunk 2). The types are shipped in Chunk 1 so subsequent chunks
// don't have to repeat them — and so the catalog validators can be
// checked against the right field names early.

import type { RaceModeId } from '../race/types';

export type MmPlatform = 'mobile' | 'console' | 'pc';

/**
 * Who hosts the race (plan fishnet-nakama-server, D-03). Only `dedicated`
 * exists as a value: a ticket without `hosting` is a relayed-match ticket.
 */
export type MmHosting = 'dedicated';

/** Dedicated tickets queue for a group of 2..4 players (D-03). */
export const DEDICATED_MIN_COUNT = 2;
export const DEDICATED_MAX_COUNT = 4;

export interface MmTicketParamsInput {
  /** Mode to queue for. */
  mode: RaceModeId;
  /** Roster size — required for quick/ranked/private, ignored for time_trial. */
  size?: 2 | 4 | 6;
  /** Free-form server-required params (latency tier, partyId, etc.). */
  input?: Record<string, string>;
  /** Client platform tag — used by the region picker (D8). */
  platform?: MmPlatform;
  /**
   * `"dedicated"` queues for a race on a dedicated server (D-03): `quick`
   * mode only, group of 2..4, `size` is stamped as 4 whatever is sent.
   */
  hosting?: MmHosting;
  /**
   * Server-only field used to authorize the RPC on the HTTP gateway path.
   * The socket path reads `ctx.userId` instead; here it lets the
   * auth middleware confirm the caller's identity. Defaults to ''.
   */
  callerUserId?: string;
  /**
   * Phase 7 Chunk 8: when set, the caller queues as a party leader.
   * Server stamps `partySize` and a `partyId` tag into the matchmaker
   * ticket so the matched-hook can keep the party together. Only the
   * leader may set this; the value must equal their current party.
   */
  partyId?: string;
}

export interface MmTicketParamsOutput {
  /** Echoed back for client validation. */
  mode: RaceModeId;
  /** Echoed back. */
  size: 2 | 4 | 6;
  /** Server-stamped. */
  version: string;
  /** Server-stamped region. */
  region: string;
  /** Echoed when the ticket asked for a dedicated server (D-03). */
  hosting?: MmHosting;
  /** Smallest group the matchmaker may form; present with `hosting` (D-03). */
  minCount?: number;
  /** Largest group the matchmaker may form; present with `hosting` (D-03). */
  maxCount?: number;
  /** Resolved matchmaker segment ('none' by default; D8). */
  mm: { segmentBy: 'none' | 'rating' };
  /** Optional constraints the matchmaker should honour. */
  constraints?: {
    /** Track-picker exclusion list (D2: last 2 tracks). */
    excludeTrackIds?: string[];
  };
}