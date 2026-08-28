import {
  ScheduleMutationBundleSchema,
  SelfPlanBundleSchema,
  type ScheduleMutationBundle,
  type ScheduleMutationOwner,
  type SelfPlanBundle,
  type ServerScheduleItemDraft,
  type SleepAdjustment,
} from "@personasim/contracts";
import type { DateTime } from "luxon";

import {
  DEFAULT_MINIMUM_SLEEP_MINUTES as CANONICAL_MINIMUM_SLEEP_MINUTES,
  type ScheduleItemLike,
  type ScheduleValidationContext,
} from "./schedule-validator.js";
import {
  localDayKey,
  minutesBetween,
  overlaps,
  parseInstant,
  parseZone,
  stableId,
} from "./shared.js";

const OWNER_SOURCE = {
  routine: "routine",
  user_negotiation: "user_invitation",
  self_planner: "self_initiated",
  manual: "manual",
} as const satisfies Record<ScheduleMutationOwner, ScheduleItemLike["source"]>;

const TERMINAL_STATUSES = new Set([
  "completed",
  "partial",
  "skipped",
  "cancelled",
]);

const DEFAULT_MAX_NIGHT_SELF_PLANS_PER_ROLLING_7_DAYS = 2;

/**
 * Canonical minimum real sleep minutes that must survive a night self-plan.
 * The planner and the projection validator share this default so a bundle is
 * never validated against a laxer bound than it was planned with.
 */
export { DEFAULT_MINIMUM_SLEEP_MINUTES } from "./schedule-validator.js";
const ROLLING_7_DAYS_HOURS = 7 * 24;
const MATERIAL_SLEEP_WINDOW_OVERLAP_MINUTES = 60;

export type FinalScheduleProjectionErrorCode =
  | "INVALID_BUNDLE"
  | "INVALID_CONTEXT"
  | "INVALID_TIME"
  | "NOT_IN_FUTURE"
  | "OUTSIDE_HORIZON"
  | "UNKNOWN_ITEM"
  | "ITEM_OWNERSHIP_MISMATCH"
  | "REVISION_MISMATCH"
  | "TERMINAL_ITEM"
  | "DUPLICATE_MUTATION"
  | "FIXED_ITEM_IMMUTABLE"
  | "COMMITTED_ITEM_IMMUTABLE"
  | "SELF_PLAN_RIGIDITY_REJECTED"
  | "SOURCE_OWNERSHIP_MISMATCH"
  | "SLEEP_REQUIRED"
  | "SLEEP_ADJUSTMENT_TARGET_INVALID"
  | "SLEEP_ADJUSTMENT_INVALID"
  | "LOST_SLEEP_MISMATCH"
  | "MINIMUM_SLEEP_REQUIRED"
  | "NIGHT_SELF_PLAN_FREQUENCY_LIMIT"
  | "SLEEP_WINDOW_VIOLATION"
  | "OVERLAP"
  | "OVERLAP_FIXED"
  | "DAILY_COMMITMENT_LIMIT";

export interface FinalScheduleProjectionError {
  code: FinalScheduleProjectionErrorCode;
  path: string;
  message: string;
  conflictingItemId?: string;
}

export interface FinalScheduleProjectionContext extends ScheduleValidationContext {
  /** Defaults to the canonical six-hour floor. */
  minimumSleepMinutes?: number;
  /**
   * Maximum material self-initiated sleep-window intrusions in the rolling
   * 168 hours ending at the candidate activity start. Defaults to 2.
   */
  maxNightSelfPlansPerRolling7Days?: number;
}

export interface FinalScheduleProjectionResult {
  ok: boolean;
  valid: boolean;
  errors: FinalScheduleProjectionError[];
  /**
   * The final snapshot only when every mutation is valid. On failure this is
   * the unchanged input snapshot, making accidental partial application hard.
   */
  projectedItems: ScheduleItemLike[];
  createdItems: ScheduleItemLike[];
  changedItems: ScheduleItemLike[];
  lostSleepMinutes: number;
}

interface CreateMutation {
  operation: "create";
  item: ServerScheduleItemDraft;
  path: string;
}

interface RescheduleMutation {
  operation: "reschedule";
  itemId: string;
  newStartAtUtc: string;
  newEndAtUtc: string;
  expectedRevision?: number;
  fixedSleepAdjustment: boolean;
  path: string;
}

interface CancelMutation {
  operation: "cancel";
  itemId: string;
  expectedRevision?: number;
  path: string;
}

type NormalizedMutation = CreateMutation | RescheduleMutation | CancelMutation;

interface NormalizedBundle {
  owner: ScheduleMutationOwner;
  mutations: NormalizedMutation[];
  selfPlan: boolean;
  sleepAdjustment?: SleepAdjustment;
}

export function scheduleSourceForOwner(
  owner: ScheduleMutationOwner,
): ScheduleItemLike["source"] {
  return OWNER_SOURCE[owner];
}

function projectionFailure(
  existingItems: readonly ScheduleItemLike[],
  errors: FinalScheduleProjectionError[],
): FinalScheduleProjectionResult {
  return {
    ok: false,
    valid: false,
    errors,
    projectedItems: [...existingItems],
    createdItems: [],
    changedItems: [],
    lostSleepMinutes: 0,
  };
}

function normalizeBundle(
  bundle: ScheduleMutationBundle | SelfPlanBundle,
): NormalizedBundle {
  if ("intentId" in bundle) {
    const mutations: NormalizedMutation[] = [
      {
        operation: "create",
        item: bundle.activity,
        path: "activity",
      },
    ];
    if (bundle.sleepAdjustment !== undefined) {
      mutations.push({
        operation: "reschedule",
        itemId: bundle.sleepAdjustment.sleepItemId,
        newStartAtUtc: bundle.sleepAdjustment.newStartAtUtc,
        newEndAtUtc: bundle.sleepAdjustment.newEndAtUtc,
        fixedSleepAdjustment: true,
        path: "sleepAdjustment",
      });
    }
    return {
      owner: "self_planner",
      mutations,
      selfPlan: true,
      ...(bundle.sleepAdjustment === undefined
        ? {}
        : { sleepAdjustment: bundle.sleepAdjustment }),
    };
  }

  const mutations: NormalizedMutation[] = [];
  for (const [index, item] of (bundle.create ?? []).entries()) {
    mutations.push({
      operation: "create",
      item,
      path: `create.${index}`,
    });
  }
  for (const [index, adjustment] of (bundle.reschedule ?? []).entries()) {
    mutations.push({
      operation: "reschedule",
      itemId: adjustment.itemId,
      newStartAtUtc: adjustment.newStartAtUtc,
      newEndAtUtc: adjustment.newEndAtUtc,
      fixedSleepAdjustment: false,
      path: `reschedule.${index}`,
      ...(adjustment.expectedRevision === undefined
        ? {}
        : { expectedRevision: adjustment.expectedRevision }),
    });
  }
  for (const [index, cancellation] of (bundle.cancel ?? []).entries()) {
    mutations.push({
      operation: "cancel",
      itemId: cancellation.itemId,
      path: `cancel.${index}`,
      ...(cancellation.expectedRevision === undefined
        ? {}
        : { expectedRevision: cancellation.expectedRevision }),
    });
  }
  return {
    owner: bundle.owner,
    mutations,
    selfPlan: false,
  };
}

function isSleepItem(
  item: Pick<ScheduleItemLike | ServerScheduleItemDraft, "category" | "title">,
): boolean {
  return (
    item.category.toLocaleLowerCase() === "sleep" ||
    /sleep|\u7761\u7720|\u7761\u89c9|\u4f11\u606f/iu.test(item.title)
  );
}

function normalizedStateEffects(
  effects: ServerScheduleItemDraft["stateEffects"],
): ScheduleItemLike["stateEffects"] {
  return {
    ...(effects.moodValence === undefined
      ? {}
      : { moodValence: effects.moodValence }),
    ...(effects.moodArousal === undefined
      ? {}
      : { moodArousal: effects.moodArousal }),
    ...(effects.energy === undefined ? {} : { energy: effects.energy }),
    ...(effects.stress === undefined ? {} : { stress: effects.stress }),
    ...(effects.socialBattery === undefined
      ? {}
      : { socialBattery: effects.socialBattery }),
    ...(effects.focus === undefined ? {} : { focus: effects.focus }),
  };
}

function parseClock(
  value: string,
): { hour: number; minute: number } | undefined {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

function sleepWindowOverlapMinutes(
  item: Pick<ScheduleItemLike, "startAtUtc" | "endAtUtc">,
  timezone: string,
  window: ScheduleValidationContext["policy"]["sleepWindow"],
): number {
  const clockStart = parseClock(window.startLocal);
  const clockEnd = parseClock(window.endLocal);
  if (clockStart === undefined || clockEnd === undefined) return 0;

  const itemStart = parseInstant(item.startAtUtc).setZone(timezone);
  const itemEnd = parseInstant(item.endAtUtc).setZone(timezone);
  let total = 0;
  let day = itemStart.startOf("day").minus({ days: 1 });
  const lastDay = itemEnd.startOf("day");
  while (day <= lastDay) {
    const start = day.set(clockStart);
    let end = day.set(clockEnd);
    if (end <= start) end = end.plus({ days: 1 });
    const overlapStart = Math.max(itemStart.toMillis(), start.toMillis());
    const overlapEnd = Math.min(itemEnd.toMillis(), end.toMillis());
    if (overlapEnd > overlapStart) {
      total += (overlapEnd - overlapStart) / 60_000;
    }
    day = day.plus({ days: 1 });
  }
  return total;
}

function countRollingNightSelfPlans(
  items: readonly ScheduleItemLike[],
  pairedActivity: ScheduleItemLike,
  agentId: string,
  timezone: string,
  window: ScheduleValidationContext["policy"]["sleepWindow"],
): number {
  const anchor = parseInstant(pairedActivity.startAtUtc);
  const rollingStart = anchor.minus({ hours: ROLLING_7_DAYS_HOURS });
  let total = 0;

  for (const item of items) {
    if (
      item.agentId !== agentId ||
      item.status === "cancelled" ||
      item.source !== "self_initiated" ||
      isSleepItem(item)
    ) {
      continue;
    }

    try {
      const itemStart = parseInstant(item.startAtUtc);
      const itemEnd = parseInstant(item.endAtUtc);
      if (itemStart > anchor || itemEnd <= rollingStart) continue;
      if (
        sleepWindowOverlapMinutes(item, timezone, window) >
        MATERIAL_SLEEP_WINDOW_OVERLAP_MINUTES
      ) {
        total += 1;
      }
    } catch {
      // Pre-existing malformed timestamps are owned by storage validation.
    }
  }

  return total;
}

function commitmentHoursByDay(
  items: readonly ScheduleItemLike[],
  timezone: string,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    if (
      item.status === "cancelled" ||
      (item.rigidity !== "fixed" && item.rigidity !== "committed") ||
      isSleepItem(item)
    ) {
      continue;
    }
    let cursor = parseInstant(item.startAtUtc).setZone(timezone);
    const end = parseInstant(item.endAtUtc).setZone(timezone);
    while (cursor < end) {
      const boundary = cursor.plus({ days: 1 }).startOf("day");
      const partEnd = boundary < end ? boundary : end;
      const day = cursor.toISODate() ?? localDayKey(item.startAtUtc, timezone);
      result.set(
        day,
        (result.get(day) ?? 0) + partEnd.diff(cursor, "hours").hours,
      );
      cursor = partEnd;
    }
  }
  return result;
}

function validateRange(
  startAtUtc: string,
  endAtUtc: string,
  path: string,
  now: DateTime,
  horizon: DateTime,
  horizonHours: number,
  errors: FinalScheduleProjectionError[],
): boolean {
  let start: DateTime;
  let end: DateTime;
  try {
    start = parseInstant(startAtUtc, `${path}.startAtUtc`);
    end = parseInstant(endAtUtc, `${path}.endAtUtc`);
  } catch {
    errors.push({
      code: "INVALID_TIME",
      path,
      message: "Start and end must be valid instants",
    });
    return false;
  }
  if (end <= start) {
    errors.push({
      code: "INVALID_TIME",
      path: `${path}.endAtUtc`,
      message: "End must be after start",
    });
    return false;
  }
  if (start < now) {
    errors.push({
      code: "NOT_IN_FUTURE",
      path: `${path}.startAtUtc`,
      message: "Only future schedule changes are allowed",
    });
  }
  if (end > horizon) {
    errors.push({
      code: "OUTSIDE_HORIZON",
      path: `${path}.endAtUtc`,
      message: `Schedule changes must remain inside the next ${horizonHours} hours`,
    });
  }
  return true;
}

function findTargetIndex(
  items: readonly ScheduleItemLike[],
  itemId: string,
): number {
  return items.findIndex((item) => item.id === itemId);
}

/**
 * The single authoritative pure validator for server-owned mutation bundles.
 *
 * It first builds the complete candidate snapshot, then validates constraints
 * against that final projection. A failed bundle always returns the unchanged
 * input snapshot; persistence layers can therefore commit only an all-or-none
 * result.
 */
export function validateFinalScheduleProjection(
  input: ScheduleMutationBundle | SelfPlanBundle,
  context: FinalScheduleProjectionContext,
): FinalScheduleProjectionResult {
  const parsed =
    "intentId" in input
      ? SelfPlanBundleSchema.safeParse(input)
      : ScheduleMutationBundleSchema.safeParse(input);
  if (!parsed.success) {
    return projectionFailure(
      context.existingItems,
      parsed.error.issues.map((issue) => ({
        code: "INVALID_BUNDLE",
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }

  let now: DateTime;
  try {
    parseZone(context.timezone);
    now = parseInstant(context.nowUtc, "nowUtc");
  } catch {
    return projectionFailure(context.existingItems, [
      {
        code: "INVALID_CONTEXT",
        path: "context",
        message: "Projection context must use a valid timezone and nowUtc",
      },
    ]);
  }

  const minimumSleepMinutes =
    context.minimumSleepMinutes ?? CANONICAL_MINIMUM_SLEEP_MINUTES;
  if (
    !Number.isFinite(minimumSleepMinutes) ||
    minimumSleepMinutes < 0 ||
    !Number.isInteger(minimumSleepMinutes)
  ) {
    return projectionFailure(context.existingItems, [
      {
        code: "INVALID_CONTEXT",
        path: "minimumSleepMinutes",
        message: "minimumSleepMinutes must be a non-negative integer",
      },
    ]);
  }

  const maxNightSelfPlansPerRolling7Days =
    context.maxNightSelfPlansPerRolling7Days ??
    DEFAULT_MAX_NIGHT_SELF_PLANS_PER_ROLLING_7_DAYS;
  if (
    !Number.isFinite(maxNightSelfPlansPerRolling7Days) ||
    maxNightSelfPlansPerRolling7Days < 0 ||
    !Number.isInteger(maxNightSelfPlansPerRolling7Days)
  ) {
    return projectionFailure(context.existingItems, [
      {
        code: "INVALID_CONTEXT",
        path: "maxNightSelfPlansPerRolling7Days",
        message:
          "maxNightSelfPlansPerRolling7Days must be a non-negative integer",
      },
    ]);
  }

  const normalized = normalizeBundle(parsed.data);
  const source = scheduleSourceForOwner(normalized.owner);
  const horizonHours = Math.max(
    0,
    Math.min(72, context.horizonHours ?? context.policy.horizonHours ?? 72),
  );
  const horizon = now.plus({ hours: horizonHours });
  const errors: FinalScheduleProjectionError[] = [];
  const candidate = [...context.existingItems];
  const mutatedTargets = new Set<string>();
  const touchedIds = new Set<string>();
  const createdIds = new Set<string>();
  let selfActivityId: string | undefined;
  let validatedLostSleepMinutes = 0;

  for (const mutation of normalized.mutations) {
    if (mutation.operation === "create") {
      const rangeValid = validateRange(
        mutation.item.startAtUtc,
        mutation.item.endAtUtc,
        mutation.path,
        now,
        horizon,
        horizonHours,
        errors,
      );
      try {
        parseZone(mutation.item.timezone);
      } catch {
        errors.push({
          code: "INVALID_TIME",
          path: `${mutation.path}.timezone`,
          message: "Schedule item timezone must be a valid IANA timezone",
        });
      }
      if (
        mutation.item.sourceRoutineId !== undefined &&
        normalized.owner !== "routine"
      ) {
        errors.push({
          code: "SOURCE_OWNERSHIP_MISMATCH",
          path: `${mutation.path}.sourceRoutineId`,
          message: "Only the routine planner may attach a sourceRoutineId",
        });
      }
      if (
        normalized.selfPlan &&
        (mutation.item.rigidity === "fixed" ||
          mutation.item.rigidity === "committed")
      ) {
        errors.push({
          code: "SELF_PLAN_RIGIDITY_REJECTED",
          path: `${mutation.path}.rigidity`,
          message: "Self-initiated activities must remain movable",
        });
      }
      if (!rangeValid) continue;

      const id = stableId(
        "schedule",
        `${context.agentId}:${source}:${mutation.item.title}:${mutation.item.startAtUtc}:${mutation.item.endAtUtc}`,
      );
      if (candidate.some((item) => item.id === id) || createdIds.has(id)) {
        errors.push({
          code: "DUPLICATE_MUTATION",
          path: mutation.path,
          message: "The bundle would create the same schedule item twice",
        });
        continue;
      }
      const created: ScheduleItemLike = {
        ...mutation.item,
        stateEffects: normalizedStateEffects(mutation.item.stateEffects),
        id,
        agentId: context.agentId,
        source,
        status: "planned",
        revision: 0,
        createdAtUtc: context.nowUtc,
        updatedAtUtc: context.nowUtc,
      };
      candidate.push(created);
      createdIds.add(id);
      touchedIds.add(id);
      if (normalized.selfPlan) selfActivityId = id;
      continue;
    }

    if (mutatedTargets.has(mutation.itemId)) {
      errors.push({
        code: "DUPLICATE_MUTATION",
        path: mutation.path,
        message: "A bundle may mutate an existing item only once",
      });
      continue;
    }
    mutatedTargets.add(mutation.itemId);

    const targetIndex = findTargetIndex(candidate, mutation.itemId);
    const target = candidate[targetIndex];
    if (targetIndex < 0 || target === undefined) {
      errors.push({
        code: "UNKNOWN_ITEM",
        path: `${mutation.path}.itemId`,
        message: "Schedule item was not found",
      });
      continue;
    }
    if (target.agentId !== context.agentId) {
      errors.push({
        code: "ITEM_OWNERSHIP_MISMATCH",
        path: `${mutation.path}.itemId`,
        message: "A bundle may mutate only its agent's schedule",
      });
      continue;
    }
    if (
      mutation.expectedRevision !== undefined &&
      mutation.expectedRevision !== target.revision
    ) {
      errors.push({
        code: "REVISION_MISMATCH",
        path: `${mutation.path}.expectedRevision`,
        message: "Schedule item changed after the bundle was prepared",
      });
      continue;
    }
    if (TERMINAL_STATUSES.has(target.status)) {
      errors.push({
        code: "TERMINAL_ITEM",
        path: `${mutation.path}.itemId`,
        message: "Terminal schedule items cannot change",
      });
      continue;
    }

    if (mutation.operation === "cancel") {
      if (target.rigidity === "fixed") {
        errors.push({
          code: "FIXED_ITEM_IMMUTABLE",
          path: `${mutation.path}.itemId`,
          message: "Fixed schedule items cannot be cancelled",
        });
        continue;
      }
      if (target.rigidity === "committed") {
        errors.push({
          code: "COMMITTED_ITEM_IMMUTABLE",
          path: `${mutation.path}.itemId`,
          message: "Committed schedule items cannot be cancelled by default",
        });
        continue;
      }
      if (isSleepItem(target)) {
        errors.push({
          code: "SLEEP_REQUIRED",
          path: `${mutation.path}.itemId`,
          message: "Sleep cannot be deleted",
        });
        continue;
      }
      candidate[targetIndex] = {
        ...target,
        status: "cancelled",
        revision: target.revision + 1,
        updatedAtUtc: context.nowUtc,
      };
      touchedIds.add(target.id);
      continue;
    }

    const sleepTarget = isSleepItem(target);
    if (target.rigidity === "fixed") {
      if (!mutation.fixedSleepAdjustment || !sleepTarget) {
        errors.push({
          code: "FIXED_ITEM_IMMUTABLE",
          path: `${mutation.path}.itemId`,
          message: "Only the paired sleep adjustment may shorten fixed sleep",
        });
        continue;
      }
    }
    if (target.rigidity === "committed") {
      errors.push({
        code: "COMMITTED_ITEM_IMMUTABLE",
        path: `${mutation.path}.itemId`,
        message: "Committed schedule items cannot be moved by default",
      });
      continue;
    }
    const rangeValid = validateRange(
      mutation.newStartAtUtc,
      mutation.newEndAtUtc,
      mutation.path,
      now,
      horizon,
      horizonHours,
      errors,
    );
    if (!rangeValid) continue;

    let plannedSleepReductionMinutes = target.plannedSleepReductionMinutes ?? 0;
    if (mutation.fixedSleepAdjustment) {
      if (!normalized.selfPlan || !sleepTarget) {
        errors.push({
          code: "SLEEP_ADJUSTMENT_TARGET_INVALID",
          path: `${mutation.path}.sleepItemId`,
          message: "A night adjustment may target only the agent's sleep item",
        });
      } else {
        const oldStart = parseInstant(target.startAtUtc);
        const oldEnd = parseInstant(target.endAtUtc);
        const newStart = parseInstant(mutation.newStartAtUtc);
        const newEnd = parseInstant(mutation.newEndAtUtc);
        if (newStart < oldStart || newEnd > oldEnd) {
          errors.push({
            code: "SLEEP_ADJUSTMENT_INVALID",
            path: mutation.path,
            message: "A night bundle may shorten sleep but cannot move it",
          });
        }
        const actualLost =
          minutesBetween(target.startAtUtc, target.endAtUtc) -
          minutesBetween(mutation.newStartAtUtc, mutation.newEndAtUtc);
        const declaredLost =
          normalized.sleepAdjustment?.lostSleepMinutes ?? Number.NaN;
        if (
          actualLost < 0 ||
          !Number.isFinite(declaredLost) ||
          Math.abs(actualLost - declaredLost) > 1e-6
        ) {
          errors.push({
            code: "LOST_SLEEP_MISMATCH",
            path: `${mutation.path}.lostSleepMinutes`,
            message: "lostSleepMinutes must equal the actual sleep reduction",
          });
        } else {
          validatedLostSleepMinutes = actualLost;
          plannedSleepReductionMinutes = Math.min(
            720,
            plannedSleepReductionMinutes + actualLost,
          );
        }
      }
    }

    if (
      sleepTarget &&
      minutesBetween(mutation.newStartAtUtc, mutation.newEndAtUtc) <
        minimumSleepMinutes
    ) {
      errors.push({
        code: "MINIMUM_SLEEP_REQUIRED",
        path: `${mutation.path}.newEndAtUtc`,
        message: `Sleep must preserve at least ${minimumSleepMinutes} minutes`,
      });
    }

    candidate[targetIndex] = {
      ...target,
      startAtUtc: mutation.newStartAtUtc,
      endAtUtc: mutation.newEndAtUtc,
      source: mutation.fixedSleepAdjustment ? target.source : "runtime_replan",
      ...(mutation.fixedSleepAdjustment
        ? { plannedSleepReductionMinutes }
        : {}),
      revision: target.revision + 1,
      updatedAtUtc: context.nowUtc,
    };
    touchedIds.add(target.id);
  }

  if (
    normalized.sleepAdjustment !== undefined &&
    selfActivityId !== undefined
  ) {
    const activity = candidate.find((item) => item.id === selfActivityId);
    const originalSleep = context.existingItems.find(
      (item) => item.id === normalized.sleepAdjustment?.sleepItemId,
    );
    if (
      activity !== undefined &&
      originalSleep !== undefined &&
      !overlaps(activity, originalSleep)
    ) {
      errors.push({
        code: "SLEEP_ADJUSTMENT_INVALID",
        path: "sleepAdjustment",
        message: "Sleep may be shortened only to resolve the paired activity",
      });
    }
    if (activity !== undefined) {
      const rollingCount = countRollingNightSelfPlans(
        candidate,
        activity,
        context.agentId,
        context.timezone,
        context.policy.sleepWindow,
      );
      if (rollingCount > maxNightSelfPlansPerRolling7Days) {
        errors.push({
          code: "NIGHT_SELF_PLAN_FREQUENCY_LIMIT",
          path: "activity",
          message:
            `Night self-planning would reach ${rollingCount} material ` +
            `sleep-window intrusions in rolling 7 days; maximum is ` +
            `${maxNightSelfPlansPerRolling7Days}`,
          conflictingItemId: activity.id,
        });
      }
    }
  }

  for (let leftIndex = 0; leftIndex < candidate.length; leftIndex += 1) {
    const left = candidate[leftIndex];
    if (
      left === undefined ||
      left.agentId !== context.agentId ||
      left.status === "cancelled"
    ) {
      continue;
    }
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < candidate.length;
      rightIndex += 1
    ) {
      const right = candidate[rightIndex];
      if (
        right === undefined ||
        right.agentId !== context.agentId ||
        right.status === "cancelled" ||
        (!touchedIds.has(left.id) && !touchedIds.has(right.id))
      ) {
        continue;
      }
      try {
        if (!overlaps(left, right)) continue;
      } catch {
        continue;
      }
      const conflicting =
        touchedIds.has(left.id) && !touchedIds.has(right.id) ? right : left;
      errors.push({
        code:
          left.rigidity === "fixed" || right.rigidity === "fixed"
            ? "OVERLAP_FIXED"
            : "OVERLAP",
        path: "bundle",
        message: `Final schedule overlaps '${conflicting.title}'`,
        conflictingItemId: conflicting.id,
      });
    }
  }

  for (const item of candidate) {
    if (
      !touchedIds.has(item.id) ||
      item.status === "cancelled" ||
      isSleepItem(item) ||
      (normalized.selfPlan &&
        normalized.sleepAdjustment !== undefined &&
        item.id === selfActivityId)
    ) {
      continue;
    }
    try {
      if (
        sleepWindowOverlapMinutes(
          item,
          context.timezone,
          context.policy.sleepWindow,
        ) > 60
      ) {
        errors.push({
          code: "SLEEP_WINDOW_VIOLATION",
          path: "bundle",
          message: "Activity substantially intrudes on the sleep window",
          conflictingItemId: item.id,
        });
      }
    } catch {
      // Item timestamps were validated above.
    }
  }

  try {
    const before = commitmentHoursByDay(
      context.existingItems,
      context.timezone,
    );
    const after = commitmentHoursByDay(candidate, context.timezone);
    for (const [day, total] of after) {
      if (
        total > context.policy.maxCommittedHoursPerDay + 1e-6 &&
        total > (before.get(day) ?? 0) + 1e-6
      ) {
        errors.push({
          code: "DAILY_COMMITMENT_LIMIT",
          path: "bundle",
          message: `${day} has ${total.toFixed(1)} committed hours, above the configured limit`,
        });
      }
    }
  } catch {
    // Existing storage contracts own validation of pre-existing timestamps.
  }

  if (errors.length > 0) {
    return projectionFailure(context.existingItems, errors);
  }

  return {
    ok: true,
    valid: true,
    errors: [],
    projectedItems: candidate,
    createdItems: candidate.filter((item) => createdIds.has(item.id)),
    changedItems: candidate.filter(
      (item) => touchedIds.has(item.id) && !createdIds.has(item.id),
    ),
    lostSleepMinutes: validatedLostSleepMinutes,
  };
}
