// Phase 4 Chunk 4 unit tests for `validateHostClaim` (race module).
//
// The grace-window edge cases are folded into this file because the
// grace check lives inside `validateHostClaim` (no separate grace
// helper). Tests cover:
//   - membership (FORBIDDEN when caller not in roster)
//   - state (BAD_REQUEST when not 'started')
//   - re-claim by current host (idempotent OK with original claimedAt)
//   - missing disconnectReportedAt (BAD_REQUEST)
//   - grace window edge cases (just-under, just-over)
//   - succession order (caller must be succession[hostIdx+1])
//   - caller not in succession at all (BAD_REQUEST)

import { describe, it, expect } from 'vitest';
import { validateHostClaim } from '../../modules/src/race/validation';
import { HOST_CLAIM_GRACE_SECONDS, HOST_CLAIM_GRACE_TOLERANCE_MS } from '../../modules/src/race/constants';
import type { RaceSession } from '../../modules/src/race/types';

const NOW = 1_700_000_000_000;

function buildSession(overrides: Partial<RaceSession> = {}): RaceSession {
  return {
    schemaVersion: 1,
    id: 'sid',
    matchId: 'match-1',
    mode: 'quick',
    trackId: 'neon_blvd',
    size: 4,
    roster: [
      { userId: 'a', loadout: { classId: 'C', bodyId: 'viper' }, isBot: false },
      { userId: 'b', loadout: { classId: 'C', bodyId: 'viper' }, isBot: false },
      { userId: 'c', loadout: { classId: 'C', bodyId: 'viper' }, isBot: false },
      { userId: 'd', loadout: { classId: 'C', bodyId: 'viper' }, isBot: false },
    ],
    host: 'a',
    hostSuccession: ['a', 'b', 'c', 'd'],
    state: 'started',
    startedAt: NOW - 1000,
    claimedAt: NOW - 1000,
    results: [],
    flags: { needsReview: false },
    version: 5,
    ...overrides,
  };
}

function withDisconnectAt(session: RaceSession, userId: string, at: number): RaceSession {
  return {
    ...session,
    roster: session.roster.map((e) =>
      e.userId === userId ? { ...e, disconnectReportedAt: at } : e,
    ),
  };
}

describe('validateHostClaim (Phase 4 Chunk 4)', () => {
  // ─── Membership ──────────────────────────────────────────────────────────
  it('FORBIDDEN when the caller is not in the roster', () => {
    const s = buildSession();
    const r = validateHostClaim({ session: s, callerUserId: 'z', nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('FORBIDDEN');
  });

  // ─── State ───────────────────────────────────────────────────────────────
  it('BAD_REQUEST when session.state is created', () => {
    const s = buildSession({ state: 'created', startedAt: null });
    const r = validateHostClaim({ session: s, callerUserId: 'b', nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('BAD_REQUEST');
    expect(r.reason).toMatch(/started/);
  });

  it('BAD_REQUEST when session.state is closed', () => {
    const s = buildSession({ state: 'closed' });
    const r = validateHostClaim({ session: s, callerUserId: 'b', nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('BAD_REQUEST');
  });

  // ─── Idempotent re-claim ────────────────────────────────────────────────
  it('OK + idempotent when caller is already the host (re-claim)', () => {
    const s = buildSession();
    const r = validateHostClaim({ session: s, callerUserId: 'a', nowMs: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.idempotent).toBe(true);
    expect(r.claimedAt).toBe(NOW - 1000); // echoes startedAt (claimedAt)
  });

  it('idempotent re-claim falls back to startedAt when claimedAt is unset', () => {
    const s = buildSession({ claimedAt: undefined });
    const r = validateHostClaim({ session: s, callerUserId: 'a', nowMs: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claimedAt).toBe(NOW - 1000);
  });

  // ─── Missing disconnect report ──────────────────────────────────────────
  it('BAD_REQUEST when host has no disconnectReportedAt', () => {
    const s = buildSession();
    // host 'a' has no disconnectReportedAt
    const r = validateHostClaim({ session: s, callerUserId: 'b', nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('BAD_REQUEST');
    expect(r.reason).toMatch(/disconnectReportedAt/);
  });

  // ─── Grace window edge cases ────────────────────────────────────────────
  it('OK when disconnectReportedAt is recent (within grace)', () => {
    const graceMs = HOST_CLAIM_GRACE_SECONDS * 1000;
    const s = withDisconnectAt(buildSession(), 'a', NOW - graceMs / 2);
    const r = validateHostClaim({ session: s, callerUserId: 'b', nowMs: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.idempotent).toBe(false);
    expect(r.claimedAt).toBe(NOW);
  });

  it('OK at the inclusive boundary (elapsed == graceMs + tolerance)', () => {
    const graceMs = HOST_CLAIM_GRACE_SECONDS * 1000 + HOST_CLAIM_GRACE_TOLERANCE_MS;
    const s = withDisconnectAt(buildSession(), 'a', NOW - graceMs);
    const r = validateHostClaim({ session: s, callerUserId: 'b', nowMs: NOW });
    expect(r.ok).toBe(true);
  });

  it('BAD_REQUEST when disconnectReportedAt exceeds grace + tolerance', () => {
    const over = (HOST_CLAIM_GRACE_SECONDS * 1000 + HOST_CLAIM_GRACE_TOLERANCE_MS) + 1;
    const s = withDisconnectAt(buildSession(), 'a', NOW - over);
    const r = validateHostClaim({ session: s, callerUserId: 'b', nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('BAD_REQUEST');
    expect(r.reason).toMatch(/grace/);
  });

  // ─── Succession order ───────────────────────────────────────────────────
  it('OK when caller is succession[hostIdx+1]', () => {
    const graceMs = HOST_CLAIM_GRACE_SECONDS * 1000 / 2;
    const s = withDisconnectAt(buildSession(), 'a', NOW - graceMs);
    const r = validateHostClaim({ session: s, callerUserId: 'b', nowMs: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.idempotent).toBe(false);
  });

  it('BAD_REQUEST when caller is succession[hostIdx+2] (skips one)', () => {
    const graceMs = HOST_CLAIM_GRACE_SECONDS * 1000 / 2;
    const s = withDisconnectAt(buildSession(), 'a', NOW - graceMs);
    // 'c' is succession[2], but 'b' (succession[1]) must claim first
    const r = validateHostClaim({ session: s, callerUserId: 'c', nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('BAD_REQUEST');
    expect(r.reason).toMatch(/succession\[2\]/);
  });

  it('BAD_REQUEST when caller is not in the succession list at all', () => {
    const graceMs = HOST_CLAIM_GRACE_SECONDS * 1000 / 2;
    // Add an out-of-succession player to the roster.
    const s = withDisconnectAt(
      {
        ...buildSession(),
        roster: [
          ...buildSession().roster,
          { userId: 'z', loadout: { classId: 'C', bodyId: 'viper' }, isBot: false },
        ],
        hostSuccession: ['a', 'b', 'c', 'd'], // 'z' not in succession
      },
      'a',
      NOW - graceMs,
    );
    const r = validateHostClaim({ session: s, callerUserId: 'z', nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('BAD_REQUEST');
    expect(r.reason).toMatch(/not in the host succession/);
  });

  it('BAD_REQUEST when current host is missing from roster (data corruption)', () => {
    const s = withDisconnectAt(buildSession(), 'a', NOW - 1000);
    // Force the host out of the roster.
    const corrupt = { ...s, roster: s.roster.filter((e) => e.userId !== 'a'), host: 'a' };
    const r = validateHostClaim({ session: corrupt, callerUserId: 'b', nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('BAD_REQUEST');
    expect(r.reason).toMatch(/not found in roster/);
  });

  it('succession list is independent of roster order — uses indexOf, not position', () => {
    // Build a session where the roster is in a different order than
    // the succession list. The claim must still respect succession.
    const base = buildSession();
    const reordered = {
      ...base,
      hostSuccession: ['a', 'b', 'c', 'd'],
      roster: [base.roster[3]!, base.roster[2]!, base.roster[1]!, base.roster[0]!],
    };
    const graceMs = HOST_CLAIM_GRACE_SECONDS * 1000 / 2;
    const s = withDisconnectAt(reordered, 'a', NOW - graceMs);
    const r = validateHostClaim({ session: s, callerUserId: 'b', nowMs: NOW });
    expect(r.ok).toBe(true);
  });
});