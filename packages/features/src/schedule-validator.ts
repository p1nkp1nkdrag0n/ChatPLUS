import type { StateDeltaLike } from "./state-engine.js";
import {
  HOUR_MS,
  localDayKey,
  minutesBetween,
  overlaps,
  parseInstant,
  parseZone,
  stableId,
} from "./shared.js";

export type ScheduleRigidityLike =
  "fixed" | "committed" | "flexible" | "filler";
export type ScheduleStatusLike =
  "planned" | "in_progress" | "completed" | "partial" | "skipped" | "cancelled";

export interface ScheduleItemDraftLike {
  title: string;
  description: string;
  category: string;
  startAtUtc: string;
  endAtUtc: string;
  timezone: string;
  rigidity: ScheduleRigidityLike;
  priority: number;
  source:
    | "routine"
    | "initial_plan"
    | "user_invitation"
    | "runtime_replan"
    | "manual";
  adherenceProbability: number;
  narrativeImportance: number;
  shareable: boolean;
  stateEffects: StateDeltaLike;
}

export interface ScheduleItemLike extends ScheduleItemDraftLike {
  id: string;
  agentId: string;
  status: ScheduleStatusLike;
  revision: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface ScheduleEffectProposalLike {
  operation: "create" | "reschedule" | "cancel";
  itemId?: string;
  item?: ScheduleItemDraftLike;
  newStartAtUtc?: string;
  newEndAtUtc?: string;
  reasonCode: string;
  reasonSummary: string;
}

export interface SchedulePolicyLike {
  horizonHours?: number;
  maxCommittedHoursPerDay: number;
  sleepWindow: { startLocal: string; endLocal: string };
}

export interface ScheduleValidationContext {
  agentId: string;
  nowUtc: string;
  timezone: string;
  existingItems: readonly ScheduleItemLike[];
  policy: SchedulePolicyLike;
  horizonHours?: number;
}

export type ScheduleValidationErrorCode =
  | "INVALID_PROPOSAL_SHAPE"
  | "INVALID_TIME"
  | "NOT_IN_FUTURE"
  | "OUTSIDE_HORIZON"
  | "UNKNOWN_ITEM"
  | "TERMINAL_ITEM"
  | "FIXED_ITEM_IMMUTABLE"
  | "COMMITTED_CANCELLATION_REJECTED"
  | "OVERLAP"
  | "OVERLAP_FIXED"
  | "DAILY_COMMITMENT_LIMIT"
  | "SLEEP_REQUIRED"
  | "SLEEP_WINDOW_VIOLATION";

export interface ScheduleValidationError {
  code: ScheduleValidationErrorCode;
  path: string;
  message: string;
  conflictingItemId?: string;
}

export interface ScheduleValidationResult {
  ok: boolean;
  valid: boolean;
  errors: ScheduleValidationError[];
  projectedItems: ScheduleItemLike[];
}

const TERMINAL_STATUSES = new Set<ScheduleStatusLike>([
  "completed",
  "partial",
  "skipped",
  "cancelled",
]);
const COMMITTED_CANCELLATION_REASONS = new Set([
  "accepted_invitation",
  "user_invitation",
  "user_request",
  "schedule_conflict",
  "health",
  "emergency",
  "higher_priority_commitment",
]);
const INSTANT_WITH_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/iu;

function isSleepItem(
  item: Pick<ScheduleItemDraftLike, "title" | "category">,
): boolean {
  return /sleep|睡眠|睡觉|休息/iu.test(`${item.category} ${item.title}`);
}

function asValidUtc(
  value: string | undefined,
  path: string,
  errors: ScheduleValidationError[],
) {
  if (value === undefined || !INSTANT_WITH_OFFSET.test(value)) {
    errors.push({
      code: "INVALID_TIME",
      path,
      message: `${path} must include a UTC offset`,
    });
    return undefined;
  }
  try {
    return parseInstant(value, path);
  } catch {
    errors.push({
      code: "INVALID_TIME",
      path,
      message: `${path} is not a valid instant`,
    });
    return undefined;
  }
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

function sleepOverlapMinutes(
  item: Pick<ScheduleItemDraftLike, "startAtUtc" | "endAtUtc">,
  timezone: string,
  window: SchedulePolicyLike["sleepWindow"],
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
    if (overlapEnd > overlapStart)
      total += (overlapEnd - overlapStart) / (60 * 1_000);
    day = day.plus({ days: 1 });
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
      !["fixed", "committed"].includes(item.rigidity) ||
      isSleepItem(item)
    ) {
      continue;
    }
    let cursor = parseInstant(item.startAtUtc).setZone(timezone);
    const end = parseInstant(item.endAtUtc).setZone(timezone);
    while (cursor < end) {
      const boundary = cursor.plus({ days: 1 }).startOf("day");
      const partEnd = boundary < end ? boundary : end;
      const key = cursor.toISODate() ?? localDayKey(item.startAtUtc, timezone);
      result.set(
        key,
        (result.get(key) ?? 0) + partEnd.diff(cursor, "hours").hours,
      );
      cursor = partEnd;
    }
  }
  return result;
}

function projectCreate(
  proposal: ScheduleEffectProposalLike,
  context: ScheduleValidationContext,
): ScheduleItemLike | undefined {
  const item = proposal.item;
  if (item === undefined) return undefined;
  const key = `${context.agentId}:${item.title}:${item.startAtUtc}:${item.endAtUtc}`;
  return {
    ...item,
    id: stableId("schedule", key),
    agentId: context.agentId,
    status: "planned",
    source: "user_invitation",
    revision: 0,
    createdAtUtc: context.nowUtc,
    updatedAtUtc: context.nowUtc,
  };
}

function projectProposal(
  proposal: ScheduleEffectProposalLike,
  context: ScheduleValidationContext,
  items: readonly ScheduleItemLike[],
): ScheduleItemLike[] {
  if (proposal.operation === "create") {
    const created = projectCreate(proposal, context);
    return created === undefined ? [...items] : [...items, created];
  }
  const targetIndex = items.findIndex((item) => item.id === proposal.itemId);
  if (targetIndex < 0) return [...items];
  const target = items[targetIndex];
  if (target === undefined) return [...items];
  const replacement: ScheduleItemLike =
    proposal.operation === "cancel"
      ? {
          ...target,
          status: "cancelled",
          revision: target.revision + 1,
          updatedAtUtc: context.nowUtc,
        }
      : {
          ...target,
          startAtUtc: proposal.newStartAtUtc ?? target.startAtUtc,
          endAtUtc: proposal.newEndAtUtc ?? target.endAtUtc,
          source: "runtime_replan",
          revision: target.revision + 1,
          updatedAtUtc: context.nowUtc,
        };
  const result = [...items];
  result[targetIndex] = replacement;
  return result;
}

export function applyScheduleProposal(
  proposal: ScheduleEffectProposalLike,
  context: ScheduleValidationContext,
): ScheduleItemLike[] {
  return projectProposal(proposal, context, context.existingItems);
}

export function validateScheduleProposal(
  proposal: ScheduleEffectProposalLike,
  context: ScheduleValidationContext,
): ScheduleValidationResult {
  const errors: ScheduleValidationError[] = [];
  try {
    parseZone(context.timezone);
  } catch {
    errors.push({
      code: "INVALID_TIME",
      path: "timezone",
      message: "Invalid IANA timezone",
    });
  }
  const now = asValidUtc(context.nowUtc, "nowUtc", errors);
  const horizonHours = Math.min(
    72,
    context.horizonHours ?? context.policy.horizonHours ?? 72,
  );
  const horizon = now?.plus({ hours: horizonHours });

  if (
    proposal.reasonCode.trim() === "" ||
    proposal.reasonSummary.trim() === ""
  ) {
    errors.push({
      code: "INVALID_PROPOSAL_SHAPE",
      path: "reasonCode",
      message: "A short reason code and summary are required",
    });
  }
  if (proposal.reasonSummary.length > 240) {
    errors.push({
      code: "INVALID_PROPOSAL_SHAPE",
      path: "reasonSummary",
      message: "reasonSummary cannot exceed 240 characters",
    });
  }

  let affected: ScheduleItemDraftLike | undefined;
  let target: ScheduleItemLike | undefined;
  if (proposal.operation === "create") {
    affected = proposal.item;
    if (affected === undefined) {
      errors.push({
        code: "INVALID_PROPOSAL_SHAPE",
        path: "item",
        message: "Create requires item",
      });
    }
  } else {
    if (proposal.itemId === undefined) {
      errors.push({
        code: "INVALID_PROPOSAL_SHAPE",
        path: "itemId",
        message: `${proposal.operation} requires itemId`,
      });
    } else {
      target = context.existingItems.find(
        (item) => item.id === proposal.itemId,
      );
      if (target === undefined) {
        errors.push({
          code: "UNKNOWN_ITEM",
          path: "itemId",
          message: "Schedule item was not found",
        });
      } else {
        if (TERMINAL_STATUSES.has(target.status)) {
          errors.push({
            code: "TERMINAL_ITEM",
            path: "itemId",
            message: "Terminal items cannot change",
          });
        }
        if (target.rigidity === "fixed") {
          errors.push({
            code: "FIXED_ITEM_IMMUTABLE",
            path: "itemId",
            message:
              "Fixed items cannot be moved or cancelled by a chat proposal",
          });
        }
        if (
          proposal.operation === "cancel" &&
          target.rigidity === "committed" &&
          !COMMITTED_CANCELLATION_REASONS.has(proposal.reasonCode)
        ) {
          errors.push({
            code: "COMMITTED_CANCELLATION_REJECTED",
            path: "reasonCode",
            message:
              "Cancelling a committed item requires a recognized material reason",
          });
        }
      }
    }
    if (proposal.operation === "reschedule" && target !== undefined) {
      affected = {
        ...target,
        startAtUtc: proposal.newStartAtUtc ?? "",
        endAtUtc: proposal.newEndAtUtc ?? "",
      };
      if (
        proposal.newStartAtUtc === undefined ||
        proposal.newEndAtUtc === undefined
      ) {
        errors.push({
          code: "INVALID_PROPOSAL_SHAPE",
          path: "newStartAtUtc",
          message: "Reschedule requires both newStartAtUtc and newEndAtUtc",
        });
      }
    }
  }

  if (affected !== undefined) {
    const start = asValidUtc(affected.startAtUtc, "startAtUtc", errors);
    const end = asValidUtc(affected.endAtUtc, "endAtUtc", errors);
    if (start !== undefined && end !== undefined) {
      if (end <= start) {
        errors.push({
          code: "INVALID_TIME",
          path: "endAtUtc",
          message: "End must be after start",
        });
      }
      if (now !== undefined && start < now) {
        errors.push({
          code: "NOT_IN_FUTURE",
          path: "startAtUtc",
          message: "Only future items can change",
        });
      }
      if (horizon !== undefined && end > horizon) {
        errors.push({
          code: "OUTSIDE_HORIZON",
          path: "endAtUtc",
          message: `Schedule effects must remain inside the next ${horizonHours} hours`,
        });
      }
      if (!isSleepItem(affected)) {
        const sleepMinutes = sleepOverlapMinutes(
          affected,
          context.timezone,
          context.policy.sleepWindow,
        );
        if (sleepMinutes > 60) {
          errors.push({
            code: "SLEEP_WINDOW_VIOLATION",
            path: "item",
            message:
              "The activity substantially intrudes on the configured sleep window",
          });
        }
      }
    }
  }

  if (
    proposal.operation === "cancel" &&
    target !== undefined &&
    isSleepItem(target)
  ) {
    errors.push({
      code: "SLEEP_REQUIRED",
      path: "itemId",
      message: "Sleep cannot be deleted",
    });
  }
  if (
    proposal.operation === "reschedule" &&
    affected !== undefined &&
    isSleepItem(affected) &&
    minutesBetween(affected.startAtUtc, affected.endAtUtc) < 240
  ) {
    errors.push({
      code: "SLEEP_REQUIRED",
      path: "newEndAtUtc",
      message: "A sleep block must preserve at least four hours",
    });
  }

  const projected = projectProposal(proposal, context, context.existingItems);
  const changedId =
    proposal.operation === "create"
      ? projectCreate(proposal, context)?.id
      : proposal.operation === "reschedule"
        ? proposal.itemId
        : undefined;
  if (changedId !== undefined) {
    const changed = projected.find((item) => item.id === changedId);
    if (changed !== undefined) {
      for (const other of projected) {
        if (
          other.id === changed.id ||
          other.status === "cancelled" ||
          changed.status === "cancelled"
        ) {
          continue;
        }
        try {
          if (overlaps(changed, other)) {
            errors.push({
              code: other.rigidity === "fixed" ? "OVERLAP_FIXED" : "OVERLAP",
              path: "item",
              message: `Proposed activity overlaps “${other.title}”`,
              conflictingItemId: other.id,
            });
          }
        } catch {
          // Invalid dates are already reported above.
        }
      }
    }
  }

  try {
    const hours = commitmentHoursByDay(projected, context.timezone);
    for (const [day, total] of hours) {
      if (total > context.policy.maxCommittedHoursPerDay + 1e-6) {
        errors.push({
          code: "DAILY_COMMITMENT_LIMIT",
          path: "item",
          message: `${day} has ${total.toFixed(1)} committed hours, above the configured limit`,
        });
      }
    }
  } catch {
    // Invalid item dates are validated at storage/contract boundaries.
  }

  return {
    ok: errors.length === 0,
    valid: errors.length === 0,
    errors,
    projectedItems: projected,
  };
}

export function validateScheduleProposals(
  proposals: readonly ScheduleEffectProposalLike[],
  context: ScheduleValidationContext,
): ScheduleValidationResult {
  let projected = [...context.existingItems];
  const errors: ScheduleValidationError[] = [];
  for (const proposal of proposals) {
    const result = validateScheduleProposal(proposal, {
      ...context,
      existingItems: projected,
    });
    errors.push(...result.errors);
    if (result.ok) projected = result.projectedItems;
  }
  return {
    ok: errors.length === 0,
    valid: errors.length === 0,
    errors,
    projectedItems: projected,
  };
}

export function millisecondsUntilNextUtcHour(now: Date): number {
  const next = new Date(now.getTime());
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return Math.max(0, next.getTime() - now.getTime());
}

export function isWithin72Hours(nowUtc: string, candidateUtc: string): boolean {
  const delta =
    parseInstant(candidateUtc).toMillis() - parseInstant(nowUtc).toMillis();
  return delta >= 0 && delta <= 72 * HOUR_MS;
}
