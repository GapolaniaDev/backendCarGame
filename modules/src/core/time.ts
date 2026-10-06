// Phase 6 — UTC date / week / reset helpers.
//
// All time maths here is UTC. Local timezones are NEVER consulted
// because (a) Nakama doesn't expose the client's tz and (b) UTC
// resets give every player the same weekly / daily clock regardless
// of where they live.
//
// Used by:
//   - missions/catalog.ts  — daily/weekly assignment
//   - missions/storage.ts  — lastAssignedAt comparison (D12)
//   - pass/season.ts       — season end checks (D11)

/** Returns 'YYYY-MM-DD' UTC for the given epoch ms. */
export function utcDate(dateMs: number): string {
  const d = new Date(dateMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Server-side wall clock in epoch milliseconds. Centralized here so
 * every time stamp in the bundle derives from one function (which
 * simplifies future clock skew handling).
 */
export function serverNowMs(): number {
  return Date.now();
}

/**
 * Returns ISO 8601 week string 'YYYY-Www' in UTC for the given epoch
 * ms. E.g. '2026-W02'. The week starts on Monday.
 */
export function utcWeek(dateMs: number): string {
  const d = new Date(dateMs);
  // ISO week algorithm — copy target into a Date at UTC midnight
  // Thursday of the same ISO week, then extract from there.
  const target = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
  ));
  // Day-of-week: 0 = Sun, 1 = Mon, …, 6 = Sat. ISO wants Mon=1..Sun=7.
  const dayNum = (target.getUTCDay() + 6) % 7 + 1;
  // Move to the Thursday of the same ISO week (ISO 8601 §3.4.2).
  target.setUTCDate(target.getUTCDate() + (4 - dayNum));
  const year = target.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(
    (((target.getTime() - jan1.getTime()) / 86_400_000) + 1) / 7,
  );
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

/** Returns the UTC ms timestamp of the next UTC midnight after `dateMs`. */
export function utcNextResetMs(dateMs: number): number {
  const d = new Date(dateMs);
  return Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0,
  );
}

/**
 * Returns the UTC ms timestamp of the next Monday 00:00 UTC at or
 * after `dateMs`. When `dateMs` itself lands on Monday 00:00 UTC, the
 * helper returns `dateMs` (idempotent week boundary).
 */
export function utcNextWeekResetMs(dateMs: number): number {
  const d = new Date(dateMs);
  const dayOfWeek = d.getUTCDay(); // 0 = Sun, 1 = Mon
  // Days until next Monday at-or-after today:
  const daysUntilMonday = dayOfWeek === 1 ? 0 : (8 - dayOfWeek) % 7;
  // Special case: Sunday (0) → 1 day; Mon (1) → 0; Tue (2) → 6; …
  const delta = dayOfWeek === 0 ? 1
              : dayOfWeek === 1 ? 0
              : (8 - dayOfWeek);
  return Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + delta, 0, 0, 0, 0,
  );
}