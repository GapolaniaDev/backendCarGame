// Plan B2 (T-04) — club_mine: the caller's club, membership and weekly rank in one call.

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import { CLUB_WEEK_LEADERBOARD_ID } from '../../modules/src/clubs/leaderboard_init';
import { PROFILES_COLLECTION, type ProfileRecord } from '../../modules/src/profiles/storage';
import { LIVEOPS_STORAGE_KEY } from '../../modules/src/liveops/config';
import type { LiveopsConfig } from '../../modules/src/liveops/types';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

interface MineData {
  inClub: boolean;
  club: { clubId: string } | null;
  membership: { role: string; joinedAt: number; weeklyContribution: number } | null;
  weeklyRank: number | null;
}

const LEADER = 'user-leader';
const LEADER_B = 'user-leader-b';
const ALICE = 'user-alice';
const NOBODY = 'user-nobody';

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

function createClub(env: LoadedBundle, leader: string, name: string): string {
  seedProfile(env, leader, 8);
  env.fakeNakama.wallets.set(leader, { coins: 10_000, gems: 0 });
  const res = call<Resp<{ clubId: string }>>(env, 'club_create', leader, {
    name, motto: 'Ride on', emblemId: 'emblem_default', region: 'us',
  });
  if (!res.ok) throw new Error(`club_create failed: ${JSON.stringify(res)}`);
  return res.data.clubId;
}

function seedLb(env: LoadedBundle, clubId: string, score: number): void {
  const bucket = env.fakeNakama.leaderboardRecords.get(CLUB_WEEK_LEADERBOARD_ID) ?? new Map();
  bucket.set(clubId, {
    leaderboardId: CLUB_WEEK_LEADERBOARD_ID, ownerId: clubId, username: '', score, subscore: 0,
    numScore: 1, metadata: {}, createTime: new Date(0).toISOString(), updateTime: new Date(0).toISOString(),
    expiryTime: null, rank: null, maxNumScore: 1,
  });
  env.fakeNakama.leaderboardRecords.set(CLUB_WEEK_LEADERBOARD_ID, bucket);
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

function mine(env: LoadedBundle, caller: string): Resp<MineData> {
  return call<Resp<MineData>>(env, 'club_mine', caller, { callerUserId: caller });
}

describe('club_mine (plan B2)', () => {
  let env: LoadedBundle;
  let clubA: string;

  beforeEach(() => {
    env = loadBundleForTest();
    clubA = createClub(env, LEADER, 'Night Riders');
  });

  it('a player without a club gets inClub false and nulls', () => {
    const res = mine(env, NOBODY);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ inClub: false, club: null, membership: null, weeklyRank: null });
  });

  it('the leader sees role leader, the right club and the wire order', () => {
    const res = mine(env, LEADER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.inClub).toBe(true);
    expect(res.data.club?.clubId).toBe(clubA);
    expect(res.data.membership?.role).toBe('leader');
    expect(Object.keys(res.data)).toEqual(['inClub', 'club', 'membership', 'weeklyRank']);
  });

  it('a member sees role member', () => {
    seedProfile(env, ALICE, 8);
    const joined = call<Resp<{ role: string }>>(env, 'club_join', ALICE, { clubId: clubA });
    expect(joined.ok).toBe(true);
    const res = mine(env, ALICE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.membership?.role).toBe('member');
      expect(res.data.club?.clubId).toBe(clubA);
    }
  });

  it('weeklyRank follows the club_week table order', () => {
    const clubB = createClub(env, LEADER_B, 'Day Riders');
    seedLb(env, clubA, 2);
    seedLb(env, clubB, 5);
    const a = mine(env, LEADER);
    const b = mine(env, LEADER_B);
    expect(a.ok && a.data.weeklyRank).toBe(2);
    expect(b.ok && b.data.weeklyRank).toBe(1);
  });

  it('a club without points has weeklyRank null', () => {
    const res = mine(env, LEADER);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.weeklyRank).toBeNull();
  });

  it('SERVICE_UNAVAILABLE when maintenance=true', () => {
    setMaintenance(env);
    const res = mine(env, LEADER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});
