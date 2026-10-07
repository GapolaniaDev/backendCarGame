// Phase 4 matchmaking RPCs.
//
// mm_ticket_params (D1): turns a player request into the matchmaker
// query + metadata the client then passes to `nk.matchmakerAdd`. The
// RPC does NOT call matchmakerAdd itself — that's the client's job
// (the runtime keeps the socket connection open). The RPC just stamps
// version + region + segmentBy + excludeTrackIds and returns the
// payload the client should send.
//
// The matched-hook (registerMatchmakerMatched) lives in
// `./matched_hook.ts`. Wired in `modules/src/main.ts`.
//
// Chunk 2 (Phase 4 plan) — see the plan doc for the locked
// decisions. The liveops/mm_config.ts dependency is a Chunk 1 catalog
// already (the types module ships in this same chunk; the JSON loader
// arrives in Chunk 8).

import type { IContext, IMatchmakerMatchedEnvelope, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import { getRankedConfig } from '../ranked/config';
import { readRankedRecord } from '../ranked/ranked_repo';
import {
  buildOutput,
  buildTicket,
  validateTicketInput,
  type BuiltTicket,
} from './ticket_params';
import type {
  MmTicketParamsInput,
  MmTicketParamsOutput,
} from './types';
import { pickCandidate } from './matched_hook';
import { readParty } from '../parties/parties_repo';
import type { PartyRecord } from '../parties/types';

export interface ResolvedTicketOptions {
  version: string;
  region: string;
  rating?: number;
  lastRatedAt?: number;
  segmentBy?: 'none' | 'rating';
  /** Phase 7 Chunk 8: party size (members.length). */
  partySize?: number;
  /** Phase 7 Chunk 8: party id (the leader's partyId). */
  partyId?: string;
}

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

export const mm_ticket_params_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;

  const v = validateTicketInput(parsed.value);
  if (!v.ok) {
    return toJson(err('BAD_REQUEST', 'invalid ticket params', { errors: v.errors }));
  }

  // LiveOps gate (Chunk 9) — maintenance only (mm_ticket_params doesn't
  // carry ClientPlatform-shaped fields; MmPlatform is "mobile|console|pc").
  const m = assertNotInMaintenance(
    logger, nk, ctx.userId ?? parsed.value.callerUserId ?? 'anon',
  );
  if (m !== null) return toJson(m);

  // Phase 7 Chunk 8: party path. When `partyId` is provided, validate
  // caller is the leader and pull party metadata into the ticket.
  const partyId = parsed.value.partyId;
  const partyResult = resolveParty(nk, logger, parsed.value, partyId);
  if (!partyResult.ok) return toJson(err(partyResult.code, partyResult.message));

  const options = resolveOptions(nk, ctx, parsed.value, partyResult.party);
  const config = getRankedConfig();
  const ticket: BuiltTicket = buildTicket(v, options, config);
  const output: MmTicketParamsOutput = buildOutput(v, ticket, options);

  logger.info(
    'mm_ticket_params user=%s mode=%s size=%d version=%s region=%s segmentBy=%s ratingBand=%s party=%s',
    ctx.userId ?? 'anon',
    output.mode,
    output.size,
    output.version,
    output.region,
    output.mm.segmentBy,
    String(ticket.query['ratingBand'] ?? 'n/a'),
    partyId ?? 'none',
  );

  // Analytics (Chunk 9).
  emit(nk, logger, 'mm_ticket_params_called', {
    mode: output.mode,
    segmentBy: output.mm.segmentBy,
    version: output.version,
    region: output.region,
    partyId: partyId ?? null,
  });

  return toJson(ok({ ticket, output }));
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pull server-stamped options from the request. The HTTP gateway
 * supplies `callerUserId`; the socket path reads it from `ctx.userId`.
 * Region defaults to 'eu-west-1' when neither side provides one.
 *
 * Phase 7 Chunk 8: when `party` is non-null, the rating/party metadata
 * is derived from the party: rating = max(members.ratedScore),
 * partySize = members.length, partyId = party.partyId.
 */
function resolveOptions(
  nk: INakama,
  ctx: IContext,
  _input: MmTicketParamsInput,
  party: PartyRecord | null,
): ResolvedTicketOptions {
  // Server-stamped version — would come from a header in production
  // (e.g. `client.version`). Today the bundle ships one version, so
  // we hardcode it. Chunk 8 promotes this to a runtime header.
  const version = '1.0.0';
  const region = (ctx as { region?: string }).region || 'eu-west-1';

  if (party === null) {
    return { version, region };
  }

  // Party path: stamp party metadata. The leader's ticket is what
  // the client passes to `nk.matchmakerAdd` — `matchmakerMatched`
  // verifies every member of the party is present.
  const opts: ResolvedTicketOptions = {
    version,
    region,
    partySize: party.members.length,
    partyId: party.partyId,
  };
  const leaderRating = readPartyLeaderRating(nk, party);
  if (leaderRating !== undefined) {
    opts.rating = leaderRating;
    opts.lastRatedAt = 0;
  }
  return opts;
}

/**
 * Phase 7 Chunk 8: lookup + validate the party the leader wants to
 * queue with. Returns `{ok:true, party}` on success, or an error
 * shape the caller can pass to `toJson(err(...))` directly.
 */
function resolveParty(
  nk: INakama,
  logger: ILogger,
  input: MmTicketParamsInput,
  partyId: string | undefined,
):
  | { ok: true; party: PartyRecord | null }
  | { ok: false; code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND'; message: string } {
  if (partyId === undefined) return { ok: true, party: null };
  const callerId = input.callerUserId;
  if (typeof callerId !== 'string' || callerId.length === 0) {
    return { ok: false, code: 'FORBIDDEN', message: 'partyId requires callerUserId' };
  }
  const partyRow = readParty(nk, partyId);
  if (partyRow === null) {
    return { ok: false, code: 'NOT_FOUND', message: 'party not found' };
  }
  const party = partyRow.record;
  if (party.leaderUserId !== callerId) {
    return { ok: false, code: 'FORBIDDEN', message: 'only the party leader can queue the party' };
  }
  if (party.state !== 'open') {
    return { ok: false, code: 'FORBIDDEN', message: 'party is not open' };
  }
  if (party.members.length < 1) {
    return { ok: false, code: 'BAD_REQUEST', message: 'party has no members' };
  }
  logger.debug('mm_ticket_params party resolved partyId=%s leader=%s members=%d',
    party.partyId, party.leaderUserId, party.members.length);
  return { ok: true, party };
}

/**
 * Phase 7 Chunk 8: read the party's leader's current ranked rating.
 * Returns undefined when the leader has no ranked record (new player).
 * Today we read only the leader's record to keep the RPC cheap — the
 * matched-hook verifies the full party arrives, so the leader's
 * rating is the "ceiling" the matchmaker band must contain.
 */
function readPartyLeaderRating(
  nk: INakama,
  party: PartyRecord,
): number | undefined {
  const leader = party.leaderUserId;
  try {
    // We don't know the seasonId without resolving liveops; default to
    // 'global' for the current implementation. Matchmaker band is
    // computed from rating ± window; an off-season record just gives
    // a slightly different initial band.
    const rec = readRankedRecord(nk, leader);
    return rec?.record.rating;
  } catch {
    return undefined;
  }
}

interface ParseOk<T> {
  ok: true;
  value: T;
}
interface ParseErr {
  ok: false;
  error: string;
}
function parseInput(body: string): ParseOk<MmTicketParamsInput> | ParseErr {
  const t = body.trim();
  let raw: unknown = {};
  if (t.length > 0) {
    try {
      raw = JSON.parse(t);
    } catch {
      return { ok: false, error: toJson(err('BAD_REQUEST', 'payload is not valid JSON')) };
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: toJson(err('BAD_REQUEST', 'payload must be an object')) };
  }
  const r = raw as Record<string, unknown>;
  // Build the input shape conditionally so we honour
  // `exactOptionalPropertyTypes` — only set keys that have values.
  const value: MmTicketParamsInput = {
    mode: (r['mode'] ?? 'quick') as MmTicketParamsInput['mode'],
  };
  if (r['size'] !== undefined) value.size = r['size'] as 2 | 4 | 6;
  if (r['input'] !== undefined && typeof r['input'] === 'object' && r['input'] !== null) {
    value.input = r['input'] as Record<string, string>;
  }
  if (r['platform'] === 'mobile' || r['platform'] === 'console' || r['platform'] === 'pc') {
    value.platform = r['platform'];
  }
  if (typeof r['callerUserId'] === 'string') value.callerUserId = r['callerUserId'];
  if (typeof r['partyId'] === 'string') value.partyId = r['partyId'];
  return { ok: true, value };
}

function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

// Top-level binding for the goja AST scanner.
export const mm_ticket_params: RpcHandler = mm_ticket_params_impl;

// ─── Matched-hook glue ───────────────────────────────────────────────────────

/**
 * Glue that wraps `pickCandidate` and the `registerMatchmakerMatched`
 * hook signature. Returns `{ matched: boolean }` per the runtime
 * contract (returning `null` would re-eval; we always choose).
 *
 * The actual `RaceSession` creation + storage write lives in Chunk 4
 * (reconnection + host_claim); Chunk 2 just validates the candidate
 * set so the matchmaker can keep or drop it.
 */
export const matchmakerMatchedHook: RpcHandler = () => {
  // This is registered separately via `initializer.registerMatchmakerMatched`.
  // The real implementation is below as `matchmakerMatchedImpl`.
  throw new Error('matchmakerMatchedHook should be registered via registerMatchmakerMatched');
};

export function matchmakerMatchedImpl(
  _ctx: IContext,
  logger: ILogger,
  nk: INakama,
  envelope: IMatchmakerMatchedEnvelope,
): { matched: boolean } {
  const decision = pickCandidate(envelope);
  if (decision.matched) {
    logger.info('matchmakerMatched candidateIndex=%d (accepted)', decision.candidateIndex);
    const session = envelope.matches[decision.candidateIndex];
    if (session !== undefined) {
      const humans = session.matched.filter((m) => m.vars['kind'] !== 'robot');
      const bots = session.matched.filter((m) => m.vars['kind'] === 'robot');
      emit(nk, logger, 'matchmaker_matched', {
        sessionId: session.sessionId,
        humanCount: humans.length,
        botCount: bots.length,
        ticketCount: session.tickets.length,
        ratingSpread: null,
      });
    }
    return { matched: true };
  }
  logger.info('matchmakerMatched reason=%s (rejected)', decision.reason);
  return { matched: false };
}