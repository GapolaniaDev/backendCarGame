// LevelPlay server-to-server reward callback: parsing and signature
// (plan T-25, P-04; audit PC-05).
//
// LevelPlay (Unity's ironSource mediation) calls the URL configured in its
// dashboard ("Set S2S callback") after each completed rewarded ad, with
// query parameters. Per its public documentation
// (docs.unity.com/grow/levelplay/platform/settings/event-handlers and
// …/server-to-server-callback):
//   - the user (`[USER_ID]`, the id the app passed to the SDK: here the
//     Nakama user id; sent URL-encoded), the reward amount
//     (`[REWARDS]`), a unique `[EVENT_ID]`, a `timestamp`
//     (`YYYYMMDDHHMM`) and a `signature`;
//   - signature = md5(timestamp + eventId + userId + rewards + privateKey),
//     lower-case hex, with the URL-DECODED user id and the "Private Key"
//     of the callback settings;
//   - the answer must be HTTP 200 with `<eventId>:OK` anywhere in the
//     body, or LevelPlay retries (20 times in 24 h, then daily for 7 days),
//     so each event must be paid at most once.
// The documented samples read `applicationUserId` (PHP) or `userId`
// (Java); `appUserId` is accepted too. Everything else (`itemName`,
// `placementName`, `adNetwork`, `custom_*`) is informational and not
// signed.
//
// Nakama hands the query string of an HTTP RPC to the module as
// `ctx.queryParams` (minus `http_key`); a POST body with the same fields
// as a JSON object is accepted too (tests, manual replays).

import type { INakama } from '../nkruntime';

export interface LevelPlayCallback {
  userId: string;
  eventId: string;
  /** As received: it is part of the signed string. */
  rewardsRaw: string;
  rewards: number;
  timestamp: string;
  signature: string;
  itemName?: string;
  placementName?: string;
  adNetwork?: string;
}

const USER_FIELDS = ['userId', 'applicationUserId', 'appUserId'] as const;

function firstValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v) && v.length > 0) return firstValue(v[0]);
  return undefined;
}

/** Field `name` from the query string, else from the JSON body object. */
function field(query: Record<string, unknown>, body: Record<string, unknown>, name: string): string | undefined {
  const q = firstValue(query[name]);
  if (q !== undefined && q.length > 0) return q;
  const b = firstValue(body[name]);
  return b !== undefined && b.length > 0 ? b : undefined;
}

export type ParseResult =
  | { ok: true; value: LevelPlayCallback }
  | { ok: false; reason: string };

export function parseLevelPlayCallback(
  queryParams: Record<string, string[]> | undefined,
  body: Record<string, unknown>,
): ParseResult {
  const query = (queryParams ?? {}) as Record<string, unknown>;
  let userId: string | undefined;
  for (const f of USER_FIELDS) {
    userId = field(query, body, f);
    if (userId !== undefined) break;
  }
  const eventId = field(query, body, 'eventId');
  const rewardsRaw = field(query, body, 'rewards');
  const timestamp = field(query, body, 'timestamp');
  const signature = field(query, body, 'signature');
  if (userId === undefined) return { ok: false, reason: 'userId is required' };
  if (eventId === undefined || !/^[A-Za-z0-9_-]{1,100}$/.test(eventId)) {
    return { ok: false, reason: 'eventId is required (alphanumeric)' };
  }
  if (rewardsRaw === undefined || !/^\d{1,9}$/.test(rewardsRaw)) {
    return { ok: false, reason: 'rewards must be a non-negative integer' };
  }
  if (timestamp === undefined) return { ok: false, reason: 'timestamp is required' };
  if (signature === undefined) return { ok: false, reason: 'signature is required' };
  const out: LevelPlayCallback = {
    userId, eventId, rewardsRaw, rewards: Number(rewardsRaw), timestamp, signature: signature.toLowerCase(),
  };
  const itemName = field(query, body, 'itemName');
  const placementName = field(query, body, 'placementName');
  const adNetwork = field(query, body, 'adNetwork');
  if (itemName !== undefined) out.itemName = itemName;
  if (placementName !== undefined) out.placementName = placementName;
  if (adNetwork !== undefined) out.adNetwork = adNetwork;
  return { ok: true, value: out };
}

/** The signature LevelPlay sends for `cb` with `privateKey`. */
export function levelPlaySignature(nk: INakama, cb: LevelPlayCallback, privateKey: string): string {
  return nk.md5Hash(`${cb.timestamp}${cb.eventId}${cb.userId}${cb.rewardsRaw}${privateKey}`).toLowerCase();
}

/** Same-length comparison that does not stop at the first difference. */
export function signaturesMatch(expected: string, received: string): boolean {
  if (expected.length !== received.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}
