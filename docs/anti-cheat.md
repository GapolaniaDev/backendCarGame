# Anti-cheat — CarVideoGameBackend

Server-side detection of impossible race times, abrupt improvement, and
suspicious partials. The detector runs as a non-blocking bus subscriber
on every `RaceCompleted` event; the human review path lives in admin RPCs.

**Phase**: 8 (Chunks 2, 3, 4)
**Source**: `modules/src/anti_cheat/`

---

## 1. Detection helpers (pure)

`modules/src/anti_cheat/detection.ts` exports pure functions over a
closed race. Each returns `DetectedMark[]` (empty when no anomaly):

| Helper | What it catches |
|---|---|
| `detectImpossiblePartialTimes(partials, track)` | A lap below `track.minSectionTimeMs` (1500-3000ms per track). |
| `detectAbruptImprovement(history, totalMs)` | A finish more than `improvementPct` (default 20%) better than the user's last 5 races on the same track+class. |
| `detectPositionGapVsConfidence(results, confidence)` | For `confidence === 'low'`, any player whose rank is ≥3 positions off the quorum (D34). |
| `detectQuorumDisagreement(results)` | A player whose host-reported rank disagrees with quorum (always — used as a tie-breaker). |

All helpers are pure (no I/O, no clock). The thresholds live in
`modules/src/catalogs/anti_cheat_thresholds.json` and load at boot.

### Confidence

`confidence: 'high' | 'low'`. The race close derives it from
`flags.needsReview` (true when the quorum detected disagreement; see
`modules/src/race/state.ts`).

---

## 2. Storage

| Collection | Owner | Schema |
|---|---|---|
| `anti_cheat_marks` | system | `{schemaVersion, userId, marks: [{id, userId, raceId, kind, severity, detectedAt, confirmed, dismissed}]}` |
| `anti_cheat_stats` | system | `{schemaVersion, utcDate, marksTotal, usersHidden, usersConfirmed, byKind: {abrupt_improvement, partial_impossible, ...}}` |
| `anti_cheat_sanctions` | system | `{schemaVersion, userId, startedAt, expiresAt, reason, markIds}` |
| `anti_cheat_partials` | system | `{schemaVersion, userId, raceId, partialsMs, trackId, detectedAt}` |

`permissionRead=1, permissionWrite=0` — server-only writes; the
client never reads these directly.

---

## 3. Subscriber (best-effort)

`modules/src/anti_cheat/subscriber.ts` subscribes to the in-process
`RaceCompleted` event. For every closed session:

1. Loads the user's last 5 races (best times by track+class).
2. Runs all four detectors over the event.
3. For each `DetectedMark`:
   - Appends to `anti_cheat_marks/{userId}/system` (CAS-write, MAX_CAS_RETRIES=3).
   - Updates the daily stats row (`anti_cheat_stats/{utcDate}/system`).
4. Emits `anti_cheat:mark_detected` analytics.

**Best-effort** — the subscriber NEVER throws. A failure in any step
is logged at `warn` and the rest of the bus subscribers continue
unaffected. The bus handler wraps in try/catch (D33).

---

## 4. Quorum rules

When the host's reported rank disagrees with the quorum (D34):

- `confidence === 'low'` AND `|host_rank - quorum_rank| >= 3` → mark
  the player as `partial_impossible` with `severity: 'high'`.
- `confidence === 'low'` AND `|host_rank - quorum_rank| < 3` → mark as
  `position_disagreement` with `severity: 'low'`.
- `confidence === 'high'` → no position-gap mark (the quorum already
  won the disagreement resolution).

The `low-conf + position-gap ≥3` rule is the **only** automatic
sanction path; all other marks are advisory until a human reviewer
confirms them.

---

## 5. Admin RPCs (review + action)

All 6 RPCs use `assertAdminKey` + bypass maintenance + `emitAdminAction`
audit (D35).

| RPC | Purpose |
|---|---|
| `admin_marks_list` | Filter marks by `{userId?, kind?, severity?, status?: 'pending'|'confirmed'|'dismissed'}` |
| `admin_partials_view` | Read `anti_cheat_partials` for a user or race |
| `admin_marks_confirm` | Flip `confirmed: true`; emit `anti_cheat:marks_confirm`; invalidate dashboard cache |
| `admin_marks_dismiss` | Flip `dismissed: true`; requires `reason` (free text); invalidate cache |
| `admin_marks_sanction` | Apply a temporary sanction (1h..30d, or `durationHours: 0` to clear) |
| `admin_anti_cheat_stats_get` | Date-range stats with `startDate`/`endDate` (max 366 days, zero-filled) |

`admin_marks_list` walks the `anti_cheat_marks` collection via
`storageList` (1-arg; no userId filter — operator view, **not** scoped
to one user). Sort: `detectedAt` descending. Cursor pagination.

`admin_marks_sanction` writes `anti_cheat_sanctions/{userId}/system` and
flips any matching `marks` to `sanctioned: true`. `durationHours: 0` clears
the existing sanction (D35).

---

## 6. Live dashboard

`admin_anti_cheat_dashboard_get` (chunk 9) is a **separate** RPC from
`admin_anti_cheat_stats_get`. It returns the live snapshot:

```json
{
  "pendingMarks": 12,
  "confirmedLast7d": 5,
  "dismissedLast7d": 3,
  "sanctionedUsers": 2,
  "topPartialAnomalies": [{"userId": "...", "count": 8}],
  "days": [{"date": "2026-10-08", "stats": {"marksTotal": 7, "usersHidden": 4, "usersConfirmed": 2}}]
}
```

- 60s in-memory TTL cache.
- Invalidated by `admin_marks_confirm`, `admin_marks_dismiss`,
  `admin_marks_sanction`.

---

## 7. Gotchas

- **Subscriber never throws** — it's best-effort. A throw in the bus
  handler would block other subscribers. Wrap every step in try/catch.
- **CAS conflicts are logged at warn, not error** — high concurrency
  on `anti_cheat_marks/{userId}` is normal (many races per second for
  popular tracks). The retry loop re-reads + applies + writes up to 3
  times.
- **`storageList` 1-arg gotcha** — `nk.storageList({collection: 'anti_cheat_marks'})`
  with no userId filter walks ALL marks. The admin RPC filters in
  memory by userId / kind / severity. For > 10K marks, switch to a
  per-user collection (deferred).
- **`admin_marks_sanction.durationHours = 0` clears the sanction**
  (D35) — it does NOT error.
- **Threshold catalog is loaded once at boot** — mutating
  `catalogs/anti_cheat_thresholds.json` requires a bundle rebuild.
