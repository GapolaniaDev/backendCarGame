// Phase 7 Chunk 8 — Unit tests for the matchmaker party-grouping rule.

import { describe, it, expect } from 'vitest';

import {
  validatePartyGrouping,
  type MatchedCandidate,
} from '../../modules/src/matchmaking/matched_hook';

function makeCandidate(opts: {
  matched: Array<{ userId: string; partyId?: string; partySize?: string }>;
}): MatchedCandidate {
  return {
    sessionId: 's1',
    tickets: [],
    matched: opts.matched.map((m) => ({
      sessionId: 's1',
      userId: m.userId,
      username: m.userId,
      vars: {
        ...(m.partyId !== undefined ? { partyId: m.partyId } : {}),
        ...(m.partySize !== undefined ? { partySize: m.partySize } : {}),
      },
    })),
  };
}

describe('matchmaker party grouping (Phase 7 Chunk 8)', () => {
  it('returns null when no partyId is set on any entry', () => {
    const c = makeCandidate({
      matched: [{ userId: 'u1' }, { userId: 'u2' }],
    });
    expect(validatePartyGrouping(c)).toBeNull();
  });

  it('returns null when every entry shares the same partyId and size matches', () => {
    const c = makeCandidate({
      matched: [
        { userId: 'u1', partyId: 'party-A', partySize: '3' },
        { userId: 'u2', partyId: 'party-A', partySize: '3' },
        { userId: 'u3', partyId: 'party-A', partySize: '3' },
      ],
    });
    expect(validatePartyGrouping(c)).toBeNull();
  });

  it('rejects when entries have mismatched partyIds', () => {
    const c = makeCandidate({
      matched: [
        { userId: 'u1', partyId: 'party-A' },
        { userId: 'u2', partyId: 'party-B' },
      ],
    });
    const reason = validatePartyGrouping(c);
    expect(reason).toMatch(/party split/);
  });

  it('rejects when the matched count differs from partySize', () => {
    const c = makeCandidate({
      matched: [
        { userId: 'u1', partyId: 'party-A', partySize: '4' },
        { userId: 'u2', partyId: 'party-A', partySize: '4' },
        { userId: 'u3', partyId: 'party-A', partySize: '4' },
      ],
    });
    const reason = validatePartyGrouping(c);
    expect(reason).toMatch(/party partial/);
  });

  it('accepts when partySize is missing (the matchmaker may not stamp it)', () => {
    const c = makeCandidate({
      matched: [
        { userId: 'u1', partyId: 'party-A' },
        { userId: 'u2', partyId: 'party-A' },
      ],
    });
    expect(validatePartyGrouping(c)).toBeNull();
  });

  it('handles empty matched list', () => {
    expect(validatePartyGrouping(makeCandidate({ matched: [] }))).toBeNull();
  });
});