import type { DateTime } from "luxon";
import type {
  ScheduleItemLike,
  ScheduleRigidityLike,
} from "./schedule-validator.js";
import { overlaps, parseInstant, parseZone, stableId } from "./shared.js";

export interface RoutineRuleLike {
  id: string;
  title: string;
  category: string;
  recurrence: string;
  preferredStartLocal: string;
  preferredDurationMinutes: number;
  rigidity: ScheduleRigidityLike;
  priority: number;
}

export interface PlanningCharacterLike {
  id: string;
  identity: { name?: string; workOrRole?: string; timezone: string };
  routines: readonly RoutineRuleLike[];
  schedulePolicy: {
    enabled: boolean;
    horizonHours?: number;
    sleepWindow: { startLocal: string; endLocal: string };
    maxCommittedHoursPerDay: number;
    routineAdherence: number;
  };
}

export interface Plan72HoursInput {
  character: PlanningCharacterLike;
  nowUtc: string;
  existingItems?: readonly ScheduleItemLike[];
  horizonHours?: number;
}

export interface Plan72HoursResult {
  items: ScheduleItemLike[];
  createdItems: ScheduleItemLike[];
  horizonEndUtc: string;
}

function clockParts(value: string, fallback: { hour: number; minute: number }) {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : fallback;
}

function categoryEffects(category: string) {
  const normalized = category.toLocaleLowerCase();
  if (/sleep|睡眠|休息/u.test(normalized)) {
    return { energy: 0.35, stress: -0.12, moodArousal: -0.18 };
  }
  if (/meal|food|用餐|早餐|午餐|晚餐/u.test(normalized)) {
    return { energy: 0.08, stress: -0.03 };
  }
  if (/social|party|聚会|社交/u.test(normalized)) {
    return { socialBattery: -0.12, moodValence: 0.08 };
  }
  if (/study|work|学习|工作/u.test(normalized)) {
    return { energy: -0.1, focus: -0.08, stress: 0.04 };
  }
  return { energy: -0.04 };
}

const SCHEDULE_CATEGORIES = new Set([
  "sleep",
  "work",
  "study",
  "meal",
  "exercise",
  "social",
  "travel",
  "leisure",
  "self_care",
  "errand",
  "other",
]);

function normalizeCategory(value: string): string {
  const normalized = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s-]+/gu, "_");
  if (SCHEDULE_CATEGORIES.has(normalized)) return normalized;
  if (/睡|休息|sleep/u.test(normalized)) return "sleep";
  if (/学习|阅读|study|class/u.test(normalized)) return "study";
  if (/工作|work|job/u.test(normalized)) return "work";
  if (/饭|餐|meal|food/u.test(normalized)) return "meal";
  if (/运动|exercise|sport/u.test(normalized)) return "exercise";
  if (/社交|聚会|social|party/u.test(normalized)) return "social";
  if (/旅行|travel|trip/u.test(normalized)) return "travel";
  if (/娱乐|leisure|game/u.test(normalized)) return "leisure";
  if (/照顾|整理|复盘|self/u.test(normalized)) return "self_care";
  if (/采购|办事|errand/u.test(normalized)) return "errand";
  return "other";
}

function occursOnDay(recurrence: string, day: DateTime): boolean {
  const normalized = recurrence.toLocaleLowerCase();
  if (/weekday|工作日/u.test(normalized)) return day.weekday <= 5;
  if (/weekend|周末/u.test(normalized)) return day.weekday >= 6;
  const weekdays = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  const mentioned = weekdays.findIndex((name) => normalized.includes(name));
  return mentioned < 0 || mentioned + 1 === day.weekday;
}

function collidesWithBuffer(
  candidate: Pick<ScheduleItemLike, "startAtUtc" | "endAtUtc">,
  items: readonly ScheduleItemLike[],
): boolean {
  const buffered = {
    startAtUtc:
      parseInstant(candidate.startAtUtc).minus({ minutes: 15 }).toISO() ??
      candidate.startAtUtc,
    endAtUtc:
      parseInstant(candidate.endAtUtc).plus({ minutes: 15 }).toISO() ??
      candidate.endAtUtc,
  };
  return items.some(
    (item) => item.status !== "cancelled" && overlaps(buffered, item),
  );
}

function createItem(
  character: PlanningCharacterLike,
  title: string,
  category: string,
  start: DateTime,
  end: DateTime,
  rigidity: ScheduleRigidityLike,
  priority: number,
  nowUtc: string,
  source: ScheduleItemLike["source"],
): ScheduleItemLike {
  const safeCategory = normalizeCategory(category);
  const startAtUtc = start.toUTC().toISO() ?? "";
  const endAtUtc = end.toUTC().toISO() ?? "";
  const key = `${character.id}:${title}:${startAtUtc}:${endAtUtc}`;
  const normalizedCategory = safeCategory.toLocaleLowerCase();
  const shareable = /travel|party|social|match|旅行|聚会|比赛|特殊/u.test(
    normalizedCategory,
  );
  return {
    id: stableId("schedule", key),
    agentId: character.id,
    title,
    description: `根据 ${character.identity.name ?? "角色"} 的习惯安排`,
    category: safeCategory,
    startAtUtc,
    endAtUtc,
    timezone: character.identity.timezone,
    status: "planned",
    rigidity,
    priority: Math.min(1, Math.max(0, priority)),
    source,
    adherenceProbability:
      rigidity === "fixed"
        ? 0.98
        : Math.min(0.98, character.schedulePolicy.routineAdherence + 0.08),
    narrativeImportance: shareable
      ? 0.75
      : Math.min(0.65, Math.max(0.15, priority * 0.55)),
    shareable,
    stateEffects: categoryEffects(safeCategory),
    revision: 0,
    createdAtUtc: nowUtc,
    updatedAtUtc: nowUtc,
  };
}

function tryPlace(
  candidate: ScheduleItemLike,
  all: ScheduleItemLike[],
  created: ScheduleItemLike[],
  now: DateTime,
  horizon: DateTime,
): void {
  const start = parseInstant(candidate.startAtUtc);
  const end = parseInstant(candidate.endAtUtc);
  if (
    start < now ||
    end > horizon ||
    end <= start ||
    collidesWithBuffer(candidate, all)
  )
    return;
  all.push(candidate);
  created.push(candidate);
}

export function plan72HoursDetailed(
  input: Plan72HoursInput,
): Plan72HoursResult {
  const { character, nowUtc } = input;
  if (!character.schedulePolicy.enabled) {
    return {
      items: [...(input.existingItems ?? [])],
      createdItems: [],
      horizonEndUtc: nowUtc,
    };
  }
  parseZone(character.identity.timezone);
  const now = parseInstant(nowUtc);
  const horizonHours = Math.min(
    72,
    input.horizonHours ?? character.schedulePolicy.horizonHours ?? 72,
  );
  const horizon = now.plus({ hours: horizonHours });
  const localNow = now.setZone(character.identity.timezone);
  const all = [...(input.existingItems ?? [])];
  const created: ScheduleItemLike[] = [];
  const sleepStart = clockParts(
    character.schedulePolicy.sleepWindow.startLocal,
    {
      hour: 23,
      minute: 0,
    },
  );
  const sleepEnd = clockParts(character.schedulePolicy.sleepWindow.endLocal, {
    hour: 8,
    minute: 0,
  });

  for (let offset = -1; offset <= 4; offset += 1) {
    const day = localNow.startOf("day").plus({ days: offset });
    const sleepFrom = day.set(sleepStart);
    let sleepTo = day.set(sleepEnd);
    if (sleepTo <= sleepFrom) sleepTo = sleepTo.plus({ days: 1 });
    tryPlace(
      createItem(
        character,
        "睡眠",
        "sleep",
        sleepFrom,
        sleepTo,
        "fixed",
        1,
        nowUtc,
        "initial_plan",
      ),
      all,
      created,
      now,
      horizon,
    );

    const meals = [
      { title: "早餐", hour: 8, minute: 15, duration: 30 },
      { title: "午餐", hour: 12, minute: 30, duration: 45 },
      { title: "晚餐", hour: 18, minute: 30, duration: 45 },
    ];
    for (const meal of meals) {
      const start = day.set({ hour: meal.hour, minute: meal.minute });
      tryPlace(
        createItem(
          character,
          meal.title,
          "meal",
          start,
          start.plus({ minutes: meal.duration }),
          "flexible",
          0.65,
          nowUtc,
          "initial_plan",
        ),
        all,
        created,
        now,
        horizon,
      );
    }

    for (const routine of character.routines) {
      if (!occursOnDay(routine.recurrence, day)) continue;
      const preferred = clockParts(routine.preferredStartLocal, {
        hour: 10,
        minute: 0,
      });
      const start = day.set(preferred);
      const duration = Math.min(
        8 * 60,
        Math.max(15, routine.preferredDurationMinutes),
      );
      tryPlace(
        createItem(
          character,
          routine.title,
          routine.category,
          start,
          start.plus({ minutes: duration }),
          routine.rigidity,
          routine.priority,
          nowUtc,
          "routine",
        ),
        all,
        created,
        now,
        horizon,
      );
    }
  }

  all.sort((left, right) => left.startAtUtc.localeCompare(right.startAtUtc));
  created.sort((left, right) =>
    left.startAtUtc.localeCompare(right.startAtUtc),
  );
  return {
    items: all,
    createdItems: created,
    horizonEndUtc: horizon.toISO() ?? horizon.toJSDate().toISOString(),
  };
}

/** Concise API used by the server: returns only newly planned, non-overlapping items. */
export function plan72h(input: Plan72HoursInput): ScheduleItemLike[] {
  return plan72HoursDetailed(input).createdItems;
}

export const plan72Hours = plan72h;
