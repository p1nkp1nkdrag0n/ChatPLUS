import { DateTime } from "luxon";

/**
 * Normalization pipeline for model-proposed schedule effects.
 *
 * The model returns loose JSON (local clock times, item references by id,
 * index or title, aliased operations). This module resolves each effect
 * against the authoritative schedule context and grounds it in the user's
 * own words before it is allowed to enter the strict proposal validator.
 * Every rejected effect is returned with a reason so the caller can record
 * an audit trail; a rejection never invalidates the reply itself.
 */

export interface ModelEffectScheduleItemLike {
  id: string;
  title: string;
  category?: string;
  startAtUtc: string;
  endAtUtc: string;
  status?: string;
  rigidity?: string;
}

export interface ModelEffectItemDraftLike {
  title: string;
  description: string;
  category: string;
  startAtUtc: string;
  endAtUtc: string;
  timezone: string;
  rigidity: "fixed" | "committed" | "flexible" | "filler";
  priority: number;
  source: string;
  adherenceProbability: number;
  narrativeImportance: number;
  shareable: boolean;
  stateEffects: Record<string, number>;
}

export type ModelEffectProposalLike =
  | {
      operation: "create";
      item: ModelEffectItemDraftLike;
      reasonCode: string;
      reasonSummary: string;
    }
  | {
      operation: "reschedule";
      itemId: string;
      newStartAtUtc: string;
      newEndAtUtc: string;
      reasonCode: string;
      reasonSummary: string;
    }
  | {
      operation: "cancel";
      itemId: string;
      reasonCode: string;
      reasonSummary: string;
    };

export interface ModelEffectRejection {
  raw: unknown;
  reasonCode: string;
  reasonSummary: string;
}

export interface NormalizeModelEffectsInput {
  effects: readonly unknown[];
  schedule: readonly ModelEffectScheduleItemLike[];
  timezone: string;
  nowUtc: string;
  userText: string;
  maxEffects?: number;
}

export interface NormalizeModelEffectsResult {
  accepted: ModelEffectProposalLike[];
  rejections: ModelEffectRejection[];
}

const SCHEDULE_INTENT_PATTERN =
  /(晚会|派对|聚会|饭局|party|celebrat|邀请|邀我|约我|约个|一起(?:去|参加|吃|玩|出[门去])|陪[我你]|见面|碰面|约会|出来(?:吃|玩|见)?|改天|换个时间|推迟|延后|提前|改期|改时间|取消(?:掉|了|吧)?|不去了|去不了|挪到|挪一挪|调整.{0,8}(?:计划|日程|安排)|(?:计划|日程|安排).{0,8}(?:改|变|调整|取消|挪)|要不要.{0,6}(?:去|来|一起)|reschedule|postpone|move\s.{0,20}\bto\b|cancel\s|invite|hang\s?out|meet\s?up|shall\swe)/iu;

const OPERATION_ALIASES: Record<string, ModelEffectProposalLike["operation"]> =
  {
    create: "create",
    add: "create",
    new: "create",
    make: "create",
    insert: "create",
    新增: "create",
    创建: "create",
    增加: "create",
    reschedule: "reschedule",
    move: "reschedule",
    shift: "reschedule",
    postpone: "reschedule",
    delay: "reschedule",
    change: "reschedule",
    update: "reschedule",
    replan: "reschedule",
    移动: "reschedule",
    改期: "reschedule",
    推迟: "reschedule",
    延后: "reschedule",
    挪: "reschedule",
    cancel: "cancel",
    delete: "cancel",
    remove: "cancel",
    drop: "cancel",
    skip: "cancel",
    取消: "cancel",
    删除: "cancel",
  };

const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/睡|sleep|nap/i, "sleep"],
  [/早餐|早饭|午餐|午饭|晚餐|晚饭|吃饭|meal|breakfast|lunch|dinner/i, "meal"],
  [/学习|自习|复习|备考|功课|study|class|homework/i, "study"],
  [/工作|加班|开会|上班|写稿|赶稿|work|meeting|shift/i, "work"],
  [/运动|健身|跑步|散步|锻炼|exercise|gym|run|jog/i, "exercise"],
  [/晚会|派对|聚会|社交|饭局|party|social|gather/i, "social"],
  [/旅行|出游|外出|远足|travel|trip|outing/i, "travel"],
  [/娱乐|游戏|电影|看剧|玩|leisure|game|movie|fun/i, "leisure"],
  [/采购|买菜|办事|errand|shopping|chore/i, "errand"],
  [/休息|放松|泡澡|护肤|self.?care|rest|relax/i, "self_care"],
];

const VALID_CATEGORIES = new Set([
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

const VALID_RIGIDITY = new Set(["fixed", "committed", "flexible", "filler"]);

const JUSTIFICATION_KEYS = [
  "justificationQuote",
  "justification",
  "quote",
  "evidence",
  "userQuote",
  "sourceQuote",
] as const;

const ITEM_ID_KEYS = ["itemId", "item_id", "scheduleItemId", "id"] as const;
const ITEM_INDEX_KEYS = ["scheduleIndex", "itemIndex", "index"] as const;
const ITEM_TITLE_KEYS = ["itemTitle", "targetTitle", "title"] as const;

/** Cheap rule-based gate deciding whether a turn may propose schedule effects. */
export function hasScheduleIntent(text: string): boolean {
  return SCHEDULE_INTENT_PATTERN.test(text);
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(value: string): string[] {
  const grams: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.push(value.slice(index, index + 2));
  }
  return grams;
}

function quoteCoverage(quote: string, userText: string): number {
  const quoteGrams = bigrams(quote);
  if (quoteGrams.length === 0) return 0;
  const userGrams = new Set(bigrams(userText));
  let hits = 0;
  for (const gram of quoteGrams) {
    if (userGrams.has(gram)) hits += 1;
  }
  return hits / quoteGrams.length;
}

/**
 * A proposal is grounded when its justification quote is copied (or lightly
 * paraphrased) from the user's own message. Invented intent cannot provide a
 * grounded quote, which is the primary defense against hallucinated schedule
 * changes.
 */
export function justificationIsGrounded(
  quote: string,
  userText: string,
): boolean {
  const normalizedQuote = normalizeForMatch(quote);
  if (normalizedQuote.length < 2) return false;
  const normalizedUser = normalizeForMatch(userText);
  if (normalizedUser.includes(normalizedQuote)) return true;
  return quoteCoverage(normalizedQuote, normalizedUser) >= 0.6;
}

function firstString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function sanitizeReasonCode(value: unknown): string {
  if (typeof value !== "string") return "model_proposal";
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (cleaned === "" || !/^[a-z]/.test(cleaned)) return "model_proposal";
  return cleaned;
}

function sanitizeReasonSummary(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, 240);
  return trimmed === "" ? fallback : trimmed;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function normalizedUnit(value: unknown, fallback: number): number {
  const parsed = firstNumberLike(value);
  if (parsed === undefined) return fallback;
  return clamp01(parsed > 1 ? parsed / 100 : parsed);
}

function firstNumberLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

interface LocalClock {
  dayOffset: number;
  hour: number;
  minute: number;
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function parseChineseInteger(value: string): number | undefined {
  if (value === "十") return 10;
  const ten = value.indexOf("十");
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : CHINESE_DIGITS[value[ten - 1] ?? ""];
    const ones =
      ten === value.length - 1 ? 0 : CHINESE_DIGITS[value[ten + 1] ?? ""];
    if (tens === undefined || ones === undefined) return undefined;
    return tens * 10 + ones;
  }
  if (value.length === 1) return CHINESE_DIGITS[value];
  const digits = [...value].map((digit) => CHINESE_DIGITS[digit]);
  if (digits.some((digit) => digit === undefined)) return undefined;
  return Number(digits.join(""));
}

function parseLocalClock(text: string): LocalClock | undefined {
  const dayOffset = /后天/.test(text)
    ? 2
    : /(明天|明日|明早|明晚|tomorrow)/i.test(text)
      ? 1
      : 0;
  const colonMatch = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(text);
  const numericPointMatch =
    colonMatch === null
      ? /(\d{1,2})\s*[点时](?:(半|一刻|三刻)|\s*(\d{1,2})\s*分?)?/.exec(text)
      : null;
  const chineseMatch =
    colonMatch === null && numericPointMatch === null
      ? /([零〇一二两三四五六七八九十]{1,3})\s*[点时](?:(半|一刻|三刻)|([零〇一二两三四五六七八九十]{1,3})\s*分)?/u.exec(
          text,
        )
      : null;
  if (
    colonMatch === null &&
    numericPointMatch === null &&
    chineseMatch === null
  ) {
    return undefined;
  }
  let hour = colonMatch
    ? Number(colonMatch[1])
    : numericPointMatch
      ? Number(numericPointMatch[1])
      : parseChineseInteger(chineseMatch?.[1] ?? "");
  const minute = colonMatch
    ? Number(colonMatch[2])
    : numericPointMatch
      ? clockMarkerMinutes(numericPointMatch[2], numericPointMatch[3])
      : clockMarkerMinutes(
          chineseMatch?.[2],
          chineseMatch?.[3],
          parseChineseInteger,
        );
  if (hour === undefined || minute === undefined) return undefined;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
  if (/(晚上|今晚|夜里|夜晚|午夜|night|evening)/i.test(text)) {
    if (hour === 12) hour = 0;
    else if (hour < 12) hour += 12;
  } else if (/(凌晨|before\s+dawn)/i.test(text)) {
    if (hour === 12) hour = 0;
  } else if (/(中午|下午|傍晚|noon|afternoon|pm)/i.test(text)) {
    if (hour < 12) hour += 12;
  }
  if (hour > 23 || minute > 59) return undefined;
  return { dayOffset, hour, minute };
}

function clockMarkerMinutes(
  marker: string | undefined,
  numeric: string | undefined,
  parser: (value: string) => number | undefined = Number,
): number | undefined {
  if (marker === "半") return 30;
  if (marker === "一刻") return 15;
  if (marker === "三刻") return 45;
  return numeric === undefined ? 0 : parser(numeric);
}

/**
 * Resolves a model-supplied time reference to a UTC ISO instant. Accepts
 * ISO timestamps (with or without zone), local clock times such as
 * "19:30"、"今晚八点"、"明天 9:00", and relative offsets like "2小时后".
 */
export function parseModelTime(
  raw: unknown,
  context: { timezone: string; nowUtc: string },
): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const fromEpoch = DateTime.fromMillis(raw, { zone: "utc" });
    return fromEpoch.isValid ? fromEpoch.toISO()! : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text === "") return undefined;

  // Time-only strings such as "19:30" are technically valid ISO for Luxon
  // (it anchors them to the next day), which would bypass the roll-forward
  // rule below. Only strings carrying an explicit date take the ISO path.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const iso = DateTime.fromISO(text, {
      zone: context.timezone,
      setZone: true,
    });
    if (iso.isValid) return iso.toUTC().toISO()!;
  }

  const now = DateTime.fromISO(context.nowUtc).setZone(context.timezone);

  const relativeHours =
    /(\d+(?:\.\d+)?)\s*个?小时后/u.exec(text) ??
    /in\s+(\d+)\s+hours?/i.exec(text) ??
    (/(?:半|0?\.5)\s*小时后/u.test(text) ? [undefined, "0.5"] : null);
  if (relativeHours !== null) {
    const hours = Number(relativeHours[1]);
    if (Number.isFinite(hours)) {
      return now.plus({ hours }).toUTC().toISO()!;
    }
  }

  const relativeMinutes =
    /(\d+)\s*分钟后/u.exec(text) ?? /in\s+(\d+)\s+minutes?/i.exec(text);
  if (relativeMinutes !== null) {
    const minutes = Number(relativeMinutes[1]);
    if (Number.isFinite(minutes)) {
      return now.plus({ minutes }).toUTC().toISO()!;
    }
  }

  const latinMeridiem = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (latinMeridiem !== null) {
    const hourRaw = Number(latinMeridiem[1]);
    const minuteRaw =
      latinMeridiem[2] === undefined ? 0 : Number(latinMeridiem[2]);
    const meridiem = latinMeridiem[3] ?? "";
    let hour = hourRaw;
    if (meridiem.toLowerCase() === "pm" && hour < 12) hour += 12;
    if (meridiem.toLowerCase() === "am" && hour === 12) hour = 0;
    if (hour > 23 || minuteRaw > 59) return undefined;
    let resolved = now.startOf("day").plus({
      days: /(明天|明日|tomorrow)/i.test(text) ? 1 : 0,
      hours: hour,
      minutes: minuteRaw,
    });
    if (resolved <= now) resolved = resolved.plus({ days: 1 });
    return resolved.toUTC().toISO()!;
  }

  const clock = parseLocalClock(text);
  if (clock !== undefined) {
    let resolved = now.startOf("day").plus({
      days: clock.dayOffset,
      hours: clock.hour,
      minutes: clock.minute,
    });
    if (resolved <= now) resolved = resolved.plus({ days: 1 });
    return resolved.toUTC().toISO()!;
  }

  return undefined;
}

function parseDurationMinutes(raw: unknown): number | undefined {
  const numeric = firstNumberLike(raw);
  if (numeric !== undefined && numeric > 0 && numeric <= 24 * 60) {
    return numeric <= 24 ? Math.round(numeric * 60) : Math.round(numeric);
  }
  if (typeof raw === "string") {
    const hours = /(\d+(?:\.\d+)?)\s*(?:个)?小时/u.exec(raw);
    if (hours !== null) return Math.round(Number(hours[1]) * 60);
    const minutes = /(\d+)\s*分钟/u.exec(raw);
    if (minutes !== null) return Math.round(Number(minutes[1]));
  }
  return undefined;
}

function resolveScheduleItem(
  effect: Record<string, unknown>,
  schedule: readonly ModelEffectScheduleItemLike[],
): ModelEffectScheduleItemLike | undefined {
  const directId = firstString(effect, ITEM_ID_KEYS);
  if (directId !== undefined) {
    const byId = schedule.find((item) => item.id === directId);
    if (byId !== undefined) return byId;
  }
  for (const key of ITEM_INDEX_KEYS) {
    if (effect[key] !== undefined) {
      const index = firstNumberLike(effect[key]);
      if (
        index !== undefined &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < schedule.length
      ) {
        return schedule[index];
      }
    }
  }
  const title = firstString(effect, ITEM_TITLE_KEYS);
  if (title !== undefined) {
    const normalizedTitle = normalizeForMatch(title);
    const exact = schedule.find(
      (item) => normalizeForMatch(item.title) === normalizedTitle,
    );
    if (exact !== undefined) return exact;
    const contained = schedule.find((item) => {
      const candidate = normalizeForMatch(item.title);
      return (
        candidate.length >= 2 &&
        (candidate.includes(normalizedTitle) ||
          normalizedTitle.includes(candidate))
      );
    });
    if (contained !== undefined) return contained;
  }
  return undefined;
}

function sanitizeStateEffects(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, number> = {};
  const source = value as Record<string, unknown>;
  for (const key of [
    "moodValence",
    "moodArousal",
    "energy",
    "stress",
    "socialBattery",
    "focus",
  ]) {
    const raw = firstNumberLike(source[key]);
    if (raw === undefined) continue;
    output[key] =
      key === "moodValence" || key === "moodArousal"
        ? clampSigned(raw)
        : clamp01(raw);
  }
  return output;
}

function categoryFrom(value: unknown, title: string): string {
  if (typeof value === "string" && VALID_CATEGORIES.has(value)) return value;
  for (const [pattern, category] of CATEGORY_KEYWORDS) {
    if (pattern.test(title)) return category;
  }
  return "other";
}

function rejection(
  raw: unknown,
  reasonCode: string,
  reasonSummary: string,
): ModelEffectRejection {
  return { raw, reasonCode, reasonSummary };
}

export function normalizeModelEffects(
  input: NormalizeModelEffectsInput,
): NormalizeModelEffectsResult {
  const maxEffects = input.maxEffects ?? 3;
  const accepted: ModelEffectProposalLike[] = [];
  const rejections: ModelEffectRejection[] = [];
  const timeContext = { timezone: input.timezone, nowUtc: input.nowUtc };

  const effects = input.effects.slice(0, 12);
  if (input.effects.length > 12) {
    rejections.push(
      rejection(
        input.effects.slice(12),
        "too_many_effects",
        "A single turn may propose at most 12 effects; the rest were dropped.",
      ),
    );
  }

  for (const raw of effects) {
    if (accepted.length >= maxEffects) {
      rejections.push(
        rejection(
          raw,
          "too_many_effects",
          `A single turn may commit at most ${maxEffects} effects.`,
        ),
      );
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      rejections.push(
        rejection(
          raw,
          "malformed_effect",
          "The effect entry is not an object.",
        ),
      );
      continue;
    }
    const effect = raw as Record<string, unknown>;

    const reasonCode = sanitizeReasonCode(effect.reasonCode);
    const reasonSummary = sanitizeReasonSummary(
      effect.reasonSummary,
      "Model-proposed schedule effect grounded in the user message.",
    );

    const quote = firstString(effect, JUSTIFICATION_KEYS);
    if (quote === undefined) {
      rejections.push(
        rejection(
          raw,
          "missing_justification",
          "The effect did not cite a justificationQuote from the user message.",
        ),
      );
      continue;
    }
    if (!justificationIsGrounded(quote, input.userText)) {
      rejections.push(
        rejection(
          raw,
          "ungrounded_justification",
          "The cited justification does not appear in the user message.",
        ),
      );
      continue;
    }

    const rawOperation =
      typeof effect.operation === "string"
        ? effect.operation.trim().toLowerCase()
        : "";
    const operation =
      OPERATION_ALIASES[rawOperation] ??
      (/^(create|add|new)/.test(rawOperation)
        ? "create"
        : /^(cancel|delete|remove)/.test(rawOperation)
          ? "cancel"
          : /^(reschedule|move|postpone|delay)/.test(rawOperation)
            ? "reschedule"
            : undefined);

    if (operation === undefined) {
      rejections.push(
        rejection(
          raw,
          "unknown_operation",
          `Unsupported operation "${rawOperation}".`,
        ),
      );
      continue;
    }

    if (operation === "cancel" || operation === "reschedule") {
      const target = resolveScheduleItem(effect, input.schedule);
      if (target === undefined) {
        rejections.push(
          rejection(
            raw,
            "unresolved_item",
            "The effect did not reference a known schedule item.",
          ),
        );
        continue;
      }
      if (operation === "cancel") {
        accepted.push({
          operation: "cancel",
          itemId: target.id,
          reasonCode,
          reasonSummary,
        });
        continue;
      }
      const startRaw =
        firstString(effect, [
          "newStartAtUtc",
          "newStart",
          "startAt",
          "startTime",
        ]) ??
        firstString(
          typeof effect.item === "object" &&
            effect.item !== null &&
            !Array.isArray(effect.item)
            ? (effect.item as Record<string, unknown>)
            : {},
          ["startAtUtc", "start", "startTime"],
        );
      const newStartAtUtc = parseModelTime(startRaw, timeContext);
      if (newStartAtUtc === undefined) {
        rejections.push(
          rejection(
            raw,
            "unparseable_time",
            "The new start time could not be resolved.",
          ),
        );
        continue;
      }
      const endRaw = firstString(effect, [
        "newEndAtUtc",
        "newEnd",
        "endAt",
        "endTime",
      ]);
      let newEndAtUtc = parseModelTime(endRaw, timeContext);
      if (newEndAtUtc === undefined) {
        const originalMinutes = Math.max(
          15,
          Math.round(
            DateTime.fromISO(target.endAtUtc).diff(
              DateTime.fromISO(target.startAtUtc),
              "minutes",
            ).minutes,
          ),
        );
        newEndAtUtc = DateTime.fromISO(newStartAtUtc)
          .plus({ minutes: originalMinutes })
          .toUTC()
          .toISO()!;
      }
      accepted.push({
        operation: "reschedule",
        itemId: target.id,
        newStartAtUtc,
        newEndAtUtc,
        reasonCode,
        reasonSummary,
      });
      continue;
    }

    const draftSource =
      typeof effect.item === "object" &&
      effect.item !== null &&
      !Array.isArray(effect.item)
        ? (effect.item as Record<string, unknown>)
        : effect;
    const title = firstString(draftSource, ["title", "name", "activity"]);
    if (title === undefined) {
      rejections.push(
        rejection(raw, "missing_title", "A created item needs a title."),
      );
      continue;
    }
    const startRaw = firstString(draftSource, [
      "startAtUtc",
      "startAt",
      "start",
      "startTime",
      "startLocal",
    ]);
    const startAtUtc = parseModelTime(startRaw, timeContext);
    if (startAtUtc === undefined) {
      rejections.push(
        rejection(
          raw,
          "unparseable_time",
          "The created item start time could not be resolved.",
        ),
      );
      continue;
    }
    const endRaw = firstString(draftSource, [
      "endAtUtc",
      "endAt",
      "end",
      "endTime",
      "endLocal",
    ]);
    const durationMinutes =
      parseDurationMinutes(
        draftSource.durationMinutes ?? draftSource.duration,
      ) ?? 120;
    let endAtUtc = parseModelTime(endRaw, timeContext);
    if (endAtUtc === undefined) {
      endAtUtc = DateTime.fromISO(startAtUtc)
        .plus({ minutes: durationMinutes })
        .toUTC()
        .toISO()!;
    }

    const rigidityRaw =
      typeof draftSource.rigidity === "string"
        ? draftSource.rigidity.trim().toLowerCase()
        : "";
    const shareableRaw = draftSource.shareable;
    accepted.push({
      operation: "create",
      item: {
        title: title.slice(0, 160),
        description:
          typeof draftSource.description === "string"
            ? draftSource.description.trim().slice(0, 1_000)
            : "",
        category: categoryFrom(draftSource.category, title),
        startAtUtc,
        endAtUtc,
        timezone: input.timezone,
        rigidity: VALID_RIGIDITY.has(rigidityRaw)
          ? (rigidityRaw as ModelEffectItemDraftLike["rigidity"])
          : "flexible",
        priority: normalizedUnit(draftSource.priority, 0.6),
        source: "user_invitation",
        adherenceProbability: normalizedUnit(
          draftSource.adherenceProbability,
          0.8,
        ),
        narrativeImportance: normalizedUnit(
          draftSource.narrativeImportance,
          0.5,
        ),
        shareable:
          shareableRaw === true ||
          shareableRaw === "true" ||
          shareableRaw === 1,
        stateEffects: sanitizeStateEffects(draftSource.stateEffects),
      },
      reasonCode,
      reasonSummary,
    });
  }

  return { accepted, rejections };
}
