// Storage layout for profiles. One profile per userId, stored at
// `profiles/{userId}` with owner = the userId (clients can read their
// own; the runtime reads them from any user for lb_get enrichment).
//
// All writes MUST omit `version` for the first create; subsequent
// updates must include the version they were based on (CAS via
// `nk.multiUpdate`).

import type { IStorageObject, INakama } from '../nkruntime';

export const PROFILES_COLLECTION = 'profiles';

export interface ProfileRecord {
  schemaVersion: 1;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: number;
  updatedAt: number;
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
 */
export function defaultProfile(userId: string, nowMs: number, defaultDisplayName: string): ProfileRecord {
  return {
    schemaVersion: 1,
    userId,
    displayName: defaultDisplayName,
    avatarUrl: null,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}