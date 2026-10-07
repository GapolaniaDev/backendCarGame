// Phase 7 Chunk 8 — Unit tests for parties pure helpers.

import { describe, it, expect } from 'vitest';

import {
  asPartyCard,
  canAddMember,
  hasMember,
  isValidPartySize,
  PARTY_MAX_SIZE,
  PARTY_STATE_OPEN,
  withAddedMember,
  withoutMember,
  type PartyRecord,
} from '../../modules/src/parties/types';

function makeParty(overrides?: Partial<PartyRecord>): PartyRecord {
  return {
    schemaVersion: 1,
    partyId: 'p1',
    leaderUserId: 'u1',
    maxSize: 4,
    state: PARTY_STATE_OPEN,
    createdAt: 1_000_000,
    members: [{ userId: 'u1', joinedAt: 1_000_000 }],
    ...overrides,
  };
}

describe('parties types (Phase 7 Chunk 8)', () => {
  describe('isValidPartySize', () => {
    it.each([2, 4, 6])('accepts %d', (n) => {
      expect(isValidPartySize(n)).toBe(true);
    });
    it.each([1, 3, 5, 7, 8, 0, -1, '4', null])('rejects %p', (n) => {
      expect(isValidPartySize(n)).toBe(false);
    });
  });

  describe('canAddMember', () => {
    it('accepts a new user when there is room', () => {
      expect(canAddMember(makeParty(), 'u2')).toBe(true);
    });
    it('rejects when the party is closed', () => {
      const p = makeParty({ state: 'closed' });
      expect(canAddMember(p, 'u2')).toBe(false);
    });
    it('rejects when the party is full', () => {
      const p = makeParty({
        maxSize: 2,
        members: [
          { userId: 'u1', joinedAt: 1 },
          { userId: 'u2', joinedAt: 2 },
        ],
      });
      expect(canAddMember(p, 'u3')).toBe(false);
    });
    it('rejects when the user is already a member', () => {
      expect(canAddMember(makeParty(), 'u1')).toBe(false);
    });
  });

  describe('hasMember', () => {
    it('returns true for a current member', () => {
      expect(hasMember(makeParty(), 'u1')).toBe(true);
    });
    it('returns false for a non-member', () => {
      expect(hasMember(makeParty(), 'u2')).toBe(false);
    });
  });

  describe('withAddedMember', () => {
    it('appends a new member', () => {
      const next = withAddedMember(makeParty(), 'u2', 2_000_000);
      expect(next.members).toHaveLength(2);
      expect(next.members[1]?.userId).toBe('u2');
      expect(next.members[1]?.joinedAt).toBe(2_000_000);
    });
    it('is idempotent when the user is already a member', () => {
      const next = withAddedMember(makeParty(), 'u1', 2_000_000);
      expect(next).toEqual(makeParty());
    });
  });

  describe('withoutMember', () => {
    it('removes a member', () => {
      const p = makeParty({
        members: [
          { userId: 'u1', joinedAt: 1 },
          { userId: 'u2', joinedAt: 2 },
        ],
      });
      const next = withoutMember(p, 'u2');
      expect(next.members).toHaveLength(1);
      expect(next.members[0]?.userId).toBe('u1');
    });
    it('is a no-op when the user is not a member', () => {
      const next = withoutMember(makeParty(), 'u3');
      expect(next.members).toEqual(makeParty().members);
    });
  });

  describe('asPartyCard', () => {
    it('projects the public card', () => {
      const p = makeParty({
        members: [
          { userId: 'u1', joinedAt: 100 },
          { userId: 'u2', joinedAt: 200 },
        ],
      });
      const card = asPartyCard(p);
      expect(card).toEqual({
        partyId: 'p1',
        leaderUserId: 'u1',
        maxSize: 4,
        state: 'open',
        createdAt: 1_000_000,
        members: [
          { userId: 'u1', joinedAt: 100 },
          { userId: 'u2', joinedAt: 200 },
        ],
      });
    });
  });

  describe('PARTY_MAX_SIZE', () => {
    it('is 6', () => {
      expect(PARTY_MAX_SIZE).toBe(6);
    });
  });
});