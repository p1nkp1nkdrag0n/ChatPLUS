import type {
  ScheduleItemLike,
  ScheduleStatusLike,
} from "./schedule-validator.js";
import {
  applyRelationshipInteraction,
  type RelationshipDailyUsage,
  type RelationshipInteractionResult,
} from "./relationship-engine.js";
import {
  applyStateDelta,
  calculateActivityCompletionProbability,
  combineStateDeltas,
  scaleStateDelta,
  type RuntimeStateLike,
  type StateDeltaLike,
} from "./state-engine.js";
import {
  localDayKey,
  minutesBetween,
  parseInstant,
  seededUnit,
  stableId,
} from "./shared.js";

export type ActivityEventTypeLike =
  "started" | "completed" | "partial" | "skipped" | "cancelled";

export type ActivityOutcomeReasonCode =
  | "seeded_probability_completed"
  | "seeded_probability_partial"
  | "seeded_probability_skipped"
  | "schedule_cancelled";

export interface ActivityEffectTrace {
  outcomeProbability?: number;
  outcomeRoll?: number;
  reasonCode: ActivityOutcomeReasonCode;
  stateRevisionBefore: number;
  stateRevisionAfter: number;
  stateBefore: RuntimeStateLike;
  stateAfter: RuntimeStateLike;
  appliedStateDelta: StateDeltaLike & { sleepDebtMinutes?: number };
  sleepDebt?: SleepDebtEffectTrace;
  relationshipSource?: "shared_activity_outcome";
  relationship?: RelationshipInteractionResult;
  relationshipDailyUsageBefore?: RelationshipDailyUsage;
  relationshipDailyUsageApplied?: RelationshipDailyUsage;
  relationshipDailyUsageAfter?: RelationshipDailyUsage;
}

export interface SleepDebtEffectTrace {
  debtBefore: number;
  plannedReductionMinutes: number;
  missedScheduledMinutes: number;
  recoveryMinutes: number;
  debtAfter: number;
}

export interface ActivityEventLike {
  id: string;
  agentId: string;
  scheduleItemId: string;
  kind: ActivityEventTypeLike;
  category: string;
  scheduleStatus: ScheduleStatusLike;
  startedAtUtc: string;
  endedAtUtc?: string;
  occurredAtUtc: string;
  summary: string;
  completionRatio: number;
  importance: number;
  shareable: boolean;
  stateDelta?: StateDeltaLike;
  effectTrace?: ActivityEffectTrace;
  idempotencyKey: string;
  createdAtUtc: string;
}

export interface SettlementInput<
  TState extends RuntimeStateLike = RuntimeStateLike,
> {
  agentId: string;
  fromUtc: string;
  toUtc: string;
  items: readonly ScheduleItemLike[];
  state: TState;
  routineAdherence: number;
  existingIdempotencyKeys?: ReadonlySet<string> | readonly string[];
  relationshipCapabilityScale?: number;
  relationshipDailyUsage?: RelationshipDailyUsage;
  relationshipTimezone?: string;
  relationshipDailyUsageByDay?: Readonly<
    Record<string, RelationshipDailyUsage>
  >;
}

export interface SettlementResult<
  TState extends RuntimeStateLike = RuntimeStateLike,
> {
  idempotencyKey: string;
  skippedAsDuplicate: boolean;
  fromUtc: string;
  toUtc: string;
  items: ScheduleItemLike[];
  changedItems: ScheduleItemLike[];
  events: ActivityEventLike[];
  state: TState;
  aggregateStateDelta: StateDeltaLike;
  relationshipDailyUsageApplied: RelationshipDailyUsage;
  relationshipDailyUsageAppliedByDay: Record<string, RelationshipDailyUsage>;
}

const TERMINAL = new Set<ScheduleStatusLike>([
  "completed",
  "partial",
  "skipped",
  "cancelled",
]);

export function activitySeed(agentId: string, item: ScheduleItemLike): string {
  return `${agentId}${item.id}${item.startAtUtc}`;
}

export const computeActivitySeed = activitySeed;

export function settlementIdempotencyKey(
  agentId: string,
  fromUtc: string,
  toUtc: string,
): string {
  return stableId("settlement", `${agentId}:${fromUtc}:${toUtc}`);
}

function eventKey(
  item: ScheduleItemLike,
  eventType: ActivityEventTypeLike,
): string {
  return `activity:${item.agentId}:${item.id}:${eventType}:${item.startAtUtc}`;
}

/**
 * Fraction of completed sleep minutes that repays sleep debt per settlement.
 * 0.5 clears the 720-minute debt cap in roughly three full nights instead of
 * five, while recovery still stays gradual across several settlements.
 */
export const SLEEP_DEBT_RECOVERY_RATE = 0.5;

function applySleepDebtSettlement<TState extends RuntimeStateLike>(
  state: TState,
  item: ScheduleItemLike,
  event: ActivityEventLike,
): { state: TState; trace?: SleepDebtEffectTrace } {
  if (
    item.category !== "sleep" ||
    event.endedAtUtc === undefined ||
    (event.kind !== "completed" &&
      event.kind !== "partial" &&
      event.kind !== "skipped")
  ) {
    return { state };
  }
  const currentDebt = Math.max(0, Math.min(720, state.sleepDebtMinutes ?? 0));
  const scheduledMinutes = Math.max(
    0,
    Math.round(minutesBetween(event.startedAtUtc, event.endedAtUtc)),
  );
  const completedMinutes = Math.round(scheduledMinutes * event.completionRatio);
  const missedScheduledMinutes = Math.max(
    0,
    scheduledMinutes - completedMinutes,
  );
  const plannedReductionMinutes = Math.max(
    0,
    Math.min(720, Math.round(item.plannedSleepReductionMinutes ?? 0)),
  );
  const recoveryMinutes = Math.min(
    currentDebt,
    Math.round(completedMinutes * SLEEP_DEBT_RECOVERY_RATE),
  );
  const debtAfter = Math.max(
    0,
    Math.min(
      720,
      currentDebt -
        recoveryMinutes +
        plannedReductionMinutes +
        missedScheduledMinutes,
    ),
  );
  return {
    state: {
      ...state,
      sleepDebtMinutes: debtAfter,
    },
    trace: {
      debtBefore: currentDebt,
      plannedReductionMinutes,
      missedScheduledMinutes,
      recoveryMinutes,
      debtAfter,
    },
  };
}

type ActivityOutcome = {
  status: "completed" | "partial" | "skipped" | "cancelled";
  delta: StateDeltaLike;
  outcomeProbability?: number;
  outcomeRoll?: number;
  reasonCode: ActivityOutcomeReasonCode;
};

function resultForItem(
  item: ScheduleItemLike,
  state: RuntimeStateLike,
  routineAdherence: number,
): ActivityOutcome {
  const probability = calculateActivityCompletionProbability({
    adherenceProbability: item.adherenceProbability,
    routineAdherence,
    rigidity: item.rigidity,
    energy: state.energy,
    stress: state.stress,
  });
  const roll = seededUnit(activitySeed(item.agentId, item));
  if (roll < probability) {
    return {
      status: "completed",
      delta: scaleStateDelta(item.stateEffects, 1),
      outcomeProbability: probability,
      outcomeRoll: roll,
      reasonCode: "seeded_probability_completed",
    };
  }
  if (roll < probability + (1 - probability) * 0.45) {
    return {
      status: "partial",
      delta: combineStateDeltas([
        scaleStateDelta(item.stateEffects, 0.5),
        { stress: 0.01 },
      ]),
      outcomeProbability: probability,
      outcomeRoll: roll,
      reasonCode: "seeded_probability_partial",
    };
  }
  return {
    status: "skipped",
    delta: { stress: 0.03, moodValence: -0.02 },
    outcomeProbability: probability,
    outcomeRoll: roll,
    reasonCode: "seeded_probability_skipped",
  };
}

function makeEvent(
  item: ScheduleItemLike,
  type: ActivityEventTypeLike,
  occurredAtUtc: string,
  delta: StateDeltaLike,
  effectTrace?: ActivityEffectTrace,
): ActivityEventLike {
  const key = eventKey(item, type);
  const outcome = {
    started: `开始了${item.title}`,
    completed: `完成了${item.title}`,
    partial: `${item.title}只完成了一部分`,
    skipped: `未能进行${item.title}`,
    cancelled: `取消了${item.title}`,
  }[type];
  return {
    id: stableId("event", key),
    agentId: item.agentId,
    scheduleItemId: item.id,
    kind: type,
    category: item.category,
    scheduleStatus: type === "started" ? "in_progress" : type,
    startedAtUtc: item.startAtUtc,
    ...(type === "started" ? {} : { endedAtUtc: item.endAtUtc }),
    occurredAtUtc,
    summary: outcome,
    completionRatio: type === "completed" ? 1 : type === "partial" ? 0.5 : 0,
    importance: item.narrativeImportance,
    shareable: item.shareable,
    ...(Object.keys(delta).length === 0 ? {} : { stateDelta: delta }),
    ...(effectTrace === undefined ? {} : { effectTrace }),
    idempotencyKey: key,
    createdAtUtc: occurredAtUtc,
  };
}

const TRACE_STATE_KEYS = [
  "moodValence",
  "moodArousal",
  "energy",
  "stress",
  "socialBattery",
  "focus",
] as const satisfies readonly (keyof StateDeltaLike)[];

function appliedStateDelta(
  before: RuntimeStateLike,
  after: RuntimeStateLike,
): StateDeltaLike & { sleepDebtMinutes?: number } {
  const applied: StateDeltaLike & { sleepDebtMinutes?: number } = {};
  for (const key of TRACE_STATE_KEYS) {
    const difference = after[key] - before[key];
    if (difference !== 0) applied[key] = difference;
  }
  const sleepDebtDifference =
    (after.sleepDebtMinutes ?? 0) - (before.sleepDebtMinutes ?? 0);
  if (sleepDebtDifference !== 0) {
    applied.sleepDebtMinutes = sleepDebtDifference;
  }
  return applied;
}

function compareTerminalItems(
  left: ScheduleItemLike,
  right: ScheduleItemLike,
): number {
  return (
    terminalOccurredAt(left).toMillis() -
      terminalOccurredAt(right).toMillis() || left.id.localeCompare(right.id)
  );
}

function terminalOccurredAt(item: ScheduleItemLike) {
  return parseInstant(
    item.status === "cancelled" ? item.updatedAtUtc : item.endAtUtc,
  );
}

function compareActivityEvents(
  left: ActivityEventLike,
  right: ActivityEventLike,
): number {
  const byTime =
    parseInstant(left.occurredAtUtc).toMillis() -
    parseInstant(right.occurredAtUtc).toMillis();
  if (byTime !== 0) return byTime;

  // When one activity ends exactly as another begins, the terminal cause is
  // applied first. Item id and kind make every remaining tie deterministic.
  const byPhase =
    (left.kind === "started" ? 1 : 0) - (right.kind === "started" ? 1 : 0);
  return (
    byPhase ||
    left.scheduleItemId.localeCompare(right.scheduleItemId) ||
    left.kind.localeCompare(right.kind)
  );
}

function selectCurrentActivity(
  items: readonly ScheduleItemLike[],
  statuses: ReadonlyMap<string, ScheduleStatusLike>,
  at: ReturnType<typeof parseInstant>,
): ScheduleItemLike | undefined {
  return items
    .filter((item) => {
      if ((statuses.get(item.id) ?? item.status) !== "in_progress")
        return false;
      const start = parseInstant(item.startAtUtc);
      const end = parseInstant(item.endAtUtc);
      return start <= at && at < end;
    })
    .sort(
      (left, right) =>
        right.priority - left.priority || left.id.localeCompare(right.id),
    )[0];
}

function finalizeState<TState extends RuntimeStateLike>(
  state: TState,
  asOfUtc: string,
  currentActivityId?: string,
): TState {
  const next = { ...state, asOfUtc };
  if (currentActivityId === undefined) delete next.currentActivityId;
  else next.currentActivityId = currentActivityId;
  return next;
}

export function settleSchedule<TState extends RuntimeStateLike>(
  input: SettlementInput<TState>,
): SettlementResult<TState> {
  const from = parseInstant(input.fromUtc, "fromUtc");
  const to = parseInstant(input.toUtc, "toUtc");
  const idempotencyKey = settlementIdempotencyKey(
    input.agentId,
    input.fromUtc,
    input.toUtc,
  );
  const existing = new Set(input.existingIdempotencyKeys ?? []);
  const baseResult = {
    idempotencyKey,
    fromUtc: input.fromUtc,
    toUtc: input.toUtc,
    items: [...input.items],
    changedItems: [] as ScheduleItemLike[],
    events: [] as ActivityEventLike[],
    state: input.state,
    aggregateStateDelta: {} as StateDeltaLike,
    relationshipDailyUsageApplied: {} as RelationshipDailyUsage,
    relationshipDailyUsageAppliedByDay: {} as Record<
      string,
      RelationshipDailyUsage
    >,
  };
  if (to <= from || existing.has(idempotencyKey)) {
    return { ...baseResult, skippedAsDuplicate: existing.has(idempotencyKey) };
  }

  const events: ActivityEventLike[] = [];
  const statuses = new Map(
    input.items.map((item) => [item.id, item.status] as const),
  );

  for (const item of input.items) {
    if (item.agentId !== input.agentId || TERMINAL.has(item.status)) continue;
    const start = parseInstant(item.startAtUtc, "schedule.startAtUtc");
    if (start > from && start <= to && item.status === "planned") {
      statuses.set(item.id, "in_progress");
      const key = eventKey(item, "started");
      if (!existing.has(key)) {
        events.push(makeEvent(item, "started", item.startAtUtc, {}));
      }
    }
  }

  const terminalItems = input.items
    .filter((item) => {
      if (item.agentId !== input.agentId) {
        return false;
      }
      if (
        item.status === "completed" ||
        item.status === "partial" ||
        item.status === "skipped"
      )
        return false;
      if (item.status === "cancelled") {
        const cancelledAt = parseInstant(
          item.updatedAtUtc,
          "schedule.updatedAtUtc",
        );
        return (
          item.source === "user_invitation" &&
          cancelledAt > from &&
          cancelledAt <= to
        );
      }
      const end = parseInstant(item.endAtUtc, "schedule.endAtUtc");
      const status = statuses.get(item.id) ?? item.status;
      return (
        end > from &&
        end <= to &&
        (status === "planned" || status === "in_progress")
      );
    })
    .sort(compareTerminalItems);

  let workingState = input.state;
  const initialRelationshipUsageByDay = cloneUsageByDay(
    input.relationshipDailyUsageByDay,
  );
  const workingRelationshipUsageByDay = cloneUsageByDay(
    input.relationshipDailyUsageByDay,
  );
  let workingRelationshipDailyUsage: RelationshipDailyUsage = {
    ...(input.relationshipDailyUsage ?? {}),
  };
  for (const item of terminalItems) {
    const status = statuses.get(item.id) ?? item.status;
    if (
      status !== "planned" &&
      status !== "in_progress" &&
      status !== "cancelled"
    ) {
      continue;
    }

    const outcome: ActivityOutcome =
      status === "cancelled"
        ? {
            status: "cancelled",
            delta: {},
            reasonCode: "schedule_cancelled",
          }
        : resultForItem(item, workingState, input.routineAdherence);
    statuses.set(item.id, outcome.status);
    const key = eventKey(item, outcome.status);
    if (existing.has(key)) continue;

    const untracedEvent = makeEvent(
      item,
      outcome.status,
      status === "cancelled" ? item.updatedAtUtc : item.endAtUtc,
      outcome.delta,
    );
    const occurredAtUtc = untracedEvent.occurredAtUtc;
    const relationshipDay = input.relationshipTimezone
      ? localDayKey(occurredAtUtc, input.relationshipTimezone)
      : undefined;
    if (relationshipDay !== undefined) {
      workingRelationshipDailyUsage = {
        ...(workingRelationshipUsageByDay[relationshipDay] ?? {}),
      };
    }
    const activeAfterEvent = selectCurrentActivity(
      input.items,
      statuses,
      parseInstant(occurredAtUtc),
    );
    const stateAfterEffects = applyStateDelta(
      workingState,
      outcome.delta,
      occurredAtUtc,
      activeAfterEvent?.id,
    );
    const sleepDebt = applySleepDebtSettlement(
      stateAfterEffects,
      item,
      untracedEvent,
    );
    const sharedRelationship = applySharedActivityRelationship({
      state: sleepDebt.state,
      item,
      event: untracedEvent,
      capabilityScale: input.relationshipCapabilityScale ?? 0,
      dailyUsage: workingRelationshipDailyUsage,
    });
    const stateAfterEvent = sharedRelationship.state;
    workingRelationshipDailyUsage = sharedRelationship.dailyUsageAfter;
    if (
      relationshipDay !== undefined &&
      sharedRelationship.trace !== undefined
    ) {
      workingRelationshipUsageByDay[relationshipDay] = {
        ...workingRelationshipDailyUsage,
      };
    }
    const effectTrace: ActivityEffectTrace = {
      ...(outcome.outcomeProbability === undefined
        ? {}
        : { outcomeProbability: outcome.outcomeProbability }),
      ...(outcome.outcomeRoll === undefined
        ? {}
        : { outcomeRoll: outcome.outcomeRoll }),
      reasonCode: outcome.reasonCode,
      stateRevisionBefore: workingState.revision,
      stateRevisionAfter: stateAfterEvent.revision,
      stateBefore: workingState,
      stateAfter: stateAfterEvent,
      appliedStateDelta: appliedStateDelta(workingState, stateAfterEvent),
      ...(sleepDebt.trace === undefined ? {} : { sleepDebt: sleepDebt.trace }),
      ...(sharedRelationship.trace === undefined
        ? {}
        : {
            relationshipSource: "shared_activity_outcome" as const,
            relationship: sharedRelationship.trace,
            relationshipDailyUsageBefore: sharedRelationship.dailyUsageBefore,
            relationshipDailyUsageApplied: sharedRelationship.dailyUsageApplied,
            relationshipDailyUsageAfter: sharedRelationship.dailyUsageAfter,
          }),
    };
    events.push(
      makeEvent(
        item,
        outcome.status,
        occurredAtUtc,
        outcome.delta,
        effectTrace,
      ),
    );
    workingState = stateAfterEvent;
  }

  const changedItems: ScheduleItemLike[] = [];
  const items = input.items.map((original) => {
    const status = statuses.get(original.id) ?? original.status;
    if (status === original.status) return original;
    const updated: ScheduleItemLike = {
      ...original,
      status,
      revision: original.revision + 1,
      updatedAtUtc: input.toUtc,
    };
    changedItems.push(updated);
    return updated;
  });

  events.sort(compareActivityEvents);

  const aggregateStateDelta = combineStateDeltas(
    events
      .filter((event) => event.kind !== "started")
      .map((event) => event.stateDelta ?? {}),
  );
  const active = selectCurrentActivity(items, statuses, to);
  const nextState = finalizeState(workingState, input.toUtc, active?.id);
  const relationshipDailyUsageApplied = usageDifference(
    input.relationshipDailyUsage,
    workingRelationshipDailyUsage,
  );
  const relationshipDailyUsageAppliedByDay = usageDifferenceByDay(
    initialRelationshipUsageByDay,
    workingRelationshipUsageByDay,
  );
  return {
    idempotencyKey,
    skippedAsDuplicate: false,
    fromUtc: input.fromUtc,
    toUtc: input.toUtc,
    items,
    changedItems,
    events,
    state: nextState,
    aggregateStateDelta,
    relationshipDailyUsageApplied,
    relationshipDailyUsageAppliedByDay,
  };
}

function applySharedActivityRelationship<
  TState extends RuntimeStateLike,
>(input: {
  state: TState;
  item: ScheduleItemLike;
  event: ActivityEventLike;
  capabilityScale: number;
  dailyUsage: RelationshipDailyUsage;
}): {
  state: TState;
  trace?: RelationshipInteractionResult;
  dailyUsageBefore?: RelationshipDailyUsage;
  dailyUsageApplied?: RelationshipDailyUsage;
  dailyUsageAfter: RelationshipDailyUsage;
} {
  if (
    input.item.source !== "user_invitation" ||
    input.state.relationship === undefined ||
    input.event.kind === "started"
  ) {
    return { state: input.state, dailyUsageAfter: input.dailyUsage };
  }
  const proposal = SHARED_ACTIVITY_RELATIONSHIP_EFFECTS[input.event.kind];
  if (proposal === undefined) {
    return { state: input.state, dailyUsageAfter: input.dailyUsage };
  }
  const trace = applyRelationshipInteraction({
    state: input.state.relationship,
    atUtc: input.event.occurredAtUtc,
    capabilityScale: input.capabilityScale,
    includeInteractionBaseline: false,
    proposal,
    dailyUsage: input.dailyUsage,
  });
  return {
    state: { ...input.state, relationship: trace.after },
    trace,
    dailyUsageBefore: { ...input.dailyUsage },
    dailyUsageApplied: usageDifference(input.dailyUsage, trace.dailyUsageAfter),
    dailyUsageAfter: trace.dailyUsageAfter,
  };
}

const SHARED_ACTIVITY_RELATIONSHIP_EFFECTS = {
  completed: {
    closeness: 0.006,
    trust: 0.003,
    familiarity: 0.002,
    recentInteractionValence: 0.08,
  },
  partial: {
    closeness: 0.003,
    trust: 0.001,
    familiarity: 0.001,
    recentInteractionValence: 0.03,
  },
  skipped: {
    closeness: -0.002,
    trust: -0.003,
    recentInteractionValence: -0.08,
  },
  cancelled: {
    closeness: -0.001,
    trust: -0.002,
    recentInteractionValence: -0.05,
  },
} as const;

function usageDifference(
  before: RelationshipDailyUsage | undefined,
  after: RelationshipDailyUsage,
): RelationshipDailyUsage {
  const difference: RelationshipDailyUsage = {};
  for (const field of [
    "closeness",
    "trust",
    "familiarity",
    "recentInteractionValence",
  ] as const) {
    const amount = (after[field] ?? 0) - (before?.[field] ?? 0);
    if (amount > 0) difference[field] = amount;
  }
  return difference;
}

function cloneUsageByDay(
  input: Readonly<Record<string, RelationshipDailyUsage>> | undefined,
): Record<string, RelationshipDailyUsage> {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([day, usage]) => [day, { ...usage }]),
  );
}

function usageDifferenceByDay(
  before: Readonly<Record<string, RelationshipDailyUsage>>,
  after: Readonly<Record<string, RelationshipDailyUsage>>,
): Record<string, RelationshipDailyUsage> {
  const result: Record<string, RelationshipDailyUsage> = {};
  for (const [day, usage] of Object.entries(after)) {
    const difference = usageDifference(before[day], usage);
    if (Object.keys(difference).length > 0) result[day] = difference;
  }
  return result;
}

export const settle = settleSchedule;
