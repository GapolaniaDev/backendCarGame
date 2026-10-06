// Phase 6 types — daily/weekly missions + achievements + per-user
// progress records. Schema is `schemaVersion: 1`; any bump requires
// a migration path in `pass_xp` / `achievements` modules.
//
// `MissionKind` enumerates every kind the metrics subscribers can
// match. New kinds must extend this union + add a branch in
// `mission_match.ts` (Chunk 4) and add tests in `mission_match.test.ts`.

export type MissionKind =
  | 'race_count'
  | 'race_position'
  | 'race_track'
  | 'race_class'
  | 'wins_quick'
  | 'wins_ranked'
  | 'race_no_abandon';

export type MissionModeFilter = 'quick' | 'ranked' | 'private' | 'time_trial';
export type MissionClassFilter = 'D' | 'C' | 'B' | 'A' | 'S';
export type MissionSizeFilter = 2 | 4 | 6;

export interface MissionFilter {
  mode?: MissionModeFilter;
  trackId?: string;
  classId?: MissionClassFilter;
  maxPosition?: number;
  size?: MissionSizeFilter;
  requireFirstWinOfDay?: boolean;
}

export interface MissionReward {
  coins?: number;
  xp?: number;
  gems?: number;
  cosmeticId?: string;
}

export interface MissionDefinition {
  id: string;
  title: string;
  description: string;
  kind: MissionKind;
  filters: MissionFilter;
  target: number;
  reward: MissionReward;
  /** Player must be at or above this level to see/claim the mission. */
  unlockLevel: number;
}

export interface MissionInstance {
  /** Stable id — `daily:<missionId>@<dateUtc>` / `weekly:<missionId>@<weekUtc>`. */
  instanceId: string;
  missionId: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
}

export interface DailyMissions {
  schemaVersion: 1;
  userId: string;
  /** UTC date string 'YYYY-MM-DD' — the day this assignment is for. */
  dateUtc: string;
  /** UTC ms when the row was created. */
  assignedAt: number;
  /** Free rerolls left today (D3 = 1/day by default). */
  rerollsLeftToday: number;
  /** UTC ms of last reroll (for analytics). */
  lastRerollAt?: number;
  missions: MissionInstance[];
}

export interface WeeklyMissions {
  schemaVersion: 1;
  userId: string;
  /** ISO week UTC string 'YYYY-Www' (e.g. '2026-W02'). */
  weekUtc: string;
  assignedAt: number;
  rerollsLeftToday: number;
  missions: MissionInstance[];
}

export interface AchievementDefinition {
  id: string;
  title: string;
  description: string;
  kind: MissionKind;
  filters: MissionFilter;
  target: number;
  reward: MissionReward;
}

export interface AchievementsRecord {
  schemaVersion: 1;
  userId: string;
  /** Per-achievementId progress counter (D13). */
  progress: Record<string, number>;
  /** Per-achievementId claimed flag. */
  claimed: Record<string, boolean>;
}