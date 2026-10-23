// Club membership lifecycle (plan T-21; audit 07 f1-f2, PC-13, Soc-2).
//
//   - `evaluateClubJoin`: the join rules — club exists, not in a club
//     already, room left, level 8, minimum division and no block with the
//     leader or an admin. `club_join` and the native JoinGroup
//     before-hook (`groups/before_join.ts`) apply the same rules.
//   - `joinClub`: membership row (version '*': one club per player) then
//     `groupUsersAdd` as the system user, which enforces `maxCount`
//     atomically; a full group rolls the row back.
//   - `removeClubMember`: row first (the truth), then the group edge
//     (best effort: a leftover edge is not a member).
//   - `releaseClubOnAccountDelete`: before an account is deleted, its
//     club survives: the oldest admin (else the oldest member) becomes
//     leader, or a club left empty is dissolved. Without it the group
//     was deleted with its only superadmin and every member row stayed.

import type { ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { checkGroupJoinBlock } from '../groups/before_join';
import {
  checkClubJoinGate,
  clubMetadataWrite,
  deleteClubMetadata,
  readClubGroup,
  readClubMetadata,
} from './clubs_repo';
import {
  deleteMember,
  memberWrite,
  multiUpdateMembers,
  readClubMembers,
  readMembership,
  writeMemberCreate,
  type MemberReadResult,
} from './members_repo';
import { deleteClubWeekMeta } from './week_repo';
import type { ClubMetadata, MemberRecord, Role } from './types';

export type ClubJoinRefusal =
  | 'not_found'
  | 'already_member'
  | 'already_in_club'
  | 'club_full'
  | 'blocked'
  | 'min_level'
  | 'min_division';

export type ClubJoinVerdict =
  | { allowed: true; meta: ClubMetadata }
  | { allowed: false; reason: ClubJoinRefusal };

export interface ClubJoinOutput {
  clubId: string;
  userId: string;
  role: Role;
  joinedAt: number;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Leader and admins: a block with any of them keeps the joiner out. */
function gatekeeperIds(members: readonly MemberReadResult[], meta: ClubMetadata): string[] {
  const ids = new Set<string>([meta.leaderId]);
  for (const m of members) {
    if (m.record.role === 'leader' || m.record.role === 'admin') ids.add(m.record.userId);
  }
  return [...ids];
}

/** The join rules, without writing anything. */
export function evaluateClubJoin(
  nk: INakama,
  logger: ILogger | undefined,
  joinerId: string,
  clubId: string,
): ClubJoinVerdict {
  const meta = readClubMetadata(nk, clubId);
  const group = meta !== null ? readClubGroup(nk, clubId) : null;
  if (meta === null || group === null) return { allowed: false, reason: 'not_found' };

  const current = readMembership(nk, joinerId);
  if (current !== null) {
    return { allowed: false, reason: current.record.clubId === clubId ? 'already_member' : 'already_in_club' };
  }
  if (group.edgeCount >= group.maxCount) return { allowed: false, reason: 'club_full' };

  const gate = checkClubJoinGate(nk, logger, joinerId, meta.record);
  if (!gate.allowed) return { allowed: false, reason: (gate.reason ?? 'blocked') as ClubJoinRefusal };

  const blocks = checkGroupJoinBlock(nk, logger, joinerId, gatekeeperIds(readClubMembers(nk, clubId), meta.record));
  if (!blocks.allowed) return { allowed: false, reason: 'blocked' };

  return { allowed: true, meta: meta.record };
}

/** Envelope error of a refused join. */
export function joinRefusalError(reason: ClubJoinRefusal): Resp<never> {
  switch (reason) {
    case 'not_found': return err('NOT_FOUND', 'no club with that id');
    case 'already_member': return err('CONFLICT', 'already a member of this club', { reason: 'ALREADY_MEMBER' });
    case 'already_in_club': return err('CONFLICT', 'already in another club; leave it first', { reason: 'ALREADY_IN_CLUB' });
    case 'club_full': return err('CONFLICT', 'the club is full', { reason: 'CLUB_FULL' });
    case 'blocked': return err('FORBIDDEN', 'cannot join this club', { reason: 'BLOCKED' });
    case 'min_level': return err('FORBIDDEN', 'level 8 required to join a club', { reason: 'MIN_LEVEL' });
    case 'min_division': return err('FORBIDDEN', 'division below the club minimum', { reason: 'MIN_DIVISION' });
  }
}

/** Apply the rules and add the player to the club. */
export function joinClub(
  nk: INakama,
  logger: ILogger,
  joinerId: string,
  clubId: string,
  nowMs: number,
): Resp<ClubJoinOutput> {
  const verdict = evaluateClubJoin(nk, logger, joinerId, clubId);
  if (!verdict.allowed) return joinRefusalError(verdict.reason);

  const rec: MemberRecord = {
    schemaVersion: 1,
    clubId,
    userId: joinerId,
    role: 'member',
    joinedAt: nowMs,
    weeklyContribution: 0,
  };
  let version: string;
  try {
    version = writeMemberCreate(nk, rec);
  } catch {
    // Lost the create-only write: a concurrent join of this player won.
    const now = readMembership(nk, joinerId);
    return joinRefusalError(now !== null && now.record.clubId === clubId ? 'already_member' : 'already_in_club');
  }

  try {
    nk.groupUsersAdd(clubId, [joinerId]);
  } catch (e) {
    // The group is full (or gone): the row must not outlive the refusal.
    try { deleteMember(nk, joinerId, version); } catch { /* the next read finds no group edge */ }
    logger.info('club_join refused by the group [club=%s user=%s]: %s', clubId, joinerId, message(e));
    return readClubGroup(nk, clubId) === null ? joinRefusalError('not_found') : joinRefusalError('club_full');
  }

  return ok({ clubId, userId: joinerId, role: rec.role, joinedAt: rec.joinedAt });
}

/** Remove a member: their row, then their group edge (best effort). */
export function removeClubMember(
  nk: INakama,
  logger: ILogger,
  member: MemberReadResult,
): void {
  deleteMember(nk, member.record.userId, member.version);
  try {
    nk.groupUsersKick(member.record.clubId, [member.record.userId]);
  } catch (e) {
    logger.warn(
      'club member removed but the group edge stayed [club=%s user=%s]: %s',
      member.record.clubId, member.record.userId, message(e),
    );
  }
}

/** Move the group superadmin role along with the leadership (best effort). */
export function syncGroupLeader(
  nk: INakama,
  logger: ILogger,
  clubId: string,
  newLeaderId: string,
  oldLeaderId: string | null,
): void {
  try {
    // One state step per call: member → admin → superadmin (a no-op once there).
    nk.groupUsersPromote(clubId, [newLeaderId]);
    nk.groupUsersPromote(clubId, [newLeaderId]);
    if (oldLeaderId !== null) nk.groupUsersDemote(clubId, [oldLeaderId]);
  } catch (e) {
    logger.warn('club leader change not mirrored in the group [club=%s]: %s', clubId, message(e));
  }
}

/** Oldest admin, else oldest member (ties by user id). */
export function pickSuccessor(members: readonly MemberReadResult[]): MemberReadResult | null {
  const rank = (r: Role): number => (r === 'admin' ? 0 : r === 'member' ? 1 : 2);
  const sorted = [...members].sort((a, b) =>
    rank(a.record.role) - rank(b.record.role)
    || a.record.joinedAt - b.record.joinedAt
    || (a.record.userId < b.record.userId ? -1 : a.record.userId > b.record.userId ? 1 : 0));
  return sorted[0] ?? null;
}

export interface ClubReleaseSummary {
  clubId: string | null;
  action: 'none' | 'left' | 'transferred' | 'dissolved';
  newLeaderId?: string;
}

/** Account deletion: leave the club so it keeps a leader (or dissolve it). */
export function releaseClubOnAccountDelete(
  nk: INakama,
  logger: ILogger,
  userId: string,
): ClubReleaseSummary {
  const mine = readMembership(nk, userId);
  if (mine === null) return { clubId: null, action: 'none' };
  const clubId = mine.record.clubId;
  if (mine.record.role !== 'leader') {
    removeClubMember(nk, logger, mine);
    return { clubId, action: 'left' };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const others = readClubMembers(nk, clubId).filter((m) => m.record.userId !== userId);
    const meta = readClubMetadata(nk, clubId);
    const successor = pickSuccessor(others);
    if (successor === null || meta === null) {
      try { deleteClubMetadata(nk, clubId); } catch { /* already gone */ }
      try { deleteClubWeekMeta(nk, clubId); } catch { /* never seeded */ }
      try { nk.groupDelete(clubId); } catch (e) { logger.warn('club dissolve: groupDelete(%s) failed: %s', clubId, message(e)); }
      deleteMember(nk, userId);
      return { clubId, action: 'dissolved' };
    }
    try {
      multiUpdateMembers(nk, [
        memberWrite({ ...successor.record, role: 'leader' }, successor.version),
        clubMetadataWrite({ ...meta.record, leaderId: successor.record.userId }, meta.version),
      ]);
    } catch (e) {
      logger.warn('club leader succession retry [club=%s attempt=%d]: %s', clubId, attempt, message(e));
      continue;
    }
    syncGroupLeader(nk, logger, clubId, successor.record.userId, null);
    removeClubMember(nk, logger, mine);
    return { clubId, action: 'transferred', newLeaderId: successor.record.userId };
  }
  logger.error('club leader succession failed [club=%s user=%s]: the row is purged with the account', clubId, userId);
  return { clubId, action: 'none' };
}
