// Every track id referenced by the content catalogs (events, tournaments,
// missions, achievements) must exist in tracks.json. A dangling reference
// would make a mission, event or tournament point at a track that cannot be raced.

import { describe, it, expect } from 'vitest';
import tracksJson from '../../modules/src/catalogs/tracks.json';
import eventsJson from '../../modules/src/catalogs/events.json';
import tournamentsJson from '../../modules/src/catalogs/tournaments.json';
import missionsDailyJson from '../../modules/src/catalogs/missions_daily.json';
import missionsWeeklyJson from '../../modules/src/catalogs/missions_weekly.json';
import achievementsJson from '../../modules/src/catalogs/achievements.json';

interface TrackRef {
  file: string;
  trackId: string;
}

interface WithFilters {
  filters?: { trackId?: string };
}

function collectFilterRefs(file: string, entries: WithFilters[] | undefined): TrackRef[] {
  const refs: TrackRef[] = [];
  for (const entry of entries ?? []) {
    const trackId = entry.filters?.trackId;
    if (typeof trackId === 'string') refs.push({ file, trackId });
  }
  return refs;
}

function collectAllRefs(): TrackRef[] {
  const refs: TrackRef[] = [];

  const events = (eventsJson as { events?: Array<{ payload?: { trackId?: string } }> }).events ?? [];
  for (const event of events) {
    const trackId = event.payload?.trackId;
    if (typeof trackId === 'string') refs.push({ file: 'events.json', trackId });
  }

  const templates = (tournamentsJson as { templates?: Array<{ trackId?: string }> }).templates ?? [];
  for (const template of templates) {
    if (typeof template.trackId === 'string') refs.push({ file: 'tournaments.json', trackId: template.trackId });
  }

  refs.push(...collectFilterRefs('missions_daily.json', (missionsDailyJson as { missions?: WithFilters[] }).missions));
  refs.push(...collectFilterRefs('missions_weekly.json', (missionsWeeklyJson as { missions?: WithFilters[] }).missions));
  refs.push(...collectFilterRefs('achievements.json', (achievementsJson as { achievements?: WithFilters[] }).achievements));

  return refs;
}

describe('catalog track references', () => {
  it('every trackId referenced by events, tournaments, missions and achievements exists in tracks.json', () => {
    const trackIds = new Set((tracksJson as { tracks: Array<{ id: string }> }).tracks.map((t) => t.id));
    const refs = collectAllRefs();
    expect(refs.length).toBeGreaterThan(0);

    const missing = refs
      .filter((r) => !trackIds.has(r.trackId))
      .map((r) => `${r.trackId} (${r.file})`);

    expect([...new Set(missing)], `track ids missing from tracks.json: ${missing.join(', ')}`).toEqual([]);
  });
});
