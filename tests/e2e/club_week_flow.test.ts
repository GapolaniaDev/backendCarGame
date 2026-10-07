// Phase 7 Chunk 5 — club_week end-to-end flow tests.
//
// Exercises the full bundle through `club_get` and `club_search`:
//   - boot creates the `club_week` leaderboard
//   - club_get triggers the lazy weekly reset on a Monday boundary
//   - club_get is a no-op same-week
//   - club_search calls ensureWeekBoundary for every group returned
//   - weekly reward inbox lands in the winning club's top-3 members
//
// The reset is *driven* by pre-seeding `clubs_week_meta/{clubId}` to
// a past ISO week so the helper treats the boundary as crossed.

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import { CLUBS_MEMBERS_COLLECTION } from '../../modules/src/clubs/members_repo';
import {
  CLUBS_WEEK_META_COLLECTION,
  CLUBS_WEEK_RESET_COLLECTION,
} from '../../modules/src/clubs/week_repo';
import {
  CLUBS_METADATA_COLLECTION,
  type ClubMetadata,
  type MemberRecord,
} from '../../modules/src/clubs/types';
import { CLUB_WEEK_LEADERBOARD_ID } from '../../modules/src/clubs/leaderboard_init';
import { INBOX_COLLECTION } from '../../modules/src/liveops/messages';
import { PROFILES_COLLECTION } from '../../modules/src/profiles/storage';
import type { ProfileRecord } from '../../modules/src/profiles/storage';
import { LIVEOPS_STORAGE_KEY } from '../../modules/src/liveops/config';
import type { LiveopsConfig } from '../../modules/src/liveops/types';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface ClubGetOutput {
  club: {
    clubId: string;
    weeklyPoints: number;
    name: string;
  };
  members: Array<{ userId: string; isLeader: boolean; username: string }>;
  weeklyRank: number | null;
}

const LEADER = 'user-leader';

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

function callCreate(env: LoadedBundle, userId: string): Resp<{ clubId: string }> {
  return call<Resp<{ clubId: string }>>(env, 'club_create', userId, {
    callerUserId: userId,
    name: 'Speed Demons',
    motto: 'Drive fast',
    emblemId: 'emblem_default',
    region: 'us',
  });
}

function callGet(env: LoadedBundle, userId: string, clubId: string): Resp<ClubGetOutput> {
  return call<Resp<ClubGetOutput>>(env, 'club_get', userId, {
    callerUserId: userId,
    clubId,
  });
}

function seedMeta(env: LoadedBundle, clubId: string, currentWeek: string): void {
  env.fakeNakama.store.set(`${CLUBS_WEEK_META_COLLECTION}/${clubId}/${clubId}`, {
    collection: CLUBS_WEEK_META_COLLECTION,
    key: clubId,
    userId: clubId,
    value: {
      schemaVersion: 1, clubId, currentWeek, lastResetAt: 1,
    } as unknown as Record<string, unknown>,
    version: 'v00000001',
    permissionRead: 1, permissionWrite: 1,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

function seedLb(env: LoadedBundle, clubId: string, score: number): void {
  const bucket = env.fakeNakama.leaderboardRecords.get(CLUB_WEEK_LEADERBOARD_ID) ?? new Map();
  bucket.set(clubId, {
    leaderboardId: CLUB_WEEK_LEADERBOARD_ID,
    ownerId: clubId,
    username: '',
    score,
    subscore: 0,
    numScore: 1,
    metadata: {},
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiryTime: null,
    rank: null,
    maxNumScore: 1,
  });
  env.fakeNakama.leaderboardRecords.set(CLUB_WEEK_LEADERBOARD_ID, bucket);
}

function setWeeklyPoints(env: LoadedBundle, clubId: string, value: number, userId: string): void {
  const obj = env.fakeNakama.store.get(`${CLUBS_METADATA_COLLECTION}/${clubId}/${userId}`);
  if (obj === undefined) return;
  const v = obj.value as ClubMetadata;
  obj.value = { ...v, weeklyPoints: value };
}

function setMemberContribution(env: LoadedBundle, clubId: string, userId: string, value: number): void {
  const obj = env.fakeNakama.store.get(`${CLUBS_MEMBERS_COLLECTION}/${clubId}/${userId}`);
  if (obj === undefined) return;
  const v = obj.value as MemberRecord;
  obj.value = { ...v, weeklyContribution: value };
}

function readMeta(env: LoadedBundle, clubId: string): { currentWeek: string; lastResetAt: number } | null {
  const obj = env.fakeNakama.store.get(`${CLUBS_WEEK_META_COLLECTION}/${clubId}/${clubId}`);
  if (obj === undefined) return null;
  return obj.value as { currentWeek: string; lastResetAt: number };
}

function readResetMarker(env: LoadedBundle, weekUtc: string): { winnerClubId: string | null; rewardedUserIds: string[] } | null {
  const obj = env.fakeNakama.store.get(`${CLUBS_WEEK_RESET_COLLECTION}/${weekUtc}/${weekUtc}`);
  if (obj === undefined) return null;
  return obj.value as { winnerClubId: string | null; rewardedUserIds: string[] };
}

function readInboxCount(env: LoadedBundle, userId: string): number {
  let n = 0;
  for (const o of env.fakeNakama.store.values()) {
    if (o.collection !== INBOX_COLLECTION) continue;
    if (o.userId !== userId) continue;
    n++;
  }
  return n;
}

describe('club_week flow e2e (Phase 7 Chunk 5)', () => {
  let env: LoadedBundle;
  let clubId: string;

  beforeEach(() => {
    env = loadBundleForTest();
    seedProfile(env, LEADER, 8);
    setCoins(env, LEADER, 10_000);
    const created = callCreate(env, LEADER);
    if (!created.ok) throw new Error('seed: club_create failed: ' + JSON.stringify(created));
    clubId = created.data.clubId;
    // club_create doesn't seed members; do it manually.
    const memberRec: MemberRecord = {
      schemaVersion: 1,
      clubId,
      userId: LEADER,
      role: 'leader',
      joinedAt: 1_700_000_000_000,
      weeklyContribution: 0,
    };
    env.fakeNakama.store.set(`${CLUBS_MEMBERS_COLLECTION}/${clubId}/${LEADER}`, {
      collection: CLUBS_MEMBERS_COLLECTION,
      key: clubId,
      userId: LEADER,
      value: memberRec as unknown as Record<string, unknown>,
      version: 'v00000001',
      permissionRead: 1, permissionWrite: 1,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    });
  });

  it('boot creates the club_week leaderboard', () => {
    const lb = env.fakeNakama.leaderboards.get(CLUB_WEEK_LEADERBOARD_ID);
    expect(lb).toBeDefined();
    expect(lb!.operator).toBe('incr');
    expect(lb!.sortOrder).toBe('desc');
    expect(lb!.resetSchedule).toBe('0 0 * * 1');
  });

  it('club_get seeds the meta row on first call', () => {
    const res = callGet(env, LEADER, clubId);
    expect(res.ok).toBe(true);
    const meta = readMeta(env, clubId);
    expect(meta).not.toBeNull();
    expect(meta!.currentWeek).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('club_get is a no-op same-week', () => {
    callGet(env, LEADER, clubId);
    const before = readMeta(env, clubId);
    const res = callGet(env, LEADER, clubId);
    expect(res.ok).toBe(true);
    const after = readMeta(env, clubId);
    expect(after!.lastResetAt).toBe(before!.lastResetAt);
  });

  it('cross-week club_get zeros weeklyPoints and writes the reset marker', () => {
    // Set up last-week state.
    setWeeklyPoints(env, clubId, 30, LEADER);
    setMemberContribution(env, clubId, LEADER, 12);
    seedLb(env, clubId, 30);
    seedMeta(env, clubId, '2026-W01'); // ISO week far in the past

    const res = callGet(env, LEADER, clubId);
    expect(res.ok).toBe(true);
    // weeklyPoints reset to 0 in the response.
    expect(res.data!.club.weeklyPoints).toBe(0);

    // Member contribution zeroed.
    const memberObj = env.fakeNakama.store.get(`${CLUBS_MEMBERS_COLLECTION}/${clubId}/${LEADER}`);
    expect((memberObj!.value as MemberRecord).weeklyContribution).toBe(0);

    // Marker written.
    const marker = readResetMarker(env, '2026-W01');
    expect(marker).not.toBeNull();
    expect(marker!.winnerClubId).toBe(clubId);

    // Inbox sent (single member → top 3 = [leader]).
    expect(readInboxCount(env, LEADER)).toBe(1);

    // Meta rolled.
    const meta = readMeta(env, clubId);
    expect(meta!.currentWeek).not.toBe('2026-W01');
  });

  it('cross-week club_search also fires the reset per-group', () => {
    setWeeklyPoints(env, clubId, 25, LEADER);
    seedLb(env, clubId, 25);
    seedMeta(env, clubId, '2026-W01');

    const searchRes = call<Resp<unknown>>(env, 'club_search', LEADER, {
      callerUserId: LEADER,
    });
    expect(searchRes.ok).toBe(true);
    // Weekly points zeroed in the search result.
    const list = (searchRes.data as { clubs: Array<{ clubId: string; weeklyPoints: number }> }).clubs;
    const entry = list.find((c) => c.clubId === clubId);
    expect(entry).toBeDefined();
    expect(entry!.weeklyPoints).toBe(0);
  });

  it('SERVICE_UNAVAILABLE when maintenance=true (reset does not run)', () => {
    setWeeklyPoints(env, clubId, 30, LEADER);
    setMemberContribution(env, clubId, LEADER, 12);
    seedLb(env, clubId, 30);
    seedMeta(env, clubId, '2026-W01');

    setMaintenance(env);
    const res = callGet(env, LEADER, clubId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('SERVICE_UNAVAILABLE');

    // Reset did not happen — weeklyPoints still 30.
    const memberObj = env.fakeNakama.store.get(`${CLUBS_MEMBERS_COLLECTION}/${clubId}/${LEADER}`);
    expect((memberObj!.value as MemberRecord).weeklyContribution).toBe(12);
  });
});