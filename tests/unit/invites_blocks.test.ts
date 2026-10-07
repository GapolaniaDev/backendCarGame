// Phase 7 Chunk 2 — Invites + Blocks unit tests.
//
// Covers:
//   1. Invite storage helpers: read/write/list/expire helpers
//   2. Invite CAS retry path
//   3. Invite lazy expire (isExpired pure helper)
//   4. Block storage helpers: read/write/list/isBlockedEitherWay
//   5. Block idempotency semantics
//   6. Hook stub checkChatSendBlock / checkGroupJoinBlock

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeNakama, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';
import {
  INVITES_COLLECTION,
  INVITE_TTL_MS,
  BLOCKS_COLLECTION,
  type InviteRecord,
  type InviteKind,
  type BlockRecord,
} from '../../modules/src/social/types';
import {
  readInvite,
  listInvitesFor,
  writeInviteCreate,
  writeInviteUpdate,
  isExpired,
  isTerminal,
  tryOnlinePush,
  MAX_CAS_RETRIES,
} from '../../modules/src/social/invites_repo';
import {
  readBlock,
  listBlocks,
  writeBlockCreate,
  deleteBlock,
  isBlockedEitherWay,
} from '../../modules/src/social/blocks_repo';
import {
  checkChatSendBlock,
} from '../../modules/src/chat/before_send';
import {
  checkGroupJoinBlock,
} from '../../modules/src/groups/before_join';
import type { ILogger } from '../../modules/src/nkruntime';

const NOW = 1_700_000_000_000;
const SENDER = 'user-sender';
const TARGET = 'user-target';
const BYSTANDER = 'user-bystander';

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

function makeInvite(overrides: Partial<InviteRecord> = {}): InviteRecord {
  return {
    schemaVersion: 1,
    inviteId: 'inv-1',
    fromUserId: SENDER,
    targetUserId: TARGET,
    kind: 'private_room',
    payload: { sessionId: 'sid-1' },
    createdAt: NOW,
    expiresAt: NOW + INVITE_TTL_MS,
    status: 'pending',
    ...overrides,
  };
}

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    schemaVersion: 1,
    ownerId: SENDER,
    targetUserId: TARGET,
    createdAt: NOW,
    ...overrides,
  };
}

describe('invites_repo (Phase 7 Chunk 2)', () => {
  let fake: FakeNakamaType;
  beforeEach(() => { fake = new FakeNakama(); });

  describe('readInvite / writeInviteCreate', () => {
    it('round-trips a fresh invite', () => {
      const rec = makeInvite();
      writeInviteCreate(fake.nakama, rec);
      const got = readInvite(fake.nakama, TARGET, rec.inviteId);
      expect(got).not.toBeNull();
      expect(got!.record.inviteId).toBe('inv-1');
      expect(got!.record.fromUserId).toBe(SENDER);
      expect(got!.record.targetUserId).toBe(TARGET);
    });

    it('returns null on absent invite', () => {
      const got = readInvite(fake.nakama, TARGET, 'nope');
      expect(got).toBeNull();
    });

    it('returns null on malformed value', () => {
      fake.store.set(
        `${INVITES_COLLECTION}/bad/${TARGET}`,
        {
          collection: INVITES_COLLECTION,
          key: 'bad',
          userId: TARGET,
          value: { schemaVersion: 99 },
          version: 'v00000001',
          permissionRead: 1,
          permissionWrite: 1,
          createTime: new Date().toISOString(),
          updateTime: new Date().toISOString(),
          expiresAt: null,
        },
      );
      const got = readInvite(fake.nakama, TARGET, 'bad');
      expect(got).toBeNull();
    });
  });

  describe('listInvitesFor', () => {
    it('lists every invite owned by the target', () => {
      writeInviteCreate(fake.nakama, makeInvite({ inviteId: 'a' }));
      writeInviteCreate(fake.nakama, makeInvite({ inviteId: 'b' }));
      const out = listInvitesFor(fake.nakama, TARGET);
      expect(out.map((r) => r.inviteId).sort()).toEqual(['a', 'b']);
    });
  });

  describe('CAS update via writeInviteUpdate', () => {
    it('updates status and bumps version', () => {
      writeInviteCreate(fake.nakama, makeInvite());
      const initial = readInvite(fake.nakama, TARGET, 'inv-1');
      const version = initial!.version;
      const next: InviteRecord = { ...initial!.record, status: 'accepted', respondedAt: NOW };
      const newVer = writeInviteUpdate(fake.nakama, next, version);
      expect(newVer).not.toBe(version);

      const reread = readInvite(fake.nakama, TARGET, 'inv-1');
      expect(reread!.record.status).toBe('accepted');
      expect(reread!.record.respondedAt).toBe(NOW);
    });

    it('MAX_CAS_RETRIES is locked to 3', () => {
      expect(MAX_CAS_RETRIES).toBe(3);
    });
  });

  describe('isExpired', () => {
    it('is false when pending and future', () => {
      expect(isExpired(makeInvite({ expiresAt: NOW + 1000 }), NOW)).toBe(false);
    });
    it('is true when pending and past', () => {
      expect(isExpired(makeInvite({ expiresAt: NOW - 1 }), NOW)).toBe(true);
    });
    it('is false when terminal regardless of expiresAt', () => {
      expect(isExpired(makeInvite({ status: 'accepted', expiresAt: NOW - 1 }), NOW)).toBe(false);
    });
  });

  describe('isTerminal', () => {
    it('true on accepted', () => {
      expect(isTerminal(makeInvite({ status: 'accepted' }))).toBe(true);
    });
    it('true on declined', () => {
      expect(isTerminal(makeInvite({ status: 'declined' }))).toBe(true);
    });
    it('false on pending', () => {
      expect(isTerminal(makeInvite({ status: 'pending' }))).toBe(false);
    });
    it('false on expired (lazy)', () => {
      expect(isTerminal(makeInvite({ status: 'expired' }))).toBe(false);
    });
  });

  describe('tryOnlinePush (stub)', () => {
    it('always returns false in Chunk 2', () => {
      expect(tryOnlinePush(fake.nakama, TARGET, 'inv-1')).toBe(false);
    });

    it('does not throw when nk has no sessionSend method', () => {
      expect(() => tryOnlinePush(fake.nakama, TARGET, 'inv-1')).not.toThrow();
    });
  });
});

describe('blocks_repo (Phase 7 Chunk 2)', () => {
  let fake: FakeNakamaType;
  beforeEach(() => { fake = new FakeNakama(); });

  it('round-trips a block row', () => {
    const rec = makeBlock();
    writeBlockCreate(fake.nakama, rec);
    const got = readBlock(fake.nakama, SENDER, TARGET);
    expect(got).not.toBeNull();
    expect(got!.record.ownerId).toBe(SENDER);
    expect(got!.record.targetUserId).toBe(TARGET);
  });

  it('returns null on absent', () => {
    expect(readBlock(fake.nakama, SENDER, TARGET)).toBeNull();
  });

  it('deleteBlock is idempotent (no throw on absent)', () => {
    expect(() => deleteBlock(fake.nakama, SENDER, 'never-blocked')).not.toThrow();
  });

  it('listBlocks returns every block owned by the caller', () => {
    writeBlockCreate(fake.nakama, makeBlock({ targetUserId: 'a' }));
    writeBlockCreate(fake.nakama, makeBlock({ targetUserId: 'b' }));
    const out = listBlocks(fake.nakama, SENDER);
    expect(out.map((b) => b.targetUserId).sort()).toEqual(['a', 'b']);
  });

  describe('isBlockedEitherWay', () => {
    it('false when neither side blocks', () => {
      expect(isBlockedEitherWay(fake.nakama, SENDER, TARGET)).toBe(false);
    });

    it('true when owner blocks target', () => {
      writeBlockCreate(fake.nakama, makeBlock());
      expect(isBlockedEitherWay(fake.nakama, SENDER, TARGET)).toBe(true);
    });

    it('true when target blocks owner (symmetric)', () => {
      writeBlockCreate(fake.nakama, makeBlock({
        ownerId: TARGET,
        targetUserId: SENDER,
      }));
      expect(isBlockedEitherWay(fake.nakama, SENDER, TARGET)).toBe(true);
    });

    it('false when checking the same user (no self-block via false negatives)', () => {
      expect(isBlockedEitherWay(fake.nakama, SENDER, SENDER)).toBe(false);
    });
  });
});

describe('chat/before_send (Phase 7 Chunk 2)', () => {
  let fake: FakeNakamaType;
  beforeEach(() => { fake = new FakeNakama(); });

  it('allowed when no block exists', () => {
    const out = checkChatSendBlock(fake.nakama, silentLogger(), SENDER, TARGET);
    expect(out.allowed).toBe(true);
    expect(out.reason).toBeNull();
  });

  it('forbidden when sender blocks recipient', () => {
    writeBlockCreate(fake.nakama, makeBlock());
    const out = checkChatSendBlock(fake.nakama, silentLogger(), SENDER, TARGET);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe('blocked');
  });

  it('forbidden when recipient blocks sender (symmetric)', () => {
    writeBlockCreate(fake.nakama, makeBlock({
      ownerId: TARGET,
      targetUserId: SENDER,
    }));
    const out = checkChatSendBlock(fake.nakama, silentLogger(), SENDER, TARGET);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe('blocked');
  });

  it('allowed when sender === recipient (self-DM short-circuit)', () => {
    const out = checkChatSendBlock(fake.nakama, silentLogger(), SENDER, SENDER);
    expect(out.allowed).toBe(true);
  });
});

describe('groups/before_join (Phase 7 Chunk 2)', () => {
  let fake: FakeNakamaType;
  beforeEach(() => { fake = new FakeNakama(); });

  it('allowed when no gatekeeper blocks the joiner', () => {
    const out = checkGroupJoinBlock(fake.nakama, silentLogger(), SENDER, [TARGET, BYSTANDER]);
    expect(out.allowed).toBe(true);
  });

  it('forbidden when any gatekeeper has blocked the joiner', () => {
    writeBlockCreate(fake.nakama, makeBlock({
      ownerId: BYSTANDER,
      targetUserId: SENDER,
    }));
    const out = checkGroupJoinBlock(fake.nakama, silentLogger(), SENDER, [TARGET, BYSTANDER]);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe('blocked');
  });

  it('ignores self-membership in gatekeeperIds', () => {
    // joiner IS a gatekeeper — should be skipped, not block themselves.
    const out = checkGroupJoinBlock(fake.nakama, silentLogger(), SENDER, [SENDER, TARGET]);
    expect(out.allowed).toBe(true);
  });
});