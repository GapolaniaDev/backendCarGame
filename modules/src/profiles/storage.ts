// Storage layout for profiles. One profile per userId, stored at
// `profiles/{userId}` with owner = the userId (clients can read their
// own; the runtime reads them from any user for lb_get enrichment).
//
// All writes MUST omit `version` for the first create; subsequent
// updates must include the version they were based on (CAS via
// `nk.multiUpdate`).
//
// The `progression` sub-record was added in Phase 3 (Chunk 3) for the
// wallet/level/XP subsystem. It is optional on the wire so v1 records
// (written before Phase 3) round-trip cleanly through `readProfile`
// with empty progression defaults.

import type { IStorageObject, INakama } from '../nkruntime';

export const PROFILES_COLLECTION = 'profiles';

/**
 * Per-player XP / level state. Lives inside `ProfileRecord` so the
 * profile doc is still the single source of truth the client knows how
 * to fetch.
 */
export interface ProfileProgression {
  /** Cumulative XP earned across all races. */
  xp: number;
  /** Highest level reached (1..50). Capped at MAX_LEVEL. */
  level: number;
  /**
   * UTC epoch-ms when the player last took a first-win-of-day stamp.
   * `0` means "never". Used by the RaceCompleted subscriber.
   */
  lastDailyWinAt: number;
}

export interface ProfileRecord {
  schemaVersion: 1;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Phase 3 progression state. Optional in storage payloads so v1
   * records (written before the wallet/level subsystem shipped)
   * round-trip cleanly. Default = zero XP at level 1, never won today.
   */
  progression?: ProfileProgression;
  /**
   * Phase 3: how many private races the player has been paid out for
   * in the current UTC day. Capped per the rewards catalog.
   */
  dailyPrivateCount?: number;
  /**
   * Phase 3: UTC epoch-ms when `dailyPrivateCount` was last reset
   * (typically once per UTC day by the RaceCompleted subscriber).
   */
  dailyResetAt?: number;
}

export function readProfile(
  nk: INakama,
  userId: string,
): ProfileRecord | null {
  const result = nk.storageRead([
    { collection: PROFILES_COLLECTION, key: userId, userId },
  ]);
  const obj = result[0];
  if (!obj) return null;
  return obj.value as unknown as ProfileRecord;
}

export function writeProfileCreate(
  nk: INakama,
  profile: ProfileRecord,
): void {
  const obj: IStorageObject = {
    collection: PROFILES_COLLECTION,
    key: profile.userId,
    userId: profile.userId,
    value: profile as unknown as Record<string, unknown>,
    permissionRead: 0,
    permissionWrite: 0,
  };
  nk.storageWrite([obj]);
}

export function writeProfileUpdate(
  nk: INakama,
  profile: ProfileRecord,
  expectedVersion: string,
): void {
  const obj: IStorageObject = {
    collection: PROFILES_COLLECTION,
    key: profile.userId,
    userId: profile.userId,
    value: profile as unknown as Record<string, unknown>,
    permissionRead: 0,
    permissionWrite: 0,
    version: expectedVersion,
  };
  nk.storageWrite([obj]);
}

/**
 * Build a default profile for a freshly-authenticated user. The
 * displayName uses the catalog's defaultDisplayName so the player
 * is never anonymous on the wire; the avatarUrl is null and the
 * client is expected to call profile_update after the user picks one.
 *
 * Phase 3 also seeds `progression` to the zero state (level 1, 0 XP,
 * never won today) so `profile_get.progression` is non-null on the
 * first read.
 */
export function defaultProfile(userId: string, nowMs: number, defaultDisplayName: string): ProfileRecord {
  return {
    schemaVersion: 1,
    userId,
    displayName: defaultDisplayName,
    avatarUrl: null,
    createdAt: nowMs,
    updatedAt: nowMs,
    progression: { xp: 0, level: 1, lastDailyWinAt: 0 },
  };
}

/**
 * Returns the profile's progression sub-record, normalising legacy v1
 * records (no progression field) to the zero state. Caller can mutate
 * the returned object without affecting the catalog.
 */
export function getProgression(profile: ProfileRecord): ProfileProgression {
  if (profile.progression === undefined) {
    return { xp: 0, level: 1, lastDailyWinAt: 0 };
  }
  return {
    xp: profile.progression.xp,
    level: profile.progression.level,
    lastDailyWinAt: profile.progression.lastDailyWinAt,
  };
}