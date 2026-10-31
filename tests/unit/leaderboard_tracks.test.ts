// The time tables (tt_*, lap_*) are track-scoped: leaderboards.json must list
// every track of tracks.json, in the same order, so a track added to the
// game gets its tables (plan B2, D-08).

import { describe, it, expect } from 'vitest';
import leaderboardsJson from '../../modules/src/catalogs/leaderboards.json';
import tracksJson from '../../modules/src/catalogs/tracks.json';

describe('leaderboards.json trackScoped.tracks', () => {
  it('equals the track ids of tracks.json, in the same order', () => {
    const trackIds = (tracksJson as { tracks: Array<{ id: string }> }).tracks.map((t) => t.id);
    expect(leaderboardsJson.trackScoped.tracks).toEqual(trackIds);
  });
});
