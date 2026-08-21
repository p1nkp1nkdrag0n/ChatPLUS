import type {
  ScheduleCategory,
  SelfPlanBundle,
  ServerScheduleItemDraft,
} from "@personasim/contracts";
import type { DateTime } from "luxon";

import {
  deriveActivityAffinities,
  type ActivityAffinities,
  type ActivityAffinityCharacterLike,
} from "./activity-affinity.js";
import {
  findFreeSlots,
  type FreeSlot,
  type ScheduleIntervalLike,
} from "./free-slot.js";
import { clamp, parseInstant, parseZone, seededUnit } from "./shared.js";

export type SelfPlanningCharacterLike = ActivityAffinityCharacterLike & {
  id: string;
  version: number;
  identity: {
    timezone: string;
    workOrRole?: string;
    worldSetting?: string;
    selfDescription?: string;
  };
};

export interface PersonalIntentLike {
  id: string;
  agentId: string;
  activity: string;
  category: ScheduleCategory;
  desiredDurationMinutes: number;
  earliestAtUtc?: string;
  latestAtUtc?: string;
  priority: number;
  freshness: number;
  status: string;
  specVersion: number;
  createdAtUtc?: string;
}

export interface SelfPlanningStateLike {
  moodValence: number;
  energy: number;
  stress: number;
  socialBattery: number;
  focus: number;
  sleepDebtMinutes?: number;
}

export interface RankedPersonalIntent {
  intent: PersonalIntentLike;
  affinity: number;
  stateCompatibility: number;
}

export type SelfPlanningSkipReason =
  | "not_pending"
  | "agent_mismatch"
  | "spec_version_mismatch"
  | "invalid_intent"
  | "no_free_slot";

export interface SelfPlanningSkippedIntent {
  intentId: string;
  reason: SelfPlanningSkipReason;
}

export interface RankedPersonalIntentSummary {
  intentId: string;
  priority: number;
  freshness: number;
  affinity: number;
  stateCompatibility: number;
}

export interface SelfPlanningResult {
  bundle?: SelfPlanBundle;
  selectedIntentId?: string;
  targetLocalDay?: string;
  seed?: string;
  rankedCandidates: RankedPersonalIntentSummary[];
  skipped: SelfPlanningSkippedIntent[];
}

export interface PlanSelfInitiatedActivityInput {
  character: SelfPlanningCharacterLike;
  state: SelfPlanningStateLike;
  intents: readonly PersonalIntentLike[];
  existingItems: readonly ScheduleIntervalLike[];
  hardIntervals?: readonly ScheduleIntervalLike[];
  nowUtc: string;
  horizonEndAtUtc: string;
  affinities?: ActivityAffinities;
  bufferMinutes?: number;
  minimumActivityMinutes?: number;
  /** Real elapsed sleep minutes that must remain after a night adjustment. */
  minimumSleepMinutes?: number;
}

interface DailyStartWindow {
  earliestStart: DateTime;
  latestStart: DateTime;
  targetLocalDay: string;
}

interface PlacementOption {
  start: DateTime;
  end: DateTime;
  targetLocalDay: string;
  seed: string;
  roll: number;
}

interface IntentPlacementWindow {
  durationMinutes: number;
  earliest: DateTime;
  latest: DateTime;
}

interface SleepShorteningPlacement extends PlacementOption {
  sleepAdjustment: NonNullable<SelfPlanBundle["sleepAdjustment"]>;
  lostSleepMinutes: number;
  nextDayWorkloadMinutes: number;
}

const NIGHT_ACTIVITY_PATTERN =
  /night|midnight|late[ -]?night|stargaz|after dark|\u6df1\u591c|\u5348\u591c|\u89c2\u661f|\u62cd\u661f|\u661f\u7a7a|\u591c\u8dd1|\u591c\u5e02|\u901a\u5bb5|\u6d41\u661f/iu;

export function stateCompatibilityForCategory(
  category: ScheduleCategory,
  state: SelfPlanningStateLike,
): number {
  const energy = clamp(state.energy);
  const stress = clamp(state.stress);
  const socialBattery = clamp(state.socialBattery);
  const focus = clamp(state.focus);
  const mood = clamp((state.moodValence + 1) / 2);
  const sleepDebt = clamp((state.sleepDebtMinutes ?? 0) / 720);

  switch (category) {
    case "sleep":
      return clamp(0.2 + (1 - energy) * 0.45 + sleepDebt * 0.35);
    case "work":
    case "study":
      return clamp(energy * 0.35 + focus * 0.5 + (1 - stress) * 0.15);
    case "meal":
      return clamp(0.55 + (1 - energy) * 0.2);
    case "exercise":
      return clamp(energy * 0.65 + (1 - stress) * 0.2 + mood * 0.15);
    case "social":
      return clamp(socialBattery * 0.55 + mood * 0.25 + (1 - stress) * 0.2);
    case "travel":
      return clamp(energy * 0.55 + (1 - stress) * 0.25 + mood * 0.2);
    case "leisure":
      return clamp(0.35 + stress * 0.25 + mood * 0.25 + energy * 0.15);
    case "self_care":
      return clamp(0.35 + stress * 0.4 + (1 - energy) * 0.25);
    case "errand":
      return clamp(energy * 0.45 + focus * 0.35 + (1 - stress) * 0.2);
    case "other":
      return 0.5;
  }
}

export function rankPersonalIntents(
  intents: readonly PersonalIntentLike[],
  affinities: ActivityAffinities,
  state: SelfPlanningStateLike,
): RankedPersonalIntent[] {
  return intents
    .map((intent) => ({
      intent,
      affinity: clamp(affinities.categoryScores[intent.category]),
      stateCompatibility: stateCompatibilityForCategory(intent.category, state),
    }))
    .sort(
      (left, right) =>
        clamp(right.intent.priority) - clamp(left.intent.priority) ||
        clamp(right.intent.freshness) - clamp(left.intent.freshness) ||
        right.affinity - left.affinity ||
        right.stateCompatibility - left.stateCompatibility ||
        (left.intent.createdAtUtc ?? "").localeCompare(
          right.intent.createdAtUtc ?? "",
        ) ||
        left.intent.id.localeCompare(right.intent.id),
    );
}

export function selfPlanningSeed(
  agentId: string,
  intentId: string,
  specVersion: number,
  targetLocalDay: string,
): string {
  return `${agentId}:${intentId}:${specVersion}:${targetLocalDay}`;
}

function maximum(left: DateTime, right: DateTime): DateTime {
  return left >= right ? left : right;
}

function minimum(left: DateTime, right: DateTime): DateTime {
  return left <= right ? left : right;
}

function toUtcIso(value: DateTime): string {
  return value.toUTC().toISO() ?? value.toJSDate().toISOString();
}

function dailyStartWindows(
  slot: FreeSlot,
  durationMinutes: number,
  timezone: string,
): DailyStartWindow[] {
  const slotStart = parseInstant(slot.startAtUtc).setZone(timezone);
  const slotEnd = parseInstant(slot.endAtUtc).setZone(timezone);
  const latestPossibleStart = slotEnd.minus({ minutes: durationMinutes });
  if (latestPossibleStart < slotStart) return [];

  const result: DailyStartWindow[] = [];
  let day = slotStart.startOf("day");
  const lastDay = latestPossibleStart.startOf("day");
  while (day <= lastDay) {
    const nextDay = day.plus({ days: 1 });
    const earliestStart = maximum(slotStart, day);
    const latestStart = minimum(
      latestPossibleStart,
      nextDay.minus({ milliseconds: 1 }),
    );
    if (latestStart >= earliestStart) {
      result.push({
        earliestStart,
        latestStart,
        targetLocalDay: day.toISODate() ?? "",
      });
    }
    day = nextDay;
  }
  return result;
}

function placementOptions(
  slots: readonly FreeSlot[],
  durationMinutes: number,
  timezone: string,
  agentId: string,
  intentId: string,
  specVersion: number,
): PlacementOption[] {
  const options: PlacementOption[] = [];
  for (const slot of slots) {
    for (const window of dailyStartWindows(slot, durationMinutes, timezone)) {
      const seed = selfPlanningSeed(
        agentId,
        intentId,
        specVersion,
        window.targetLocalDay,
      );
      const roll = seededUnit(seed);
      const availableMilliseconds =
        window.latestStart.toMillis() - window.earliestStart.toMillis();
      const stepMilliseconds = 5 * 60_000;
      const stepCount = Math.floor(availableMilliseconds / stepMilliseconds);
      const chosenStep = Math.floor(roll * (stepCount + 1));
      const start = window.earliestStart.plus({
        milliseconds: chosenStep * stepMilliseconds,
      });
      options.push({
        start,
        end: start.plus({ minutes: durationMinutes }),
        targetLocalDay: window.targetLocalDay,
        seed,
        roll,
      });
    }
  }
  return options.sort(
    (left, right) =>
      left.roll - right.roll ||
      left.start.toMillis() - right.start.toMillis() ||
      left.seed.localeCompare(right.seed),
  );
}

function activityStateEffects(
  category: ScheduleCategory,
): ServerScheduleItemDraft["stateEffects"] {
  switch (category) {
    case "sleep":
      return { energy: 0.25, stress: -0.08 };
    case "work":
    case "study":
      return { energy: -0.08, focus: -0.05, stress: 0.03 };
    case "meal":
      return { energy: 0.08, stress: -0.02 };
    case "exercise":
      return { energy: -0.12, stress: -0.08, moodValence: 0.06 };
    case "social":
      return { socialBattery: -0.1, moodValence: 0.06 };
    case "travel":
      return { energy: -0.12, stress: 0.02 };
    case "leisure":
      return { energy: -0.04, stress: -0.05, moodValence: 0.08 };
    case "self_care":
      return { energy: 0.06, stress: -0.1 };
    case "errand":
      return { energy: -0.05, focus: -0.02 };
    case "other":
      return { energy: -0.03 };
  }
}

function scheduleDraft(
  intent: PersonalIntentLike,
  placement: PlacementOption,
  timezone: string,
  affinity: number,
  stateEffects?: ServerScheduleItemDraft["stateEffects"],
): ServerScheduleItemDraft {
  return {
    title: intent.activity,
    description: `Self-initiated plan for intent ${intent.id}`,
    category: intent.category,
    startAtUtc: toUtcIso(placement.start),
    endAtUtc: toUtcIso(placement.end),
    timezone,
    rigidity: "flexible",
    priority: clamp(0.35 + affinity * 0.3),
    adherenceProbability: 0.72,
    narrativeImportance: 0.6,
    shareable: true,
    stateEffects: stateEffects ?? activityStateEffects(intent.category),
  };
}

function intentPlacementWindow(
  intent: PersonalIntentLike,
  now: DateTime,
  horizonEnd: DateTime,
  minimumActivityMinutes: number,
): IntentPlacementWindow | undefined {
  const durationMinutes = Math.max(
    minimumActivityMinutes,
    intent.desiredDurationMinutes,
  );
  let earliest = now;
  let latest = horizonEnd;
  try {
    if (intent.earliestAtUtc !== undefined) {
      earliest = maximum(
        earliest,
        parseInstant(intent.earliestAtUtc, "intent.earliestAtUtc"),
      );
    }
    if (intent.latestAtUtc !== undefined) {
      latest = minimum(
        latest,
        parseInstant(intent.latestAtUtc, "intent.latestAtUtc"),
      );
    }
  } catch {
    return undefined;
  }
  return latest <= earliest ? undefined : { durationMinutes, earliest, latest };
}

function tryPlaceIntent(
  ranked: RankedPersonalIntent,
  input: PlanSelfInitiatedActivityInput,
  now: DateTime,
  horizonEnd: DateTime,
  minimumActivityMinutes: number,
  bufferMinutes: number,
): PlacementOption | undefined {
  const intent = ranked.intent;
  const window = intentPlacementWindow(
    intent,
    now,
    horizonEnd,
    minimumActivityMinutes,
  );
  if (window === undefined) return undefined;
  const { durationMinutes, earliest, latest } = window;

  let slots: FreeSlot[];
  try {
    slots = findFreeSlots({
      horizonStartAtUtc: toUtcIso(earliest),
      horizonEndAtUtc: toUtcIso(latest),
      timezone: input.character.identity.timezone,
      existingItems: input.existingItems,
      ...(input.hardIntervals === undefined
        ? {}
        : { hardIntervals: input.hardIntervals }),
      durationMinutes,
      minimumDurationMinutes: minimumActivityMinutes,
      bufferMinutes,
    });
  } catch {
    return undefined;
  }

  return placementOptions(
    slots,
    durationMinutes,
    input.character.identity.timezone,
    input.character.id,
    intent.id,
    intent.specVersion,
  )[0];
}

function nightPlacementEligible(
  candidate: RankedPersonalIntent,
  affinities: ActivityAffinities,
): boolean {
  const intent = candidate.intent;
  if (intent.category === "sleep") return false;
  if (NIGHT_ACTIVITY_PATTERN.test(intent.activity)) return true;
  return (
    seededUnit(`night:${intent.agentId}:${intent.id}:${intent.specVersion}`) <
    clamp(affinities.nightOwlBias)
  );
}

function nextDayWorkloadMinutes(
  input: PlanSelfInitiatedActivityInput,
  wakeAt: DateTime,
): number {
  const timezone = input.character.identity.timezone;
  const localWake = wakeAt.setZone(timezone);
  const dayEnd = localWake.startOf("day").plus({ days: 1 }).toUTC();
  const rangeStart = wakeAt.toMillis();
  const rangeEnd = dayEnd.toMillis();
  if (rangeEnd <= rangeStart) return 0;

  const intervals: { start: number; end: number }[] = [];
  for (const item of [...input.existingItems, ...(input.hardIntervals ?? [])]) {
    if (
      item.status === "cancelled" ||
      (item.category !== "work" && item.category !== "study")
    ) {
      continue;
    }
    try {
      const start = parseInstant(item.startAtUtc).toMillis();
      const end = parseInstant(item.endAtUtc).toMillis();
      const clippedStart = Math.max(rangeStart, start);
      const clippedEnd = Math.min(rangeEnd, end);
      if (clippedEnd > clippedStart) {
        intervals.push({ start: clippedStart, end: clippedEnd });
      }
    } catch {
      // Malformed schedule data cannot make a night plan more attractive.
    }
  }

  intervals.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let totalMilliseconds = 0;
  let mergedStart: number | undefined;
  let mergedEnd: number | undefined;
  for (const interval of intervals) {
    if (
      mergedStart === undefined ||
      mergedEnd === undefined ||
      interval.start > mergedEnd
    ) {
      if (mergedStart !== undefined && mergedEnd !== undefined) {
        totalMilliseconds += mergedEnd - mergedStart;
      }
      mergedStart = interval.start;
      mergedEnd = interval.end;
    } else {
      mergedEnd = Math.max(mergedEnd, interval.end);
    }
  }
  if (mergedStart !== undefined && mergedEnd !== undefined) {
    totalMilliseconds += mergedEnd - mergedStart;
  }
  return totalMilliseconds / 60_000;
}

function nightActivityStateEffects(
  category: ScheduleCategory,
  state: SelfPlanningStateLike,
  lostSleepMinutes: number,
  nextDayWorkload: number,
): ServerScheduleItemDraft["stateEffects"] {
  const base = activityStateEffects(category);
  const lostSleepLoad = clamp(lostSleepMinutes / 240);
  const existingDebtLoad = clamp((state.sleepDebtMinutes ?? 0) / 720);
  const workloadLoad = clamp(nextDayWorkload / 480);
  const fatigueLoad = clamp(
    lostSleepLoad * 0.55 + existingDebtLoad * 0.25 + workloadLoad * 0.2,
  );

  return {
    ...base,
    energy: clamp((base.energy ?? 0) - (0.05 + fatigueLoad * 0.32), -1, 1),
    focus: clamp(
      (base.focus ?? 0) - (fatigueLoad * 0.18 + workloadLoad * 0.04),
      -1,
      1,
    ),
    stress: clamp(
      (base.stress ?? 0) + fatigueLoad * 0.12 + workloadLoad * 0.06,
      -1,
      1,
    ),
  };
}

function mutableSleepItem(item: ScheduleIntervalLike): boolean {
  return (
    item.category === "sleep" &&
    item.id !== undefined &&
    item.id.trim() !== "" &&
    item.rigidity !== "committed" &&
    !["in_progress", "completed", "partial", "skipped", "cancelled"].includes(
      item.status ?? "planned",
    )
  );
}

function isSleepShorteningPlacement(
  placement: PlacementOption,
): placement is SleepShorteningPlacement {
  return "sleepAdjustment" in placement;
}

function tryPlaceIntentByShorteningSleep(
  candidate: RankedPersonalIntent,
  input: PlanSelfInitiatedActivityInput,
  now: DateTime,
  horizonEnd: DateTime,
  minimumActivityMinutes: number,
  minimumSleepMinutes: number,
  bufferMinutes: number,
  affinities: ActivityAffinities,
): SleepShorteningPlacement | undefined {
  if (!nightPlacementEligible(candidate, affinities)) return undefined;
  const intent = candidate.intent;
  const window = intentPlacementWindow(
    intent,
    now,
    horizonEnd,
    minimumActivityMinutes,
  );
  if (window === undefined) return undefined;

  const options: SleepShorteningPlacement[] = [];
  for (const [sleepIndex, sleep] of input.existingItems.entries()) {
    if (!mutableSleepItem(sleep)) continue;

    try {
      const sleepStart = parseInstant(sleep.startAtUtc, "sleep.startAtUtc");
      const sleepEnd = parseInstant(sleep.endAtUtc, "sleep.endAtUtc");
      if (sleepStart < now || sleepEnd <= sleepStart) continue;

      const latestActivityEnd = sleepEnd.minus({
        minutes: minimumSleepMinutes,
      });
      if (latestActivityEnd <= sleepStart) continue;

      const slots = findFreeSlots({
        horizonStartAtUtc: toUtcIso(window.earliest),
        horizonEndAtUtc: toUtcIso(window.latest),
        timezone: input.character.identity.timezone,
        existingItems: input.existingItems.filter(
          (_item, index) => index !== sleepIndex,
        ),
        ...(input.hardIntervals === undefined
          ? {}
          : { hardIntervals: input.hardIntervals }),
        durationMinutes: window.durationMinutes,
        minimumDurationMinutes: minimumActivityMinutes,
        bufferMinutes,
      });

      for (const slot of slots) {
        const slotStart = parseInstant(slot.startAtUtc);
        const slotEnd = parseInstant(slot.endAtUtc);
        const start = maximum(maximum(window.earliest, sleepStart), slotStart);
        const allowedEnd = minimum(
          minimum(window.latest, latestActivityEnd),
          slotEnd,
        );
        const end = start.plus({ minutes: window.durationMinutes });
        if (end > allowedEnd) continue;

        const lostSleepMinutes =
          (end.toMillis() - sleepStart.toMillis()) / 60_000;
        if (
          !Number.isInteger(lostSleepMinutes) ||
          lostSleepMinutes <= 0 ||
          lostSleepMinutes > 720
        ) {
          continue;
        }

        const targetLocalDay =
          start.setZone(input.character.identity.timezone).toISODate() ?? "";
        const seed = selfPlanningSeed(
          input.character.id,
          intent.id,
          intent.specVersion,
          targetLocalDay,
        );
        options.push({
          start,
          end,
          targetLocalDay,
          seed,
          roll: seededUnit(`${seed}:sleep:${sleep.id}`),
          lostSleepMinutes,
          nextDayWorkloadMinutes: nextDayWorkloadMinutes(input, sleepEnd),
          sleepAdjustment: {
            sleepItemId: sleep.id!,
            newStartAtUtc: toUtcIso(end),
            newEndAtUtc: toUtcIso(sleepEnd),
            lostSleepMinutes,
          },
        });
      }
    } catch {
      // Invalid sleep data cannot be adjusted; try the next candidate/item.
    }
  }

  return options.sort(
    (left, right) =>
      left.lostSleepMinutes - right.lostSleepMinutes ||
      left.roll - right.roll ||
      left.start.toMillis() - right.start.toMillis() ||
      left.seed.localeCompare(right.seed),
  )[0];
}

/**
 * Ranks pending intents, attempts them in order, and returns at most one
 * server-owned SelfPlanBundle. A failed first placement never blocks the next
 * candidate.
 */
export function planSelfInitiatedActivity(
  input: PlanSelfInitiatedActivityInput,
): SelfPlanningResult {
  parseZone(input.character.identity.timezone);
  const now = parseInstant(input.nowUtc, "nowUtc");
  const horizonEnd = parseInstant(input.horizonEndAtUtc, "horizonEndAtUtc");
  if (horizonEnd <= now) {
    throw new TypeError("horizonEndAtUtc must be after nowUtc");
  }
  const minimumActivityMinutes = Math.max(
    5,
    Math.trunc(input.minimumActivityMinutes ?? 15),
  );
  const bufferMinutes = Math.max(0, Math.trunc(input.bufferMinutes ?? 15));
  const minimumSleepMinutes = input.minimumSleepMinutes ?? 360;
  if (!Number.isInteger(minimumSleepMinutes) || minimumSleepMinutes < 0) {
    throw new TypeError("minimumSleepMinutes must be a non-negative integer");
  }
  const affinities =
    input.affinities ?? deriveActivityAffinities(input.character);
  const eligible: PersonalIntentLike[] = [];
  const skipped: SelfPlanningSkippedIntent[] = [];

  for (const intent of input.intents) {
    if (intent.status !== "pending") {
      skipped.push({ intentId: intent.id, reason: "not_pending" });
    } else if (intent.agentId !== input.character.id) {
      skipped.push({ intentId: intent.id, reason: "agent_mismatch" });
    } else if (intent.specVersion !== input.character.version) {
      skipped.push({
        intentId: intent.id,
        reason: "spec_version_mismatch",
      });
    } else if (
      !Number.isInteger(intent.desiredDurationMinutes) ||
      intent.desiredDurationMinutes <= 0
    ) {
      skipped.push({ intentId: intent.id, reason: "invalid_intent" });
    } else {
      eligible.push(intent);
    }
  }

  const ranked = rankPersonalIntents(eligible, affinities, input.state);
  const rankedCandidates = ranked.map((candidate) => ({
    intentId: candidate.intent.id,
    priority: clamp(candidate.intent.priority),
    freshness: clamp(candidate.intent.freshness),
    affinity: candidate.affinity,
    stateCompatibility: candidate.stateCompatibility,
  }));

  for (const candidate of ranked) {
    const ordinaryPlacement = tryPlaceIntent(
      candidate,
      input,
      now,
      horizonEnd,
      minimumActivityMinutes,
      bufferMinutes,
    );
    const placement =
      ordinaryPlacement ??
      tryPlaceIntentByShorteningSleep(
        candidate,
        input,
        now,
        horizonEnd,
        minimumActivityMinutes,
        minimumSleepMinutes,
        bufferMinutes,
        affinities,
      );
    if (placement === undefined) {
      skipped.push({
        intentId: candidate.intent.id,
        reason: "no_free_slot",
      });
      continue;
    }

    const sleepPlacement = isSleepShorteningPlacement(placement)
      ? placement
      : undefined;
    return {
      bundle: {
        intentId: candidate.intent.id,
        activity: scheduleDraft(
          candidate.intent,
          placement,
          input.character.identity.timezone,
          candidate.affinity,
          sleepPlacement === undefined
            ? undefined
            : nightActivityStateEffects(
                candidate.intent.category,
                input.state,
                sleepPlacement.lostSleepMinutes,
                sleepPlacement.nextDayWorkloadMinutes,
              ),
        ),
        ...(sleepPlacement === undefined
          ? {}
          : { sleepAdjustment: sleepPlacement.sleepAdjustment }),
      },
      selectedIntentId: candidate.intent.id,
      targetLocalDay: placement.targetLocalDay,
      seed: placement.seed,
      rankedCandidates,
      skipped,
    };
  }

  return {
    rankedCandidates,
    skipped,
  };
}

export const planSelfInitiatedActivities = planSelfInitiatedActivity;
