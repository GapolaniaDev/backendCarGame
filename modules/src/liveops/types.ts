// Phase 4 liveops types. Live-ops flag catalog shape (consumed by
// `config_get` when the runtime wants to surface feature flags to
// the client). The catalog itself lands in a later chunk; this file
// ships the shape so Chunk 2+ can reference it.

export type LiveOpsFlagId =
  | 'ranked_enabled'
  | 'quick_bots_enabled'
  | 'season_banner_visible'
  | 'club_create_enabled';

export interface LiveOpsFlag {
  id: LiveOpsFlagId;
  enabled: boolean;
  /** When the flag enables (UTC epoch-ms). 0 = always-on. */
  startsAt: number;
  /** When the flag disables (UTC epoch-ms). 0 = always-on. */
  endsAt: number;
  /** Optional free-form payload sent to clients. */
  payload?: Record<string, unknown>;
}

export interface LiveOpsCatalog {
  version: number;
  flags: ReadonlyArray<LiveOpsFlag>;
}