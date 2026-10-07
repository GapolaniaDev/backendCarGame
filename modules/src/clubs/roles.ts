// Phase 7 Chunk 4 — Pure role / permission logic.
//
// All functions in this module are pure — they take the actor's and
// target's `MemberRecord`s (or just role strings when the record is
// absent) and return a decision. They do NOT touch storage or Nakama.
//
// The 5 actions + 1 read of the public roster are:
//   canUpdateClub   — `club_update`
//   canKickMember   — `club_kick`
//   canPromoteTo    — `club_promote`
//   canDemoteTo     — `club_demote`
//   canLeave        — `club_leave`
//   applyTransfer   — promotes target to leader + demotes old leader to
//                     admin in one batch (used by `club_promote` when
//                     `to === 'leader'`)

import type { Role } from './types';

// ─── canUpdateClub ──────────────────────────────────────────────────────────

export interface ClubUpdateFields {
  motto?: string;
  emblemId?: string;
  minDivision?: string;
}

/**
 * Per-field update permission:
 *   - leader: all three fields
 *   - admin : motto + emblemId ONLY (NOT minDivision — leader-only)
 *   - member: nothing
 */
export function canUpdateClub(
  actorRole: Role | null,
  fields: ClubUpdateFields,
): { allowed: boolean; deniedField: keyof ClubUpdateFields | null } {
  if (actorRole === 'leader') {
    return { allowed: Object.keys(fields).length > 0, deniedField: null };
  }
  if (actorRole === 'admin') {
    if (fields.minDivision !== undefined) {
      return { allowed: false, deniedField: 'minDivision' };
    }
    return { allowed: Object.keys(fields).length > 0, deniedField: null };
  }
  return { allowed: false, deniedField: Object.keys(fields)[0] as keyof ClubUpdateFields | null };
}

// ─── canKickMember ──────────────────────────────────────────────────────────

export type KickReason =
  | 'allowed'
  | 'not_member'         // actor is not in the club
  | 'target_not_member'  // target is not in the club
  | 'self_kick'          // use leave instead
  | 'cannot_kick_leader' // must transfer first
  | 'cannot_kick_admin'  // only leader can demote/kick admins
  | 'admin_cannot_kick_admin';

export function canKickMember(
  actor: { role: Role } | null,
  target: { role: Role } | null,
): { allowed: boolean; reason: KickReason } {
  if (actor === null) return { allowed: false, reason: 'not_member' };
  if (target === null) return { allowed: false, reason: 'target_not_member' };
  if (actor.role === 'leader') {
    if (target.role === 'leader') return { allowed: false, reason: 'cannot_kick_leader' };
    return { allowed: true, reason: 'allowed' };
  }
  if (actor.role === 'admin') {
    if (target.role === 'leader') return { allowed: false, reason: 'cannot_kick_leader' };
    if (target.role === 'admin') return { allowed: false, reason: 'admin_cannot_kick_admin' };
    return { allowed: true, reason: 'allowed' };
  }
  return { allowed: false, reason: 'not_member' };
}

// ─── canPromoteTo ───────────────────────────────────────────────────────────

export type PromoteReason =
  | 'allowed'
  | 'not_leader'
  | 'target_not_member'
  | 'already_role'
  | 'invalid_target_role';

export function canPromoteTo(
  actor: { role: Role } | null,
  target: { role: Role } | null,
  to: Role,
): { allowed: boolean; reason: PromoteReason } {
  if (actor === null || actor.role !== 'leader') {
    return { allowed: false, reason: 'not_leader' };
  }
  if (target === null) return { allowed: false, reason: 'target_not_member' };
  if (to !== 'admin' && to !== 'leader') {
    return { allowed: false, reason: 'invalid_target_role' };
  }
  if (target.role === to) return { allowed: false, reason: 'already_role' };
  return { allowed: true, reason: 'allowed' };
}

// ─── canDemoteTo ────────────────────────────────────────────────────────────

export type DemoteReason =
  | 'allowed'
  | 'not_leader'
  | 'target_not_member'
  | 'cannot_demote_leader'      // must transfer first
  | 'cannot_demote_to_leader'   // promote instead
  | 'already_role'
  | 'invalid_target_role';

export function canDemoteTo(
  actor: { role: Role } | null,
  target: { role: Role } | null,
  to: Role,
): { allowed: boolean; reason: DemoteReason } {
  if (actor === null || actor.role !== 'leader') {
    return { allowed: false, reason: 'not_leader' };
  }
  if (target === null) return { allowed: false, reason: 'target_not_member' };
  if (to === 'leader') return { allowed: false, reason: 'cannot_demote_to_leader' };
  if (to !== 'admin' && to !== 'member') {
    return { allowed: false, reason: 'invalid_target_role' };
  }
  if (target.role === 'leader') {
    return { allowed: false, reason: 'cannot_demote_leader' };
  }
  if (target.role === to) return { allowed: false, reason: 'already_role' };
  return { allowed: true, reason: 'allowed' };
}

// ─── canLeave ───────────────────────────────────────────────────────────────

export type LeaveReason = 'allowed' | 'not_member' | 'leader_cannot_leave';

export function canLeave(
  actor: { role: Role } | null,
): { allowed: boolean; reason: LeaveReason } {
  if (actor === null) return { allowed: false, reason: 'not_member' };
  if (actor.role === 'leader') return { allowed: false, reason: 'leader_cannot_leave' };
  return { allowed: true, reason: 'allowed' };
}

// ─── applyTransfer (atomic leader swap) ─────────────────────────────────────

export interface TransferStep {
  userId: string;
  from: Role;
  to: Role;
}

/**
 * Atomic leader swap. The caller (always the current leader) hands
 * over their own role to the target user. Both steps MUST be written
 * in one `multiUpdate` so we never have a window with zero leaders or
 * two leaders.
 *
 * `targetFrom` is the target's current role, supplied by the caller
 * (we already have it from the read-side permission check). Returns
 * an empty array when the swap is a no-op (e.g. transferring to
 * yourself).
 */
export function applyTransfer(
  currentLeaderId: string,
  targetUserId: string,
  targetFrom: Role,
): TransferStep[] {
  if (currentLeaderId === targetUserId) return [];
  const steps: TransferStep[] = [
    { userId: currentLeaderId, from: 'leader', to: 'admin' },
  ];
  if (targetFrom !== 'leader') {
    steps.push({ userId: targetUserId, from: targetFrom, to: 'leader' });
  }
  return steps;
}