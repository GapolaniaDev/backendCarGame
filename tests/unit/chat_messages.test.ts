// Phase 7 Chunk 6 — Chat history storage helpers.

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeNakama, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';
import {
  listChatMessages,
  readChatMessage,
  writeChatMessageCreate,
} from '../../modules/src/chat/messages';
import {
  CHAT_HISTORY_TTL_MS,
  type ChatMessageRecord,
} from '../../modules/src/chat/types';

const NOW = 1_700_000_000_000;
const CHANNEL = 'club:g-1';

function mkMsg(
  overrides: Partial<ChatMessageRecord> & { messageId: string; senderUserId: string; createdAt: number; content: string },
): ChatMessageRecord {
  return {
    schemaVersion: 1,
    messageId: overrides.messageId,
    channelId: overrides.channelId ?? CHANNEL,
    channelType: overrides.channelType ?? 'club',
    targetId: overrides.targetId ?? 'g-1',
    senderUserId: overrides.senderUserId,
    senderName: overrides.senderName ?? overrides.senderUserId,
    content: overrides.content,
    language: overrides.language ?? 'es',
    createdAt: overrides.createdAt,
    expiresAt: overrides.expiresAt ?? (overrides.createdAt + CHAT_HISTORY_TTL_MS),
  };
}

describe('chat messages storage (Phase 7 Chunk 6)', () => {
  let fake: FakeNakamaType;
  let nk: INakama;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
  });

  it('writeChatMessageCreate inserts with default TTL = createdAt + 7d', () => {
    const w = writeChatMessageCreate(
      nk,
      mkMsg({ messageId: 'm1', senderUserId: 'u1', createdAt: NOW, content: 'hola' }),
      NOW,
    );
    expect(w.message.messageId).toBe('m1');
    expect(w.expiresAt).toBe(NOW + CHAT_HISTORY_TTL_MS);
    expect(w.message.expiresAt).toBe(NOW + CHAT_HISTORY_TTL_MS);
  });

  it('readChatMessage returns null for missing message', () => {
    expect(readChatMessage(nk, CHANNEL, 'absent', NOW)).toBeNull();
  });

  it('readChatMessage returns the message when present', () => {
    writeChatMessageCreate(
      nk,
      mkMsg({ messageId: 'm1', senderUserId: 'u1', createdAt: NOW, content: 'hola' }),
      NOW,
    );
    const r = readChatMessage(nk, CHANNEL, 'm1', NOW);
    expect(r).not.toBeNull();
    expect(r!.content).toBe('hola');
    expect(r!.senderUserId).toBe('u1');
  });

  it('readChatMessage returns null for expired messages (lazy TTL)', () => {
    writeChatMessageCreate(
      nk,
      mkMsg({
        messageId: 'm1',
        senderUserId: 'u1',
        createdAt: NOW - (CHAT_HISTORY_TTL_MS + 1000),
        content: 'old',
      }),
      NOW,
    );
    expect(readChatMessage(nk, CHANNEL, 'm1', NOW)).toBeNull();
  });

  it('listChatMessages returns newest first', () => {
    writeChatMessageCreate(
      nk,
      mkMsg({ messageId: 'm1', senderUserId: 'u1', createdAt: NOW - 2000, content: 'oldest' }),
      NOW,
    );
    writeChatMessageCreate(
      nk,
      mkMsg({ messageId: 'm2', senderUserId: 'u2', createdAt: NOW - 1000, content: 'middle' }),
      NOW,
    );
    writeChatMessageCreate(
      nk,
      mkMsg({ messageId: 'm3', senderUserId: 'u3', createdAt: NOW, content: 'newest' }),
      NOW,
    );
    const r = listChatMessages(nk, CHANNEL, {}, NOW);
    expect(r.messages.map((m) => m.messageId)).toEqual(['m3', 'm2', 'm1']);
    expect(r.messages[0].content).toBe('newest');
  });

  it('listChatMessages filters by channelId (no cross-channel leak)', () => {
    writeChatMessageCreate(
      nk,
      mkMsg({
        messageId: 'm1',
        senderUserId: 'u1',
        createdAt: NOW,
        content: 'in g-1',
        channelId: 'club:g-1',
        targetId: 'g-1',
      }),
      NOW,
    );
    writeChatMessageCreate(
      nk,
      mkMsg({
        messageId: 'm2',
        senderUserId: 'u2',
        createdAt: NOW,
        content: 'in g-2',
        channelId: 'club:g-2',
        targetId: 'g-2',
      }),
      NOW,
    );
    const r = listChatMessages(nk, 'club:g-1', {}, NOW);
    expect(r.messages.map((m) => m.messageId)).toEqual(['m1']);
    expect(r.messages[0].content).toBe('in g-1');
  });

  it('listChatMessages drops expired messages and reports the count', () => {
    writeChatMessageCreate(
      nk,
      mkMsg({ messageId: 'fresh', senderUserId: 'u1', createdAt: NOW, content: 'new' }),
      NOW,
    );
    writeChatMessageCreate(
      nk,
      mkMsg({
        messageId: 'stale',
        senderUserId: 'u1',
        createdAt: NOW - (CHAT_HISTORY_TTL_MS + 100),
        content: 'old',
      }),
      NOW,
    );
    const r = listChatMessages(nk, CHANNEL, {}, NOW);
    expect(r.messages.map((m) => m.messageId)).toEqual(['fresh']);
    expect(r.expiredFiltered).toBe(1);
  });

  it('listChatMessages respects the limit cap', () => {
    for (let i = 0; i < 5; i++) {
      writeChatMessageCreate(
        nk,
        mkMsg({
          messageId: `m${i}`,
          senderUserId: `u${i}`,
          createdAt: NOW - (5 - i) * 100,
          content: `msg ${i}`,
        }),
        NOW,
      );
    }
    const r = listChatMessages(nk, CHANNEL, { limit: 2 }, NOW);
    expect(r.messages.length).toBe(2);
    // Newest first
    expect(r.messages[0].messageId).toBe('m4');
    expect(r.messages[1].messageId).toBe('m3');
  });

  it('listChatMessages returns a card with ts (not createdAt)', () => {
    writeChatMessageCreate(
      nk,
      mkMsg({ messageId: 'm1', senderUserId: 'u1', createdAt: NOW, content: 'hello' }),
      NOW,
    );
    const r = listChatMessages(nk, CHANNEL, {}, NOW);
    expect(r.messages[0].ts).toBe(NOW);
  });
});