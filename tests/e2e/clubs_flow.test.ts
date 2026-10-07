// Phase 7 Chunk 3 — Clubs e2e tests.
//
// Covers the full RPC surface (club_create / club_get / club_search):
//   1. club_create — happy path: spend 5000 coins, group + metadata
//      persisted, leader recorded, storage + wallet updated.
//   2. club_create — INSUFFICIENT_FUNDS when wallet < 5000 coins.
//   3. club_create — FORBIDDEN when profile level < 8.
//   4. club_create — CONFLICT on duplicate name (second-pre-created).
//   5. club_create — CONFLICT on lifetime cap (user already created one).
//   6. club_create — BAD_REQUEST on unknown emblemId.
//   7. club_create — BAD_REQUEST on blocked-word name/motto.
//   8. club_create — RATE_LIMITED after burst.
//   9. club_create — SERVICE_UNAVAILABLE when liveops.maintenance=true.
//  10. club_get — round-trips a freshly-created club.
//  11. club_get — NOT_FOUND on missing clubId.
//  12. club_get — BAD_REQUEST on missing clubId field.
//  13. club_search — returns the just-created club via name prefix.
//  14. club_search — region filter excludes mismatched clubs.
//  15. club_search — empty list on no matches.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  FakeContext,
  FakeLogger,
  loadBundleForTest,
  SYSTEM_USER_ID,
  type FakeNakama as FakeNakamaType,
} from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  CLUBS_METADATA_COLLECTION,
  type ClubMetadata,
  type ClubView,
} from '../../modules/src/clubs/types';
import { PROFILES_COLLECTION } from '../../modules/src/profiles/storage';
import type { ProfileRecord } from '../../modules/src/profiles/storage';
import { LIVEOPS_STORAGE_KEY } from '../../modules/src/liveops/config';
import type { LiveopsConfig } from '../../modules/src/liveops/types';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface ClubCreateOutput {
  clubId: string;
  name: string;
  costPaid: number;
  newBalance: number;
}

interface ClubGetOutput {
  club: ClubView;
  members: Array<{ userId: string; isLeader: boolean; username: string }>;
  weeklyRank: number | null;
}

interface ClubSearchOutput {
  clubs: ClubView[];
  nextCursor: string;
}

const LEADER = 'user-leader';

function call<T>(
  env: LoadedBundle,
  rpc: string,
  caller: string | null,
  payload: unknown,
): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as T;
}

function callClubCreate(
  env: LoadedBundle,
  userId: string,
  payload: Partial<{
    name: string;
    motto: string;
    emblemId: string;
    region: string;
    minDivision: string;
  }> = {},
): Resp<ClubCreateOutput> {
  return call<Resp<ClubCreateOutput>>(env, 'club_create', userId, {
    callerUserId: userId,
    name: 'Fast Lane',
    motto: 'Drive fast',
    emblemId: 'emblem_default',
    region: 'us',
    ...payload,
  });
}

function callClubGet(
  env: LoadedBundle,
  userId: string,
  clubId: string,
): Resp<ClubGetOutput> {
  return call<Resp<ClubGetOutput>>(env, 'club_get', userId, {
    callerUserId: userId,
    clubId,
  });
}

function callClubSearch(
  env: LoadedBundle,
  userId: string,
  payload: Partial<{
    name: string;
    region: string;
    limit: number;
    cursor: string;
  }> = {},
): Resp<ClubSearchOutput> {
  return call<Resp<ClubSearchOutput>>(env, 'club_search', userId, {
    callerUserId: userId,
    ...payload,
  });
}

function setCoins(env: LoadedBundle, userId: string, coins: number): void {
  env.fakeNakama.wallets.set(userId, { coins, gems: 0 });
}

function seedProfile(
  env: LoadedBundle,
  userId: string,
  level: number,
): void {
  const profile: ProfileRecord = {
    schemaVersion: 1,
    userId,
    displayName: `user-${userId}`,
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
    schemaVersion: 1,
    version: 1,
    flags: { maintenance: true },
    minClientVersion: {
      ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0',
    },
    regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
    calendar: [],
  };
  const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
  env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: cfg as unknown as LiveopsConfig,
    version: stored?.version ?? 'v00000001',
    permissionRead: 1,
    permissionWrite: 0,
    createTime: stored?.createTime ?? new Date(0).toISOString(),
    updateTime: new Date().toISOString(),
    expiresAt: null,
  });
}

describe('clubs e2e (Phase 7 Chunk 3)', () => {
  let env: LoadedBundle;
  let fake: FakeNakamaType;

  beforeEach(() => {
    env = loadBundleForTest();
    fake = env.fakeNakama;
    seedProfile(env, LEADER, 8);
    setCoins(env, LEADER, 10_000);
  });

  describe('club_create', () => {
    it('SUCCESS — debits 5000 coins, persists metadata + counter', () => {
      const res = callClubCreate(env, LEADER);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.costPaid).toBe(5000);
      expect(res.data.newBalance).toBe(5000);
      expect(res.data.name).toBe('Fast Lane');
      expect(res.data.clubId.length).toBeGreaterThan(0);

      // Storage: clubs_metadata row exists.
      const metaKeys = Array.from(fake.store.keys()).filter((k) =>
        k.startsWith(`${CLUBS_METADATA_COLLECTION}/`),
      );
      expect(metaKeys).toHaveLength(1);

      // Storage: clubs_created counter for leader.
      const counter = fake.store.get(`clubs_created/${LEADER}/${LEADER}`);
      expect(counter).toBeDefined();

      // Storage: leader appears in the group's member set.
      const groupId = res.data.clubId;
      const members = fake.groupMembers.get(groupId);
      expect(members).toBeDefined();
      expect(members!.has(LEADER)).toBe(true);
    });

    it('INSUFFICIENT_FUNDS when coins < 5000', () => {
      setCoins(env, LEADER, 4999);
      const res = callClubCreate(env, LEADER);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('FORBIDDEN when profile level < 8', () => {
      seedProfile(env, LEADER, 7);
      const res = callClubCreate(env, LEADER);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    });

    it('CONFLICT on lifetime cap (user already created one)', () => {
      const first = callClubCreate(env, LEADER);
      expect(first.ok).toBe(true);
      // Refund the coins (since the previous call spent them).
      setCoins(env, LEADER, 10_000);
      const second = callClubCreate(env, LEADER, { name: 'Other Lane' });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.code).toBe('CONFLICT');
        expect((second.error.details as { existingClubId?: string }).existingClubId).toBe(first.data!.clubId);
      }
    });

    it('CONFLICT on duplicate name', () => {
      const first = callClubCreate(env, LEADER, { name: 'Speed Demons' });
      expect(first.ok).toBe(true);
      // Refund + clear lifetime cap so the duplicate-name check is the only gate.
      setCoins(env, LEADER, 10_000);
      fake.store.delete(`clubs_created/${LEADER}/${LEADER}`);
      fake.groups.delete(first.data!.clubId);
      fake.groupMembers.delete(first.data!.clubId);
      // Re-create with a different name, then attempt to clone it.
      const setup = callClubCreate(env, LEADER, { name: 'Speed Demons' });
      expect(setup.ok).toBe(true);
      setCoins(env, LEADER, 10_000);
      fake.store.delete(`clubs_created/${LEADER}/${LEADER}`);
      const dup = callClubCreate(env, LEADER, { name: 'Speed Demons' });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.error.code).toBe('CONFLICT');
    });

    it('BAD_REQUEST on unknown emblemId', () => {
      const res = callClubCreate(env, LEADER, { emblemId: 'emblem_404' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
    });

    it('BAD_REQUEST on blocked-word name', () => {
      const res = callClubCreate(env, LEADER, { name: 'Admin Corner' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
    });

    it('BAD_REQUEST on bad motto (too short)', () => {
      const res = callClubCreate(env, LEADER, { motto: 'no' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
    });

    it('SERVICE_UNAVAILABLE when liveops.maintenance=true', () => {
      setMaintenance(env);
      const res = callClubCreate(env, LEADER);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('RATE_LIMITED after burst (5 in 60s window)', () => {
      // The lifetime counter blocks the 2nd attempt, but the rate limit
      // fires BEFORE that check. Spam 5 successful-shape calls in 60s
      // and the 6th should be RATE_LIMITED.
      // To get past the lifetime cap, delete the counter between calls.
      for (let i = 0; i < 5; i++) {
        const res = callClubCreate(env, LEADER, { name: `Club ${i}` });
        // The first will succeed, others fail CONFLICT due to lifetime.
        // We only care about the rate-limit verdict on attempt 6.
        void res;
        fake.store.delete(`clubs_created/${LEADER}/${LEADER}`);
      }
      const sixth = callClubCreate(env, LEADER, { name: 'Club 5' });
      expect(sixth.ok).toBe(false);
      if (!sixth.ok) expect(sixth.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('club_get', () => {
    it('round-trips a freshly-created club', () => {
      const created = callClubCreate(env, LEADER);
      expect(created.ok).toBe(true);
      const res = callClubGet(env, LEADER, created.data!.clubId);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.club.name).toBe('Fast Lane');
      expect(res.data.club.emblemId).toBe('emblem_default');
      expect(res.data.club.region).toBe('us');
      expect(res.data.club.maxMembers).toBe(30);
      expect(res.data.club.open).toBe(true);
      expect(res.data.members).toHaveLength(1);
      expect(res.data.members[0].userId).toBe(LEADER);
      expect(res.data.members[0].isLeader).toBe(true);
    });

    it('NOT_FOUND on missing clubId', () => {
      const res = callClubGet(env, LEADER, 'no-such-club');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('NOT_FOUND');
    });

    it('BAD_REQUEST when clubId missing', () => {
      const res = call<Resp<ClubGetOutput>>(env, 'club_get', LEADER, {
        callerUserId: LEADER,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('club_search', () => {
    it('returns the just-created club via name prefix', () => {
      const created = callClubCreate(env, LEADER, { name: 'Phantom Racers' });
      expect(created.ok).toBe(true);
      const res = callClubSearch(env, LEADER, { name: 'Phantom' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.clubs.length).toBeGreaterThan(0);
      const hit = res.data.clubs.find((c) => c.clubId === created.data!.clubId);
      expect(hit).toBeDefined();
      expect(hit!.name).toBe('Phantom Racers');
    });

    it('region filter excludes mismatched clubs', () => {
      callClubCreate(env, LEADER, { name: 'Euro Squad', region: 'eu' });
      const res = callClubSearch(env, LEADER, { region: 'us' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // Only US clubs — and we created an EU one.
      expect(res.data.clubs.every((c) => c.region === 'us')).toBe(true);
    });

    it('empty list on no matches', () => {
      const res = callClubSearch(env, LEADER, { name: 'NoSuchPrefixZZZ' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.clubs).toEqual([]);
    });
  });
});

// ─── Helpers also exported so other suites can extend ────────────────────────

void FakeContext;
void FakeLogger;

// Pull in a small type-only assertion to keep `FakeNakama as importable`
// warnings quiet when other suites spread this file's helpers.
export type { FakeNakamaType };