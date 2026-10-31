// Phase 7 Chunk 6 — Chat history storage helpers; plan T-22 numbered
// channels with a real cursor.

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeLogger, FakeNakama, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';
import {
  listChatMessages,
  parseChatCursor,
  writeChatMessageCreate,
} from '../../modules/src/chat/messages';
import {
  CHAT_HISTORY_COLLECTION,
  CHAT_HISTORY_TTL_MS,
  chatMessageKey,
  type ChatMessageRecord,
} from '../../modules/src/chat/types';

const NOW = 1_700_000_000_000;
const logger = new FakeLogger();
const CHANNEL = 'club:g-1';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

type NewMessage = Omit<ChatMessageRecord, 'schemaVersion' | 'expiresAt' | 'seq'> & { expiresAt?: number };

function mkMsg(overrides: Partial<NewMessage> & { messageId: string; createdAt: number; content: string }): NewMessage {
  return {
    messageId: overrides.messageId,
    channelId: overrides.channelId ?? CHANNEL,
    channelType: overrides.channelType ?? 'club',
    targetId: overrides.targetId ?? 'g-1',
    senderUserId: overrides.senderUserId ?? 'u1',
    senderName: overrides.senderName ?? 'u1',
    content: overrides.content,
    language: overrides.language ?? 'es',
    createdAt: overrides.createdAt,
    ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
  };
}

describe('chat messages storage (Phase 7 Chunk 6, plan T-22)', () => {
  let fake: FakeNakamaType;
  let nk: INakama;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
  });

  it('writeChatMessageCreate numbers the channel and sets the default TTL', () => {
    const a = writeChatMessageCreate(nk, mkMsg({ messageId: 'm1', createdAt: NOW, content: 'a' }), NOW);
    const b = writeChatMessageCreate(nk, mkMsg({ messageId: 'm2', createdAt: NOW, content: 'b' }), NOW);
    expect(a.message.seq).toBe(1);
    expect(b.message.seq).toBe(2);
    expect(a.expiresAt).toBe(NOW + CHAT_HISTORY_TTL_MS);
    expect(fake.store.has(`${CHAT_HISTORY_COLLECTION}/${chatMessageKey(CHANNEL, 2)}/${SYSTEM}`)).toBe(true);
  });

  it('channels are numbered independently', () => {
    writeChatMessageCreate(nk, mkMsg({ messageId: 'm1', createdAt: NOW, content: 'a' }), NOW);
    const other = writeChatMessageCreate(nk, mkMsg({ messageId: 'x1', channelId: 'club:g-2', targetId: 'g-2', createdAt: NOW, content: 'x' }), NOW);
    expect(other.message.seq).toBe(1);
    expect(listChatMessages(nk, 'club:g-2', {}, NOW, logger).messages.map((m) => m.content)).toEqual(['x']);
  });

  it('listChatMessages returns newest first, empty for an unknown channel', () => {
    for (const c of ['a', 'b', 'c']) writeChatMessageCreate(nk, mkMsg({ messageId: c, createdAt: NOW, content: c }), NOW);
    expect(listChatMessages(nk, CHANNEL, {}, NOW, logger).messages.map((m) => m.content)).toEqual(['c', 'b', 'a']);
    expect(listChatMessages(nk, 'club:none', {}, NOW, logger)).toEqual({ messages: [], nextCursor: '', expiredFiltered: 0 });
  });

  it('pages of 50 walk the whole history with the cursor (120 messages)', () => {
    for (let i = 1; i <= 120; i++) writeChatMessageCreate(nk, mkMsg({ messageId: `m${i}`, createdAt: NOW + i, content: `#${i}` }), NOW);
    const seen: string[] = [];
    let cursor = '';
    const sizes: number[] = [];
    for (let page = 0; page < 10; page++) {
      const r = listChatMessages(nk, CHANNEL, { limit: 50, cursor }, NOW + 200, logger);
      sizes.push(r.messages.length);
      seen.push(...r.messages.map((m) => m.content));
      if (r.nextCursor === '') break;
      cursor = r.nextCursor;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(seen[0]).toBe('#120');
    expect(seen[119]).toBe('#1');
    expect(new Set(seen).size).toBe(120);
  });

  it('the first expired message ends the history', () => {
    writeChatMessageCreate(nk, mkMsg({ messageId: 'old', createdAt: NOW - CHAT_HISTORY_TTL_MS - 10, content: 'old' }), NOW - CHAT_HISTORY_TTL_MS - 10);
    writeChatMessageCreate(nk, mkMsg({ messageId: 'new', createdAt: NOW, content: 'new' }), NOW);
    const r = listChatMessages(nk, CHANNEL, {}, NOW, logger);
    expect(r.messages.map((m) => m.content)).toEqual(['new']);
    expect(r.expiredFiltered).toBe(1);
    expect(r.nextCursor).toBe('');
  });

  it('a purged message is a gap the page skips', () => {
    for (const c of ['a', 'b', 'c']) writeChatMessageCreate(nk, mkMsg({ messageId: c, createdAt: NOW, content: c }), NOW);
    fake.store.delete(`${CHAT_HISTORY_COLLECTION}/${chatMessageKey(CHANNEL, 2)}/${SYSTEM}`);
    expect(listChatMessages(nk, CHANNEL, {}, NOW, logger).messages.map((m) => m.content)).toEqual(['c', 'a']);
  });

  it('hideSenders leaves out the blocked senders', () => {
    writeChatMessageCreate(nk, mkMsg({ messageId: 'a', senderUserId: 'u1', createdAt: NOW, content: 'a' }), NOW);
    writeChatMessageCreate(nk, mkMsg({ messageId: 'b', senderUserId: 'u2', createdAt: NOW, content: 'b' }), NOW);
    const r = listChatMessages(nk, CHANNEL, { hideSenders: new Set(['u2']) }, NOW, logger);
    expect(r.messages.map((m) => m.content)).toEqual(['a']);
  });

  it('a malformed cursor throws RangeError', () => {
    writeChatMessageCreate(nk, mkMsg({ messageId: 'a', createdAt: NOW, content: 'a' }), NOW);
    expect(() => listChatMessages(nk, CHANNEL, { cursor: 'abc' }, NOW, logger)).toThrow(RangeError);
    expect(parseChatCursor('0')).toBeNull();
    expect(parseChatCursor('17')).toBe(17);
  });

  it('cards carry ts (not createdAt) and the sender name', () => {
    writeChatMessageCreate(nk, mkMsg({ messageId: 'a', senderName: 'alice', createdAt: NOW, content: 'a' }), NOW);
    const card = listChatMessages(nk, CHANNEL, {}, NOW, logger).messages[0]!;
    expect(card.ts).toBe(NOW);
    expect(card.senderName).toBe('alice');
    expect((card as unknown as { createdAt?: number }).createdAt).toBeUndefined();
  });
});
