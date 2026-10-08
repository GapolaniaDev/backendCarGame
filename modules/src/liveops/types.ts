// Phase 5 Chunk 1 — Liveops config types.
//
// The runtime shape consumed by the boot path (`bootEnsure`) and
// every maintenance/version gate. The shape is intentionally
// conservative: every field that an admin can override at runtime
// (flags, minClientVersion, regions, calendar) is here, and the
// validator in `config.ts` rejects anything that doesn't conform.

export type ClientPlatform = 'ios' | 'android' | 'windows' | 'macos' | 'linux';
export type CalendarEntryType = 'event' | 'tournament' | 'maintenance';
export type NodeRole = 'home' | 'relay';

/**
 * Provider of receipt verification. `mock` is for development/CI and
 * returns a deterministic canned result. Phase 9 Chunk 2 (D61).
 */
export type IapVerificationProvider = 'mock' | 'apple' | 'google';
export type IapEnvironment = 'sandbox' | 'production';

export interface IapVerificationConfig {
  provider: IapVerificationProvider;
  /** Required when provider='apple'. */
  appleSharedSecret?: string;
  /** Required when provider='google'. base64 of the service account JSON. */
  googleServiceAccount?: string;
  /** Android package name (e.g. com.cvg.game). Required when provider='google'. */
  packageName?: string;
  environment: IapEnvironment;
  /** Per-request timeout. Default 10000ms (D61). */
  timeoutMs: number;
}

export interface LiveopsRegion {
  id: string;
  displayName: string;
  relayUrl: string;
}

export interface LiveopsCalendarEntry {
  id: string;
  type: CalendarEntryType;
  /** ISO-8601 UTC string (e.g. "2026-10-31T12:00:00Z"). */
  startUtc: string;
  endUtc: string;
}

export interface LiveopsConfig {
  schemaVersion: 1;
  version: number;
  flags: {
    maintenance: boolean;
    maintenanceMessage?: string;
    maintenanceExemptUserIds?: string[];
  };
  minClientVersion: Record<ClientPlatform, string>;
  regions: ReadonlyArray<LiveopsRegion>;
  calendar: ReadonlyArray<LiveopsCalendarEntry>;
  /**
   * Shared secret that admin RPCs (`admin_*`) compare against the
   * request body's `adminKey`. When unset, every admin RPC fails
   * closed with `SERVICE_UNAVAILABLE`.
   *
   * The secret must also match Nakama's HTTP `http_key` query param
   * (the gateway validates it server-side; the JS layer can't see it,
   * so the admin tool sends the same value via the body field).
   *
   * D7 (Phase 5 Chunk 6).
   */
  adminRpcKey?: string;
  /**
   * Optional webhook URL. When set, `emit()` POSTs a small JSON
   * payload (name, ts, id, props) for every analytics event AFTER the
   * storage write succeeds. Best-effort — failures are logged at
   * warn level and never propagate. D8 (Phase 5 Chunk 7).
   */
  analyticsWebhook?: string;
  /**
   * Node role. `home` (default) exposes the full game surface;
   * `relay` only exposes the match + race RPCs needed for the
   * latency-sensitive race loop. Phase 5 Chunk 8.
   *
   * Stored here (not `process.env.NODE_ROLE`) because the JS
   * runtime strips `process.env` (esbuild `--platform=neutral`).
   * Bootstrap via `liveops_config_override` per replica.
   */
  nodeRole?: NodeRole;
  /**
   * HMAC secret for `relay_token` RPC signing/verification. The
   * relay replica verifies tokens offline with this secret — no
   * round-trip to home. Phase 5 Chunk 8.
   */
  relayTokenSecret?: string;
  /**
   * Receipt verification config for IAPs (Phase 9 Chunk 2). When set
   * the `verifyReceipt` dispatcher routes to the configured provider;
   * when unset the dispatcher rejects every receipt with
   * `VERIFICATION_FAILED`. D61.
   */
  iapVerification?: IapVerificationConfig;
}
