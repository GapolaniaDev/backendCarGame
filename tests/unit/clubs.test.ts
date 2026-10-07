// Phase 7 Chunk 3 — Clubs unit tests.
//
// Covers:
//   1. emblemas catalog: validate, load, getEmblema, getEmblemas
//   2. clubs_repo: readClubMetadata (storageRead + storageList fallback),
//      readClubCreated, writeClubMetadataCreate/Update, writeClubCreated,
//      buildClubView, buildMemberView, isDivisionAtOrAbove,
//      checkClubJoinGate
//   3. RPC validators: validateClubName, validateClubMotto

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeNakama, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';
import {
  validateEmblemasCatalog,
  loadEmblemasCatalog,
  getEmblema,
  getEmblemas,
  _resetEmblemasCatalogForTests,
} from '../../modules/src/clubs/catalog';
import {
  readClubMetadata,
  readClubCreated,
  writeClubMetadataCreate,
  writeClubMetadataUpdate,
  writeClubCreated,
  buildClubView,
  buildMemberView,
  isDivisionAtOrAbove,
  checkClubJoinGate,
} from '../../modules/src/clubs/clubs_repo';
import {
  validateClubName,
  validateClubMotto,
} from '../../modules/src/clubs/rpcs';
import {
  CLUBS_METADATA_COLLECTION,
  type ClubMetadata,
} from '../../modules/src/clubs/types';
import type { ILogger } from '../../modules/src/nkruntime';

const NOW = 1_700_000_000_000;
const LEADER = 'user-leader';
const JOINER = 'user-joiner';
const NEUTRAL = 'user-neutral';

function silentLogger(): ILogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    withField: (() => silentLogger()) as unknown as ILogger['withField'],
    withFields: (() => silentLogger()) as unknown as ILogger['withFields'],
    getFields: (): Record<string, unknown> => ({}),
  };
}

function makeMeta(overrides: Partial<ClubMetadata> = {}): ClubMetadata {
  return {
    schemaVersion: 1,
    clubId: 'club-1',
    leaderId: LEADER,
    motto: 'Drive fast',
    emblemId: 'emblem_default',
    region: 'us',
    minDivision: 'bronce',
    weeklyPoints: 0,
    createdAt: NOW,
    ...overrides,
  };
}

const RAW_EMBLEMAS = [
  { id: 'emblem_default', name: 'Default', imageUrl: 'emblemas/default.png' },
  { id: 'emblem_racing', name: 'Racing', imageUrl: 'emblemas/racing.png' },
  { id: 'emblem_drift', name: 'Drift', imageUrl: 'emblemas/drift.png' },
];

describe('emblemas catalog (Phase 7 Chunk 3)', () => {
  beforeEach(() => { _resetEmblemasCatalogForTests(); });

  it('validateEmblemasCatalog accepts a well-formed array', () => {
    expect(() => validateEmblemasCatalog(RAW_EMBLEMAS)).not.toThrow();
  });

  it('validateEmblemasCatalog rejects non-array', () => {
    expect(() => validateEmblemasCatalog({ id: 'x' })).toThrow();
    expect(() => validateEmblemasCatalog(null)).toThrow();
  });

  it('validateEmblemasCatalog rejects entry missing id', () => {
    expect(() => validateEmblemasCatalog([
      { id: '', name: 'x', imageUrl: 'y' },
    ])).toThrow(/id/);
  });

  it('validateEmblemasCatalog rejects entry missing name', () => {
    expect(() => validateEmblemasCatalog([
      { id: 'a', name: '', imageUrl: 'y' },
    ])).toThrow(/name/);
  });

  it('validateEmblemasCatalog rejects entry missing imageUrl', () => {
    expect(() => validateEmblemasCatalog([
      { id: 'a', name: 'x', imageUrl: '' },
    ])).toThrow(/imageUrl/);
  });

  it('loadEmblemasCatalog caches the entries', () => {
    const logger = silentLogger();
    const loaded = loadEmblemasCatalog(logger, RAW_EMBLEMAS);
    expect(loaded).toHaveLength(3);
    expect(getEmblemas()).toHaveLength(3);
    expect(getEmblema('emblem_racing')).not.toBeNull();
    expect(getEmblema('emblem_racing')!.name).toBe('Racing');
    expect(getEmblema('emblem_missing')).toBeNull();
  });

  it('_resetEmblemasCatalogForTests clears the cache', () => {
    const logger = silentLogger();
    loadEmblemasCatalog(logger, RAW_EMBLEMAS);
    expect(getEmblemas()).toHaveLength(3);
    _resetEmblemasCatalogForTests();
    expect(getEmblemas()).toEqual([]);
    expect(getEmblema('emblem_racing')).toBeNull();
  });
});

describe('clubs_repo (Phase 7 Chunk 3)', () => {
  let fake: FakeNakamaType;
  beforeEach(() => {
    fake = new FakeNakama();
    _resetEmblemasCatalogForTests();
  });

  describe('writeClubMetadataCreate + readClubMetadata', () => {
    it('round-trips a fresh metadata row via storageRead', () => {
      const meta = makeMeta();
      writeClubMetadataCreate(fake.nakama, meta);
      const got = readClubMetadata(fake.nakama, meta.clubId);
      expect(got).not.toBeNull();
      expect(got!.record.leaderId).toBe(LEADER);
      expect(got!.record.motto).toBe('Drive fast');
      expect(got!.record.weeklyPoints).toBe(0);
      expect(got!.version.length).toBeGreaterThan(0);
    });

    it('readClubMetadata falls back to storageList when user-scoped read fails', () => {
      const meta = makeMeta();
      // Insert directly under a different owner (simulates leader loss /
      // restart). The stub's storageRead with `userId=clubId` will miss
      // since the row's userId is LEADER, not the club id.
      fake.store.set(`${CLUBS_METADATA_COLLECTION}/${meta.clubId}/${LEADER}`, {
        collection: CLUBS_METADATA_COLLECTION,
        key: meta.clubId,
        userId: LEADER,
        value: meta as unknown as Record<string, unknown>,
        version: 'v00000001',
        permissionRead: 2,
        permissionWrite: 1,
        createTime: new Date(0).toISOString(),
        updateTime: new Date(0).toISOString(),
        expiresAt: null,
      });
      const got = readClubMetadata(fake.nakama, meta.clubId);
      expect(got).not.toBeNull();
      expect(got!.record.leaderId).toBe(LEADER);
    });

    it('readClubMetadata returns null on absent', () => {
      const got = readClubMetadata(fake.nakama, 'no-such-club');
      expect(got).toBeNull();
    });
  });

  describe('writeClubMetadataUpdate (CAS)', () => {
    it('succeeds when version matches', () => {
      const meta = makeMeta();
      const v1 = writeClubMetadataCreate(fake.nakama, meta);
      const updated = { ...meta, motto: 'New motto' };
      const v2 = writeClubMetadataUpdate(fake.nakama, updated, v1);
      expect(v2.length).toBeGreaterThan(0);
      expect(v2).not.toBe(v1);
      const got = readClubMetadata(fake.nakama, meta.clubId);
      expect(got!.record.motto).toBe('New motto');
    });
  });

  describe('writeClubCreated + readClubCreated', () => {
    it('round-trips a lifetime counter', () => {
      const rec = {
        schemaVersion: 1 as const,
        userId: LEADER,
        clubId: 'club-1',
        createdAt: NOW,
      };
      writeClubCreated(fake.nakama, rec);
      const got = readClubCreated(fake.nakama, LEADER);
      expect(got).not.toBeNull();
      expect(got!.record.clubId).toBe('club-1');
      expect(got!.record.createdAt).toBe(NOW);
    });

    it('readClubCreated returns null on absent', () => {
      expect(readClubCreated(fake.nakama, 'unknown')).toBeNull();
    });
  });

  describe('buildClubView', () => {
    it('composes the public view from a Nakama group + metadata', () => {
      const meta = makeMeta();
      const group = {
        groupId: meta.clubId,
        creatorUserId: meta.leaderId,
        name: 'Fast Lane',
        description: meta.motto,
        metadata: { emblemId: meta.emblemId, region: meta.region },
        maxCount: 30,
        open: true,
      };
      const view = buildClubView(group, meta, 7);
      expect(view.clubId).toBe('club-1');
      expect(view.name).toBe('Fast Lane');
      expect(view.memberCount).toBe(7);
      expect(view.maxMembers).toBe(30);
      expect(view.open).toBe(true);
    });
  });

  describe('buildMemberView', () => {
    it('flags the leader and yields memberCount=1 for single-member input', () => {
      const members = buildMemberView([{ userId: LEADER }], LEADER);
      expect(members).toHaveLength(1);
      expect(members[0].isLeader).toBe(true);
      expect(members[0].userId).toBe(LEADER);
    });

    it('non-leader members have isLeader=false', () => {
      const members = buildMemberView(
        [{ userId: LEADER }, { userId: JOINER }],
        LEADER,
      );
      expect(members).toHaveLength(2);
      expect(members[0].isLeader).toBe(true);
      expect(members[1].isLeader).toBe(false);
    });

    it('empty members yields empty array', () => {
      expect(buildMemberView([], LEADER)).toEqual([]);
    });
  });

  describe('isDivisionAtOrAbove', () => {
    const cfg = { divisions: [
      { id: 'bronce' },
      { id: 'plata' },
      { id: 'oro' },
    ] };

    it('actual >= required when both known', () => {
      expect(isDivisionAtOrAbove('oro', 'bronce', cfg)).toBe(true);
      expect(isDivisionAtOrAbove('plata', 'plata', cfg)).toBe(true);
      expect(isDivisionAtOrAbove('bronce', 'plata', cfg)).toBe(false);
    });

    it('returns false on unknown division', () => {
      expect(isDivisionAtOrAbove('unknown', 'bronce', cfg)).toBe(false);
      expect(isDivisionAtOrAbove('bronce', 'unknown', cfg)).toBe(false);
    });
  });

  describe('checkClubJoinGate', () => {
    it('allows when minDivision=bronce (default) and no block', () => {
      const meta = makeMeta({ minDivision: 'bronce' });
      const d = checkClubJoinGate(fake.nakama, silentLogger(), JOINER, meta);
      expect(d.allowed).toBe(true);
      expect(d.reason).toBeNull();
    });
  });
});

describe('club RPC validators (Phase 7 Chunk 3)', () => {
  describe('validateClubName', () => {
    it('accepts a normal name', () => {
      const r = validateClubName('Fast Lane');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('Fast Lane');
    });

    it('trims whitespace', () => {
      const r = validateClubName('  Fast Lane  ');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('Fast Lane');
    });

    it('rejects non-string', () => {
      const r = validateClubName(123);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('BAD_REQUEST');
    });

    it('rejects too short', () => {
      const r = validateClubName('ab');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/3\.\.32/);
    });

    it('rejects too long', () => {
      const r = validateClubName('x'.repeat(33));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/3\.\.32/);
    });

    it('rejects control chars', () => {
      const r = validateClubName('Bad\x00Name');
      expect(r.ok).toBe(false);
    });

    it('rejects blocked words', () => {
      const r = validateClubName('Admin Club');
      expect(r.ok).toBe(false);
    });
  });

  describe('validateClubMotto', () => {
    it('accepts a normal motto', () => {
      const r = validateClubMotto('Speed Forever');
      expect(r.ok).toBe(true);
    });

    it('rejects too short', () => {
      const r = validateClubMotto('ab');
      expect(r.ok).toBe(false);
    });

    it('rejects too long', () => {
      const r = validateClubMotto('x'.repeat(25));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/3\.\.24/);
    });

    it('rejects blocked words', () => {
      const r = validateClubMotto('best support');
      expect(r.ok).toBe(false);
    });
  });
});

// ─── Make NEUTRAL available for future block tests (silence unused-var) ────
void NEUTRAL;