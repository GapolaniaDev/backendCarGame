// Plan T-21 — clubs with a roster and a way in (audit PC-13, 07 f1-f2, Soc-2).
//
//   - club_join: the joiner shows in club_members_list and in the group;
//     rules (level 8, block with leader/admin, one club, room left);
//   - the native JoinGroup (and every other client group write) is refused;
//   - club_create charges in the transaction that writes the club;
//   - the `officer` alias, the leader transfer moving the group superadmin;
//   - a stable club_members_list cursor;
//   - account deletion hands a led club to a successor (or dissolves it)
//     and takes the player out of their party.

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import { CLUBS_MEMBERS_COLLECTION } from '../../modules/src/clubs/members_repo';
import { CLUBS_METADATA_COLLECTION, type ClubMetadata } from '../../modules/src/clubs/types';
import { PROFILES_COLLECTION, type ProfileRecord } from '../../modules/src/profiles/storage';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: { reason?: string } & Record<string, unknown> } };

interface MemberView { userId: string; username: string; role: string; joinedAt: number }

const LEADER = 'user-leader';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const CARL = 'user-carl';

function call<T>(env: LoadedBundle, rpc: string, caller: string, payload: unknown): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  return JSON.parse(handler({ ...FakeContext, userId: caller }, env.logger, env.nak, JSON.stringify(payload))) as T;
}

function seedProfile(env: LoadedBundle, userId: string, level: number): void {
  const profile: ProfileRecord = {
    schemaVersion: 1, userId, displayName: userId, avatarUrl: null,
    createdAt: 1, updatedAt: 1, progression: { xp: 0, level, lastDailyWinAt: 0 },
  };
  env.fakeNakama.store.set(`${PROFILES_COLLECTION}/${userId}/${userId}`, {
    collection: PROFILES_COLLECTION, key: userId, userId,
    value: profile as unknown as Record<string, unknown>, version: 'v1',
    permissionRead: 0, permissionWrite: 0,
    createTime: new Date(0).toISOString(), updateTime: new Date(0).toISOString(), expiresAt: null,
  });
}

function createClub(env: LoadedBundle, leader: string, name = 'Night Riders'): string {
  seedProfile(env, leader, 8);
  env.fakeNakama.wallets.set(leader, { coins: 10_000, gems: 0 });
  const res = call<Resp<{ clubId: string }>>(env, 'club_create', leader, {
    name, motto: 'Ride on', emblemId: 'emblem_default', region: 'us',
  });
  if (!res.ok) throw new Error(`club_create failed: ${JSON.stringify(res)}`);
  return res.data.clubId;
}

function join(env: LoadedBundle, userId: string, clubId: string, level = 8): Resp<{ role: string }> {
  seedProfile(env, userId, level);
  return call<Resp<{ role: string }>>(env, 'club_join', userId, { clubId });
}

function roster(env: LoadedBundle, caller: string, clubId: string, limit = 50, cursor?: string): Resp<{ members: MemberView[]; nextCursor: string }> {
  return call(env, 'club_members_list', caller, { clubId, limit, ...(cursor !== undefined ? { cursor } : {}) });
}

function hasRow(env: LoadedBundle, userId: string): boolean {
  return env.fakeNakama.store.has(`${CLUBS_MEMBERS_COLLECTION}/current/${userId}`);
}

function meta(env: LoadedBundle, clubId: string): ClubMetadata | undefined {
  return env.fakeNakama.store.get(`${CLUBS_METADATA_COLLECTION}/${clubId}/${SYSTEM_USER_ID}`)?.value as ClubMetadata | undefined;
}

describe('club_join and the club roster (plan T-21)', () => {
  let env: LoadedBundle;
  let clubId: string;

  beforeEach(() => {
    env = loadBundleForTest();
    clubId = createClub(env, LEADER);
  });

  it('club_create writes the leader row and a closed group in one go', () => {
    expect(hasRow(env, LEADER)).toBe(true);
    expect(meta(env, clubId)?.leaderId).toBe(LEADER);
    expect(env.fakeNakama.groups.get(clubId)?.open).toBe(false);
    expect(env.fakeNakama.groupStates.get(clubId)?.get(LEADER)).toBe(0);
    expect(env.fakeNakama.wallets.get(LEADER)?.coins).toBe(5_000);
  });

  it('a player joins by RPC and shows in club_members_list', () => {
    const res = join(env, ALICE, clubId);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.role).toBe('member');
    const list = roster(env, ALICE, clubId);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.members.map((m) => [m.userId, m.role])).toEqual([[LEADER, 'leader'], [ALICE, 'member']]);
    expect(list.data.members[1]!.username).toBe(`name-${ALICE}`);
    expect(env.fakeNakama.groupMembers.get(clubId)?.has(ALICE)).toBe(true);
    const got = call<Resp<{ club: { memberCount: number } }>>(env, 'club_get', ALICE, { clubId });
    if (got.ok) expect(got.data.club.memberCount).toBe(2);
  });

  it('level below 8 → FORBIDDEN MIN_LEVEL, nothing written', () => {
    const res = join(env, ALICE, clubId, 5);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('FORBIDDEN');
      expect(res.error.details?.reason).toBe('MIN_LEVEL');
    }
    expect(hasRow(env, ALICE)).toBe(false);
    expect(env.fakeNakama.groupMembers.get(clubId)?.has(ALICE)).toBe(false);
  });

  it('a block with the leader or an admin → FORBIDDEN BLOCKED', () => {
    expect(call<Resp<unknown>>(env, 'block_add', LEADER, { targetUserId: ALICE }).ok).toBe(true);
    const a = join(env, ALICE, clubId);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.details?.reason).toBe('BLOCKED');

    expect(join(env, BOB, clubId).ok).toBe(true);
    expect(call<Resp<unknown>>(env, 'club_promote', LEADER, { clubId, targetUserId: BOB, to: 'admin' }).ok).toBe(true);
    expect(call<Resp<unknown>>(env, 'block_add', CARL, { targetUserId: BOB }).ok).toBe(true);
    const c = join(env, CARL, clubId);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.details?.reason).toBe('BLOCKED');
  });

  it('one club per player: ALREADY_MEMBER / ALREADY_IN_CLUB', () => {
    expect(join(env, ALICE, clubId).ok).toBe(true);
    const again = join(env, ALICE, clubId);
    if (!again.ok) expect(again.error.details?.reason).toBe('ALREADY_MEMBER');
    const other = createClub(env, BOB, 'Day Riders');
    const second = join(env, ALICE, other);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.details?.reason).toBe('ALREADY_IN_CLUB');
    // ... and a member cannot found a club either.
    env.fakeNakama.wallets.set(ALICE, { coins: 10_000, gems: 0 });
    const found = call<Resp<unknown>>(env, 'club_create', ALICE, { name: 'Alice Club', motto: 'Mine', emblemId: 'emblem_default', region: 'us' });
    expect(found.ok).toBe(false);
    expect(env.fakeNakama.wallets.get(ALICE)?.coins).toBe(10_000);
  });

  it('a full club → CONFLICT CLUB_FULL and no row', () => {
    env.fakeNakama.groups.get(clubId)!.maxCount = 2;
    expect(join(env, ALICE, clubId).ok).toBe(true);
    const res = join(env, BOB, clubId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.details?.reason).toBe('CLUB_FULL');
    expect(hasRow(env, BOB)).toBe(false);
  });

  it('leave, then join again', () => {
    expect(join(env, ALICE, clubId).ok).toBe(true);
    expect(call<Resp<unknown>>(env, 'club_leave', ALICE, { clubId }).ok).toBe(true);
    expect(hasRow(env, ALICE)).toBe(false);
    expect(env.fakeNakama.groupMembers.get(clubId)?.has(ALICE)).toBe(false);
    expect(join(env, ALICE, clubId).ok).toBe(true);
  });

  it('the native JoinGroup does not skip the rules (and never joins)', () => {
    const hook = env.fakeInitializer.groupHooks.get('JoinGroup');
    expect(hook).toBeDefined();
    seedProfile(env, ALICE, 5);
    let thrown: { code?: number; message?: string } | null = null;
    try { hook!({ ...FakeContext, userId: ALICE }, env.logger, env.nak, { groupId: clubId }); } catch (e) { thrown = e as typeof thrown; }
    expect(thrown?.code).toBe(7);
    expect(thrown?.message).toContain('min_level');

    seedProfile(env, ALICE, 8);
    thrown = null;
    try { hook!({ ...FakeContext, userId: ALICE }, env.logger, env.nak, { groupId: clubId }); } catch (e) { thrown = e as typeof thrown; }
    expect(thrown?.code).toBe(7);
    expect(thrown?.message).toContain('club_join');
    expect(hasRow(env, ALICE)).toBe(false);
  });

  it('every other client group write is refused', () => {
    for (const api of ['CreateGroup', 'UpdateGroup', 'DeleteGroup', 'LeaveGroup', 'AddGroupUsers', 'BanGroupUsers', 'KickGroupUsers', 'PromoteGroupUsers', 'DemoteGroupUsers']) {
      const hook = env.fakeInitializer.groupHooks.get(api);
      expect(hook, api).toBeDefined();
      expect(() => hook!({ ...FakeContext, userId: LEADER }, env.logger, env.nak, { groupId: clubId }), api).toThrow();
    }
  });

  it('club_create without funds leaves no group, metadata or row', () => {
    seedProfile(env, ALICE, 8);
    env.fakeNakama.wallets.set(ALICE, { coins: 100, gems: 0 });
    const res = call<Resp<unknown>>(env, 'club_create', ALICE, { name: 'Poor Club', motto: 'Broke', emblemId: 'emblem_default', region: 'us' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(env.fakeNakama.groups.size).toBe(1);
    expect(hasRow(env, ALICE)).toBe(false);
    expect(env.fakeNakama.store.has(`clubs_created/${ALICE}/${ALICE}`)).toBe(false);
  });

  it('the client role `officer` is accepted as admin', () => {
    expect(join(env, ALICE, clubId).ok).toBe(true);
    const up = call<Resp<{ role: string }>>(env, 'club_promote', LEADER, { clubId, targetUserId: ALICE, to: 'officer' });
    expect(up.ok).toBe(true);
    if (up.ok) expect(up.data.role).toBe('admin');
    const down = call<Resp<{ role: string }>>(env, 'club_demote', LEADER, { clubId, targetUserId: ALICE, to: 'member' });
    expect(down.ok).toBe(true);
  });

  it('a leader transfer moves the group superadmin; the former leader can then be kicked', () => {
    expect(join(env, ALICE, clubId).ok).toBe(true);
    expect(call<Resp<unknown>>(env, 'club_promote', LEADER, { clubId, targetUserId: ALICE, to: 'leader' }).ok).toBe(true);
    expect(meta(env, clubId)?.leaderId).toBe(ALICE);
    expect(env.fakeNakama.groupStates.get(clubId)?.get(ALICE)).toBe(0);
    expect(env.fakeNakama.groupStates.get(clubId)?.get(LEADER)).toBe(1);
    expect(call<Resp<unknown>>(env, 'club_kick', ALICE, { clubId, targetUserId: LEADER }).ok).toBe(true);
    expect(env.fakeNakama.groupMembers.get(clubId)?.has(LEADER)).toBe(false);
  });

  it('the roster cursor visits every member once, in order', () => {
    for (const u of [ALICE, BOB, CARL, 'user-dan']) expect(join(env, u, clubId).ok).toBe(true);
    expect(call<Resp<unknown>>(env, 'club_promote', LEADER, { clubId, targetUserId: CARL, to: 'admin' }).ok).toBe(true);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = roster(env, LEADER, clubId, 2, cursor);
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      seen.push(...page.data.members.map((m) => m.userId));
      if (page.data.nextCursor === '') break;
      cursor = page.data.nextCursor;
    }
    expect(seen).toEqual([LEADER, CARL, ALICE, BOB, 'user-dan']);
  });

  it('deleting the leader hands the club to the oldest admin', () => {
    expect(join(env, ALICE, clubId).ok).toBe(true);
    expect(join(env, BOB, clubId).ok).toBe(true);
    expect(call<Resp<unknown>>(env, 'club_promote', LEADER, { clubId, targetUserId: BOB, to: 'admin' }).ok).toBe(true);
    expect(call<Resp<unknown>>(env, 'account_delete', LEADER, { confirmText: 'DELETE' }).ok).toBe(true);
    expect(meta(env, clubId)?.leaderId).toBe(BOB);
    expect(env.fakeNakama.groups.has(clubId)).toBe(true);
    const list = roster(env, ALICE, clubId);
    if (list.ok) expect(list.data.members.map((m) => [m.userId, m.role])).toEqual([[BOB, 'leader'], [ALICE, 'member']]);
  });

  it('deleting the only member dissolves the club', () => {
    expect(call<Resp<unknown>>(env, 'account_delete', LEADER, { confirmText: 'DELETE' }).ok).toBe(true);
    expect(meta(env, clubId)).toBeUndefined();
    expect(env.fakeNakama.groups.has(clubId)).toBe(false);
    expect(call<Resp<unknown>>(env, 'club_get', ALICE, { clubId }).ok).toBe(false);
  });

  it('deleting an account takes it out of its party (a leader hands it over)', () => {
    const created = call<Resp<{ partyId: string }>>(env, 'party_create', ALICE, {});
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const partyId = created.data.partyId;
    expect(call<Resp<unknown>>(env, 'party_join', BOB, { partyId }).ok).toBe(true);
    expect(call<Resp<unknown>>(env, 'account_delete', ALICE, { confirmText: 'DELETE' }).ok).toBe(true);
    const got = call<Resp<{ party: { leaderUserId: string; members: Array<{ userId: string }> } }>>(env, 'party_get', BOB, { partyId });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data.party.leaderUserId).toBe(BOB);
    expect(got.data.party.members.map((m) => m.userId)).toEqual([BOB]);
  });
});
