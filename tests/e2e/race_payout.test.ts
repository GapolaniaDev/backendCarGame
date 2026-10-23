// Race payouts through the wallet (plan T-11; F0b finding, audit 05 f15).
// Until T-11 every payout called `nk.walletLedgerUpdate(userId, …)`, which
// in 3.27 edits an existing ledger row by id ("sql: no rows in result
// set"): the closing submit answered HTTP 500 and lazy closes paid
// nothing. The stub now has the 3.27 semantics, so these fail on the old
// wallet helpers.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
  seedRaceGarage,
  type LoadedBundle,
} from './_stubs';
import type { RaceSession } from '../../modules/src/race/types';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

const A = 'payout-player-a';
const B = 'payout-player-b';
const D_LAPS = [48_100, 48_100, 48_100];

function call<T>(env: LoadedBundle, rpc: string, caller: string, payload: unknown): Resp<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  return JSON.parse(handler({ ...FakeContext, userId: caller }, env.logger, env.nak, JSON.stringify(payload))) as Resp<T>;
}

function stored(env: LoadedBundle, sid: string): RaceSession {
  return env.fakeNakama.store.get(`race_sessions/${sid}/${SYSTEM_USER_ID}`)?.value as unknown as RaceSession;
}

function startRace(env: LoadedBundle, host: string, others: string[]): string {
  const created = call<{ sessionId: string }>(env, 'race_session_create', host, {
    matchId: `m-${host}`, mode: 'private', trackId: 'neon_blvd', size: 2,
    hostLoadout: { classId: 'D', bodyId: 'starter_viper' }, hostUserId: host,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const sid = created.data.sessionId;
  for (const u of others) call(env, 'race_session_join', u, { sessionId: sid, userId: u, loadout: { classId: 'D', bodyId: 'starter_viper' } });
  const started = call(env, 'race_session_start', host, { sessionId: sid });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  stored(env, sid).startedAt = Date.now() - 200_000;
  return sid;
}

function submit(env: LoadedBundle, sid: string, user: string, requestId?: string) {
  return call<{ rewards?: { perPlayer?: Record<string, { newBalance: { coins: number } }> } }>(env, 'race_submit_result', user, {
    sessionId: sid,
    report: { userId: user, totalMs: D_LAPS.reduce((x, y) => x + y, 0), laps: D_LAPS, isBotReport: false },
    ...(requestId ? { requestId } : {}),
  });
}

const coins = (env: LoadedBundle, u: string): number => env.fakeNakama.wallets.get(u)?.['coins'] ?? 0;
/** Ledger rows of the race reward (the first-win marker has its own key). */
const raceLedger = (env: LoadedBundle, u: string) =>
  (env.fakeNakama.ledger.get(u) ?? []).filter((l) => /^race:[^:]+:[^:]+$/.test(String((l['metadata'] as { idempotencyKey?: string }).idempotencyKey)));

describe('race payouts (T-11)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
    for (const u of [A, B]) seedRaceGarage(env.nak, u, 'D');
  });

  it('the closing submit answers ok with the rewards, credits the wallet and writes its ledger row', () => {
    const sid = startRace(env, A, []);
    const r = submit(env, sid, A, 'req-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(stored(env, sid).state).toBe('closed');
    const earned = coins(env, A);
    expect(earned).toBeGreaterThan(0);
    expect(raceLedger(env, A)).toHaveLength(1);
    expect(raceLedger(env, A)[0]?.['metadata']).toMatchObject({ idempotencyKey: `race:${sid}:${A}` });

    // The retried submit replays; the payout is not applied twice.
    expect(submit(env, sid, A, 'req-1').ok).toBe(true);
    expect(coins(env, A)).toBe(earned);
    expect(raceLedger(env, A)).toHaveLength(1);
  });

  it('a lazy close (absent player DNF after the grace) pays the finisher', () => {
    const sid = startRace(env, A, [B]);
    expect(submit(env, sid, A).ok).toBe(true);
    expect(coins(env, A)).toBe(0);
    for (const e of stored(env, sid).roster) if (e.reportedAt !== undefined) e.reportedAt -= 31_000;

    const got = call<{ session: RaceSession }>(env, 'race_session_get', A, { sessionId: sid });
    expect(got.ok).toBe(true);
    expect(stored(env, sid).state).toBe('closed');
    expect(coins(env, A)).toBeGreaterThan(0);
    expect(coins(env, B)).toBe(0);
    expect(env.logger.lines.some((l) => /race close payout failed/.test(l))).toBe(false);
  });
});
