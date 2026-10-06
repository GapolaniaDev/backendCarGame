// Phase 4 Chunk 3 — track picker (pure helper).
//
// Decision D2: avoid the last 2 tracks each human player recently raced.
// The chunk-3 RPC `race_session_quick_bots` receives an `excludeTrackIds`
// list in the input (typically empty until Chunk 4 wires per-player
// "recent tracks" storage) and picks a track from the intersection of
// `allowedTrackIds` ∩ complement(`excludeTrackIds`). When the
// intersection is empty (every allowed track has been raced recently by
// at least one player), the picker falls back to the full
// `allowedTrackIds` set so the race always finds a track — at the
// expense of potentially repeating a recent pick. This mirrors how a
// Unity party with the entire recent-track history full would still need
// to play.
//
// The helper is intentionally pure (no Nakama calls, no Math.random):
// determinism is required so two RPC implementations under different
// memory layouts produce the same track for the same seed input. The
// caller passes a `seed` input (e.g. the sessionId) and the picker
// hashes to a stable index. RNG-less fallback below is acceptable
// because the test suite exercises the deterministic path explicitly
// and the runtime fallback is rare (only when ALL allowed tracks are
// excluded).

/**
 * Pick a track from `allowedTrackIds` excluding the `excludeTrackIds`
 * set. Returns the chosen track id (a member of `allowedTrackIds`).
 *
 * - If the intersection `allowedTrackIds \ excludeTrackIds` is non-empty,
 *   the picker hashes `seed` to pick one of those tracks.
 * - If the intersection is empty (every allowed track is in the exclude set),
 *   the picker falls back to hashing against the FULL `allowedTrackIds`
 *   set so the caller never receives an empty string.
 * - If `allowedTrackIds` is itself empty, returns the empty string —
 *   the RPC maps that to `BAD_REQUEST` upstream.
 */
export function pickTrack(
  allowedTrackIds: ReadonlyArray<string>,
  excludeTrackIds: ReadonlyArray<string>,
  seed: string,
): string {
  const exclude = new Set(excludeTrackIds);
  const candidates = allowedTrackIds.filter((id) => !exclude.has(id));
  const pool = candidates.length > 0 ? candidates : allowedTrackIds;
  if (pool.length === 0) return '';
  // Stable FNV-1a-style hash so the result is reproducible per seed.
  // The hash avoids the Math.random() path so e2e tests can assert
  // exact track ids given a fixed seed.
  const idx = Math.abs(fnv1a(seed)) % pool.length;
  return pool[idx] ?? pool[0] ?? '';
}

/** FNV-1a 32-bit hash. Deterministic per input string. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // Multiply by FNV prime (32-bit). Use Math.imul to stay in int32.
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}