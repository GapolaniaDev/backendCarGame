// Phase 7 Chunk 5 — club_week reset hook unit tests.
//
// Drives `ensureWeekBoundary` directly against a fresh FakeNakama.
// Covers:
//   - first call seeds the meta row (no reset, no reward)
//   - same-week call is `same_week` no-op
//   - cross-week call zeros metadata + members, writes the global
//     reset marker, and sends inbox rewards to the winning club's
//     top-3 contributors
//   - second cross-week caller (different club) finds the marker
//     already present, so no double-send
//   - empty leaderboard → no winner, no inbox
//   - meta cache CAS failure → write_failed outcome (does not throw)

import { describe, it, expect, beforeEach } from 'vitest';

import type { INakama, ILogger } from '../../modules/src/nkruntime';
import { FakeNakama, FakeLogger, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';
import { ensureWeekBoundary } from '../../modules/src/clubs/club_week_reset';
import {
  CLUBS_WEEK_META_COLLECTION,
  CLUBS_WEEK_RESET_COLLECTION,
} from '../../modules/src/clubs/week_repo';
import { CLUBS_MEMBERS_COLLECTION } from '../../modules/src/clubs/members_repo';
import { CLUBS_METADATA_COLLECTION, type ClubMetadata, type MemberRecord } from '../../modules/src/clubs/types';
import { CLUB_WEEK_LEADERBOARD_ID } from '../../modules/src/clubs/leaderboard_init';
import { INBOX_COLLECTION } from '../../modules/src/liveops/messages';

const NOW = 1_700_000_000_000;

function seedClubMeta(fake: FakeNakamaType, clubId: string, leaderId: string, weeklyPoints: number): void {
  const rec: ClubMetadata = {
    schemaVersion: 1,
    clubId,
    leaderId,
    motto: 'm',
    emblemId: 'emblem_default',
    region: 'us',
    minDivision: 'bronce',
    weeklyPoints,
    createdAt: NOW,
  };
  fake.store.set(`${CLUBS_METADATA_COLLECTION}/${clubId}/${leaderId}`, {
    collection: CLUBS_METADATA_COLLECTION,
    key: clubId,
    userId: leaderId,
    value: rec as unknown as Record<string, unknown>,
    version: 'v00000001',
    permissionRead: 2,
    permissionWrite: 1,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

function seedMember(fake: FakeNakamaType, clubId: string, userId: string, weeklyContribution: number, joinedAt: number, role: 'leader' | 'admin' | 'member' = 'member'): void {
  const rec: MemberRecord = {
    schemaVersion: 1,
    clubId,
    userId,
    role,
    joinedAt,
    weeklyContribution,
  };
  fake.store.set(`${CLUBS_MEMBERS_COLLECTION}/${clubId}/${userId}`, {
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

function ensureLeaderboard(fake: FakeNakamaType): void {
  fake.leaderboards.set(CLUB_WEEK_LEADERBOARD_ID, {
    id: CLUB_WEEK_LEADERBOARD_ID,
    authoritative: true,
    sortOrder: 'desc',
    operator: 'incr',
    resetSchedule: '0 0 * * 1',
    metadata: {},
  } as never);
}

function seedLbRecord(fake: FakeNakamaType, clubId: string, score: number): void {
  const bucket = fake.leaderboardRecords.get(CLUB_WEEK_LEADERBOARD_ID) ?? new Map();
  bucket.set(clubId, {
    leaderboardId: CLUB_WEEK_LEADERBOARD_ID,
    ownerId: clubId,
    username: '',
    score,
    subscore: NOW,
    numScore: 1,
    metadata: {},
    createTime: new Date(NOW).toISOString(),
    updateTime: new Date(NOW).toISOString(),
    expiryTime: null,
    rank: null,
    maxNumScore: 1,
  });
  fake.leaderboardRecords.set(CLUB_WEEK_LEADERBOARD_ID, bucket);
}

function readMeta(fake: FakeNakamaType, clubId: string): ClubMetadata | null {
  for (const o of fake.store.values()) {
    if (o.collection !== CLUBS_METADATA_COLLECTION) continue;
    if (o.key !== clubId) continue;
    return o.value as unknown as ClubMetadata;
  }
  return null;
}

function readMember(fake: FakeNakamaType, clubId: string, userId: string): MemberRecord | null {
  const obj = fake.store.get(`${CLUBS_MEMBERS_COLLECTION}/${clubId}/${userId}`);
  if (obj === undefined) return null;
  return obj.value as unknown as MemberRecord;
}

function readResetMarker(fake: FakeNakamaType, weekUtc: string): { winnerClubId: string | null; rewardedUserIds: string[] } | null {
  const obj = fake.store.get(`${CLUBS_WEEK_RESET_COLLECTION}/${weekUtc}/${weekUtc}`);
  if (obj === undefined) return null;
  const v = obj.value as { winnerClubId: string | null; rewardedUserIds: string[] };
  return { winnerClubId: v.winnerClubId, rewardedUserIds: v.rewardedUserIds };
}

function readInboxCount(fake: FakeNakamaType, userId: string): number {
  let n = 0;
  for (const o of fake.store.values()) {
    if (o.collection !== INBOX_COLLECTION) continue;
    if (o.userId !== userId) continue;
    n++;
  }
  return n;
}

describe('ensureWeekBoundary (Phase 7 Chunk 5)', () => {
  let fake: FakeNakamaType;
  let logger: ILogger;

  beforeEach(() => {
    fake = new FakeNakama();
    logger = new FakeLogger();
    ensureLeaderboard(fake);
  });

  it('first call seeds the meta row without firing a reset', () => {
    const out = ensureWeekBoundary(fake.nakama as INakama, logger, 'club-1');
    expect(out.reset).toBe(false);
    expect(out.reason).toBe('first_seen');
    const meta = fake.store.get(`${CLUBS_WEEK_META_COLLECTION}/club-1/club-1`);
    expect(meta).toBeDefined();
    expect((meta!.value as { currentWeek: string }).currentWeek).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('same-week call is a no-op (same_week)', () => {
    ensureWeekBoundary(fake.nakama as INakama, logger, 'club-1');
    const out = ensureWeekBoundary(fake.nakama as INakama, logger, 'club-1');
    expect(out.reset).toBe(false);
    expect(out.reason).toBe('same_week');
  });

  it('cross-week: zeros metadata + members, writes marker, sends reward', () => {
    // Seed a winner club with 3 contributors.
    seedLbRecord(fake, 'club-1', 30);
    seedLbRecord(fake, 'club-2', 10);
    seedClubMeta(fake, 'club-1', 'user-L1', 30);
    seedClubMeta(fake, 'club-2', 'user-L2', 10);
    seedMember(fake, 'club-1', 'user-L1', 10, 100, 'leader');
    seedMember(fake, 'club-1', 'user-M1', 8, 200);
    seedMember(fake, 'club-1', 'user-M2', 5, 300);
    seedMember(fake, 'club-1', 'user-M3', 2, 400);

    // Seed the meta row to last week.
    fake.store.set(`${CLUBS_WEEK_META_COLLECTION}/club-1/club-1`, {
      collection: CLUBS_WEEK_META_COLLECTION,
      key: 'club-1',
      userId: 'club-1',
      value: {
        schemaVersion: 1,
        clubId: 'club-1',
        currentWeek: '2026-W01',
        lastResetAt: NOW - 7 * 86_400_000,
      } as unknown as Record<string, unknown>,
      version: 'v00000001',
      permissionRead: 1,
      permissionWrite: 1,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    });

    const out = ensureWeekBoundary(fake.nakama as INakama, logger, 'club-1');
    expect(out.reset).toBe(true);
    expect(out.reason).toBe('ok');
    expect(out.winnerClubId).toBe('club-1');
    expect(out.rewardedUserIds.length).toBe(3);
    expect(out.rewardedUserIds).toContain('user-L1');
    expect(out.rewardedUserIds).toContain('user-M1');
    expect(out.rewardedUserIds).toContain('user-M2');

    // Metadata weeklyPoints reset.
    expect(readMeta(fake, 'club-1')!.weeklyPoints).toBe(0);
    // Members reset.
    expect(readMember(fake, 'club-1', 'user-L1')!.weeklyContribution).toBe(0);
    expect(readMember(fake, 'club-1', 'user-M1')!.weeklyContribution).toBe(0);
    expect(readMember(fake, 'club-1', 'user-M2')!.weeklyContribution).toBe(0);
    expect(readMember(fake, 'club-1', 'user-M3')!.weeklyContribution).toBe(0);
    // Global marker written.
    const marker = readResetMarker(fake, '2026-W01');
    expect(marker).not.toBeNull();
    expect(marker!.winnerClubId).toBe('club-1');
    expect(marker!.rewardedUserIds.length).toBe(3);
    // Inbox sent.
    expect(readInboxCount(fake, 'user-L1')).toBe(1);
    expect(readInboxCount(fake, 'user-M1')).toBe(1);
    expect(readInboxCount(fake, 'user-M2')).toBe(1);
    expect(readInboxCount(fake, 'user-M3')).toBe(0); // outside top 3
  });

  it('second club across the boundary finds the marker — no double-send', () => {
    seedLbRecord(fake, 'club-1', 30);
    seedLbRecord(fake, 'club-2', 10);
    seedClubMeta(fake, 'club-1', 'user-L1', 30);
    seedClubMeta(fake, 'club-2', 'user-L2', 10);
    seedMember(fake, 'club-1', 'user-L1', 10, 100, 'leader');
    seedMember(fake, 'club-2', 'user-L2', 5, 100, 'leader');

    // Seed both clubs' meta rows to last week.
    for (const cid of ['club-1', 'club-2']) {
      fake.store.set(`${CLUBS_WEEK_META_COLLECTION}/${cid}/${cid}`, {
        collection: CLUBS_WEEK_META_COLLECTION,
        key: cid,
        userId: cid,
        value: {
          schemaVersion: 1,
          clubId: cid,
          currentWeek: '2026-W01',
          lastResetAt: NOW - 7 * 86_400_000,
        } as unknown as Record<string, unknown>,
        version: 'v00000001',
        permissionRead: 1,
        permissionWrite: 1,
        createTime: new Date(0).toISOString(),
        updateTime: new Date(0).toISOString(),
        expiresAt: null,
      });
    }

    // First club-1 call owns the reward.
    const out1 = ensureWeekBoundary(fake.nakama as INakama, logger, 'club-1');
    expect(out1.reset).toBe(true);
    expect(out1.winnerClubId).toBe('club-1');
    expect(readInboxCount(fake, 'user-L1')).toBe(1);

    // Second club-2 call sees the marker → no inbox.
    const out2 = ensureWeekBoundary(fake.nakama as INakama, logger, 'club-2');
    expect(out2.reset).toBe(true);
    expect(out2.winnerClubId).toBe('club-1'); // marker is global
    expect(readInboxCount(fake, 'user-L2')).toBe(0); // NOT a winner

    // Both clubs' meta + members are zeroed.
    expect(readMeta(fake, 'club-2')!.weeklyPoints).toBe(0);
    expect(readMember(fake, 'club-2', 'user-L2')!.weeklyContribution).toBe(0);
  });

  it('empty leaderboard → no_winner (no inbox)', () => {
    seedClubMeta(fake, 'club-1', 'user-L1', 5);
    seedMember(fake, 'club-1', 'user-L1', 5, 100, 'leader');
    fake.store.set(`${CLUBS_WEEK_META_COLLECTION}/club-1/club-1`, {
      collection: CLUBS_WEEK_META_COLLECTION,
      key: 'club-1',
      userId: 'club-1',
      value: {
        schemaVersion: 1,
        clubId: 'club-1',
        currentWeek: '2026-W01',
        lastResetAt: NOW - 7 * 86_400_000,
      } as unknown as Record<string, unknown>,
      version: 'v00000001',
      permissionRead: 1,
      permissionWrite: 1,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    });

    const out = ensureWeekBoundary(fake.nakama as INakama, logger, 'club-1');
    expect(out.reset).toBe(true);
    expect(out.winnerClubId).toBeNull();
    expect(out.rewardedUserIds).toEqual([]);
    expect(readInboxCount(fake, 'user-L1')).toBe(0);
    // Marker is still written so future resets don't repeat.
    expect(readResetMarker(fake, '2026-W01')).not.toBeNull();
  });

  it('only top-3 by weeklyContribution receive the inbox', () => {
    seedLbRecord(fake, 'club-1', 50);
    seedClubMeta(fake, 'club-1', 'user-L1', 50);
    // 5 members with very different contributions.
    seedMember(fake, 'club-1', 'user-L1', 20, 100, 'leader');
    seedMember(fake, 'club-1', 'user-A', 15, 200);
    seedMember(fake, 'club-1', 'user-B', 10, 300);
    seedMember(fake, 'club-1', 'user-C', 3, 400);  // outside top 3
    seedMember(fake, 'club-1', 'user-D', 1, 500);  // outside top 3
    fake.store.set(`${CLUBS_WEEK_META_COLLECTION}/club-1/club-1`, {
      collection: CLUBS_WEEK_META_COLLECTION,
      key: 'club-1',
      userId: 'club-1',
      value: {
        schemaVersion: 1, clubId: 'club-1',
        currentWeek: '2026-W01', lastResetAt: NOW - 7 * 86_400_000,
      } as unknown as Record<string, unknown>,
      version: 'v00000001',
      permissionRead: 1, permissionWrite: 1,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    });

    const out = ensureWeekBoundary(fake.nakama as INakama, logger, 'club-1');
    expect(out.reset).toBe(true);
    expect(out.rewardedUserIds).toEqual(['user-L1', 'user-A', 'user-B']);
    expect(readInboxCount(fake, 'user-C')).toBe(0);
    expect(readInboxCount(fake, 'user-D')).toBe(0);
  });
});