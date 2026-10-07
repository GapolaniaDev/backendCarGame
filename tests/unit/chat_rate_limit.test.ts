// Phase 7 Chunk 6 — Chat rate limit (1/s, 20/min).

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeNakama, FakeLogger, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';
import type { INakama, ILogger } from '../../modules/src/nkruntime';
import {
  checkChatRateLimit,
  computeNextRateState,
  readChatRate,
  wouldReject,
  CHAT_RATE_LIMITS,
} from '../../modules/src/chat/rate_limit';
import {
  CHAT_RATE_PER_MINUTE_LIMIT,
  type ChatRateRecord,
} from '../../modules/src/chat/types';

const NOW = 1_700_000_000_000;

function freshRate(userId: string, tsLast: number, countWindow: number, windowStartTs: number): ChatRateRecord {
  return {
    schemaVersion: 1,
    userId,
    tsLast,
    countWindow,
    windowStartTs,
  };
}

describe('chat rate limit (Phase 7 Chunk 6)', () => {
  let fake: FakeNakamaType;
  let nk: INakama;
  let logger: ILogger;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
    logger = new FakeLogger();
  });

  it('first message is allowed', () => {
    const v = checkChatRateLimit(nk, logger, 'u1', NOW);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('ok');
  });

  it('second message within 1s is rejected (too_fast)', () => {
    checkChatRateLimit(nk, logger, 'u1', NOW);
    const v = checkChatRateLimit(nk, logger, 'u1', NOW + 500);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toBe('too_fast');
      expect(v.tsLast).toBe(NOW);
    }
  });

  it('message after >=1s is allowed', () => {
    checkChatRateLimit(nk, logger, 'u1', NOW);
    const v = checkChatRateLimit(nk, logger, 'u1', NOW + 1001);
    expect(v.allowed).toBe(true);
  });

  it('20 messages in the same minute are allowed; 21st is window_full', () => {
    // Spread at >1s intervals to dodge the too_fast rule.
    for (let i = 0; i < CHAT_RATE_PER_MINUTE_LIMIT; i++) {
      const v = checkChatRateLimit(nk, logger, 'u1', NOW + i * 1001);
      expect(v.allowed).toBe(true);
    }
    const v = checkChatRateLimit(nk, logger, 'u1', NOW + 20 * 1001);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toBe('window_full');
    }
  });

  it('after the minute window ends, sending again is allowed', () => {
    for (let i = 0; i < CHAT_RATE_PER_MINUTE_LIMIT; i++) {
      checkChatRateLimit(nk, logger, 'u1', NOW + i * 1001);
    }
    // First message of the next minute window (>=60_000ms after first).
    const v = checkChatRateLimit(nk, logger, 'u1', NOW + 60_000 + 1001);
    expect(v.allowed).toBe(true);
    if (v.allowed) {
      // countWindow restarted at 1
      expect(v.countWindow).toBe(1);
    }
  });

  it('computeNextRateState is pure', () => {
    expect(computeNextRateState(null, NOW)).toEqual({
      schemaVersion: 1,
      userId: '',
      tsLast: NOW,
      countWindow: 1,
      windowStartTs: NOW,
    });
    const prev = freshRate('u1', NOW - 2000, 5, NOW - 10_000);
    const next = computeNextRateState(prev, NOW);
    expect(next.countWindow).toBe(6);
    expect(next.windowStartTs).toBe(NOW - 10_000);
  });

  it('wouldReject flags the right reason without touching storage', () => {
    expect(wouldReject(null, NOW)).toBeNull();
    expect(wouldReject(freshRate('u', NOW - 500, 1, NOW - 500), NOW)).toBe('too_fast');
    expect(wouldReject(freshRate('u', NOW - 2000, 20, NOW - 30_000), NOW)).toBe('window_full');
    expect(wouldReject(freshRate('u', NOW - 2000, 19, NOW - 30_000), NOW)).toBeNull();
  });

  it('different users have independent rate buckets', () => {
    checkChatRateLimit(nk, logger, 'u1', NOW);
    // u2 is unaffected by u1's bucket.
    const v = checkChatRateLimit(nk, logger, 'u2', NOW + 100);
    expect(v.allowed).toBe(true);
  });

  it('exposes per-second + per-minute constants', () => {
    expect(CHAT_RATE_LIMITS.perSecond).toBe(1);
    expect(CHAT_RATE_LIMITS.perMinute).toBe(20);
    expect(CHAT_RATE_LIMITS.secondWindowMs).toBe(1000);
    expect(CHAT_RATE_LIMITS.minuteWindowMs).toBe(60_000);
  });

  it('readChatRate returns null for an absent user', () => {
    expect(readChatRate(nk, 'absent')).toBeNull();
  });
});