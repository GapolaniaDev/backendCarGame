// Phase 4 Chunk 2 unit tests for the matchmakerMatched hook.
// Validates `pickCandidate` + `validateCandidate` + `buildRaceSessionFromCandidate`.

import { describe, it, expect } from 'vitest';
import {
  pickCandidate,
  validateCandidate,
  buildRaceSessionFromCandidate,
} from '../../modules/src/matchmaking/matched_hook';
import type { IMatchmakerMatchedEnvelope } from '../../modules/src/nkruntime';

function mkTicket(
  ticketId: string,
  mode: string,
  size: number,
  userId: string,
  rtt = 50,
): IMatchmakerMatchedEnvelope['matches'][number] {
  return {
    sessionId: `s-${ticketId}`,
    tickets: [
      {
        ticket: `ticket-${ticketId}`,
        metadata: {
          mode,
          size: String(size),
          version: '1.0.0',
          region: 'eu-west-1',
          segmentBy: 'none',
        },
      },
    ],
    matched: [
      {
        sessionId: `s-${ticketId}`,
        userId,
        username: `user-${userId}`,
        vars: { rtt: String(rtt) },
      },
    ],
  };
}

function mkEnvelope(
  candidates: IMatchmakerMatchedEnvelope['matches'],
): IMatchmakerMatchedEnvelope {
  return { matches: candidates };
}

describe('matched_hook (Phase 4 Chunk 2)', () => {
  it('pickCandidate accepts a fully-aligned pair', () => {
    const env = mkEnvelope([
      mkTicket('a', 'quick', 2, 'user-a', 50),
      {
        sessionId: 's-a',
        tickets: [
          {
            ticket: 'ticket-a',
            metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' },
          },
          {
            ticket: 'ticket-b',
            metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' },
          },
        ],
        matched: [
          { sessionId: 's-a', userId: 'user-a', username: 'A', vars: { rtt: '50' } },
          { sessionId: 's-a', userId: 'user-b', username: 'B', vars: { rtt: '60' } },
        ],
      },
    ]);
    const d = pickCandidate(env);
    expect(d.matched).toBe(true);
    if (!d.matched) return;
    expect(d.candidateIndex).toBe(1);
  });

  it('pickCandidate returns reason "no_candidates" when the envelope is empty', () => {
    const env = mkEnvelope([]);
    const d = pickCandidate(env);
    expect(d.matched).toBe(false);
    if (d.matched) return;
    expect(d.reason).toBe('no_candidates');
  });

  it('pickCandidate returns reason "no_qualified_candidate" when no candidate aligns', () => {
    const env = mkEnvelope([
      mkTicket('a', 'quick', 4, 'user-a'),
    ]);
    const d = pickCandidate(env);
    expect(d.matched).toBe(false);
    if (d.matched) return;
    expect(d.reason).toBe('no_qualified_candidate');
  });

  it('validateCandidate rejects a candidate with mismatched mode on ticket[1]', () => {
    const c: IMatchmakerMatchedEnvelope['matches'][number] = {
      sessionId: 's-a',
      tickets: [
        { ticket: 't-a', metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' } },
        { ticket: 't-b', metadata: { mode: 'ranked', size: '2', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' } },
      ],
      matched: [
        { sessionId: 's-a', userId: 'u-a', username: 'A', vars: { rtt: '50' } },
        { sessionId: 's-a', userId: 'u-b', username: 'B', vars: { rtt: '60' } },
      ],
    };
    expect(validateCandidate(c)).toMatch(/mode mismatch on ticket\[1\]/);
  });

  it('validateCandidate rejects a candidate with mismatched version on ticket[1]', () => {
    const c: IMatchmakerMatchedEnvelope['matches'][number] = {
      sessionId: 's-a',
      tickets: [
        { ticket: 't-a', metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' } },
        { ticket: 't-b', metadata: { mode: 'quick', size: '2', version: '0.9.0', region: 'eu-west-1', segmentBy: 'none' } },
      ],
      matched: [
        { sessionId: 's-a', userId: 'u-a', username: 'A', vars: { rtt: '50' } },
        { sessionId: 's-a', userId: 'u-b', username: 'B', vars: { rtt: '60' } },
      ],
    };
    expect(validateCandidate(c)).toMatch(/version mismatch/);
  });

  it('validateCandidate rejects a candidate with mismatched region on ticket[1]', () => {
    const c: IMatchmakerMatchedEnvelope['matches'][number] = {
      sessionId: 's-a',
      tickets: [
        { ticket: 't-a', metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' } },
        { ticket: 't-b', metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'us-east-1', segmentBy: 'none' } },
      ],
      matched: [
        { sessionId: 's-a', userId: 'u-a', username: 'A', vars: { rtt: '50' } },
        { sessionId: 's-a', userId: 'u-b', username: 'B', vars: { rtt: '60' } },
      ],
    };
    expect(validateCandidate(c)).toMatch(/region mismatch/);
  });

  it('validateCandidate rejects a candidate with size outside {2, 4, 6}', () => {
    const c: IMatchmakerMatchedEnvelope['matches'][number] = {
      sessionId: 's-a',
      tickets: [
        { ticket: 't-a', metadata: { mode: 'quick', size: '8', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' } },
      ],
      matched: [
        { sessionId: 's-a', userId: 'u-a', username: 'A', vars: { rtt: '50' } },
      ],
    };
    expect(validateCandidate(c)).toMatch(/size/);
  });

  it('validateCandidate rejects a candidate where tickets/matched length differ', () => {
    const c: IMatchmakerMatchedEnvelope['matches'][number] = {
      sessionId: 's-a',
      tickets: [
        { ticket: 't-a', metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' } },
        { ticket: 't-b', metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' } },
      ],
      matched: [
        { sessionId: 's-a', userId: 'u-a', username: 'A', vars: { rtt: '50' } },
        { sessionId: 's-a', userId: 'u-b', username: 'B', vars: { rtt: '60' } },
        { sessionId: 's-a', userId: 'u-c', username: 'C', vars: { rtt: '70' } },
      ],
    };
    expect(validateCandidate(c)).toMatch(/tickets\/matched length/);
  });

  it('validateCandidate rejects a candidate with invalid mode literal on ticket[0]', () => {
    const c: IMatchmakerMatchedEnvelope['matches'][number] = {
      sessionId: 's-a',
      tickets: [
        { ticket: 't-a', metadata: { mode: 'invalid_mode', size: '2', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' } },
        { ticket: 't-b', metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' } },
      ],
      matched: [
        { sessionId: 's-a', userId: 'u-a', username: 'A', vars: { rtt: '50' } },
        { sessionId: 's-a', userId: 'u-b', username: 'B', vars: { rtt: '60' } },
      ],
    };
    expect(validateCandidate(c)).toMatch(/invalid or missing mode/);
  });

  it('buildRaceSessionFromCandidate picks the lowest-RTT user as host', () => {
    const c: IMatchmakerMatchedEnvelope['matches'][number] = {
      sessionId: 's-1',
      tickets: [
        {
          ticket: 'ticket-1',
          metadata: { mode: 'ranked', size: '4', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' },
        },
        {
          ticket: 'ticket-2',
          metadata: { mode: 'ranked', size: '4', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' },
        },
      ],
      matched: [
        { sessionId: 's-1', userId: 'user-a', username: 'A', vars: { rtt: '120' } },
        { sessionId: 's-1', userId: 'user-b', username: 'B', vars: { rtt: '30' } },
      ],
    };
    const s = buildRaceSessionFromCandidate(c);
    expect(s.host).toBe('user-b');
    expect(s.hostSuccession[0]).toBe('user-b');
    expect(s.size).toBe(2);
    expect(s.mode).toBe('ranked');
    expect(s.state).toBe('created');
    expect(s.roster).toHaveLength(2);
  });

  it('buildRaceSessionFromCandidate places host first in hostSuccession', () => {
    const c: IMatchmakerMatchedEnvelope['matches'][number] = {
      sessionId: 's-2',
      tickets: [
        {
          ticket: 'ticket-1',
          metadata: { mode: 'quick', size: '6', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' },
        },
      ],
      matched: [
        { sessionId: 's-2', userId: 'user-a', username: 'A', vars: { rtt: '40' } },
        { sessionId: 's-2', userId: 'user-b', username: 'B', vars: { rtt: '60' } },
        { sessionId: 's-2', userId: 'user-c', username: 'C', vars: { rtt: '90' } },
      ],
    };
    const s = buildRaceSessionFromCandidate(c);
    expect(s.host).toBe('user-a');
    expect(s.hostSuccession).toEqual(['user-a', 'user-b', 'user-c']);
  });
});