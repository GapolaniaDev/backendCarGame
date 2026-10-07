// Phase 7 Chunk 2 — Invite storage helpers.
//
// Storage layout:
//   invites/{targetUserId}/{inviteId} — owner=targetUserId, key=inviteId
//   Read=1/Write=1 server-owned.
//
// The TARGET owns the row so the JS layer can write/delete without
// permission checks. The SENDER is captured in `fromUserId`.
//
// `invite_list` (target's view) returns pending + lazy-expired only;
// accepted/declined rows are hidden.
//
// `invite_respond` is a CAS-update; both parties (sender + target)
// can read the row, but only the target can CAS-write (since they're
// the row owner).

import type { IStorageKey, IStorageObject, INakama } from '../nkruntime';
import {
  asInviteWrite,
  type InviteRecord,
  INVITES_COLLECTION,
} from './types';

export const MAX_CAS_RETRIES = 3;

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read a single invite row. Owner MUST be the target user (since the
 * row is keyed under them). Returns `null` when absent or malformed.
 */
export function readInvite(
  nk: INakama,
  targetUserId: string,
  inviteId: string,
): { record: InviteRecord; version: string } | null {
  const objs = nk.storageRead([
    { collection: INVITES_COLLECTION, key: inviteId, userId: targetUserId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const value = obj.value as Partial<InviteRecord>;
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== 1 ||
    typeof value.inviteId !== 'string' ||
    typeof value.fromUserId !== 'string' ||
    typeof value.targetUserId !== 'string' ||
    typeof value.createdAt !== 'number' ||
    typeof value.expiresAt !== 'number' ||
    typeof value.status !== 'string'
  ) {
    return null;
  }
  return { record: value as InviteRecord, version: obj.version ?? '' };
}

/**
 * List every invite row owned by `targetUserId`. Caller-side filtering
 * (status, expiresAt) happens in the RPC layer (`invite_list`).
 */
export function listInvitesFor(
  nk: INakama,
  targetUserId: string,
): InviteRecord[] {
  const res = nk.storageList({
    collection: INVITES_COLLECTION,
    userId: targetUserId,
    limit: 200,
  });
  const out: InviteRecord[] = [];
  for (const obj of res.objects) {
    const v = obj.value as Partial<InviteRecord>;
    if (
      v &&
      typeof v === 'object' &&
      v.schemaVersion === 1 &&
      typeof v.inviteId === 'string' &&
      typeof v.fromUserId === 'string' &&
      typeof v.targetUserId === 'string' &&
      typeof v.createdAt === 'number' &&
      typeof v.expiresAt === 'number' &&
      typeof v.status === 'string'
    ) {
      out.push(v as InviteRecord);
    }
  }
  return out;
}

// ─── Write ─────────────────────────────────────────────────────────────────────

export function writeInviteCreate(
  nk: INakama,
  record: InviteRecord,
): string {
  const obj: IStorageObject = asInviteWrite(record);
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * CAS-update an invite (status transition: pending → accepted/declined).
 */
export function writeInviteUpdate(
  nk: INakama,
  record: InviteRecord,
  version: string,
): string {
  const obj: IStorageObject = { ...asInviteWrite(record), version };
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * True when the invite has aged past its TTL AND is still pending.
 * Pure; doesn't mutate the record.
 */
export function isExpired(record: InviteRecord, now: number): boolean {
  return record.status === 'pending' && now >= record.expiresAt;
}

/**
 * Returns `true` when the record has reached a terminal status.
 * Pure.
 */
export function isTerminal(record: InviteRecord): boolean {
  return record.status === 'accepted' || record.status === 'declined';
}

/**
 * Stub for the Chunk 5 socket push. The Nakama 3.27 JS runtime does
 * NOT expose `socket.send` (verified against `nkruntime.d.ts`). Real
 * push delivery will land with the chat/presence module in Chunk 5
 * (which will use `nk.sessionSend` once exposed, or stash the payload
 * in a presence-stream pickup for the matching player on `authenticate`).
 *
 * Returns `false` so callers mark `delivered:'offline'`. When Chunk 5
 * lands, replace this stub with the real presence-stream push and
 * flip `delivered:'online'` when the target is connected.
 */
export function tryOnlinePush(
  nk: INakama,
  _targetUserId: string,
  _inviteId: string,
): boolean {
  // Defensive no-op stub. Never throws.
  void nk;
  return false;
}