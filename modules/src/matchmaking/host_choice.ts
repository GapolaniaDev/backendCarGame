// Phase 4 Chunk 3 — host choice (pure helper).
//
// Used by `race_session_quick_bots` (and later the host-claim logic in
// Chunk 4) to decide which human player becomes the session's host.
// The host is always a HUMAN — bots cannot host because they don't have
// a real socket connection that can attest bot reports.
//
// Decision: host = human with the lowest rttMs. Ties resolve to the
// lexicographically smallest userId (stable, no Math.random). When the
// roster contains exactly one human, that human is the host
// regardless of rttMs.

export interface HumanEntry {
  userId: string;
  /** Round-trip-time in ms. Defaults to 9999 when undefined. */
  rttMs?: number;
}

const MAX_RTT = 9999;

/**
 * Pick the human with the lowest rttMs. Ties resolve to the
 * lexicographically smallest userId. Bots are ignored — only entries
 * the caller passes are considered humans.
 *
 * Throws when the input is empty (caller's bug — the RPC layer ensures
 * at least one human is present).
 */
export function pickHost(roster: ReadonlyArray<HumanEntry>): string {
  if (roster.length === 0) {
    throw new Error('pickHost: empty roster');
  }
  let best = roster[0]!;
  let bestRtt = best.rttMs ?? MAX_RTT;
  for (let i = 1; i < roster.length; i += 1) {
    const entry = roster[i]!;
    const rtt = entry.rttMs ?? MAX_RTT;
    if (rtt < bestRtt || (rtt === bestRtt && entry.userId < best.userId)) {
      best = entry;
      bestRtt = rtt;
    }
  }
  return best.userId;
}

/**
 * Order the humans by ascending rttMs (lowest first). The first entry
 * is the host candidate. Ties resolve to lexicographically smallest
 * userId. Used to populate `hostSuccession` on the session record so
 * the host-claim logic (Chunk 4) can promote the next human when the
 * current host disconnects.
 */
export function pickHostSuccession(roster: ReadonlyArray<HumanEntry>): string[] {
  const sorted = [...roster].sort((a, b) => {
    const ra = a.rttMs ?? MAX_RTT;
    const rb = b.rttMs ?? MAX_RTT;
    if (ra !== rb) return ra - rb;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  return sorted.map((e) => e.userId);
}