import type {
  ScheduleItemLike,
  ScheduleStatusLike,
} from "./schedule-validator.js";
import {
  applyStateDelta,
  calculateActivityCompletionProbability,
  combineStateDeltas,
  scaleStateDelta,
  type RuntimeStateLike,
  type StateDeltaLike,
} from "./state-engine.js";
import {
  minutesBetween,
  parseInstant,
  seededUnit,
  stableId,
} from "./shared.js";

export type ActivityEventTypeLike =
  "started" | "completed" | "partial" | "skipped" | "cancelled";

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

function applySleepDebtRepayment<TState extends RuntimeStateLike>(
  state: TState,
  events: readonly ActivityEventLike[],
): TState {
  const currentDebt = Math.max(0, Math.min(720, state.sleepDebtMinutes ?? 0));
  if (currentDebt === 0) return state;
  const recoveredMinutes = events
    .filter(
      (event) =>
        (event.kind === "completed" || event.kind === "partial") &&
        event.category === "sleep" &&
        event.endedAtUtc !== undefined,
    )
    .reduce(
      (total, event) =>
        total +
        Math.round(
          minutesBetween(event.startedAtUtc, event.endedAtUtc!) *
            event.completionRatio *
            0.3,
        ),
      0,
    );
  if (recoveredMinutes === 0) return state;
  return {
    ...state,
    sleepDebtMinutes: Math.max(0, currentDebt - recoveredMinutes),
  };
}

function resultForItem(
  item: ScheduleItemLike,
  state: RuntimeStateLike,
  routineAdherence: number,
): {
  status: "completed" | "partial" | "skipped";
  delta: StateDeltaLike;
  roll: number;
} {
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
      roll,
    };
  }
  if (roll < probability + (1 - probability) * 0.45) {
    return {
      status: "partial",
      delta: combineStateDeltas([
        scaleStateDelta(item.stateEffects, 0.5),
        { stress: 0.01 },
      ]),
      roll,
    };
  }
  return {
    status: "skipped",
    delta: { stress: 0.03, moodValence: -0.02 },
    roll,
  };
}

function makeEvent(
  item: ScheduleItemLike,
  type: ActivityEventTypeLike,
  occurredAtUtc: string,
  delta: StateDeltaLike,
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
    idempotencyKey: key,
    createdAtUtc: occurredAtUtc,
  };
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
  };
  if (to <= from || existing.has(idempotencyKey)) {
    return { ...baseResult, skippedAsDuplicate: existing.has(idempotencyKey) };
  }

  const events: ActivityEventLike[] = [];
  const changedItems: ScheduleItemLike[] = [];
  const items = input.items.map((original) => {
    if (original.agentId !== input.agentId || TERMINAL.has(original.status))
      return original;
    const start = parseInstant(original.startAtUtc, "schedule.startAtUtc");
    const end = parseInstant(original.endAtUtc, "schedule.endAtUtc");
    let status = original.status;

    if (start > from && start <= to && status === "planned") {
      status = "in_progress";
      const key = eventKey(original, "started");
      if (!existing.has(key))
        events.push(makeEvent(original, "started", original.startAtUtc, {}));
    }

    if (
      end > from &&
      end <= to &&
      (status === "planned" || status === "in_progress")
    ) {
      const outcome = resultForItem(
        original,
        input.state,
        input.routineAdherence,
      );
      status = outcome.status;
      const key = eventKey(original, outcome.status);
      if (!existing.has(key)) {
        events.push(
          makeEvent(original, outcome.status, original.endAtUtc, outcome.delta),
        );
      }
    }

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

  const aggregateStateDelta = combineStateDeltas(
    events
      .filter((event) => event.kind !== "started")
      .map((event) => event.stateDelta ?? {}),
  );
  const active = items
    .filter((item) => {
      if (item.status !== "in_progress") return false;
      const start = parseInstant(item.startAtUtc);
      const end = parseInstant(item.endAtUtc);
      return start <= to && to < end;
    })
    .sort((left, right) => right.priority - left.priority)[0];
  const stateAfterEffects = applyStateDelta(
    input.state,
    aggregateStateDelta,
    input.toUtc,
    active?.id,
  );
  const nextState = applySleepDebtRepayment(stateAfterEffects, events);
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
  };
}

export const settle = settleSchedule;
