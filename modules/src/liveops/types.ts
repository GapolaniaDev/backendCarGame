// Phase 5 Chunk 1 — Liveops config types.
//
// The runtime shape consumed by the boot path (`bootEnsure`) and
// every maintenance/version gate. The shape is intentionally
// conservative: every field that an admin can override at runtime
// (flags, minClientVersion, regions, calendar) is here, and the
// validator in `config.ts` rejects anything that doesn't conform.

export type ClientPlatform = 'ios' | 'android' | 'windows' | 'macos' | 'linux';
export type CalendarEntryType = 'event' | 'tournament' | 'maintenance';

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
}
