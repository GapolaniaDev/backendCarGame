// Phase 3 wallet helpers. All wallet movement in the runtime flows
// through this module — RPC handlers, the RaceCompleted subscriber, and
// future purchase flows must call `grant` / `spend` instead of touching
// `nk.walletUpdate` directly. Centralising the helpers lets us:
//
//   - keep the idempotency key construction in one place
//   - enforce the compact `motivo:idOrigen` metadata format (≤200 bytes)
//   - surface `INSUFFICIENT_FUNDS` as a domain Err instead of an
//     opaque Nakama runtime error
//
// The wallet itself is Nakama-native (`coins`, `gems`); we never keep
// balances in our own storage.

import type { INakama } from '../nkruntime';
import { err, ok, type Err, type Resp } from '../core/response';
import type {
  LedgerMetadata,
  LedgerReason,
  WalletChangeset,
  WalletView,
} from './types';

/** Maximum byte size of a packed metadata payload sent to Nakama. */
export const LEDGER_METADATA_MAX_BYTES = 200;

/** Idempotency cache TTL for grant/spend (7 days in seconds). */
export const WALLET_IDEMPOTENCY_TTL_SEC = 7 * 24 * 60 * 60;

/** Prefix for the localcache idempotency key namespace. */
export const WALLET_IDEMPOTENCY_PREFIX = 'wallet:idemp';

/**
 * Minimal subset of the account payload we care about. `nk.accountGetId`
 * returns a richer object; we project only what `walletGet` needs.
 */
interface AccountLike {
  wallet?: Record<string, number>;
}

/**
 * Pack a `LedgerMetadata` into the compact `motivo:idOrigen` form
 * decided for Phase 3 (Decision 8). Anything that doesn't fit in
 * `LEDGER_METADATA_MAX_BYTES` is rejected so a corrupt request never
 * reaches Nakama's storage layer.
 *
 * Extra fields (sessionId, confidence, mode) are appended after a `;`
 * separator when present, keeping the primary `reason:sourceId`
 * substring searchable in ops.
 */
export function formatLedgerMetadata(meta: LedgerMetadata): string {
  const head = `${meta.reason}:${meta.sourceId}`;
  const extras: string[] = [];
  if (meta.sessionId !== undefined) extras.push(`sessionId=${meta.sessionId}`);
  if (meta.confidence !== undefined) extras.push(`confidence=${meta.confidence}`);
  if (meta.mode !== undefined) extras.push(`mode=${meta.mode}`);
  const packed = extras.length === 0 ? head : `${head};${extras.join(',')}`;
  if (byteLength(packed) > LEDGER_METADATA_MAX_BYTES) {
    throw new Error(
      `ledger metadata exceeds ${LEDGER_METADATA_MAX_BYTES} bytes (${byteLength(packed)})`,
    );
  }
  return packed;
}

/**
 * Inverse of `formatLedgerMetadata`: split a packed string back into
 * its structured form. Used when reading the ledger back via
 * `nk.walletLedgerList`. Returns `null` if the input isn't shaped like
 * `reason:sourceId` — i.e. it was written by an older runtime.
 */
export function parseLedgerMetadata(packed: string): LedgerMetadata | null {
  const [head, rest] = packed.split(';', 2);
  if (head === undefined) return null;
  const colonIdx = head.indexOf(':');
  if (colonIdx <= 0) return null;
  const reason = head.slice(0, colonIdx);
  const sourceId = head.slice(colonIdx + 1);
  if (!isLedgerReason(reason)) return null;
  const out: LedgerMetadata = { reason, sourceId };
  if (rest === undefined) return out;
  for (const pair of rest.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    if (k === 'sessionId') out.sessionId = v;
    else if (k === 'confidence') {
      if (v === 'quorum' || v === 'client' || v === 'server') out.confidence = v;
    } else if (k === 'mode') {
      if (v === 'quick' || v === 'ranked' || v === 'private' || v === 'time_trial') {
        out.mode = v;
      }
    }
  }
  return out;
}

/**
 * Read the current `{ coins, gems }` view for a user. Returns zeros if
 * the wallet is empty / the user has never received any. Missing
 * currencies are coerced to 0 so callers don't need to null-check.
 */
export function walletGet(nk: INakama, userId: string): WalletView {
  const account = nk.accountGetId(userId) as AccountLike | null;
  const w = account?.wallet ?? {};
  const coinsRaw = w['coins'];
  const gemsRaw = w['gems'];
  return {
    coins: typeof coinsRaw === 'number' ? coinsRaw : 0,
    gems: typeof gemsRaw === 'number' ? gemsRaw : 0,
  };
}

/**
 * Add funds to the wallet. `changeset` values are POSITIVE amounts to
 * credit. Idempotent per (userId, idempotencyKey) for
 * `WALLET_IDEMPOTENCY_TTL_SEC` seconds, so a retried grant (or a
 * RaceCompleted subscriber that fires twice for the same session)
 * cannot double-credit.
 *
 * Returns the post-grant wallet view on success.
 */
export function grant(
  nk: INakama,
  userId: string,
  changeset: WalletChangeset,
  metadata: LedgerMetadata,
  idempotencyKey: string,
): Resp<WalletView> {
  const positive = sanitiseChangeset(changeset);
  if (positive === null) {
    return err('BAD_REQUEST', 'grant changeset must contain coins or gems');
  }
  for (const v of Object.values(positive)) {
    if (v <= 0) {
      return err('BAD_REQUEST', 'grant changeset values must be positive');
    }
    if (!Number.isInteger(v)) {
      return err('BAD_REQUEST', 'grant changeset values must be integers');
    }
  }

  if (claimIdempotencyKey(nk, userId, idempotencyKey)) {
    return ok(walletGet(nk, userId));
  }

  let packed: string;
  try {
    packed = formatLedgerMetadata(metadata);
  } catch (e) {
    return err('INTERNAL', (e as Error).message);
  }
  nk.walletUpdate(userId, positive);
  nk.walletLedgerUpdate(userId, positive, { reason: packed }, idempotencyKey);
  return ok(walletGet(nk, userId));
}

/**
 * Subtract funds from the wallet. `changeset` values are POSITIVE
 * amounts to subtract (the helper internally negates them before
 * calling `nk.walletUpdate`). Returns `INSUFFICIENT_FUNDS` if the
 * resulting balance would go negative for any currency.
 *
 * Idempotent on the same `(userId, idempotencyKey)` pair within the
 * 7-day TTL.
 */
export function spend(
  nk: INakama,
  userId: string,
  changeset: WalletChangeset,
  metadata: LedgerMetadata,
  idempotencyKey: string,
): Resp<WalletView> {
  const positive = sanitiseChangeset(changeset);
  if (positive === null) {
    return err('BAD_REQUEST', 'spend changeset must contain coins or gems');
  }
  for (const v of Object.values(positive)) {
    if (v <= 0) {
      return err('BAD_REQUEST', 'spend changeset values must be positive (helper negates internally)');
    }
    if (!Number.isInteger(v)) {
      return err('BAD_REQUEST', 'spend changeset values must be integers');
    }
  }

  // Pre-check: Nakama's JS wrapper returns just the updated map on
  // walletUpdate, so a negative-balance rejection would surface as an
  // opaque runtime error. Inspect the current balance first and reject
  // with a clean INSUFFICIENT_FUNDS envelope when the spend would
  // underflow.
  const current = walletGet(nk, userId);
  if (typeof positive.coins === 'number' && current.coins < positive.coins) {
    return err('INSUFFICIENT_FUNDS', 'not enough coins', { currency: 'coins', balance: current.coins });
  }
  if (typeof positive.gems === 'number' && current.gems < positive.gems) {
    return err('INSUFFICIENT_FUNDS', 'not enough gems', { currency: 'gems', balance: current.gems });
  }

  if (claimIdempotencyKey(nk, userId, idempotencyKey)) {
    return ok(walletGet(nk, userId));
  }

  const signed: Record<string, number> = {};
  for (const [k, v] of Object.entries(positive)) {
    signed[k] = -v;
  }

  let packed: string;
  try {
    packed = formatLedgerMetadata(metadata);
  } catch (e) {
    return err('INTERNAL', (e as Error).message);
  }
  nk.walletUpdate(userId, signed);
  nk.walletLedgerUpdate(userId, signed, { reason: packed }, idempotencyKey);
  return ok(walletGet(nk, userId));
}

/**
 * Write a wallet ledger entry WITHOUT changing any balance. Used by
 * subscribers that want to record an event (e.g. first-win-of-day
 * stamp) without affecting the spendable total.
 *
 * Idempotent on the same `(userId, idempotencyKey)` pair.
 */
export function applyLedger(
  nk: INakama,
  userId: string,
  metadata: LedgerMetadata,
  idempotencyKey: string,
): Resp<{ recorded: true }> {
  if (claimIdempotencyKey(nk, userId, idempotencyKey)) {
    return ok({ recorded: true });
  }
  let packed: string;
  try {
    packed = formatLedgerMetadata(metadata);
  } catch (e) {
    return err('INTERNAL', (e as Error).message);
  }
  // Empty changeset — Nakama accepts a zero-balance ledger entry as a
  // marker. We don't change anything.
  nk.walletLedgerUpdate(userId, {}, { reason: packed }, idempotencyKey);
  return ok({ recorded: true });
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Returns true if the (userId, key) was already claimed (caller should
 * skip the side effect). Returns false the first time the pair is seen
 * and records the claim.
 *
 * Backed by `nk.localcachePut` — per-process, resets on restart. That's
 * intentional: a restart should not leave grants half-applied.
 */
function claimIdempotencyKey(nk: INakama, userId: string, key: string): boolean {
  const cacheKey = `${WALLET_IDEMPOTENCY_PREFIX}:${userId}:${key}`;
  const seen = nk.localcacheGet<string>(cacheKey);
  if (seen !== null && seen !== '' && seen === '1') {
    return true;
  }
  nk.localcachePut(cacheKey, '1', WALLET_IDEMPOTENCY_TTL_SEC);
  return false;
}

function sanitiseChangeset(raw: WalletChangeset): Record<string, number> | null {
  if (raw === null || typeof raw !== 'object') return null;
  const out: Record<string, number> = {};
  if (typeof raw.coins === 'number') out['coins'] = raw.coins;
  if (typeof raw.gems === 'number') out['gems'] = raw.gems;
  return Object.keys(out).length === 0 ? null : out;
}

function isLedgerReason(value: string): value is LedgerReason {
  return (
    value === 'race' ||
    value === 'mission' ||
    value === 'store' ||
    value === 'level' ||
    value === 'admin'
  );
}

function byteLength(s: string): number {
  // JavaScript strings are UTF-16; Nakama expects UTF-8 byte length.
  // Approximate with the platform encoder, or fall back to char length.
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  return s.length;
}

// ─── Re-exports for tests / callers that want the typed Err shape ────────────

export type WalletErr = Err;