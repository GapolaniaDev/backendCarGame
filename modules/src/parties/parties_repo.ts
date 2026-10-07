// Phase 7 Chunk 8 — Party storage helpers + CAS-retry wrappers.

import type { IStorageObject, INakama } from '../nkruntime';
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