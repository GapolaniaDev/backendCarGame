// Registry of dedicated race servers (plan fishnet-nakama-server, T-04;
// decisions D-01 and D-02).
//
// A dedicated race server (a headless Unity/FishNet process) registers
// itself with `rs_heartbeat` every few seconds. The registry row says where
// it listens, when it was last seen and which session (if any) it has been
// assigned. Nakama assigns sessions to live, free servers (T-05).

/** Storage collection: one system-owned object per server, key = serverId. */
export const RACE_SERVERS_COLLECTION = 'race_servers';

/** A server is alive while its last heartbeat is at most this old. */
export const RACE_SERVER_ALIVE_MS = 10_000;

/** The ticker frees the session of a server without heartbeat for this long. */
export const RACE_SERVER_STALE_MS = 30_000;

export const RACE_SERVER_ID_MAX_LENGTH = 64;
export const RACE_SERVER_CAPACITY_MAX = 16;
export const RACE_SERVER_PORT_MAX = 65_535;

/** Persisted registry row (the storage version token travels beside it). */
export interface RaceServerRecord {
  schemaVersion: 1;
  /** Address clients connect to. */
  host: string;
  /** Port clients connect to, 1-65535. */
  port: number;
  /** Rooms the process declares (stored; today each process declares 1). */
  capacity: number;
  /** Epoch ms (server clock) of the last heartbeat. */
  lastSeenMs: number;
  /** Session assigned to this server, or null when free. */
  sessionId: string | null;
  /** Epoch ms when `sessionId` was assigned (0 when never). */
  assignedAtMs: number;
  buildVersion: string;
  [key: string]: unknown;
}
