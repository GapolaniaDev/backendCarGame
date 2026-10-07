// Phase 7 Chunk 4 — Club membership + roles + updates e2e.
//
// Covers all 6 new RPCs end-to-end:
//   - club_update (leader/admin permission branches)
//   - club_members_list (default ordering + cursor pagination)
//   - club_kick (admin can kick member; cannot kick admin/leader; self-kick → CONFLICT)
//   - club_promote (member → admin; member → leader transfer; admin → leader transfer)
//   - club_demote (admin → member; leader demote → CONFLICT)
//   - club_leave (leader → FORBIDDEN; member → OK)

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import { CLUBS_MEMBERS_COLLECTION } from '../../modules/src/clubs/members_repo';
import type { MemberRecord } from '../../modules/src/clubs/types';
import { PROFILES_COLLECTION } from '../../modules/src/profiles/storage';
import type { ProfileRecord } from '../../modules/src/profiles/storage';
import { LIVEOPS_STORAGE_KEY } from '../../modules/src/liveops/config';
import type { LiveopsConfig } from '../../modules/src/liveops/types';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface ClubCreateOutput { clubId: string; name: string; costPaid: number; newBalance: number; }
interface ClubUpdateOutput { clubId: string; updatedAt: number; }
interface ClubMembersListOutput {
  members: Array<{
    userId: string;
    username: string;
    avatarUrl: string | null;
    role: 'leader' | 'admin' | 'member';
    level: number | null;
    weeklyContribution: number;
    joinedAt: number;
  }>;
  nextCursor: string;
}
interface ClubKickOutput { removed: boolean; clubId: string; targetUserId: string; }
interface ClubPromoteOutput { clubId: string; userId: string; role: 'leader' | 'admin' | 'member'; }
interface ClubDemoteOutput { clubId: string; userId: string; role: 'leader' | 'admin' | 'member'; }
interface ClubLeaveOutput { left: boolean; clubId: string; userId: string; }

const LEADER = 'user-leader';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';
const OUTSIDER = 'user-outsider';

function call<T>(env: LoadedBundle, rpc: string, caller: string | null, payload: unknown): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as T;
}

function setCoins(env: LoadedBundle, userId: string, coins: number): void {
  env.fakeNakama.wallets.set(userId, { coins, gems: 0 });
}

function seedProfile(env: LoadedBundle, userId: string, level: number): void {
  const profile: ProfileRecord = {
    schemaVersion: 1,
    userId,
    displayName: userId,
    avatarUrl: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    progression: { xp: 0, level, lastDailyWinAt: 0 },
  };
  env.fakeNakama.store.set(`${PROFILES_COLLECTION}/${userId}/${userId}`, {
    collection: PROFILES_COLLECTION,
    key: userId,
    userId,
    value: profile as unknown as Record<string, unknown>,
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

function seedMember(env: LoadedBundle, clubId: string, userId: string, role: 'leader' | 'admin' | 'member'): void {
  const rec: MemberRecord = {
    schemaVersion: 1,
    clubId,
    userId,
    role,
    joinedAt: 1_700_000_000_000 + Math.floor(Math.random() * 10000),
    weeklyContribution: 0,
  };
  env.fakeNakama.store.set(`${CLUBS_MEMBERS_COLLECTION}/${clubId}/${userId}`, {
    collection: CLUBS_MEMBERS_COLLECTION,
    key: clubId,
    userId,
    value: rec as unknown as Record<string, unknown>,
    version: 'v00000001',
    permissionRead: 1,
    permissionWrite: 1,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

function setMaintenance(env: LoadedBundle): void {
  const cfg: LiveopsConfig = {
    schemaVersion: 1, version: 1,
    flags: { maintenance: true },
    minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
    regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
    calendar: [],
  };
  const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
  env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
    collection: 'liveops', key: 'config', userId: SYSTEM_USER_ID,
    value: cfg as unknown as LiveopsConfig,
    version: stored?.version ?? 'v00000001',
    permissionRead: 1, permissionWrite: 0,
    createTime: stored?.createTime ?? new Date(0).toISOString(),
    updateTime: new Date().toISOString(),
    expiresAt: null,
  });
}

function callCreate(env: LoadedBundle, userId: string): Resp<ClubCreateOutput> {
  return call<Resp<ClubCreateOutput>>(env, 'club_create', userId, {
    callerUserId: userId,
    name: 'Speed Demons',
    motto: 'Drive fast',
    emblemId: 'emblem_default',
    region: 'us',
  });
}

function callUpdate(env: LoadedBundle, userId: string, payload: Record<string, unknown>): Resp<ClubUpdateOutput> {
  return call<Resp<ClubUpdateOutput>>(env, 'club_update', userId, {
    callerUserId: userId,
    ...payload,
  });
}

function callMembersList(env: LoadedBundle, userId: string, payload: Record<string, unknown> = {}): Resp<ClubMembersListOutput> {
  return call<Resp<ClubMembersListOutput>>(env, 'club_members_list', userId, {
    callerUserId: userId,
    ...payload,
  });
}

function callKick(env: LoadedBundle, userId: string, payload: Record<string, unknown>): Resp<ClubKickOutput> {
  return call<Resp<ClubKickOutput>>(env, 'club_kick', userId, {
    callerUserId: userId,
    ...payload,
  });
}

function callPromote(env: LoadedBundle, userId: string, payload: Record<string, unknown>): Resp<ClubPromoteOutput> {
  return call<Resp<ClubPromoteOutput>>(env, 'club_promote', userId, {
    callerUserId: userId,
    ...payload,
  });
}

function callDemote(env: LoadedBundle, userId: string, payload: Record<string, unknown>): Resp<ClubDemoteOutput> {
  return call<Resp<ClubDemoteOutput>>(env, 'club_demote', userId, {
    callerUserId: userId,
    ...payload,
  });
}

function callLeave(env: LoadedBundle, userId: string, payload: Record<string, unknown>): Resp<ClubLeaveOutput> {
  return call<Resp<ClubLeaveOutput>>(env, 'club_leave', userId, {
    callerUserId: userId,
    ...payload,
  });
}

describe('club membership e2e (Phase 7 Chunk 4)', () => {
  let env: LoadedBundle;
  let clubId: string;

  beforeEach(() => {
    env = loadBundleForTest();
    // Seed leader + admin + member profiles.
    seedProfile(env, LEADER, 8);
    seedProfile(env, ADMIN, 8);
    seedProfile(env, MEMBER, 5);
    setCoins(env, LEADER, 10_000);
    const created = callCreate(env, LEADER);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('seed: club_create failed');
    clubId = created.data.clubId;
    seedMember(env, clubId, LEADER, 'leader');
    seedMember(env, clubId, ADMIN, 'admin');
    seedMember(env, clubId, MEMBER, 'member');
  });

  describe('club_update', () => {
    it('leader can update motto + emblem + minDivision', () => {
      const res = callUpdate(env, LEADER, { clubId, motto: 'New Motto', emblemId: 'emblem_neon', minDivision: 'oro' });
      expect(res.ok).toBe(true);
    });

    it('member cannot update anything → FORBIDDEN', () => {
      const res = callUpdate(env, MEMBER, { clubId, motto: 'Update here' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    });

    it('admin can update motto + emblem but NOT minDivision → FORBIDDEN', () => {
      const ok = callUpdate(env, ADMIN, { clubId, motto: 'Updated' });
      expect(ok.ok).toBe(true);
      const denied = callUpdate(env, ADMIN, { clubId, minDivision: 'oro' });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('FORBIDDEN');
    });

    it('member cannot update anything → FORBIDDEN', () => {
      const res = callUpdate(env, MEMBER, { clubId, motto: 'Update here' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    });

    it('outsider → FORBIDDEN', () => {
      const res = callUpdate(env, OUTSIDER, { clubId, motto: 'Hello World' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    });

    it('unknown emblem → BAD_REQUEST', () => {
      const res = callUpdate(env, LEADER, { clubId, emblemId: 'emblem_nope' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
    });

    it('NOT_FOUND on unknown clubId', () => {
      const res = callUpdate(env, LEADER, { clubId: 'no-such', motto: 'Hello World' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('NOT_FOUND');
    });

    it('SERVICE_UNAVAILABLE when maintenance=true', () => {
      setMaintenance(env);
      const res = callUpdate(env, LEADER, { clubId, motto: 'Hello World' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('empty fields → BAD_REQUEST', () => {
      const res = callUpdate(env, LEADER, { clubId });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('club_members_list', () => {
    it('returns all 3 members with leader first', () => {
      const res = callMembersList(env, OUTSIDER, { clubId });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.members).toHaveLength(3);
      expect(res.data.members[0].userId).toBe(LEADER);
      expect(res.data.members[0].role).toBe('leader');
    });

    it('paginated via cursor', () => {
      const page1 = callMembersList(env, OUTSIDER, { clubId, limit: 2 });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.data.members).toHaveLength(2);
      expect(page1.data.nextCursor).not.toBe('');

      const page2 = callMembersList(env, OUTSIDER, { clubId, limit: 2, cursor: page1.data.nextCursor });
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;
      expect(page2.data.members.length).toBeGreaterThan(0);
    });

    it('NOT_FOUND on missing clubId', () => {
      const res = callMembersList(env, OUTSIDER, { clubId: 'no-such' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('NOT_FOUND');
    });
  });

  describe('club_kick', () => {
    it('admin can kick a member', () => {
      const res = callKick(env, ADMIN, { clubId, targetUserId: MEMBER });
      expect(res.ok).toBe(true);
    });

    it('admin cannot kick another admin → FORBIDDEN', () => {
      // Seed a second admin.
      seedMember(env, clubId, 'user-admin-2', 'admin');
      const res = callKick(env, ADMIN, { clubId, targetUserId: 'user-admin-2' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    });

    it('leader can kick the admin', () => {
      const res = callKick(env, LEADER, { clubId, targetUserId: ADMIN });
      expect(res.ok).toBe(true);
    });

    it('leader cannot kick the leader → CONFLICT', () => {
      const res = callKick(env, LEADER, { clubId, targetUserId: LEADER });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('CONFLICT');
    });

    it('self-kick by admin → FORBIDDEN (admin cannot kick admin)', () => {
      const res = callKick(env, ADMIN, { clubId, targetUserId: ADMIN });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    });

    it('leader self-kick → CONFLICT (must transfer first)', () => {
      const res = callKick(env, LEADER, { clubId, targetUserId: LEADER });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('CONFLICT');
    });

    it('member cannot kick anyone → FORBIDDEN', () => {
      const res = callKick(env, MEMBER, { clubId, targetUserId: ADMIN });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    });

    it('kick non-member → NOT_FOUND', () => {
      const res = callKick(env, LEADER, { clubId, targetUserId: OUTSIDER });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('NOT_FOUND');
    });
  });

  describe('club_promote', () => {
    it('leader promotes member → admin', () => {
      const res = callPromote(env, LEADER, { clubId, targetUserId: MEMBER, to: 'admin' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.role).toBe('admin');
    });

    it('non-leader promote → FORBIDDEN', () => {
      const res = callPromote(env, ADMIN, { clubId, targetUserId: MEMBER, to: 'admin' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    });

    it('already in role → BAD_REQUEST', () => {
      const res = callPromote(env, LEADER, { clubId, targetUserId: ADMIN, to: 'admin' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
    });

    it('member → leader: atomic transfer (leader becomes admin, member becomes leader)', () => {
      const res = callPromote(env, LEADER, { clubId, targetUserId: MEMBER, to: 'leader' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.role).toBe('leader');
      // Verify the swap persisted.
      const list = callMembersList(env, OUTSIDER, { clubId });
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const oldLeader = list.data.members.find((m) => m.userId === LEADER);
      const newLeader = list.data.members.find((m) => m.userId === MEMBER);
      expect(oldLeader!.role).toBe('admin');
      expect(newLeader!.role).toBe('leader');
    });

    it('admin → leader: transfer', () => {
      const res = callPromote(env, LEADER, { clubId, targetUserId: ADMIN, to: 'leader' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.role).toBe('leader');
    });

    it('to=member is rejected as invalid', () => {
      const res = callPromote(env, LEADER, { clubId, targetUserId: MEMBER, to: 'member' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('club_demote', () => {
    it('leader demotes admin → member', () => {
      const res = callDemote(env, LEADER, { clubId, targetUserId: ADMIN, to: 'member' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.role).toBe('member');
    });

    it('non-leader demote → FORBIDDEN', () => {
      const res = callDemote(env, ADMIN, { clubId, targetUserId: MEMBER, to: 'member' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    });

    it('cannot demote leader → CONFLICT', () => {
      const res = callDemote(env, LEADER, { clubId, targetUserId: LEADER, to: 'admin' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('CONFLICT');
    });

    it('to=leader is rejected (use promote)', () => {
      const res = callDemote(env, LEADER, { clubId, targetUserId: ADMIN, to: 'leader' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
    });

    it('already in role → BAD_REQUEST', () => {
      const res = callDemote(env, LEADER, { clubId, targetUserId: MEMBER, to: 'member' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('club_leave', () => {
    it('member leaves successfully', () => {
      const res = callLeave(env, MEMBER, { clubId });
      expect(res.ok).toBe(true);
    });

    it('admin leaves successfully', () => {
      const res = callLeave(env, ADMIN, { clubId });
      expect(res.ok).toBe(true);
    });

    it('leader cannot leave → FORBIDDEN', () => {
      const res = callLeave(env, LEADER, { clubId });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    });

    it('non-member leave → NOT_FOUND', () => {
      const res = callLeave(env, OUTSIDER, { clubId });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('NOT_FOUND');
    });
  });
});