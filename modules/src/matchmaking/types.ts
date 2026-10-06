// Phase 4 matchmaking types. Public input/output shapes for the
// future `mm_ticket_params` RPC (Chunk 2) and the matchmaker hook
// (Chunk 2). The types are shipped in Chunk 1 so subsequent chunks
// don't have to repeat them — and so the catalog validators can be
// checked against the right field names early.

import type { RaceModeId } from '../race/types';

export type MmPlatform = 'mobile' | 'console' | 'pc';

export interface MmTicketParamsInput {
  /** Mode to queue for. */
  mode: RaceModeId;
  /** Roster size — required for quick/ranked/private, ignored for time_trial. */
  size?: 2 | 4 | 6;
  /** Free-form server-required params (latency tier, partyId, etc.). */
  input?: Record<string, string>;
  /** Client platform tag — used by the region picker (D8). */
  platform?: MmPlatform;
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
  /** Resolved matchmaker segment ('none' by default; D8). */
  mm: { segmentBy: 'none' | 'rating' };
  /** Optional constraints the matchmaker should honour. */
  constraints?: {
    /** Track-picker exclusion list (D2: last 2 tracks). */
    excludeTrackIds?: string[];
  };
}