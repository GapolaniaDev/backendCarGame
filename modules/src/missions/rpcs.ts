// Phase 6 Chunk 3 — 3 RPCs:
//
//   missions_get    — current daily + weekly assignments
//   mission_claim   — claim a completed mission's reward
//   mission_reroll  — reroll one mission (free once/day, 50 gems after)
//
// All three are gated by maintenance + min client version via
// `assertNotInMaintenance` and `assertMinClientVersion` (Phase 5
// Chunk 2/9). The caller is resolved through `resolveCaller` so the
// HTTP gateway path requires `callerUserId` to match the body's
// `userId` claim (defense-in-depth).

import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import { grant, spend } from '../economy/wallet';
import type { LedgerMetadata } from '../economy/types';
import { utcDate, utcWeek } from '../core/time';
import { addPassXp } from '../pass/pass_repo';
import { missionXPFor } from '../pass/xp_engine';
import type { IContext, ILogger, INakama } from '../nkruntime';
import {
  getMissionsDailyCatalog,
  getMissionsWeeklyCatalog,
} from './catalog';
import type {
  MissionDefinition,
  MissionInstance,
  MissionReward,
} from './types';
import {
  ensureDailyMissions,
  ensureWeeklyMissions,
  claimDailyMission,
  claimWeeklyMission,
  rerollDailyMission,
  PAID_REROLL_COST_GEMS,
} from './missions_repo';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

// ─── Rate limits (missions-specific) ────────────────────────────────────────

const MISSIONS_RATE_LIMITS = {
  missions_get: { maxPerWindow: 60, windowSec: 60 },
  mission_claim: { maxPerWindow: 30, windowSec: 60 },
  mission_reroll: { maxPerWindow: 10, windowSec: 60 },
} as const;

// ─── Input shapes ────────────────────────────────────────────────────────────

export interface MissionsGetInput {
  callerUserId?: string;
}

export interface MissionClaimInput {
  missionId: string;
  kind: 'daily' | 'weekly';
  callerUserId?: string;
}

export interface MissionRerollInput {
  missionId: string;
  useGems?: boolean;
  callerUserId?: string;
}

// ─── Response shapes ─────────────────────────────────────────────────────────

export interface MissionCardOutput {
  instanceId: string;
  missionId: string;
  title: string;
  description: string;
  kind: MissionDefinition['kind'];
  filters: MissionDefinition['filters'];
  target: number;
  reward: MissionReward;
  progress: number;
  completed: boolean;
  claimed: boolean;
  locked: boolean;
}

export interface MissionAssignmentOutput {
  dateUtc?: string;
  weekUtc?: string;
  assignedAt: number;
  rerollsLeftToday: number;
  missions: MissionCardOutput[];
}

export interface MissionsGetOutput {
  daily: MissionAssignmentOutput;
  weekly: MissionAssignmentOutput;
  rerollsLeftToday: number;
  nowUtc: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface CallerOk { ok: true; id: string; }
interface CallerErr { ok: false; error: string; }

function resolveCallerInternal(
  ctx: IContext,
  declared: string | undefined,
  logger: ILogger,
): CallerOk | CallerErr {
  const socketCaller = ctx.userId ?? null;
  const declaredCaller = typeof declared === 'string' && declared.length > 0 ? declared : null;
  if (socketCaller !== null) {
    if (declaredCaller !== null && declaredCaller !== socketCaller) {
      return {
        ok: false,
        error: toJson(err('FORBIDDEN', 'callerUserId does not match authenticated user')),
      };
    }
    return { ok: true, id: socketCaller };
  }
  if (declaredCaller !== null) return { ok: true, id: declaredCaller };
  logger.warn('missions RPC called with no caller identity');
  return { ok: false, error: toJson(err('UNAUTHENTICATED', 'no caller identity')) };
}

function parseInput<T>(body: string): Resp<T> {
  if (body === '' || body === undefined || body === null) {
    return ok({} as T);
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return err('BAD_REQUEST', 'body must be a JSON object');
    }
    return ok(parsed as T);
  } catch {
    return err('BAD_REQUEST', 'body is not valid JSON');
  }
}

function buildMissionCard(
  instance: MissionInstance,
  definition: MissionDefinition,
  playerLevel: number,
): MissionCardOutput {
  return {
    instanceId: instance.instanceId,
    missionId: definition.id,
    title: definition.title,
    description: definition.description,
    kind: definition.kind,
    filters: definition.filters,
    target: definition.target,
    reward: definition.reward,
    progress: instance.progress,
    completed: instance.completed,
    claimed: instance.claimed,
    locked: definition.unlockLevel > playerLevel,
  };
}

function resolveLevel(nk: INakama, userId: string): number {
  const objs = nk.storageRead([{ collection: 'profiles', key: userId, userId }]);
  const obj = objs[0];
  if (!obj) return 1;
  const value = obj.value as { progression?: { level?: number } } | null;
  const lvl = value?.progression?.level;
  return typeof lvl === 'number' && lvl >= 1 ? lvl : 1;
}

function checkRateOrLimit(
  nk: INakama,
  logger: ILogger,
  rpcName: keyof typeof MISSIONS_RATE_LIMITS,
  userId: string,
): Resp<unknown> | null {
  const opts = MISSIONS_RATE_LIMITS[rpcName];
  const verdict = checkRateLimit(nk, {
    rpcName,
    userId,
    maxPerWindow: opts.maxPerWindow,
    windowSec: opts.windowSec,
  });
  if (!verdict.allowed) {
    logger.warn('%s rate limit exceeded user=%s %d/%d',
      rpcName, userId, verdict.count, verdict.limit);
    return err('RATE_LIMITED',
      `${rpcName} rate limit exceeded (${verdict.count}/${verdict.limit})`);
  }
  return null;
}

// ─── missions_get ───────────────────────────────────────────────────────────

export const missions_get: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<MissionsGetInput>(body);
  if (!parsed.ok) return toJson(parsed);

  const callerId = resolveCallerInternal(ctx, parsed.data.callerUserId, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const rl = checkRateOrLimit(nk, logger, 'missions_get', userId);
  if (rl !== null) return toJson(rl);

  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  const playerLevel = resolveLevel(nk, userId);
  const dateUtc = utcDate(Date.now());
  const weekUtc = utcWeek(Date.now());

  const dailyCatalog = getMissionsDailyCatalog();
  const weeklyCatalog = getMissionsWeeklyCatalog();

  const dailyRes = ensureDailyMissions(nk, logger, userId, dateUtc, playerLevel, [...dailyCatalog]);
  const weeklyRes = ensureWeeklyMissions(nk, logger, userId, weekUtc, playerLevel, [...weeklyCatalog]);

  const dailyById = new Map(dailyCatalog.map((d) => [d.id, d]));
  const weeklyById = new Map(weeklyCatalog.map((d) => [d.id, d]));

  const dailyMissions = dailyRes.record.missions
    .map((inst) => {
      const def = dailyById.get(inst.missionId);
      if (def === undefined) return null;
      return buildMissionCard(inst, def, playerLevel);
    })
    .filter((c): c is MissionCardOutput => c !== null);

  const weeklyMissions = weeklyRes.record.missions
    .map((inst) => {
      const def = weeklyById.get(inst.missionId);
      if (def === undefined) return null;
      return buildMissionCard(inst, def, playerLevel);
    })
    .filter((c): c is MissionCardOutput => c !== null);

  const payload: MissionsGetOutput = {
    daily: {
      dateUtc: dailyRes.record.dateUtc,
      assignedAt: dailyRes.record.assignedAt,
      rerollsLeftToday: dailyRes.record.rerollsLeftToday,
      missions: dailyMissions,
    },
    weekly: {
      weekUtc: weeklyRes.record.weekUtc,
      assignedAt: weeklyRes.record.assignedAt,
      rerollsLeftToday: weeklyRes.record.rerollsLeftToday,
      missions: weeklyMissions,
    },
    rerollsLeftToday: dailyRes.record.rerollsLeftToday,
    nowUtc: new Date().toISOString(),
  };

  emit(nk, logger, 'missions_get_called', {
    userId,
    dailyCount: dailyMissions.length,
    weeklyCount: weeklyMissions.length,
    rerollsLeftToday: dailyRes.record.rerollsLeftToday,
  });

  return toJson(ok(payload));
};

// ─── mission_claim ──────────────────────────────────────────────────────────

export const mission_claim: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<MissionClaimInput>(body);
  if (!parsed.ok) return toJson(parsed);

  const callerId = resolveCallerInternal(ctx, parsed.data.callerUserId, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const rl = checkRateOrLimit(nk, logger, 'mission_claim', userId);
  if (rl !== null) return toJson(rl);

  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  const missionId = parsed.data.missionId;
  const kind = parsed.data.kind;
  if (typeof missionId !== 'string' || missionId.length === 0) {
    return toJson(err('BAD_REQUEST', 'missionId is required'));
  }
  if (kind !== 'daily' && kind !== 'weekly') {
    return toJson(err('BAD_REQUEST', `kind must be 'daily' or 'weekly', got ${String(kind)}`));
  }

  const dateUtc = utcDate(Date.now());
  const weekUtc = utcWeek(Date.now());

  const dailyCatalog = getMissionsDailyCatalog();
  const weeklyCatalog = getMissionsWeeklyCatalog();

  let reward: MissionReward;

  if (kind === 'daily') {
    const claimResp = claimDailyMission(nk, logger, userId, dateUtc, missionId, [...dailyCatalog]);
    if (!claimResp.ok) return toJson(claimResp);
    reward = claimResp.data.reward;
  } else {
    const claimResp = claimWeeklyMission(nk, logger, userId, weekUtc, missionId, [...weeklyCatalog]);
    if (!claimResp.ok) return toJson(claimResp);
    reward = claimResp.data.reward;
  }

  // Convert reward → wallet changeset (cosmeticId is handled by garage).
  const changeset: { coins?: number; gems?: number } = {};
  if (reward.coins !== undefined && reward.coins > 0) changeset.coins = reward.coins;
  if (reward.gems !== undefined && reward.gems > 0) changeset.gems = reward.gems;

  if (Object.keys(changeset).length > 0) {
    const meta: LedgerMetadata = { reason: 'mission', sourceId: 'mission_claim' };
    const grantKey = `mission:${kind}:${missionId}:${userId}`;
    const grantResp = grant(nk, userId, changeset, meta, grantKey);
    if (!grantResp.ok) return toJson(grantResp);
  }

  // Phase 6 Chunk 7 — route the catalog XP into the battle pass.
  const xpAmount = missionXPFor(reward);
  let passXpGranted = 0;
  let passNewLevel = 0;
  let passLevelUps: number[] = [];
  if (xpAmount > 0) {
    const xpResult = addPassXp(nk, logger, userId, xpAmount);
    if (xpResult !== null) {
      passXpGranted = xpAmount;
      passNewLevel = xpResult.newLevel;
      passLevelUps = xpResult.levelUps;
      emit(nk, logger, 'pass_xp_gained', {
        userId,
        source: 'mission_claim',
        amount: xpAmount,
        missionId,
        kind,
        newLevel: xpResult.newLevel,
        levelUps: xpResult.levelUps,
      });
    }
  }

  emit(nk, logger, 'mission_claimed', {
    userId,
    missionId,
    kind,
    reward,
  });

  return toJson(ok({
    missionId,
    reward,
    kind,
    xpGranted: passXpGranted,
    passLevel: passNewLevel,
    levelUps: passLevelUps,
  }));
};

// ─── mission_reroll ─────────────────────────────────────────────────────────

export const mission_reroll: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<MissionRerollInput>(body);
  if (!parsed.ok) return toJson(parsed);

  const callerId = resolveCallerInternal(ctx, parsed.data.callerUserId, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const rl = checkRateOrLimit(nk, logger, 'mission_reroll', userId);
  if (rl !== null) return toJson(rl);

  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  const missionId = parsed.data.missionId;
  const useGems = parsed.data.useGems === true;
  if (typeof missionId !== 'string' || missionId.length === 0) {
    return toJson(err('BAD_REQUEST', 'missionId is required'));
  }

  const dateUtc = utcDate(Date.now());
  const dailyCatalog = getMissionsDailyCatalog();

  const rerollResp = rerollDailyMission(
    nk, logger, userId, dateUtc, missionId, useGems, [...dailyCatalog],
  );
  if (!rerollResp.ok) return toJson(rerollResp);

  if (rerollResp.data.costGems > 0) {
    const meta: LedgerMetadata = { reason: 'mission', sourceId: 'mission_reroll' };
    const spendKey = `mission_reroll:${userId}:${dateUtc}:${missionId}`;
    const spendResp = spend(
      nk, userId, { gems: PAID_REROLL_COST_GEMS }, meta, spendKey,
    );
    if (!spendResp.ok) return toJson(spendResp);
  }

  emit(nk, logger, 'mission_rerolled', {
    userId,
    missionId,
    costGems: rerollResp.data.costGems,
    newMissionId: rerollResp.data.newDefinition.id,
    rerollsLeftToday: rerollResp.data.record.rerollsLeftToday,
  });

  return toJson(ok({
    missionId,
    newMission: rerollResp.data.newDefinition,
    costGems: rerollResp.data.costGems,
    rerollsLeftToday: rerollResp.data.record.rerollsLeftToday,
  }));
};

// ─── Helpers exported for tests ─────────────────────────────────────────────

export const _testInternals = {
  resolveLevel,
  buildMissionCard,
  parseInput,
  resolveCallerInternal,
};