// Phase 7 Chunk 8 — Party storage helpers + CAS-retry wrappers.

import type { ILogger, IStorageObject, INakama } from '../nkruntime';
import {
  ACTIVE_PARTY_COLLECTION,
  PARTIES_COLLECTION,
  asActivePartyWrite,
  asPartyWrite,
  type ActivePartyRecord,
  type PartyRecord,
} from './types';

export const MAX_CAS_RETRIES = 3;

// ─── Parties ────────────────────────────────────────────────────────────────

export interface PartyReadResult {
  record: PartyRecord;
  version: string;
}

export function readParty(nk: INakama, partyId: string): PartyReadResult | null {
  const objs = nk.storageRead([
    { collection: PARTIES_COLLECTION, key: partyId, userId: '00000000-0000-0000-0000-000000000000' },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<PartyRecord>;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.partyId !== 'string' || typeof v.leaderUserId !== 'string' ||
    typeof v.maxSize !== 'number' || typeof v.state !== 'string' ||
    typeof v.createdAt !== 'number' || !Array.isArray(v.members)
  ) {
    return null;
  }
  return { record: v as PartyRecord, version: obj.version ?? '' };
}

export function writePartyCreate(nk: INakama, rec: PartyRecord): string {
  const obj: IStorageObject = asPartyWrite(rec);
  const acks = nk.storageWrite([obj]);
  return (acks as Array<{ version?: string }>)[0]?.version ?? '';
}

export function writePartyUpdate(nk: INakama, rec: PartyRecord, version: string): string {
  const obj: IStorageObject = { ...asPartyWrite(rec), version };
  const acks = nk.storageWrite([obj]);
  return (acks as Array<{ version?: string }>)[0]?.version ?? '';
}

export function deleteParty(nk: INakama, partyId: string): void {
  nk.storageDelete([{ collection: PARTIES_COLLECTION, key: partyId, userId: '00000000-0000-0000-0000-000000000000' }]);
}

// ─── Active party (inverse index) ───────────────────────────────────────────

export interface ActivePartyReadResult {
  record: ActivePartyRecord;
  version: string;
}

export function readActiveParty(nk: INakama, userId: string): ActivePartyReadResult | null {
  const objs = nk.storageRead([
    { collection: ACTIVE_PARTY_COLLECTION, key: userId, userId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<ActivePartyRecord>;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.userId !== 'string' || typeof v.partyId !== 'string' ||
    typeof v.joinedAt !== 'number'
  ) {
    return null;
  }
  return { record: v as ActivePartyRecord, version: obj.version ?? '' };
}

export function writeActivePartyCreate(nk: INakama, rec: ActivePartyRecord): string {
  const obj: IStorageObject = asActivePartyWrite(rec);
  const acks = nk.storageWrite([obj]);
  return (acks as Array<{ version?: string }>)[0]?.version ?? '';
}

export function writeActivePartyUpdate(nk: INakama, rec: ActivePartyRecord, version: string): string {
  const obj: IStorageObject = { ...asActivePartyWrite(rec), version };
  const acks = nk.storageWrite([obj]);
  return (acks as Array<{ version?: string }>)[0]?.version ?? '';
}

export function deleteActiveParty(nk: INakama, userId: string): void {
  nk.storageDelete([{ collection: ACTIVE_PARTY_COLLECTION, key: userId, userId }]);
}

// ─── Join / leave CAS helpers ───────────────────────────────────────────────

/**
 * Phase 7 Chunk 9 — Add `userId` to the party roster + write the
 * active_party inverse index. CAS-retryable (up to MAX_CAS_RETRIES).
 *
 * Returns the updated `PartyRecord` on success, or `null` when the
 * party is missing. The caller is responsible for the "is the user
 * already in another party?" and "is the user self-invited?" gates —
 * this helper only checks party-local invariants (state=open, room
 * available, not-already-member).
 */
export function joinParty(
  nk: INakama,
  logger: ILogger,
  userId: string,
  partyId: string,
): PartyReadResult | null {
  const initial = readParty(nk, partyId);
  if (initial === null) return null;
  let party = initial.record;
  let version = initial.version;

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    // Party-local gates — re-checked every iteration to defeat stale CAS.
    if (party.state !== 'open') {
      throw new Error('party is closed');
    }
    if (party.members.length >= party.maxSize) {
      throw new Error('party is full');
    }
    if (party.members.some((m) => m.userId === userId)) {
      throw new Error('already a member');
    }

    const nowMs = Date.now();
    const nextParty: PartyRecord = {
      ...party,
      members: [...party.members, { userId, joinedAt: nowMs }],
    };

    try {
      writePartyUpdate(nk, nextParty, version);

      // Active-party index (owner=userId so the same user can read it
      // back via the inverse-index pattern).
      const activeRec: ActivePartyRecord = {
        schemaVersion: 1,
        userId,
        partyId,
        joinedAt: nowMs,
      };
      writeActivePartyCreate(nk, activeRec);

      return { record: nextParty, version };
    } catch (e) {
      logger.warn(
        'joinParty CAS retry attempt=%d user=%s party=%s err=%s',
        attempt,
        userId,
        partyId,
        e instanceof Error ? e.message : String(e),
      );
      const reread = readParty(nk, partyId);
      if (reread === null) return null;
      party = reread.record;
      version = reread.version;
    }
  }
  throw new Error('CAS retries exhausted');
}