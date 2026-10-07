// Phase 7 Chunk 6 — Chat-specific rate limit.
//
// Two layered checks:
//   1. 1 message per second per user   (token-bucket-like, single slot)
//   2. 20 messages per minute per user (sliding window via counter)
//
// Stored at `chat_rate/{userId}` = { schemaVersion, tsLast, countWindow,
// windowStartTs }. The per-second check uses `tsLast`; the per-minute
// check uses (windowStartTs, countWindow). Server-only writes
// (Write=0) so a tampered client cannot reset their own counter.
//
// The 1/s check rejects BEFORE incrementing the counter — a too-fast
// send attempt costs the user nothing in the minute budget. The 20/min
// check rejects BEFORE incrementing — a window-full attempt is a no-op
// (the bucket stays at 20; legitimate senders retry on the next
// window).
//
// Concurrent senders are handled by a 3-attempt CAS-retry loop: each
// retry re-evaluates the limits against fresh state.

import type { ILogger, INakama } from '../nkruntime';
import {
  CHAT_RATE_MINUTE_WINDOW_MS,
  CHAT_RATE_PER_MINUTE_LIMIT,
  CHAT_RATE_PER_SECOND_LIMIT,
  CHAT_RATE_SECOND_WINDOW_MS,
  asChatRateWrite,
  type ChatRateRecord,
} from './types';

export const MAX_CAS_RETRIES = 3;

// ─── Read / write helpers ────────────────────────────────────────────────────

export interface ChatRateReadResult {
  record: ChatRateRecord;
  version: string;
}

/**
 * Read the rate-limit row for `userId`. Returns `null` when absent.
 */
export function readChatRate(
  nk: INakama,
  userId: string,
): ChatRateReadResult | null {
  const objs = nk.storageRead([
    { collection: 'chat_rate', key: userId, userId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const value = obj.value as Partial<ChatRateRecord>;
  if (
    !value || typeof value !== 'object' || value.schemaVersion !== 1 ||
    typeof value.userId !== 'string' ||
    typeof value.tsLast !== 'number' ||
    typeof value.countWindow !== 'number' ||
    typeof value.windowStartTs !== 'number'
  ) {
    return null;
  }
  return { record: value as ChatRateRecord, version: obj.version ?? '' };
}

export function writeChatRateCreate(
  nk: INakama,
  record: ChatRateRecord,
): string {
  const acks = nk.storageWrite([asChatRateWrite(record)]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

export function writeChatRateUpdate(
  nk: INakama,
  record: ChatRateRecord,
  version: string,
): string {
  const obj = { ...asChatRateWrite(record), version };
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

// ─── Verdict shape ──────────────────────────────────────────────────────────

export type ChatRateVerdict =
  | { allowed: true; reason: 'ok'; tsLast: number; countWindow: number }
  | {
      allowed: false;
      reason: 'too_fast' | 'window_full' | 'cas_failed';
      tsLast: number | null;
      countWindow: number | null;
    };

/**
 * Check + consume one slot of the chat rate budget for `userId`. On
 * allow, the storage row is committed (with CAS retries). On reject,
 * storage is untouched.
 *
 * `nowMs` is injectable so tests can advance the clock deterministically.
 */
export function checkChatRateLimit(
  nk: INakama,
  logger: ILogger,
  userId: string,
  nowMs: number,
): ChatRateVerdict {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const fresh = readChatRate(nk, userId);

    // ── 1/s check ──
    if (fresh !== null && nowMs - fresh.record.tsLast < CHAT_RATE_SECOND_WINDOW_MS) {
      return {
        allowed: false,
        reason: 'too_fast',
        tsLast: fresh.record.tsLast,
        countWindow: fresh.record.countWindow,
      };
    }

    // ── 20/min check ──
    const inSameWindow = fresh !== null
      && nowMs - fresh.record.windowStartTs < CHAT_RATE_MINUTE_WINDOW_MS;
    if (inSameWindow && fresh!.record.countWindow >= CHAT_RATE_PER_MINUTE_LIMIT) {
      return {
        allowed: false,
        reason: 'window_full',
        tsLast: fresh!.record.tsLast,
        countWindow: fresh!.record.countWindow,
      };
    }

    // ── Compute next state + CAS write ──
    const windowStartTs = inSameWindow ? fresh!.record.windowStartTs : nowMs;
    const countWindow = inSameWindow ? fresh!.record.countWindow + 1 : 1;
    const next: ChatRateRecord = {
      schemaVersion: 1,
      userId,
      tsLast: nowMs,
      countWindow,
      windowStartTs,
    };

    try {
      if (fresh === null) {
        writeChatRateCreate(nk, next);
      } else {
        writeChatRateUpdate(nk, next, fresh.version);
      }
      return { allowed: true, reason: 'ok', tsLast: nowMs, countWindow };
    } catch (e) {
      logger.warn(
        'chat rate CAS conflict attempt=%d: %s',
        attempt + 1,
        e instanceof Error ? e.message : String(e),
      );
      if (attempt === MAX_CAS_RETRIES - 1) {
        return {
          allowed: false,
          reason: 'cas_failed',
          tsLast: fresh?.record.tsLast ?? null,
          countWindow: fresh?.record.countWindow ?? null,
        };
      }
    }
  }
  // Loop always returns — but the type system needs a return path.
  return {
    allowed: false,
    reason: 'cas_failed',
    tsLast: null,
    countWindow: null,
  };
}

// ─── Pure compute helpers (exposed for unit tests) ──────────────────────────

/**
 * Pure: given a previous record (or null) and `nowMs`, compute the
 * next state. Mirrors the loop body above without I/O.
 */
export function computeNextRateState(
  prev: ChatRateRecord | null,
  nowMs: number,
): ChatRateRecord {
  const inSameWindow = prev !== null
    && nowMs - prev.windowStartTs < CHAT_RATE_MINUTE_WINDOW_MS;
  const windowStartTs = inSameWindow ? prev!.windowStartTs : nowMs;
  const countWindow = inSameWindow ? prev!.countWindow + 1 : 1;
  return {
    schemaVersion: 1,
    userId: prev?.userId ?? '',
    tsLast: nowMs,
    countWindow,
    windowStartTs,
  };
}

/** Convenience for diagnostics: which limit would reject at `nowMs`. */
export function wouldReject(
  prev: ChatRateRecord | null,
  nowMs: number,
): null | 'too_fast' | 'window_full' {
  if (prev !== null && nowMs - prev.tsLast < CHAT_RATE_SECOND_WINDOW_MS) {
    return 'too_fast';
  }
  const inSameWindow = prev !== null
    && nowMs - prev.windowStartTs < CHAT_RATE_MINUTE_WINDOW_MS;
  if (inSameWindow && prev!.countWindow >= CHAT_RATE_PER_MINUTE_LIMIT) {
    return 'window_full';
  }
  return null;
}

// Reference the per-second limit so it's exported (used in tests / docs).
export const CHAT_RATE_LIMITS = {
  perSecond: CHAT_RATE_PER_SECOND_LIMIT,
  perMinute: CHAT_RATE_PER_MINUTE_LIMIT,
  secondWindowMs: CHAT_RATE_SECOND_WINDOW_MS,
  minuteWindowMs: CHAT_RATE_MINUTE_WINDOW_MS,
} as const;