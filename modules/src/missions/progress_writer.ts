// Phase 6 Chunk 4 — pure progress writers.
//
// These helpers transform in-memory records; they do NOT touch storage.
// The subscriber (`subscriber.ts`) is the orchestrator that reads,
// applies, and CAS-persists the result.
//
// Three responsibilities:
//   1. `applyIncrementsToMissions`  — sum increments into per-instance
//      progress (capped at target), preserve `claimed` flag.
//   2. `applyIncrementsToAchievements` — sum increments into the
//      achievements progress map (no `completed`/`claimed` fields on
//      achievements; the subscriber derives completion from `>= target`).
//   3. `markCompletedIfReached` + `newlyCompleted` — flip `completed`
//      when progress hits the target; report which missionIds
//      transitioned so the subscriber can emit analytics.

import type {
  AchievementDefinition,
  MissionDefinition,
  MissionInstance,
  AchievementsRecord,
} from './types';

// ─── Mission progress ───────────────────────────────────────────────────────

/**
 * Pure: apply `increments` (per instanceId) to `missions`, returning a
 * NEW array. Inputs are not mutated. Progress is capped at the
 * instance's target (looking up the definition by missionId). `claimed`
 * is preserved — `claimDailyMission` / `claimWeeklyMission` are the
 * only writers.
 *
 * Mission instances that have already been `claimed` are kept as-is
 * (no further progress mutations).
 */
export function applyIncrementsToMissions(
  missions: ReadonlyArray<MissionInstance>,
  definitions: ReadonlyArray<MissionDefinition>,
  increments: ReadonlyMap<string, number>,
): MissionInstance[] {
  if (increments.size === 0) return missions.slice();
  const defById = new Map<string, MissionDefinition>();
  for (const d of definitions) defById.set(d.id, d);

  const out: MissionInstance[] = missions.map((m) => {
    const inc = increments.get(m.instanceId);
    if (inc === undefined || inc <= 0) return m;
    if (m.claimed) return m; // idempotency: claim already done, do not mutate
    const def = defById.get(m.missionId);
    const target = def?.target ?? m.progress + inc;
    const next = Math.min(target, m.progress + inc);
    return { ...m, progress: next };
  });
  return out;
}

/**
 * Pure: for each mission, set `completed=true` iff progress >= target.
 * Preserves `claimed` (claim is the only writer for that flag).
 */
export function markCompletedIfReached(
  missions: ReadonlyArray<MissionInstance>,
  definitions: ReadonlyArray<MissionDefinition>,
): MissionInstance[] {
  const defById = new Map<string, MissionDefinition>();
  for (const d of definitions) defById.set(d.id, d);
  return missions.map((m) => {
    if (m.completed) return m;
    const def = defById.get(m.missionId);
    const target = def?.target ?? Number.POSITIVE_INFINITY;
    if (m.progress >= target) {
      return { ...m, completed: true };
    }
    return m;
  });
}

/**
 * Returns the set of `missionId`s that flipped from `completed=false`
 * to `completed=true` between `before` and `after`. Order is
 * preserved. Mission instances whose `missionId` is absent from one
 * side are skipped (defensive — caller is expected to align the two
 * arrays by instanceId/missionId).
 */
export function newlyCompleted(
  before: ReadonlyArray<MissionInstance>,
  after: ReadonlyArray<MissionInstance>,
): string[] {
  const flipped: string[] = [];
  const afterByInstance = new Map<string, MissionInstance>();
  for (const m of after) afterByInstance.set(m.instanceId, m);
  for (const b of before) {
    if (b.completed) continue;
    const a = afterByInstance.get(b.instanceId);
    if (a === undefined) continue;
    if (!a.completed) continue;
    flipped.push(b.missionId);
  }
  return flipped;
}

// ─── Achievements progress ──────────────────────────────────────────────────

/**
 * Pure: sum `increments` into the `progress` map of an achievements
 * record. Returns a NEW record (input not mutated). Entries that are
 * not in the catalog are still summed (the catalog may add new
 * achievements between subscriber runs and old progress should not be
 * lost; the subscriber always re-reads the catalog at apply time).
 *
 * Achievements have no `claimed` field in the storage record — the
 * subscriber's claim flow (Chunk 5) tracks per-achievementId claims
 * via `record.claimed[achievementId]` and decrements the same map on
 * claim. The writer here never touches that field.
 */
export function applyIncrementsToAchievements(
  record: AchievementsRecord,
  _definitions: ReadonlyArray<AchievementDefinition>,
  increments: ReadonlyMap<string, number>,
): AchievementsRecord {
  if (increments.size === 0) return record;
  const nextProgress: Record<string, number> = { ...record.progress };
  for (const [id, inc] of increments) {
    if (inc <= 0) continue;
    const cur = nextProgress[id] ?? 0;
    nextProgress[id] = cur + inc;
  }
  return {
    ...record,
    progress: nextProgress,
  };
}

/**
 * Pure: returns the set of achievement IDs whose progress reached
 * the target for the first time. Caller is responsible for emitting
 * the `achievement_unlocked` analytics event.
 */
export function newlyCompletedAchievements(
  record: AchievementsRecord,
  definitions: ReadonlyArray<AchievementDefinition>,
): string[] {
  const claimed = record.claimed;
  const flipped: string[] = [];
  for (const def of definitions) {
    if (claimed[def.id] === true) continue;
    const progress = record.progress[def.id] ?? 0;
    if (progress >= def.target) flipped.push(def.id);
  }
  return flipped;
}