// Phase 8 Chunk 5 — Unit tests for the tournaments catalog loader +
// lazy-instance materialisation.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  loadTournamentsCatalog,
  getTournamentTemplates,
  findTournamentTemplate,
  tournamentWindow,
  ensureTournamentsForWindow,
  tournamentState,
  TOURNAMENT_LOOKAHEAD_MS,
  _resetTournamentsCatalogForTests,
} from '../../modules/src/tournaments/catalog';
import {
  readTournamentInstance,
} from '../../modules/src/tournaments/repo';
import type { RawTournamentsFile } from '../../modules/src/tournaments/types';
import { FakeNakama } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
  getFields: () => ({}),
} as unknown as Parameters<typeof loadTournamentsCatalog>[0];

const NOW = Date.now();

function mkFile(
  overrides?: Partial<{ templates: RawTournamentsFile['templates'] }>,
): RawTournamentsFile {
  return {
    version: 1,
    templates: overrides?.templates ?? [
      {
        id: 'past',
        kind: 'time_trial',
        trackId: 'track-A',
        startsAtUtc: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
        endsAtUtc: new Date(NOW - 1 * 60 * 60 * 1000).toISOString(),
        entryFee: 50,
        maxAttempts: 5,
        minLevel: 5,
        prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 100 } }],
      },
      {
        id: 'live',
        kind: 'cup',
        trackId: 'track-A',
        startsAtUtc: new Date(NOW - 1 * 60 * 60 * 1000).toISOString(),
        endsAtUtc: new Date(NOW + 5 * 24 * 60 * 60 * 1000).toISOString(),
        entryFee: 100,
        maxAttempts: 10,
        minLevel: 8,
        prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 500 } }],
      },
      {
        id: 'future',
        kind: 'time_trial',
        trackId: 'track-A',
        startsAtUtc: new Date(NOW + 5 * 24 * 60 * 60 * 1000).toISOString(),
        endsAtUtc: new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString(),
        entryFee: 0,
        maxAttempts: 20,
        minLevel: 1,
        prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 1000 } }],
      },
      {
        id: 'too-far',
        kind: 'club_cup',
        trackId: 'track-A',
        startsAtUtc: new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString(),
        endsAtUtc: new Date(NOW + 35 * 24 * 60 * 60 * 1000).toISOString(),
        entryFee: 0,
        maxAttempts: 100,
        minLevel: 1,
        prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 1000 } }],
      },
    ],
  };
}

beforeEach(() => {
  _resetTournamentsCatalogForTests();
});

describe('tournaments catalog (Phase 8 Chunk 5)', () => {
  describe('loadTournamentsCatalog', () => {
    it('loads + freezes the templates', () => {
      const tpl = loadTournamentsCatalog(SILENT_LOGGER, mkFile());
      expect(tpl).toHaveLength(4);
      const live = tpl.find((t) => t.id === 'live');
      expect(live).toBeDefined();
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (live as unknown as { entryFee: number }).entryFee = 999;
      }).toThrow();
    });

    it('throws on malformed payload', () => {
      expect(() =>
        loadTournamentsCatalog(SILENT_LOGGER, { version: 2, templates: [] }),
      ).toThrow(/version must be 1/);
      expect(() =>
        loadTournamentsCatalog(SILENT_LOGGER, { version: 1, templates: 'nope' }),
      ).toThrow(/must be an array/);
    });

    it('throws when getTournamentTemplates is called before load', () => {
      expect(() => getTournamentTemplates()).toThrow(/not loaded/);
    });
  });

  describe('tournamentWindow', () => {
    it('parses ISO timestamps to epoch ms', () => {
      const tpl = findTournamentTemplateFromFixtures();
      const w = tournamentWindow(tpl);
      expect(Number.isFinite(w.startsAt)).toBe(true);
      expect(Number.isFinite(w.endsAt)).toBe(true);
      expect(w.endsAt).toBeGreaterThan(w.startsAt);
    });
  });

  describe('ensureTournamentInstance + ensureTournamentsForWindow', () => {
    it('returns 0 for an empty catalog', () => {
      loadTournamentsCatalog(SILENT_LOGGER, { version: 1, templates: [] });
      const fake = new FakeNakama();
      const out = ensureTournamentsForWindow(fake.nakama as INakama, NOW);
      expect(out).toHaveLength(0);
    });

    it('materialises templates in window, skips past + too-far', () => {
      loadTournamentsCatalog(SILENT_LOGGER, mkFile());
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      const out = ensureTournamentsForWindow(nk, NOW);
      const ids = out.map((t) => t.id).sort();
      // 'past' expired, 'too-far' > 7d lookahead; 'live' + 'future' returned.
      expect(ids).toEqual(['future', 'live']);
    });

    it('materialises a future template within the lookahead window', () => {
      loadTournamentsCatalog(SILENT_LOGGER, mkFile());
      const fake = new FakeNakama();
      const out = ensureTournamentsForWindow(fake.nakama as INakama, NOW);
      const future = out.find((t) => t.id === 'future');
      expect(future).toBeDefined();
      expect(future?.startsAt).toBeGreaterThan(NOW);
    });

    it('does NOT materialise a template beyond the 7d lookahead', () => {
      loadTournamentsCatalog(SILENT_LOGGER, mkFile());
      const fake = new FakeNakama();
      const out = ensureTournamentsForWindow(fake.nakama as INakama, NOW);
      expect(out.find((t) => t.id === 'too-far')).toBeUndefined();
    });

    it('is idempotent — second call does not duplicate', () => {
      loadTournamentsCatalog(SILENT_LOGGER, mkFile());
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      const first = ensureTournamentsForWindow(nk, NOW);
      const second = ensureTournamentsForWindow(nk, NOW);
      expect(first.map((t) => t.id).sort()).toEqual(['future', 'live']);
      expect(second.map((t) => t.id).sort()).toEqual(['future', 'live']);
      // Storage rows are exactly one per template id.
      expect(readTournamentInstance(nk, 'live')).not.toBeNull();
      expect(readTournamentInstance(nk, 'future')).not.toBeNull();
    });

    it('creates the row with state implicit-open (storage id = TID)', () => {
      loadTournamentsCatalog(SILENT_LOGGER, mkFile());
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      ensureTournamentsForWindow(nk, NOW);
      const live = readTournamentInstance(nk, 'live');
      expect(live).not.toBeNull();
      expect(live?.kind).toBe('cup');
      expect(live?.entryFee).toBe(100);
      expect(live?.maxAttempts).toBe(10);
    });
  });

  describe('tournamentState', () => {
    it('returns "open" within the window, well before end', () => {
      // Closing threshold = last 1h, so 2h remaining is safely "open".
      const t = mkTournament({ startsAt: NOW - 1000, endsAt: NOW + 2 * 60 * 60 * 1000 });
      expect(tournamentState(t, NOW)).toBe('open');
    });

    it('returns "closing" within the last hour', () => {
      const t = mkTournament({
        startsAt: NOW - 1000,
        endsAt: NOW + 30 * 60 * 1000,
      });
      expect(tournamentState(t, NOW)).toBe('closing');
    });

    it('returns "closed" after endsAt', () => {
      const t = mkTournament({
        startsAt: NOW - 60 * 60 * 1000,
        endsAt: NOW - 1000,
      });
      expect(tournamentState(t, NOW)).toBe('closed');
    });
  });

  describe('TOURNAMENT_LOOKAHEAD_MS', () => {
    it('is 7 days', () => {
      expect(TOURNAMENT_LOOKAHEAD_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function findTournamentTemplateFromFixtures() {
  loadTournamentsCatalog(SILENT_LOGGER, mkFile());
  return findTournamentTemplate('live')!;
}

function mkTournament(args: { startsAt: number; endsAt: number }) {
  return {
    schemaVersion: 1,
    id: 'x',
    templateId: 'x',
    kind: 'time_trial' as const,
    trackId: 't',
    startsAt: args.startsAt,
    endsAt: args.endsAt,
    entryFee: 0,
    maxAttempts: 5,
    minLevel: 1,
    prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 100 } }],
    createdAt: 0,
  };
}