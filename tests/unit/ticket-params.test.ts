// Phase 4 Chunk 2 unit tests:
//   - validateTicketInput (mode + size + platform validation)
//   - buildTicket (query + metadata for the matchmaker)
//   - buildOutput (echo shape for the client)
//   - D1 enforcement: server stamps version + region (caller cannot override)
//   - D9 enforcement: ranked mode lands in the rating band

import { describe, it, expect } from 'vitest';
import {
  validateTicketInput,
  buildTicket,
  buildOutput,
} from '../../modules/src/matchmaking/ticket_params';
import type { RawRankedConfigFile } from '../../modules/src/ranked/config';
import { loadRankedConfig, getRankedConfig } from '../../modules/src/ranked/config';
import { _resetRankedConfigForTests } from '../../modules/src/ranked/config';

const RANKED: RawRankedConfigFile = {
  version: 1,
  kFactorNormal: 24,
  kFactorInitial: 40,
  initialRating: 1000,
  divisions: [
    { id: 'bronce',   displayName: 'Bronce',   minRating: 0,    maxRating: 999 },
    { id: 'plata',    displayName: 'Plata',    minRating: 1000, maxRating: 1199 },
    { id: 'oro',      displayName: 'Oro',      minRating: 1200, maxRating: 1399 },
    { id: 'platino',  displayName: 'Platino',  minRating: 1400, maxRating: 1599 },
    { id: 'diamante', displayName: 'Diamante', minRating: 1600, maxRating: 9999 },
  ],
  ratingWindowBySeconds: [
    { elapsedMax: 30,    window: 100 },
    { elapsedMax: 120,   window: 200 },
    { elapsedMax: 3600,  window: 400 },
    { elapsedMax: 86400, window: 400 },
  ],
  hiddenMarkThreshold: 5,
  graceSeconds: 20,
};

describe('ticket_params (Phase 4 Chunk 2)', () => {
  // Helpers — fully unit; no Nakama.
  it('validateTicketInput accepts a quick/2 ticket', () => {
    const r = validateTicketInput({ mode: 'quick', size: 2, callerUserId: '' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe('quick');
    expect(r.size).toBe(2);
  });

  it('validateTicketInput accepts size 4 and 6', () => {
    expect(validateTicketInput({ mode: 'ranked', size: 4, callerUserId: '' }).ok).toBe(true);
    expect(validateTicketInput({ mode: 'ranked', size: 6, callerUserId: '' }).ok).toBe(true);
  });

  it('validateTicketInput rejects an unknown mode', () => {
    const r = validateTicketInput({ mode: 'turbo' as never, callerUserId: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/mode/);
  });

  it('validateTicketInput rejects a size that is not 2/4/6', () => {
    const r = validateTicketInput({ mode: 'quick', size: 8 as never, callerUserId: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/size/);
  });

  it('validateTicketInput rejects an unknown platform', () => {
    const r = validateTicketInput({ mode: 'quick', platform: 'tablet' as never, callerUserId: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/platform/);
  });

  it('validateTicketInput defaults size to 4 for non-time-trial', () => {
    const r = validateTicketInput({ mode: 'quick', callerUserId: '' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.size).toBe(4);
  });

  it('buildTicket includes mode/size/version/region/segmentBy in the query (D1)', () => {
    loadRankedConfig(console as never, RANKED);
    const cfg = getRankedConfig();
    const v = validateTicketInput({ mode: 'quick', size: 2, callerUserId: '' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const ticket = buildTicket(v, { version: '1.0.0', region: 'eu-west-1' }, cfg);
    expect(ticket.query['mode']).toBe('quick');
    expect(ticket.query['size']).toBe(2);
    expect(ticket.query['version']).toBe('1.0.0');
    expect(ticket.query['region']).toBe('eu-west-1');
    expect(ticket.query['segmentBy']).toBe('none');
    // Non-ranked → ratingBand === 'unrated' sentinel
    expect(ticket.query['ratingBand']).toBe('unrated');
  });

  it('buildTicket uses the rating band for ranked mode (D9)', () => {
    loadRankedConfig(console as never, RANKED);
    const cfg = getRankedConfig();
    const v = validateTicketInput({ mode: 'ranked', size: 4, callerUserId: '' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const ticket = buildTicket(v, { version: '1.0.0', region: 'eu-west-1', rating: 1240, lastRatedAt: Date.now() }, cfg);
    // ratingWindowFor(0) → 100; 1240 ± 100 → 1140..1340
    expect(ticket.query['ratingBand']).toBe('1140-1340');
  });

  it('buildTicket widens the rating window when lastRatedAt is older', () => {
    loadRankedConfig(console as never, RANKED);
    const cfg = getRankedConfig();
    const v = validateTicketInput({ mode: 'ranked', size: 4, callerUserId: '' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const elapsedHours = 7200 * 1000; // 2h ago
    const ticket = buildTicket(v, { version: '1.0.0', region: 'eu-west-1', rating: 1240, lastRatedAt: Date.now() - elapsedHours }, cfg);
    // elapsedSec = 7200 > 3600 → window = 400
    expect(ticket.query['ratingBand']).toBe('840-1640');
  });

  it('buildTicket uses initial rating when lastRatedAt is undefined', () => {
    loadRankedConfig(console as never, RANKED);
    const cfg = getRankedConfig();
    const v = validateTicketInput({ mode: 'ranked', size: 4, callerUserId: '' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const ticket = buildTicket(v, { version: '1.0.0', region: 'eu-west-1' }, cfg);
    // rating = 1000 (initial); window = 100; band = 900..1100
    expect(ticket.query['ratingBand']).toBe('900-1100');
  });

  it('buildTicket honours an explicit segmentBy override (D8)', () => {
    loadRankedConfig(console as never, RANKED);
    const cfg = getRankedConfig();
    const v = validateTicketInput({ mode: 'quick', size: 4, callerUserId: '' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const ticket = buildTicket(v, { version: '1.0.0', region: 'eu-west-1', segmentBy: 'rating' }, cfg);
    expect(ticket.query['segmentBy']).toBe('rating');
    expect(ticket.metadata['segmentBy']).toBe('rating');
  });

  it('buildOutput echoes the stamped values + an empty excludeTrackIds list (D2 placeholder)', () => {
    loadRankedConfig(console as never, RANKED);
    const cfg = getRankedConfig();
    const v = validateTicketInput({ mode: 'ranked', size: 6, callerUserId: '' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const ticket = buildTicket(v, { version: '1.0.0', region: 'eu-west-1' }, cfg);
    const out = buildOutput(v, ticket, { version: '1.0.0', region: 'eu-west-1' });
    expect(out.mode).toBe('ranked');
    expect(out.size).toBe(6);
    expect(out.version).toBe('1.0.0');
    expect(out.region).toBe('eu-west-1');
    expect(out.mm.segmentBy).toBe('none');
    expect(out.constraints?.excludeTrackIds).toEqual([]);
  });

  it('buildTicket metadata carries all the fields the matchmaker needs to identify the ticket', () => {
    loadRankedConfig(console as never, RANKED);
    const cfg = getRankedConfig();
    const v = validateTicketInput({ mode: 'quick', size: 2, callerUserId: '' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const ticket = buildTicket(v, { version: '1.0.0', region: 'eu-west-1' }, cfg);
    expect(ticket.metadata['mode']).toBe('quick');
    expect(ticket.metadata['size']).toBe('2');
    expect(ticket.metadata['version']).toBe('1.0.0');
    expect(ticket.metadata['region']).toBe('eu-west-1');
    expect(ticket.metadata['segmentBy']).toBe('none');
  });

  it('resetRankedConfigForTests is idempotent', () => {
    _resetRankedConfigForTests();
    _resetRankedConfigForTests();
    // After resetting, calling getRankedConfig throws.
    expect(() => getRankedConfig()).toThrow(/not loaded/);
  });
});