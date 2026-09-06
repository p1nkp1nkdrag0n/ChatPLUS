import { createHash } from "node:crypto";

import {
  DailyLifeContextSchema,
  DailyLifeIntentSchema,
  LifeOutcomeSchema,
  LifeThreadSchema,
  type CharacterGoal,
  type CharacterGoalMilestone,
  type CharacterSpec,
  type DailyLifeContext,
  type DailyLifeIntent,
  type DayPeriod,
  type LifeDomain,
  type LifeOutcome,
  type LifeThread,
  type LifeThreadClock,
  type LifeThreadTimelinePlan,
  type RuntimeState,
} from "@personasim/contracts";
import {
  projectCharacterTime,
  seededUnit,
  stableId,
} from "@personasim/features";
import { DateTime } from "luxon";

import type { DatabaseStore } from "../db/store.js";
import { buildTimeBasedGoalMilestones } from "../domain/defaults.js";

interface DailyIntentSeed {
  title: string;
  summary: string;
  domain: LifeDomain;
  period: DayPeriod;
  sourceKind: "goal" | "routine" | "spontaneous";
  importance: number;
  goalRefIds: string[];
  threadIds: string[];
}

export function createDailyLifeContext(input: {
  agentId: string;
  spec: CharacterSpec;
  state: RuntimeState;
  threads: readonly LifeThread[];
  intents: readonly DailyLifeIntent[];
  localDate: string;
  localHour: number;
  currentPressureEpisodeIds: string[];
  recentOutcomeIds: string[];
  atUtc: string;
}): DailyLifeContext {
  const currentPeriod = dayPeriod(input.localHour);
  return DailyLifeContextSchema.parse({
    id: stableId(
      "life_day",
      `${input.agentId}:${input.localDate}:${input.spec.version}`,
    ),
    agentId: input.agentId,
    localDate: input.localDate,
    timezone: input.spec.identity.timezone,
    status: "active",
    currentPeriod,
    availability: availabilityFor(input.state),
    availabilityConfidence: "inferred",
    theme:
      input.threads[0]?.title ??
      (input.spec.compilationPolicyVersion === "companion_character_v2"
        ? undefined
        : input.spec.persona.goals[0]?.title),
    currentFocus: focusForPeriod(input.intents, currentPeriod),
    todayFocus: input.intents.map((intent) => intent.title),
    intentIds: input.intents.map((intent) => intent.id),
    activeThreadIds: input.threads.map((thread) => thread.id),
    currentPressureEpisodeIds: input.currentPressureEpisodeIds,
    recentOutcomeIds: input.recentOutcomeIds,
    revision: 1,
    schemaVersion: 1,
    createdAtUtc: input.atUtc,
    updatedAtUtc: input.atUtc,
  });
}

export function refreshDailyLifeContext(input: {
  context: DailyLifeContext;
  state: RuntimeState;
  intents: readonly DailyLifeIntent[];
  threads: readonly LifeThread[];
  localHour: number;
  currentPressureEpisodeIds: string[];
  recentOutcomeIds: string[];
  atUtc: string;
}): DailyLifeContext {
  const currentPeriod = dayPeriod(input.localHour);
  const availability = availabilityFor(input.state);
  const currentFocus = focusForPeriod(input.intents, currentPeriod);
  const activeThreadIds = input.threads.map((thread) => thread.id);
  const changed =
    input.context.currentPeriod !== currentPeriod ||
    input.context.availability !== availability ||
    input.context.currentFocus !== currentFocus ||
    JSON.stringify(input.context.activeThreadIds) !==
      JSON.stringify(activeThreadIds) ||
    JSON.stringify(input.context.currentPressureEpisodeIds) !==
      JSON.stringify(input.currentPressureEpisodeIds) ||
    JSON.stringify(input.context.recentOutcomeIds) !==
      JSON.stringify(input.recentOutcomeIds);
  if (!changed) return input.context;
  return DailyLifeContextSchema.parse({
    ...input.context,
    currentPeriod,
    availability,
    currentFocus,
    activeThreadIds,
    currentPressureEpisodeIds: input.currentPressureEpisodeIds,
    recentOutcomeIds: input.recentOutcomeIds,
    revision: input.context.revision + 1,
    updatedAtUtc: input.atUtc,
  });
}

export function settleDailyLifeContext(
  context: DailyLifeContext,
  outcomeIds: string[],
  atUtc: string,
): DailyLifeContext {
  return DailyLifeContextSchema.parse({
    ...context,
    status: "settled",
    recentOutcomeIds: outcomeIds.slice(0, 8),
    revision: context.revision + 1,
    updatedAtUtc: atUtc,
  });
}

export function buildDeterministicLifeOutcome(input: {
  agentId: string;
  intent: DailyLifeIntent;
  evidenceId: string;
  effectiveLocalDate: string;
  recordedAtUtc: string;
}): LifeOutcome {
  const outcomeKind = seededOutcome(input.intent.id);
  const summary = outcomeSummary(input.intent.title, outcomeKind);
  return LifeOutcomeSchema.parse({
    id: stableId("life_outcome", input.intent.id),
    agentId: input.agentId,
    intentId: input.intent.id,
    outcomeKind,
    summary,
    outcomeFacts: [summary],
    origin: "simulation",
    threadIds: input.intent.threadIds,
    sourceEvidenceIds: [input.evidenceId],
    importance: input.intent.importance,
    effectiveLocalDate: input.effectiveLocalDate,
    temporalPrecision: "day",
    recordedAtUtc: input.recordedAtUtc,
    idempotencyKey: `life-outcome:${input.intent.id}`,
    schemaVersion: 1,
  });
}

export function freezeTimelinePlan(
  spec: CharacterSpec,
  goal: CharacterGoal,
  anchorUtc: string,
): LifeThreadTimelinePlan {
  const milestones = structuredClone(timeMilestonesForGoal(goal));
  const timeBasis = timelineClockForCharacter(spec, anchorUtc);
  const origin: LifeThreadTimelinePlan["origin"] =
    goal.milestones === undefined ? "legacy_fallback_v1" : "character_spec";
  const unsigned: Omit<LifeThreadTimelinePlan, "planSha256"> = {
    schemaVersion: 1 as const,
    sourceGoalId: goal.id,
    sourceCharacterVersion: spec.version,
    origin,
    timeBasis,
    milestones,
  };
  return {
    ...unsigned,
    planSha256: hashTimelinePlan(unsigned),
  };
}

export function createEvidenceDrivenGoalThread(
  spec: CharacterSpec,
  goal: CharacterGoal,
  atUtc: string,
): LifeThread {
  const key = `life-thread:${spec.id}:goal:${goal.id}`;
  const localDate = projectCharacterTime(spec.identity, atUtc).localDate;
  return LifeThreadSchema.parse({
    id: stableId("life_thread", key),
    agentId: spec.id,
    subject: "character",
    title: goal.title,
    summary: goal.description,
    domain: inferDomain(`${goal.title} ${goal.description}`),
    status: "active",
    progressionPolicy: "evidence_driven_v2",
    sourceGoalId: goal.id,
    sourceCharacterVersion: spec.version,
    currentStage: "当前关注",
    progressNote: goal.description,
    nextStepHint: "根据实际投入与处境决定是否继续、暂停或调整。",
    startedLocalDate: localDate,
    sourceMessageIds: [],
    idempotencyKey: key,
    revision: 1,
    schemaVersion: 3,
    createdAtUtc: atUtc,
    updatedAtUtc: atUtc,
  });
}

/** A day's result may change the current focus; it never proves the whole goal is complete. */
export function projectGoalThreadOutcome(
  thread: LifeThread,
  outcome: LifeOutcome,
  atUtc: string,
): LifeThread | undefined {
  if (
    thread.progressionPolicy !== "evidence_driven_v2" ||
    thread.agentId !== outcome.agentId ||
    !outcome.threadIds.includes(thread.id) ||
    outcome.sourceEvidenceIds.length === 0 ||
    thread.status === "resolved" ||
    thread.status === "abandoned"
  )
    return undefined;
  if (
    outcome.effectiveLocalDate <
    (thread.lastAdvancedLocalDate ?? thread.startedLocalDate)
  )
    return undefined;
  const paused =
    outcome.outcomeKind === "deferred" || outcome.outcomeKind === "cancelled";
  const hasEffort =
    outcome.outcomeKind === "completed" || outcome.outcomeKind === "partial";
  return LifeThreadSchema.parse({
    ...thread,
    status: paused ? "paused" : hasEffort ? "active" : thread.status,
    currentStage: paused ? "近期暂缓" : hasEffort ? "近期有投入" : "暂未投入",
    progressNote: outcome.summary,
    nextStepHint: paused
      ? "先保留这次暂停；之后依据新的实际投入再决定是否继续或调整。"
      : "只依据本次已有记录调整近期投入，不预设完成日期或最终成果。",
    lastAdvancedLocalDate: outcome.effectiveLocalDate,
    revision: thread.revision + 1,
    updatedAtUtc: atUtc,
  });
}

export function timelineLocalDate(
  clock: LifeThreadClock,
  atUtc: string,
): string {
  const identity =
    clock.mode === "realtime"
      ? { timezone: clock.timezone }
      : {
          timezone: clock.timezone,
          temporalFrame: {
            mode: "anchored_story" as const,
            eraLabel: "frozen life-thread story clock",
            storyAnchorLocalDate: clock.storyAnchorLocalDate,
            systemAnchorUtc: clock.systemAnchorUtc,
          },
        };
  return projectCharacterTime(identity, atUtc).localDate;
}

export function assertTimelinePlanHash(plan: LifeThreadTimelinePlan): void {
  const unsigned = {
    schemaVersion: plan.schemaVersion,
    sourceGoalId: plan.sourceGoalId,
    sourceCharacterVersion: plan.sourceCharacterVersion,
    origin: plan.origin,
    timeBasis: plan.timeBasis,
    milestones: plan.milestones,
  };
  if (hashTimelinePlan(unsigned) !== plan.planSha256) {
    throw new Error(
      `Life-thread timeline plan hash mismatch for goal ${plan.sourceGoalId}`,
    );
  }
}

export function resolveLegacyTimelinePlan(
  store: DatabaseStore,
  thread: LifeThread,
): { plan: LifeThreadTimelinePlan; persistedIndex: number } {
  const candidates = store
    .listCharacterVersions(thread.agentId)
    .flatMap(({ spec }) =>
      spec.persona.goals.flatMap((goal) =>
        `life-thread:${thread.agentId}:goal:${goal.id}` ===
        thread.idempotencyKey
          ? [{ spec, goal }]
          : [],
      ),
    )
    .filter(({ spec, goal }) => {
      const plan = freezeTimelinePlan(spec, goal, thread.createdAtUtc);
      return (
        timelineLocalDate(plan.timeBasis, thread.createdAtUtc) ===
        thread.startedLocalDate
      );
    });
  const createdBefore = candidates.filter(
    ({ spec }) =>
      Date.parse(spec.createdAtUtc) <= Date.parse(thread.createdAtUtc),
  );
  const selected = (createdBefore.length > 0 ? createdBefore : candidates)[0];
  if (selected === undefined) {
    throw new Error(
      `Cannot resolve a frozen source plan for legacy life thread ${thread.id}`,
    );
  }
  const plan = freezeTimelinePlan(
    selected.spec,
    selected.goal,
    thread.createdAtUtc,
  );
  const titleMatches = plan.milestones
    .map((milestone, index) =>
      milestone.title === thread.currentStage ? index : -1,
    )
    .filter((index) => index >= 0);
  return {
    plan,
    persistedIndex: titleMatches.length === 1 ? titleMatches[0]! : 0,
  };
}

export function localCalendarDayDifference(
  fromLocalDate: string,
  toLocalDate: string,
): number {
  const from = DateTime.fromISO(fromLocalDate, { zone: "UTC" }).startOf("day");
  const to = DateTime.fromISO(toLocalDate, { zone: "UTC" }).startOf("day");
  return Math.trunc(to.diff(from, "days").days);
}

export function milestoneIndexAt(
  milestones: CharacterGoalMilestone[],
  elapsedDays: number,
): number {
  let index = 0;
  for (let candidate = 1; candidate < milestones.length; candidate += 1) {
    if (milestones[candidate]!.afterDays > elapsedDays) break;
    index = candidate;
  }
  return index;
}

export function milestoneEffectiveLocalDate(
  startedLocalDate: string,
  afterDays: number,
): string {
  return DateTime.fromISO(startedLocalDate, { zone: "UTC" })
    .plus({ days: afterDays })
    .toISODate()!;
}

export function milestoneNextStep(
  milestone: CharacterGoalMilestone,
  next: CharacterGoalMilestone | undefined,
): string {
  const text =
    milestone.nextStepHint ??
    (next === undefined
      ? `继续维持并复盘“${milestone.title}”阶段。`
      : `为之后进入“${next.title}”阶段保留可持续的准备。`);
  return text.slice(0, 240);
}

export function buildDailyIntents(
  spec: CharacterSpec,
  threads: LifeThread[],
  localDate: string,
  atUtc: string,
): DailyLifeIntent[] {
  const contextId = stableId(
    "life_day",
    `${spec.id}:${localDate}:${spec.version}`,
  );
  const goalIntents: DailyIntentSeed[] = spec.persona.goals
    .filter(
      (goal) =>
        spec.compilationPolicyVersion !== "companion_character_v2" ||
        threads.some(
          (thread) =>
            thread.status === "active" && thread.sourceGoalId === goal.id,
        ),
    )
    .slice(0, 3)
    .map((goal, index) => ({
      title: goal.title,
      summary: `今天为“${goal.title}”推进一个有意义但不要求精确钟点的步骤。`,
      domain: inferDomain(`${goal.title} ${goal.description}`),
      period: (["morning", "afternoon", "evening"] as const)[index % 3]!,
      sourceKind: "goal" as const,
      importance: Math.max(0.45, goal.priority),
      goalRefIds: [goal.id],
      threadIds: threads
        .filter(
          (thread) =>
            thread.sourceGoalId === goal.id ||
            thread.timelinePlan?.sourceGoalId === goal.id ||
            (thread.progressionPolicy !== "evidence_driven_v2" &&
              thread.timelinePlan === undefined &&
              thread.title === goal.title),
        )
        .map((thread) => thread.id),
    }));
  const routineIntents: DailyIntentSeed[] = spec.routines
    .filter(
      (routine) =>
        routine.category !== "sleep" &&
        routine.category !== "meal" &&
        !spec.persona.goals.some((goal) => goal.title === routine.title),
    )
    .slice(0, Math.max(0, 4 - goalIntents.length))
    .map((routine) => ({
      title: routine.title,
      summary: `按自己的生活节奏处理“${routine.title}”，不声明精确开始或结束时间。`,
      domain: routineDomain(routine.category),
      period: periodFromClock(routine.preferredStartLocal),
      sourceKind: "routine" as const,
      importance: routine.priority,
      goalRefIds: [],
      threadIds: [],
    }));
  const bases = [...goalIntents, ...routineIntents].slice(0, 6);
  if (bases.length === 0) {
    bases.push({
      title: "照顾今天的生活状态",
      summary: "根据精力和压力决定今天值得投入的一件小事。",
      domain: "self_reflection",
      period: "anytime",
      sourceKind: "spontaneous",
      importance: 0.5,
      goalRefIds: [],
      threadIds: [],
    });
  }
  return bases.map((base, index) =>
    DailyLifeIntentSchema.parse({
      id: stableId("life_intent", `${contextId}:${index}:${base.title}`),
      agentId: spec.id,
      contextId,
      localDate,
      title: base.title,
      summary: base.summary,
      domain: base.domain,
      period: base.period,
      durationBand: index === 0 ? "most_of_period" : "part_of_period",
      commitmentLevel: index === 0 ? "priority" : "optional",
      status: "intended",
      sourceKind: base.sourceKind,
      shareable: base.importance >= 0.65,
      importance: clamp01(base.importance),
      threadIds: base.threadIds,
      goalRefIds: base.goalRefIds,
      evidenceMessageIds: [],
      idempotencyKey: `life-intent:${contextId}:${index}`,
      revision: 1,
      schemaVersion: 1,
      createdAtUtc: atUtc,
      updatedAtUtc: atUtc,
    }),
  );
}

export function dayPeriod(hour: number): Exclude<DayPeriod, "anytime"> {
  if (hour < 6) return "early_morning";
  if (hour < 11) return "morning";
  if (hour < 14) return "midday";
  if (hour < 18) return "afternoon";
  if (hour < 23) return "evening";
  return "late_night";
}

export function availabilityFor(
  state: RuntimeState,
): "free" | "interruptible" | "occupied" {
  if (state.stress > 0.78 || (state.focus > 0.8 && state.energy < 0.4)) {
    return "occupied";
  }
  if (state.focus > 0.58 || state.socialBattery < 0.35) return "interruptible";
  return "free";
}

export function focusForPeriod(
  intents: readonly DailyLifeIntent[],
  period: Exclude<DayPeriod, "anytime">,
): string | undefined {
  return (
    intents.find((intent) => intent.period === period)?.title ??
    intents.find((intent) => intent.period === "anytime")?.title ??
    intents[0]?.title
  );
}

export function inferDomain(text: string): LifeDomain {
  if (/工作|职业|辞职|转行|项目|公司/u.test(text)) return "work";
  if (/学习|考试|课程|学校|毕业/u.test(text)) return "study";
  if (/家人|伴侣|分手|关系|朋友/u.test(text)) return "relationship";
  if (/健康|睡眠|生病|身体/u.test(text)) return "health";
  if (/创作|画|写|音乐|作品/u.test(text)) return "creative";
  if (/旅行|出门|运动|活动/u.test(text)) return "leisure";
  return "self_reflection";
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function timeMilestonesForGoal(goal: CharacterGoal): CharacterGoalMilestone[] {
  return goal.milestones ?? buildTimeBasedGoalMilestones(goal.id, goal.title);
}

function timelineClockForCharacter(
  spec: CharacterSpec,
  fallbackSystemAnchorUtc: string,
): LifeThreadClock {
  const frame = spec.identity.temporalFrame;
  if (frame?.mode !== "anchored_story") {
    return { mode: "realtime", timezone: spec.identity.timezone };
  }
  return {
    mode: "anchored_story",
    timezone: spec.identity.timezone,
    storyAnchorLocalDate: frame.storyAnchorLocalDate,
    systemAnchorUtc: frame.systemAnchorUtc ?? fallbackSystemAnchorUtc,
  };
}

function hashTimelinePlan(
  value: Omit<LifeThreadTimelinePlan, "planSha256">,
): string {
  const canonical = {
    schemaVersion: value.schemaVersion,
    sourceGoalId: value.sourceGoalId,
    sourceCharacterVersion: value.sourceCharacterVersion,
    origin: value.origin,
    timeBasis: value.timeBasis,
    milestones: value.milestones,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function periodFromClock(value: string): DayPeriod {
  const hour = Number(value.slice(0, 2));
  return Number.isFinite(hour) ? dayPeriod(hour) : "anytime";
}

function seededOutcome(intentId: string): LifeOutcome["outcomeKind"] {
  const roll = seededUnit(`${intentId}:fuzzy-life-outcome`);
  if (roll < 0.62) return "completed";
  if (roll < 0.8) return "partial";
  if (roll < 0.92) return "deferred";
  return "skipped";
}

function outcomeSummary(
  title: string,
  kind: LifeOutcome["outcomeKind"],
): string {
  if (kind === "completed") return `完成了“${title}”中今天想推进的部分。`;
  if (kind === "partial") return `“${title}”有了一些进展，但还没有完全处理完。`;
  if (kind === "deferred") return `“${title}”今天没有展开，决定以后再继续。`;
  if (kind === "cancelled") return `取消了今天关于“${title}”的打算。`;
  return `今天没有继续“${title}”。`;
}

function routineDomain(category: string): LifeDomain {
  if (category === "work") return "work";
  if (category === "study") return "study";
  if (category === "exercise") return "health";
  if (category === "social") return "relationship";
  if (category === "creative") return "creative";
  if (category === "leisure") return "leisure";
  return "self_reflection";
}
