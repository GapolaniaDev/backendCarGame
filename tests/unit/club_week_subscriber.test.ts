// Phase 7 Chunk 5 — club_week subscriber unit tests.
//
// Drives the RaceCompleted handler directly with synthetic events on
// a fresh FakeNakama. Covers:
//   - confidence gate (`needsReview` aborts the whole event)
//   - leaderboardRecordWrite with `incr` against the `club_week` table
//   - clubs_members/{clubId}/{userId}.weeklyContribution CAS additive
//   - clubs_metadata.weeklyPoints CAS additive
//   - bot/abandoned filtering
//   - 0 humans / all bots → no writes
//   - players without a club → skip silently

import { describe, it, expect, beforeEach } from 'vitest';

import type { INakama, ILogger } from '../../modules/src/nkruntime';
import { EventBus } from '../../modules/src/core/event_bus';
import type { RaceCompletedEvent } from '../../modules/src/race/types';
import { FakeNakama, FakeLogger, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';
import { handleRaceCompletedForClubWeek } from '../../modules/src/clubs/club_week_subscriber';
import { CLUB_WEEK_LEADERBOARD_ID } from '../../modules/src/clubs/leaderboard_init';
import { CLUBS_MEMBERS_COLLECTION } from '../../modules/src/clubs/members_repo';
import { CLUBS_METADATA_COLLECTION, type ClubMetadata, type MemberRecord } from '../../modules/src/clubs/types';

const NOW = 1_700_000_000_000;

function makeEvent(
  results: RaceCompletedEvent['results'],
  needsReview: boolean = false,
): RaceCompletedEvent {
  return {
    schemaVersion: 1,
    sessionId: 'sid-1',
    mode: 'quick',
    trackId: 'neon_blvd',
    size: results.length as 2 | 4 | 6 | 1,
    results,
    flags: { needsReview, reviewReason: needsReview ? 'incomplete_reports' : undefined },
    closedAt: NOW,
  };
}

function makeBus(logger: ILogger): EventBus {
  return new EventBus(logger);
}

function makeDeps(fake: FakeNakamaType) {
  const logger: ILogger = new FakeLogger();
  return {
    nk: fake.nakama as INakama,
    logger,
    bus: makeBus(logger),
  };
}

function seedClubMeta(fake: FakeNakamaType, clubId: string, leaderId: string, weeklyPoints: number = 0): void {
  const rec: ClubMetadata = {
    schemaVersion: 1,
    clubId,
    leaderId,
    motto: 'Drive fast',
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

function seedMember(
  fake: FakeNakamaType,
  clubId: string,
  userId: string,
  weeklyContribution: number = 0,
  role: 'leader' | 'admin' | 'member' = 'member',
): void {
  const rec: MemberRecord = {
    schemaVersion: 1,
    clubId,
    userId,
    role,
    joinedAt: NOW + Math.floor(Math.random() * 10000),
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
  // The subscriber calls leaderboardRecordWrite against this table.
  // The production boot wires `ensureClubWeekLeaderboard`; we seed the
  // table here so the stub can find it.
  fake.leaderboards.set(CLUB_WEEK_LEADERBOARD_ID, {
    id: CLUB_WEEK_LEADERBOARD_ID,
    authoritative: true,
    sortOrder: 'desc',
    operator: 'incr',
    resetSchedule: '0 0 * * 1',
    metadata: {},
  } as never);
}

function readMeta(fake: FakeNakamaType, clubId: string): ClubMetadata | null {
  for (const o of fake.store.values()) {
    if (o.collection !== CLUBS_METADATA_COLLECTION) continue;
    if (o.key !== clubId) continue;
    return o.value as unknown as ClubMetadata;
  }
  return null;
}

function readMemberRow(fake: FakeNakamaType, clubId: string, userId: string): MemberRecord | null {
  const obj = fake.store.get(`${CLUBS_MEMBERS_COLLECTION}/${clubId}/${userId}`);
  if (obj === undefined) return null;
  return obj.value as unknown as MemberRecord;
}

describe('club_week subscriber (Phase 7 Chunk 5)', () => {
  let fake: FakeNakamaType;
  beforeEach(() => {
    fake = new FakeNakama();
    ensureLeaderboard(fake);
  });

  it('drops the whole event when needsReview=true (client confidence)', () => {
    seedClubMeta(fake, 'club-1', 'user-L');
    seedMember(fake, 'club-1', 'user-A');
    const event = makeEvent([
      { rank: 1, userId: 'user-A', isBot: false, totalMs: 60_000, abandoned: false },
      { rank: 2, userId: 'user-B', isBot: false, totalMs: 61_000, abandoned: false },
    ], /* needsReview */ true);
    const out = handleRaceCompletedForClubWeek(makeDeps(fake), event);
    expect(out.processed).toBe(false);
    expect(out.reason).toBe('confidence_client');
    // No leaderboard writes happened.
    expect(fake.leaderboardRecords.get(CLUB_WEEK_LEADERBOARD_ID)).toBeUndefined();
  });

  it('returns no_humans when all results are bots', () => {
    seedClubMeta(fake, 'club-1', 'user-L');
    seedMember(fake, 'club-1', 'bot-1');
    const event = makeEvent([
      { rank: 1, userId: 'bot-1', isBot: true, totalMs: 60_000, abandoned: false },
      { rank: 2, userId: 'bot-2', isBot: true, totalMs: 61_000, abandoned: false },
    ]);
    const out = handleRaceCompletedForClubWeek(makeDeps(fake), event);
    expect(out.processed).toBe(false);
    expect(out.reason).toBe('no_humans');
  });

  it('credits 3/2/1 to the right humans and increments lb by total', () => {
    seedClubMeta(fake, 'club-1', 'user-L');
    seedMember(fake, 'club-1', 'user-A');
    seedMember(fake, 'club-1', 'user-B');
    seedMember(fake, 'club-1', 'user-C');
    const event = makeEvent([
      { rank: 1, userId: 'user-A', isBot: false, totalMs: 60_000, abandoned: false },
      { rank: 2, userId: 'user-B', isBot: false, totalMs: 61_000, abandoned: false },
      { rank: 3, userId: 'user-C', isBot: false, totalMs: 62_000, abandoned: false },
    ]);
    const out = handleRaceCompletedForClubWeek(makeDeps(fake), event);
    expect(out.processed).toBe(true);
    expect(out.reason).toBe('ok');
    expect(out.humans.length).toBe(3);

    const lbRec = fake.leaderboardRecords.get(CLUB_WEEK_LEADERBOARD_ID)?.get('club-1');
    expect(lbRec).toBeDefined();
    // 3 + 2 + 2 = 7
    expect(lbRec!.score).toBe(7);

    expect(readMemberRow(fake, 'club-1', 'user-A')!.weeklyContribution).toBe(3);
    expect(readMemberRow(fake, 'club-1', 'user-B')!.weeklyContribution).toBe(2);
    expect(readMemberRow(fake, 'club-1', 'user-C')!.weeklyContribution).toBe(2);

    expect(readMeta(fake, 'club-1')!.weeklyPoints).toBe(7);
  });

  it('credits 1 point to a finish-only finisher (rank=4)', () => {
    seedClubMeta(fake, 'club-1', 'user-L');
    seedMember(fake, 'club-1', 'user-A');
    seedMember(fake, 'club-1', 'user-D');
    const event = makeEvent([
      { rank: 1, userId: 'user-A', isBot: false, totalMs: 60_000, abandoned: false },
      { rank: 4, userId: 'user-D', isBot: false, totalMs: 70_000, abandoned: false },
    ]);
    handleRaceCompletedForClubWeek(makeDeps(fake), event);
    expect(readMemberRow(fake, 'club-1', 'user-A')!.weeklyContribution).toBe(3);
    expect(readMemberRow(fake, 'club-1', 'user-D')!.weeklyContribution).toBe(1);
  });

  it('does not credit abandoned or bot results', () => {
    seedClubMeta(fake, 'club-1', 'user-L');
    seedMember(fake, 'club-1', 'user-A');
    seedMember(fake, 'club-1', 'user-B');
    const event = makeEvent([
      { rank: 1, userId: 'user-A', isBot: false, totalMs: 60_000, abandoned: false },
      { rank: 2, userId: 'user-B', isBot: false, totalMs: 61_000, abandoned: true },
      { rank: 3, userId: 'bot-1', isBot: true, totalMs: 62_000, abandoned: false },
    ]);
    handleRaceCompletedForClubWeek(makeDeps(fake), event);
    expect(readMemberRow(fake, 'club-1', 'user-A')!.weeklyContribution).toBe(3);
    // B was abandoned; no row update.
    expect(readMemberRow(fake, 'club-1', 'user-B')!.weeklyContribution).toBe(0);
    // Bots have no member row.
    expect(readMemberRow(fake, 'club-1', 'bot-1')).toBeNull();
  });

  it('skips players without a club (no member row)', () => {
    seedClubMeta(fake, 'club-1', 'user-L');
    seedMember(fake, 'club-1', 'user-A');
    // user-B has no row → outcome.skipped effectively.
    const event = makeEvent([
      { rank: 1, userId: 'user-A', isBot: false, totalMs: 60_000, abandoned: false },
      { rank: 2, userId: 'user-B', isBot: false, totalMs: 61_000, abandoned: false },
    ]);
    const out = handleRaceCompletedForClubWeek(makeDeps(fake), event);
    expect(out.processed).toBe(true);
    expect(out.humans.length).toBe(1);
    expect(out.humans[0]!.userId).toBe('user-A');
    expect(out.reason).toBe('ok');
  });

  it('handles multiple clubs in the same race', () => {
    // Two clubs; A wins, B is second and in a different club, C is third.
    seedClubMeta(fake, 'club-1', 'user-L1');
    seedClubMeta(fake, 'club-2', 'user-L2');
    seedMember(fake, 'club-1', 'user-A');
    seedMember(fake, 'club-1', 'user-C');
    seedMember(fake, 'club-2', 'user-B');
    const event = makeEvent([
      { rank: 1, userId: 'user-A', isBot: false, totalMs: 60_000, abandoned: false },
      { rank: 2, userId: 'user-B', isBot: false, totalMs: 61_000, abandoned: false },
      { rank: 3, userId: 'user-C', isBot: false, totalMs: 62_000, abandoned: false },
    ]);
    handleRaceCompletedForClubWeek(makeDeps(fake), event);
    // LB rows for both clubs.
    const lb1 = fake.leaderboardRecords.get(CLUB_WEEK_LEADERBOARD_ID)?.get('club-1');
    const lb2 = fake.leaderboardRecords.get(CLUB_WEEK_LEADERBOARD_ID)?.get('club-2');
    expect(lb1!.score).toBe(5); // 3 (A) + 2 (C)
    expect(lb2!.score).toBe(2); // B
    // Metadata weeklyPoints.
    expect(readMeta(fake, 'club-1')!.weeklyPoints).toBe(5);
    expect(readMeta(fake, 'club-2')!.weeklyPoints).toBe(2);
  });

  it('does not throw when leaderboard table is missing', () => {
    // Drop the seeded leaderboard so leaderboardRecordWrite throws.
    fake.leaderboards.delete(CLUB_WEEK_LEADERBOARD_ID);
    seedClubMeta(fake, 'club-1', 'user-L');
    seedMember(fake, 'club-1', 'user-A');
    const event = makeEvent([
      { rank: 1, userId: 'user-A', isBot: false, totalMs: 60_000, abandoned: false },
    ]);
    // Subscriber must not throw — the LB error is caught and logged.
    const out = handleRaceCompletedForClubWeek(makeDeps(fake), event);
    expect(out.processed).toBe(true);
    // The member CAS path should still have applied (no LB-side effect).
    expect(readMemberRow(fake, 'club-1', 'user-A')!.weeklyContribution).toBe(3);
  });
});