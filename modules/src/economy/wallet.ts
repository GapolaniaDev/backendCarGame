// Phase 3 wallet helpers. All wallet movement in the runtime flows
// through this module — RPC handlers, the RaceCompleted subscriber, and
// future purchase flows must call `grant` / `spend` / `moveWallet`
// instead of touching `nk.walletUpdate` directly. Centralising the
// helpers lets us:
//
//   - keep the idempotency key construction in one place
//   - enforce the compact `motivo:idOrigen` metadata format (<=200 bytes)
//   - surface `INSUFFICIENT_FUNDS` as a domain Err instead of an
//     opaque Nakama runtime error
//
// Every movement is ONE `nk.multiUpdate` (plan T-11, audit PC-11): the
// wallet update with its ledger row (`updateLedger`, metadata
// `{reason, idempotencyKey}`), the durable idempotency record of
// `core/idempotency.ts`, and any storage write the caller delivers with
// it (a garage, a pass record...). They commit or roll back together, so
// a failed delivery never keeps the money and a retry after a restart
// never charges or pays twice. (In 3.27 `nk.walletLedgerUpdate` only
// edits the metadata of an existing ledger row; called with a user id it
// failed with "sql: no rows in result set" after every grant, F0b.)
//
// The wallet itself is Nakama-native (`coins`, `gems`); we never keep
// balances in our own storage.

import type { IMultiUpdateResult, INakama, IStorageObject, IWalletUpdate } from '../nkruntime';
import { err, ok, type Err, type Resp } from '../core/response';
import { emit } from '../core/admin/analytics';
import {
  errorMessage,
  idempotencyWrite,
  isNegativeWallet,
  isVersionConflict,
  readIdempotency,
  type IdempotencyRecord,
  type StoredIdempotency,
} from '../core/idempotency';
import type {
  LedgerMetadata,
  LedgerReason,
  WalletChangeset,
  WalletView,
} from './types';
export type { WalletView } from './types';

/** Maximum byte size of a packed metadata payload sent to Nakama. */
export const LEDGER_METADATA_MAX_BYTES = 200;

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

/** One wallet update of a movement: signed deltas and their ledger reason. */
export interface WalletMove {
  /** Signed `{currencyId: amount}` deltas (negative spends). */
  changeset: Record<string, number>;
  metadata: LedgerMetadata;
}

export interface MoveOptions {
  /**
   * Storage writes committed in the same transaction as the movement
   * (their `version` is honoured: a lost CAS rolls the money back too).
   */
  extraWrites?: IStorageObject[];
  /** Stored with the idempotency record and returned on a replay. */
  result?: unknown;
}

export interface MoveOutcome {
  /** True when the key was already applied: nothing moved this time. */
  replayed: boolean;
  /** Balance after the movement (or the current one on a replay). */
  balance: WalletView;
  record: IdempotencyRecord;
}

/**
 * Apply `moves` to `userId`'s wallet exactly once per `key`, with their
 * ledger rows, the durable idempotency record and `opts.extraWrites`, in
 * one `nk.multiUpdate`.
 *
 *   - key already applied → `{ replayed: true }`, nothing moves;
 *   - key reverted (see `revert`) → applied again (CAS on the record);
 *   - a balance would go negative → `INSUFFICIENT_FUNDS`, nothing moves;
 *   - a concurrent movement with the same key won → replay;
 *   - an extra write lost its CAS → `CONFLICT` (`details.reason =
 *     'VERSION_CONFLICT'`), nothing moves: the caller may re-read and retry.
 *
 * Never throws: runtime failures come back as `INTERNAL`.
 */
export function moveWallet(
  nk: INakama,
  userId: string,
  key: string,
  moves: ReadonlyArray<WalletMove>,
  opts: MoveOptions = {},
): Resp<MoveOutcome> {
  if (typeof key !== 'string' || key.length === 0) {
    return err('INTERNAL', 'wallet movement without an idempotency key');
  }
  const updates: IWalletUpdate[] = [];
  for (const m of moves) {
    let packed: string;
    try {
      packed = formatLedgerMetadata(m.metadata);
    } catch (e) {
      return err('INTERNAL', errorMessage(e));
    }
    updates.push({ userId, changeset: { ...m.changeset }, metadata: { reason: packed, idempotencyKey: key } });
  }

  let existing: StoredIdempotency | null;
  try {
    existing = readIdempotency(nk, userId, key);
  } catch (e) {
    return err('INTERNAL', `idempotency read failed: ${errorMessage(e)}`);
  }
  if (existing !== null && existing.record.state === 'applied') {
    return ok({ replayed: true, balance: walletGet(nk, userId), record: existing.record });
  }

  // Routine short balances stop here: Nakama logs every failed
  // multiUpdate at error level. Under concurrency the transaction still
  // decides (two spends that both pass this check cannot both commit).
  const short = shortCurrency(walletGet(nk, userId), moves);
  if (short !== null) {
    return err('INSUFFICIENT_FUNDS', `not enough ${short.currency}`, short);
  }

  const record: IdempotencyRecord = {
    schemaVersion: 1,
    key,
    state: 'applied',
    changeset: netChangeset(moves),
    appliedAt: Date.now(),
    ...(opts.result !== undefined ? { result: opts.result } : {}),
  };
  const writes = [idempotencyWrite(nk, userId, record, existing?.version ?? null), ...(opts.extraWrites ?? [])];
  let acks: IMultiUpdateResult;
  try {
    acks = nk.multiUpdate(
      undefined,
      writes,
      undefined,
      updates.length > 0 ? updates : undefined,
      updates.length > 0 ? true : undefined,
    );
  } catch (e) {
    if (isNegativeWallet(e)) return insufficientFunds(nk, userId, record.changeset, e);
    if (isVersionConflict(e)) {
      const now = readIdempotency(nk, userId, key);
      if (now !== null && now.record.state === 'applied') {
        return ok({ replayed: true, balance: walletGet(nk, userId), record: now.record });
      }
      return err('CONFLICT', 'concurrent update; nothing was charged, please retry', { reason: 'VERSION_CONFLICT' });
    }
    return err('INTERNAL', `wallet movement failed: ${errorMessage(e)}`);
  }
  return ok({ replayed: false, balance: balanceAfter(nk, userId, acks), record });
}

/**
 * Add funds to the wallet. `changeset` values are POSITIVE amounts to
 * credit. Idempotent per (userId, idempotencyKey), durably: a retried
 * grant (or a RaceCompleted subscriber that fires twice for the same
 * session) cannot double-credit, also after a restart.
 *
 * Returns the post-grant wallet view on success.
 */
export function grant(
  nk: INakama,
  userId: string,
  changeset: WalletChangeset,
  metadata: LedgerMetadata,
  idempotencyKey: string,
  opts: MoveOptions = {},
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

  const moved = moveWallet(nk, userId, idempotencyKey, [{ changeset: positive, metadata }], opts);
  if (!moved.ok) return moved;
  if (!moved.data.replayed) {
    emit(nk, undefined, 'wallet_moved', {
      userId,
      kind: 'grant',
      changeset: { ...positive },
      reason: safeReason(metadata),
      newBalance: moved.data.balance,
    });
  }
  return ok(moved.data.balance);
}

/**
 * Subtract funds from the wallet. `changeset` values are POSITIVE
 * amounts to subtract (the helper negates them). Returns
 * `INSUFFICIENT_FUNDS` if the resulting balance would go negative for
 * any currency — checked by the wallet transaction itself, so two
 * concurrent spends cannot both pass.
 *
 * Idempotent on the same `(userId, idempotencyKey)` pair, durably.
 */
export function spend(
  nk: INakama,
  userId: string,
  changeset: WalletChangeset,
  metadata: LedgerMetadata,
  idempotencyKey: string,
  opts: MoveOptions = {},
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

  const signed: Record<string, number> = {};
  for (const [k, v] of Object.entries(positive)) {
    signed[k] = -v;
  }
  const moved = moveWallet(nk, userId, idempotencyKey, [{ changeset: signed, metadata }], opts);
  if (!moved.ok) return moved;
  if (!moved.data.replayed) {
    emit(nk, undefined, 'wallet_moved', {
      userId,
      kind: 'spend',
      changeset: { ...signed },
      reason: safeReason(metadata),
      newBalance: moved.data.balance,
    });
  }
  return ok(moved.data.balance);
}

/**
 * Write a wallet ledger entry WITHOUT changing any balance (an empty
 * changeset). Used by subscribers that want to record an event (e.g.
 * first-win-of-day stamp) without affecting the spendable total.
 *
 * Idempotent on the same `(userId, idempotencyKey)` pair.
 */
export function applyLedger(
  nk: INakama,
  userId: string,
  metadata: LedgerMetadata,
  idempotencyKey: string,
): Resp<{ recorded: true }> {
  const moved = moveWallet(nk, userId, idempotencyKey, [{ changeset: {}, metadata }]);
  if (!moved.ok) return moved;
  return ok({ recorded: true });
}

/**
 * Compensating movement: undo what `idempotencyKey` applied (the inverse
 * of its recorded net changeset, with its own ledger row) and mark the
 * record `reverted` in the same transaction, so a later movement with the
 * same key applies again — a purchase retried after a refund charges
 * (HT-73, audit 05 f11). For flows whose delivery cannot share the
 * movement's transaction; deliveries that are storage writes go in
 * `MoveOptions.extraWrites` instead and need no refund.
 *
 * `reverted: false` when there was nothing to undo (unknown key or
 * already reverted). `INSUFFICIENT_FUNDS` when the player already spent
 * what the movement credited.
 */
export function revert(
  nk: INakama,
  userId: string,
  idempotencyKey: string,
  metadata: LedgerMetadata,
): Resp<{ reverted: boolean; balance: WalletView }> {
  let packed: string;
  try {
    packed = formatLedgerMetadata(metadata);
  } catch (e) {
    return err('INTERNAL', errorMessage(e));
  }
  const cur = readIdempotency(nk, userId, idempotencyKey);
  if (cur === null || cur.record.state !== 'applied') {
    return ok({ reverted: false, balance: walletGet(nk, userId) });
  }
  const inverse: Record<string, number> = {};
  for (const [k, v] of Object.entries(cur.record.changeset)) {
    if (v !== 0) inverse[k] = -v;
  }
  const record: IdempotencyRecord = { ...cur.record, state: 'reverted', revertedAt: Date.now() };
  const updates: IWalletUpdate[] = Object.keys(inverse).length > 0
    ? [{ userId, changeset: inverse, metadata: { reason: packed, idempotencyKey, revert: true } }]
    : [];
  let acks: IMultiUpdateResult;
  try {
    acks = nk.multiUpdate(
      undefined,
      [idempotencyWrite(nk, userId, record, cur.version)],
      undefined,
      updates.length > 0 ? updates : undefined,
      updates.length > 0 ? true : undefined,
    );
  } catch (e) {
    if (isNegativeWallet(e)) return insufficientFunds(nk, userId, inverse, e);
    if (isVersionConflict(e)) {
      const now = readIdempotency(nk, userId, idempotencyKey);
      if (now !== null && now.record.state === 'reverted') {
        return ok({ reverted: false, balance: walletGet(nk, userId) });
      }
      return err('CONFLICT', 'concurrent update of the movement being reverted', { reason: 'VERSION_CONFLICT' });
    }
    return err('INTERNAL', `wallet revert failed: ${errorMessage(e)}`);
  }
  const balance = balanceAfter(nk, userId, acks);
  emit(nk, undefined, 'wallet_moved', {
    userId,
    kind: 'revert',
    changeset: { ...inverse },
    reason: packed,
    newBalance: balance,
  });
  return ok({ reverted: true, balance });
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Sum of the moves per currency (the record's net movement). */
function netChangeset(moves: ReadonlyArray<WalletMove>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of moves) {
    for (const [k, v] of Object.entries(m.changeset)) {
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

/** Wallet after the transaction's last wallet update, else a fresh read. */
function balanceAfter(nk: INakama, userId: string, acks: IMultiUpdateResult | undefined): WalletView {
  const list = acks?.walletUpdateAcks ?? [];
  const last = list[list.length - 1];
  if (last?.updated && typeof last.updated === 'object') return toView(last.updated);
  return walletGet(nk, userId);
}

/** `{coins, gems}` view of a Nakama wallet map. */
function toView(w: Record<string, number>): WalletView {
  const coins = w['coins'];
  const gems = w['gems'];
  return {
    coins: typeof coins === 'number' ? coins : 0,
    gems: typeof gems === 'number' ? gems : 0,
  };
}

/** The first currency the moves would take below zero, applied in order. */
function shortCurrency(
  current: WalletView,
  moves: ReadonlyArray<WalletMove>,
): { currency: 'coins' | 'gems'; balance: number } | null {
  const running: Record<string, number> = { coins: current.coins, gems: current.gems };
  for (const m of moves) {
    for (const [k, v] of Object.entries(m.changeset)) {
      running[k] = (running[k] ?? 0) + v;
      if ((running[k] ?? 0) < 0 && (k === 'coins' || k === 'gems')) {
        return { currency: k, balance: current[k] };
      }
    }
  }
  return null;
}

/** `INSUFFICIENT_FUNDS` naming the currency the transaction rejected. */
function insufficientFunds(
  nk: INakama,
  userId: string,
  changeset: Record<string, number>,
  e: unknown,
): Err {
  const path = /at path '([^']+)'/.exec(errorMessage(e))?.[1];
  const current = walletGet(nk, userId);
  let currency: 'coins' | 'gems' = 'coins';
  if (path === 'coins' || path === 'gems') {
    currency = path;
  } else if ((changeset['gems'] ?? 0) < 0 && current.gems + (changeset['gems'] ?? 0) < 0) {
    currency = 'gems';
  }
  return err('INSUFFICIENT_FUNDS', `not enough ${currency}`, { currency, balance: current[currency] });
}

function safeReason(metadata: LedgerMetadata): string {
  try {
    return formatLedgerMetadata(metadata);
  } catch {
    return `${metadata.reason}:${metadata.sourceId}`;
  }
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
    value === 'admin' ||
    value === 'event'
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