// Phase 8 Chunk 8 — `event_list` RPC.
//
// Returns every event in the catalog (past, present, future) with an
// `isActive` boolean. No auth beyond the standard caller-identity
// check. The client uses this to render a calendar of upcoming
// promotions and to know which `xp_double` / `special_offer` events
// are live right now.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { activeEvents, getEventsCatalog } from '../core/active_events';
import { serverNowMs } from '../core/time';
import { requireCaller } from '../core/caller';
import { withRuntime } from '../core/runtime_state';

export interface EventListInput {
  /** Optional; must match the session user when present (D-03). */
  callerUserId?: string;
}

export interface EventListEvent {
  id: string;
  kind: string;
  startsAtUtc: string;
  endsAtUtc: string;
  payload: Record<string, unknown>;
  isActive: boolean;
}

export interface EventListOutput {
  events: EventListEvent[];
  /** Server epoch-ms the catalog was queried at. */
  now: number;
}

/**
 * `nowMs` is injectable so tests pin the clock; Nakama calls the RPC with
 * four arguments, so the runtime always uses the server clock.
 */
export const event_list_impl = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
  nowMs: () => number = serverNowMs,
): string => {
  const parsed = parseInput(body);
  if (!parsed.ok) return toJson(parsed.value);

  const caller = requireCaller(ctx, parsed.value);
  if (!caller.ok) return toJson(caller.error);

  const nowUtc = nowMs();
  const all = getEventsCatalog();
  const active = new Set(activeEvents(nowUtc).map((e) => e.id));

  const events: EventListEvent[] = all.map((e) => ({
    id: e.id,
    kind: e.kind,
    startsAtUtc: e.startsAtUtc,
    endsAtUtc: e.endsAtUtc,
    payload: e.payload,
    isActive: active.has(e.id),
  }));
  // Sort by startsAtUtc ascending so the client can render a calendar
  // without re-sorting.
  events.sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc));

  logger.info('event_list events=%d active=%d now=%d', events.length, active.size, nowUtc);
  return toJson(ok({ events, now: nowUtc }));
};

// ─── helpers ─────────────────────────────────────────────────────────────────

interface ParseOk<T> {
  ok: true;
  value: T;
}
interface ParseErr {
  ok: false;
  value: Resp<never>;
}
function parseInput(body: string): ParseOk<EventListInput> | ParseErr {
  if (typeof body !== 'string' || body.length === 0) {
    return { ok: true, value: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, value: err('BAD_REQUEST', 'payload is not valid JSON') };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, value: err('BAD_REQUEST', 'payload must be an object') };
  }
  return { ok: true, value: raw as EventListInput };
}

function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

// ─── Top-level bindings ──────────────────────────────────────────────────────

// Global names the 3.27 registration scanner resolves (main.ts). Each one
// loads the VM's runtime state first (plan T-29, D-11; audit N8).
export const event_list = withRuntime(event_list_impl);
