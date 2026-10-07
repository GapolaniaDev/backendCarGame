// Phase 7 Chunk 7 — Unit tests for moderation type enums + validators.

import { describe, it, expect } from 'vitest';

import {
  isReportReason,
  isReportStatus,
  REPORT_REASONS,
  REPORT_STATUSES,
} from '../../modules/src/moderation/types';
import { _parseContextForTests } from '../../modules/src/moderation/rpcs';

describe('moderation types (Phase 7 Chunk 7)', () => {
  describe('isReportReason', () => {
    it.each(REPORT_REASONS)('accepts %s', (r) => {
      expect(isReportReason(r)).toBe(true);
    });

    it.each(['CHEATING', 'random', '', 7, null, undefined, {}])(
      'rejects %p',
      (v) => {
        expect(isReportReason(v)).toBe(false);
      },
    );
  });

  describe('isReportStatus', () => {
    it.each(REPORT_STATUSES)('accepts %s', (s) => {
      expect(isReportStatus(s)).toBe(true);
    });

    it.each(['OPEN', 'ban', '', 42, null])('rejects %p', (v) => {
      expect(isReportStatus(v)).toBe(false);
    });
  });

  describe('parseContext (via _parseContextForTests)', () => {
    it('returns an empty object when undefined', () => {
      const r = _parseContextForTests(undefined);
      expect(r).toEqual({});
    });

    it('rejects non-objects', () => {
      const r = _parseContextForTests('not-an-object');
      expect('ok' in r && r.ok === false).toBe(true);
    });

    it('accepts a valid sessionId', () => {
      const r = _parseContextForTests({ sessionId: 'session-abc.123' });
      expect(r).toEqual({ sessionId: 'session-abc.123' });
    });

    it('rejects malformed sessionId', () => {
      const r = _parseContextForTests({ sessionId: 'no spaces allowed here' });
      expect('ok' in r && r.ok === false).toBe(true);
    });

    it('accepts lastMessages array', () => {
      const r = _parseContextForTests({
        lastMessages: [
          { senderUserId: 'u1', content: 'hi', ts: 100 },
        ],
      });
      expect('ok' in r).toBe(false);
      expect(r).toEqual({
        lastMessages: [{ senderUserId: 'u1', content: 'hi', ts: 100 }],
      });
    });

    it('rejects too many lastMessages', () => {
      const tooMany = Array.from({ length: 21 }, (_, i) => ({
        senderUserId: `u${i}`,
        content: 'x',
        ts: i,
      }));
      const r = _parseContextForTests({ lastMessages: tooMany });
      expect('ok' in r && r.ok === false).toBe(true);
    });
  });
});