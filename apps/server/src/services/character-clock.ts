import { DateTime } from "luxon";

import type { DatabaseStore } from "../db/store.js";
import { buildTimeBasedGoalMilestones } from "../domain/defaults.js";
import type { LifePlanningMode } from "../domain/capabilities.js";
import { ApiError } from "../domain/errors.js";
import type { CharacterDraft } from "../domain/schemas.js";

export function applyLifePlanningAuthority(
  draft: CharacterDraft,
  lifePlanningMode: LifePlanningMode,
): CharacterDraft {
  if (lifePlanningMode === "legacy_exact") return draft;
  return {
    ...draft,
    // Keep the persisted compatibility field readable, but never advertise
    // its writer as enabled while this server runs the fuzzy-life model.
    schedulePolicy: { ...draft.schedulePolicy, enabled: false },
  };
}

export function ensureTimeBasedGoalMilestones(
  draft: CharacterDraft,
): CharacterDraft {
  const next = structuredClone(draft);
  next.persona.goals = next.persona.goals.map((goal) => ({
    ...goal,
    milestones:
      goal.milestones?.length === undefined || goal.milestones.length < 2
        ? buildTimeBasedGoalMilestones(goal.id, goal.title)
        : goal.milestones,
  }));
  return next;
}

export function assertCharacterClockIsEditable(
  store: DatabaseStore,
  agentId: string,
  previous: CharacterDraft,
  candidate: CharacterDraft,
): void {
  if (
    characterClockSignature(previous) === characterClockSignature(candidate) ||
    !store.hasFuzzyLifeState(agentId)
  ) {
    return;
  }
  throw new ApiError(
    409,
    "character_story_clock_locked",
    "Timezone or story-time anchors cannot be changed after life simulation has started. Create a new character or use a future explicit timeline-rebase operation.",
  );
}

export function assertTimezone(timezone: string): void {
  if (!DateTime.utc().setZone(timezone).isValid) {
    throw new ApiError(
      400,
      "invalid_timezone",
      `Unsupported IANA timezone: ${timezone}`,
    );
  }
}

export function normalizeTemporalAnchor(
  draft: CharacterDraft,
  nowUtc: string,
  previous?: CharacterDraft,
): CharacterDraft {
  if (draft.identity.temporalFrame?.mode !== "anchored_story") return draft;
  const previousFrame = previous?.identity.temporalFrame;
  const preservesStoryClock =
    previousFrame?.mode === "anchored_story" &&
    previous?.identity.timezone === draft.identity.timezone &&
    sameAuthoredStoryAnchor(previousFrame, draft.identity.temporalFrame);
  const storyAnchorLocalDate = preservesStoryClock
    ? previousFrame.storyAnchorLocalDate
    : operationalStoryAnchorDate(
        draft.identity.temporalFrame.storyAnchorLocalDate,
        draft.identity.temporalFrame.anchorPrecision ?? "day",
        draft.identity.timezone,
        nowUtc,
      );
  return {
    ...draft,
    identity: {
      ...draft.identity,
      temporalFrame: {
        ...draft.identity.temporalFrame,
        storyAnchorLocalDate,
        systemAnchorUtc:
          (preservesStoryClock ? previousFrame.systemAnchorUtc : undefined) ??
          nowUtc,
      },
    },
  };
}

function characterClockSignature(draft: CharacterDraft): string {
  const frame = draft.identity.temporalFrame;
  return JSON.stringify({
    timezone: draft.identity.timezone,
    mode: frame?.mode ?? "realtime",
    ...(frame?.mode !== "anchored_story"
      ? {}
      : {
          storyAnchorLocalDate: frame.storyAnchorLocalDate,
          anchorPrecision: frame.anchorPrecision ?? "day",
          systemAnchorUtc: frame.systemAnchorUtc,
        }),
  });
}

function sameAuthoredStoryAnchor(
  left: Extract<
    NonNullable<CharacterDraft["identity"]["temporalFrame"]>,
    { mode: "anchored_story" }
  >,
  right: Extract<
    NonNullable<CharacterDraft["identity"]["temporalFrame"]>,
    { mode: "anchored_story" }
  >,
): boolean {
  const precision = right.anchorPrecision ?? "day";
  if ((left.anchorPrecision ?? "day") !== precision) return false;
  if (
    left.storyAnchorLocalDate.slice(0, 4) !==
    right.storyAnchorLocalDate.slice(0, 4)
  ) {
    return false;
  }
  if (precision === "year") return true;
  if (
    left.storyAnchorLocalDate.slice(5, 7) !==
    right.storyAnchorLocalDate.slice(5, 7)
  ) {
    return false;
  }
  return (
    precision === "month" ||
    left.storyAnchorLocalDate === right.storyAnchorLocalDate
  );
}

function operationalStoryAnchorDate(
  authoredDate: string,
  precision: "year" | "month" | "day",
  timezone: string,
  nowUtc: string,
): string {
  if (precision === "day") return authoredDate;
  const authored = DateTime.fromISO(authoredDate, { zone: timezone });
  const nowLocal = DateTime.fromISO(nowUtc, { setZone: true }).setZone(
    timezone,
  );
  const month = precision === "year" ? nowLocal.month : authored.month;
  const daysInMonth =
    DateTime.fromObject(
      { year: authored.year, month, day: 1 },
      { zone: timezone },
    ).daysInMonth ?? 28;
  return DateTime.fromObject(
    {
      year: authored.year,
      month,
      day: Math.min(nowLocal.day, daysInMonth),
    },
    { zone: timezone },
  ).toISODate()!;
}
