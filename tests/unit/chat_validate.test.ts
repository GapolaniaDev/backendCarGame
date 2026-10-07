// Phase 7 Chunk 6 — validateChatSend synchronous helper.
//
// Drives the validator directly against a fresh FakeNakama with seeded
// club membership / friend edges / silenced rows. No bundle is loaded
// — these tests pin the per-step behaviour of the spec's before_send
// checklist.

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeNakama, FakeLogger, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';
import type { INakama, ILogger } from '../../modules/src/nkruntime';
import {
  _resetBlockedWordsForTests,
  loadBlockedWordsCatalog,
} from '../../modules/src/chat/blocked_words';
import { validateChatSend } from '../../modules/src/chat/rpcs';
import { CLUBS_MEMBERS_COLLECTION } from '../../modules/src/clubs/members_repo';
import { FRIENDS_EDGE_COLLECTION, type FriendEdgeRecord } from '../../modules/src/social/types';
import { CHAT_MAX_CONTENT_LEN, type SilencedRecord } from '../../modules/src/chat/types';
import { silenceUser } from '../../modules/src/chat/silenced';

const NOW = 1_700_000_000_000;

function seedCatalog(logger: ILogger): void {
  _resetBlockedWordsForTests();
  loadBlockedWordsCatalog(logger, {
    version: 1,
    blocked: { es: ['idiota'], en: ['idiot'], pt: [] },
  });
}

function seedMember(fake: FakeNakamaType, clubId: string, userId: string): void {
  fake.store.set(`${CLUBS_MEMBERS_COLLECTION}/${clubId}/${userId}`, {
    collection: CLUBS_MEMBERS_COLLECTION,
    key: clubId,
    userId,
    value: {
      schemaVersion: 1, clubId, userId, role: 'member',
      joinedAt: 1_700_000_000_000, weeklyContribution: 0,
    },
    version: 'v00000001',
    permissionRead: 1, permissionWrite: 1,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

function seedFriendEdge(fake: FakeNakamaType, ownerId: string, friendId: string): void {
  const rec: FriendEdgeRecord = {
    schemaVersion: 1,
    userId: ownerId,
    friendId,
    friendCode: 'ABCDEFGH',
    since: 1_700_000_000_000,
  };
  fake.store.set(`${FRIENDS_EDGE_COLLECTION}/${friendId}/${ownerId}`, {
    collection: FRIENDS_EDGE_COLLECTION,
    key: friendId,
    userId: ownerId,
    value: rec as unknown as Record<string, unknown>,
    version: 'v00000001',
    permissionRead: 1, permissionWrite: 1,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

describe('validateChatSend (Phase 7 Chunk 6)', () => {
  let fake: FakeNakamaType;
  let nk: INakama;
  let logger: ILogger;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
    logger = new FakeLogger();
    seedCatalog(logger);
  });

  // ── Content / language ────────────────────────────────────────────────

  it('content >200 returns BAD_REQUEST', () => {
    seedMember(fake, 'g1', 'u1');
    const long = 'x'.repeat(CHAT_MAX_CONTENT_LEN + 1);
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'club', targetId: 'g1', language: 'es', content: long,
    }, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('BAD_REQUEST');
      expect(v.message).toMatch(/too long/);
      expect((v.details as { length: number }).length).toBe(CHAT_MAX_CONTENT_LEN + 1);
    }
  });

  it('missing language returns BAD_REQUEST', () => {
    seedMember(fake, 'g1', 'u1');
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'club', targetId: 'g1',
      language: 'fr' as unknown as 'es', content: 'hola',
    }, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('BAD_REQUEST');
  });

  it('blocked word (es) returns FORBIDDEN', () => {
    seedMember(fake, 'g1', 'u1');
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'club', targetId: 'g1', language: 'es', content: 'eres un IDIOTA',
    }, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('FORBIDDEN');
  });

  it('blocked word (en) returns FORBIDDEN', () => {
    seedMember(fake, 'g1', 'u1');
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'club', targetId: 'g1', language: 'en', content: 'id1ot',
    }, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('FORBIDDEN');
  });

  // ── Silenced ───────────────────────────────────────────────────────────

  it('silenced user gets FORBIDDEN with untilUtc in details', () => {
    seedMember(fake, 'g1', 'u1');
    const until = silenceUser(nk, 'u1', 'auto', 60_000, NOW);
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'club', targetId: 'g1', language: 'es', content: 'hola',
    }, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('FORBIDDEN');
      expect((v.details as { untilUtc: number }).untilUtc).toBe(until);
      expect((v.details as { reason: string }).reason).toBe('auto');
    }
  });

  it('silence that has expired does NOT block', () => {
    seedMember(fake, 'g1', 'u1');
    // Silence them for a window that's already over.
    const row: SilencedRecord = {
      schemaVersion: 1,
      userId: 'u1',
      untilUtc: NOW - 1000,
      reason: 'auto',
      createdAt: NOW - 5000,
    };
    fake.store.set(`silenced/u1/u1`, {
      collection: 'silenced', key: 'u1', userId: 'u1',
      value: row as unknown as Record<string, unknown>,
      version: 'v00000001',
      permissionRead: 1, permissionWrite: 0,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    });
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'club', targetId: 'g1', language: 'es', content: 'hola',
    }, NOW);
    expect(v.ok).toBe(true);
  });

  // ── Channel access ─────────────────────────────────────────────────────

  it('club channel — non-member returns FORBIDDEN', () => {
    // No membership seeded.
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'club', targetId: 'g1', language: 'es', content: 'hola',
    }, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('FORBIDDEN');
  });

  it('club channel — happy path resolves channelId', () => {
    seedMember(fake, 'g1', 'u1');
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'club', targetId: 'g1', language: 'es', content: 'hola',
    }, NOW);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.channelId).toBe('club:g1');
  });

  it('direct channel — not friend returns FORBIDDEN', () => {
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'direct', targetId: 'u2', language: 'es', content: 'hola',
    }, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('FORBIDDEN');
  });

  it('direct channel — happy path resolves channelId symmetrically', () => {
    seedFriendEdge(fake, 'u1', 'u2');
    seedFriendEdge(fake, 'u2', 'u1');
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'direct', targetId: 'u2', language: 'es', content: 'hola',
    }, NOW);
    expect(v.ok).toBe(true);
    if (v.ok) {
      const [a, b] = ['u1', 'u2'].sort();
      expect(v.channelId).toBe(`direct:${a}:${b}`);
    }
  });

  it('direct channel — self-chat returns BAD_REQUEST', () => {
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'direct', targetId: 'u1', language: 'es', content: 'hola',
    }, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('BAD_REQUEST');
  });

  it('direct channel — only one side of the edge is enough (caller→peer)', () => {
    // Caller has the edge; peer's edge is missing. Call should still pass.
    seedFriendEdge(fake, 'u1', 'u2');
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'direct', targetId: 'u2', language: 'es', content: 'hola',
    }, NOW);
    expect(v.ok).toBe(true);
  });

  // ── Rate limit ─────────────────────────────────────────────────────────

  it('too_fast rejection happens BEFORE content validation', () => {
    seedMember(fake, 'g1', 'u1');
    validateChatSend(nk, logger, 'u1', {
      channelType: 'club', targetId: 'g1', language: 'es', content: 'primero',
    }, NOW);
    const v = validateChatSend(nk, logger, 'u1', {
      channelType: 'club', targetId: 'g1', language: 'es',
      // Even a 300-char blocked-word message is rejected as too_fast,
      // because the rate check is the FIRST step.
      content: 'x'.repeat(300),
    }, NOW + 100);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('RATE_LIMITED');
  });
});