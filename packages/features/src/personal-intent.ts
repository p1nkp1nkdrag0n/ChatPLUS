import type {
  PersonalIntent,
  PersonalIntentBasis,
  PersonalIntentCandidate,
  ScheduleCategory,
} from "@personasim/contracts";
import { DateTime } from "luxon";

export interface PersonalIntentSpecSnapshot {
  version: number;
  persona: {
    goals: readonly {
      id: string;
      title: string;
      description: string;
    }[];
    preferences: readonly {
      id: string;
      subject: string;
      preference: string;
      conditions: readonly string[];
    }[];
  };
  routines: readonly {
    id: string;
    title: string;
    category: string;
    recurrence: string;
  }[];
}

export interface PersonalIntentUserMessage {
  id: string;
  text: string;
}

export interface SpontaneousIntentPolicy {
  enabled?: boolean;
  budgetAvailable?: boolean;
  categoryAllowlist?: readonly ScheduleCategory[];
  riskAllowed?: boolean;
  frequencyAllowed?: boolean;
  personaBoundaryAllowed?: boolean;
  scheduleAllowed?: boolean;
}

export interface PersonalIntentGroundingInput {
  activity: string;
  category: ScheduleCategory;
  basisKind: PersonalIntentBasis;
  basisRefIds?: readonly string[];
  evidenceMessageIds?: readonly string[];
  evidenceQuotes?: readonly string[];
}

export interface PersonalIntentGroundingContext {
  spec: PersonalIntentSpecSnapshot;
  currentUserMessage?: PersonalIntentUserMessage;
  spontaneousPolicy?: SpontaneousIntentPolicy;
}

export interface PersonalIntentGrounding {
  basisRefIds: string[];
  evidenceMessageIds: string[];
  evidenceQuotes: string[];
}

export interface PersonalIntentRejection {
  reasonCode: string;
  reasonSummary: string;
}

export type PersonalIntentGroundingResult =
  | { ok: true; grounding: PersonalIntentGrounding }
  | { ok: false; rejection: PersonalIntentRejection };

export interface PersonalIntentTimeWindow {
  earliestAtUtc?: string;
  latestAtUtc?: string;
}

export interface NormalizePersonalIntentCandidateInput {
  candidate: PersonalIntentCandidate;
  agentId: string;
  spec: PersonalIntentSpecSnapshot;
  currentUserMessage: PersonalIntentUserMessage;
  nowUtc: string;
  timezone: string;
  priority?: number;
  freshness?: number;
}

export interface NormalizedPersonalIntent {
  agentId: string;
  activity: string;
  category: ScheduleCategory;
  desiredDurationMinutes: number;
  earliestAtUtc?: string;
  latestAtUtc?: string;
  basisKind: PersonalIntentBasis;
  basisRefIds: string[];
  evidenceMessageIds: string[];
  evidenceQuotes: string[];
  priority: number;
  freshness: number;
  dedupeKey: string;
  specVersion: number;
  schemaVersion: number;
  reasonCode: string;
  reasonSummary: string;
}

export type NormalizePersonalIntentCandidateResult =
  | { accepted: true; intent: NormalizedPersonalIntent }
  | { accepted: false; rejection: PersonalIntentRejection };

const SCHEDULE_CATEGORIES = new Set<ScheduleCategory>([
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

const CATEGORY_ALIASES: Readonly<Record<string, ScheduleCategory>> = {
  fitness: "exercise",
  workout: "exercise",
  sport: "exercise",
  learning: "study",
  school: "study",
  food: "meal",
  dining: "meal",
  entertainment: "leisure",
  fun: "leisure",
  wellness: "self_care",
  selfcare: "self_care",
  chores: "errand",
  shopping: "errand",
};

const CATEGORY_KEYWORDS: readonly [RegExp, ScheduleCategory][] = [
  [/\u7761|\u5348\u7761|sleep|nap/iu, "sleep"],
  [
    /\u5de5\u4f5c|\u4e0a\u73ed|\u52a0\u73ed|\u5f00\u4f1a|\u5199\u7a3f|\u526a\u8f91|\u7f16\u8f91|\u6821\u5bf9|\u8bbe\u8ba1|\u5236\u4f5c|\u5f55\u97f3|\u6df7\u97f3|\u58f0\u97f3|\u97f3\u9891|\u540e\u671f|work|meeting|shift|edit|design|proofread|mix(?:ing)?|audio|sound/iu,
    "work",
  ],
  [
    /\u5b66\u4e60|\u590d\u4e60|\u5907\u8003|\u8bfe\u7a0b|\u4f5c\u4e1a|study|learn|class|homework/iu,
    "study",
  ],
  [
    /\u65e9\u9910|\u5348\u9910|\u665a\u9910|\u5403\u996d|\u505a\u996d|meal|breakfast|lunch|dinner/iu,
    "meal",
  ],
  [
    /\u8dd1\u6b65|\u6563\u6b65|\u5065\u8eab|\u8fd0\u52a8|\u953b\u70bc|exercise|fitness|workout|jog|run/iu,
    "exercise",
  ],
  [
    /\u805a\u4f1a|\u89c1\u9762|\u670b\u53cb|\u793e\u4ea4|\u6d3e\u5bf9|social|party|gather|meet/iu,
    "social",
  ],
  [
    /\u65c5\u884c|\u51fa\u6e38|\u8fdc\u8db3|\u901a\u52e4|travel|trip|hike|commute/iu,
    "travel",
  ],
  [
    /\u7535\u5f71|\u6e38\u620f|\u9605\u8bfb|\u6444\u5f71|\u5a31\u4e50|movie|game|read|photo|leisure/iu,
    "leisure",
  ],
  [
    /\u4f11\u606f|\u653e\u677e|\u51a5\u60f3|\u62a4\u80a4|\u6ce1\u6fa1|self.?care|relax|meditat/iu,
    "self_care",
  ],
  [
    /\u91c7\u8d2d|\u4e70\u83dc|\u8d2d\u7269|\u529e\u4e8b|\u5bb6\u52a1|errand|shopping|chore/iu,
    "errand",
  ],
];

export const DEFAULT_PERSONAL_INTENT_DURATION_MINUTES: Readonly<
  Record<ScheduleCategory, number>
> = {
  sleep: 480,
  work: 90,
  study: 60,
  meal: 45,
  exercise: 45,
  social: 90,
  travel: 60,
  leisure: 60,
  self_care: 30,
  errand: 45,
  other: 60,
};

export const DEFAULT_PERSONAL_INTENT_TTL_DAYS: Readonly<
  Record<PersonalIntentBasis, number>
> = {
  goal: 30,
  preference: 30,
  routine: 7,
  chat: 14,
  spontaneous: 1,
};

const ENGLISH_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "like",
  "want",
]);

function uniqueSorted(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].sort();
}

function rejection(
  reasonCode: string,
  reasonSummary: string,
): PersonalIntentGroundingResult {
  return { ok: false, rejection: { reasonCode, reasonSummary } };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function normalizePersonalIntentActivity(activity: string): string {
  return activity.normalize("NFKC").trim().replace(/\s+/gu, " ").slice(0, 160);
}

export function normalizePersonalIntentCategory(
  category: string | undefined,
  activity: string,
): ScheduleCategory {
  if (category !== undefined) {
    const normalized = category
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/gu, "_");
    if (SCHEDULE_CATEGORIES.has(normalized as ScheduleCategory)) {
      return normalized as ScheduleCategory;
    }
    const alias = CATEGORY_ALIASES[normalized.replace(/_/gu, "")];
    if (alias !== undefined) return alias;
  }
  for (const [pattern, inferred] of CATEGORY_KEYWORDS) {
    if (pattern.test(activity)) return inferred;
  }
  return "other";
}

function parsedDurationMinutes(hint: string): number | undefined {
  const text = hint.normalize("NFKC").trim().toLowerCase();
  if (text === "") return undefined;
  if (/\u534a\s*(?:\u4e2a)?\u5c0f\u65f6|half\s+(?:an?\s+)?hour/iu.test(text)) {
    return 30;
  }
  if (/(?:\u4e00|1)\s*(?:\u4e2a)?\u5c0f\u65f6|\ban?\s+hour\b/iu.test(text)) {
    return 60;
  }
  if (/(?:\u4e24|\u4e8c)\s*(?:\u4e2a)?\u5c0f\u65f6/iu.test(text)) {
    return 120;
  }
  const hours =
    /(\d+(?:\.\d+)?)\s*(?:\u4e2a)?(?:\u5c0f\u65f6|hours?|hrs?|h)/iu.exec(text);
  if (hours !== null) return Math.round(Number(hours[1]) * 60);
  const minutes = /(\d+)\s*(?:\u5206\u949f|minutes?|mins?|m)/iu.exec(text);
  if (minutes !== null) return Number(minutes[1]);
  if (/^\d+$/.test(text)) return Number(text);
  return undefined;
}

export function normalizePersonalIntentDuration(
  durationHint: string | undefined,
  category: ScheduleCategory,
): number {
  const parsed =
    durationHint === undefined
      ? undefined
      : parsedDurationMinutes(durationHint);
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PERSONAL_INTENT_DURATION_MINUTES[category];
  }
  return Math.max(5, Math.min(1_440, Math.round(parsed)));
}

function utcIso(value: DateTime): string {
  return value.toUTC().toISO()!;
}

function makeWindow(
  start: DateTime,
  end: DateTime,
  now: DateTime,
): PersonalIntentTimeWindow {
  const earliest = start < now ? now : start;
  if (end <= earliest) return {};
  return { earliestAtUtc: utcIso(earliest), latestAtUtc: utcIso(end) };
}

/** Converts a fuzzy model hint into a server-owned UTC planning window. */
export function parsePersonalIntentTimingHint(
  timingHint: string | undefined,
  context: { nowUtc: string; timezone: string },
): PersonalIntentTimeWindow {
  if (timingHint === undefined || timingHint.trim() === "") return {};
  const parsedNow = DateTime.fromISO(context.nowUtc, { zone: "utc" });
  if (!parsedNow.isValid) return {};
  const now = parsedNow.setZone(context.timezone);
  if (!now.isValid) return {};
  const text = timingHint.normalize("NFKC").trim().toLowerCase();

  const relativeHours =
    /(?:\u672a\u6765|\u63a5\u4e0b\u6765|within|in|next)\s*(\d+)\s*(?:\u4e2a)?(?:\u5c0f\u65f6|hours?)/iu.exec(
      text,
    );
  if (relativeHours !== null) {
    return makeWindow(now, now.plus({ hours: Number(relativeHours[1]) }), now);
  }
  const relativeDays =
    /(?:\u672a\u6765|\u63a5\u4e0b\u6765|within|in|next)\s*(\d+)\s*(?:\u5929|days?)/iu.exec(
      text,
    ) ?? /(\d+)\s*(?:\u5929|days?)\s*(?:\u5185|\u4ee5\u5185)/iu.exec(text);
  if (relativeDays !== null) {
    return makeWindow(now, now.plus({ days: Number(relativeDays[1]) }), now);
  }
  if (/\u4e24\u5929\u5185|\u672a\u6765\u4e24\u5929/iu.test(text)) {
    return makeWindow(now, now.plus({ days: 2 }), now);
  }
  if (
    /\u8fd1\u671f|\u6700\u8fd1|\u8fd9\u51e0\u5929|soon|next few days/iu.test(
      text,
    )
  ) {
    return makeWindow(now, now.plus({ days: 3 }), now);
  }
  if (
    /\u6709\u7a7a|\u7a7a\u95f2|when(?:ever)? free|when i have time/iu.test(text)
  ) {
    return makeWindow(now, now.plus({ days: 7 }), now);
  }

  const period =
    /\u65e9\u4e0a|\u65e9\u6668|\u6e05\u6668|\u4e0a\u5348|morning/iu.test(text)
      ? ([6, 12] as const)
      : /\u4e2d\u5348|noon/iu.test(text)
        ? ([11, 14] as const)
        : /\u4e0b\u5348|afternoon/iu.test(text)
          ? ([12, 18] as const)
          : /\u665a\u4e0a|\u4eca\u665a|\u508d\u665a|\u665a\u95f4|(?:\u5468|\u661f\u671f)[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u65e5\u5929]\u665a|evening|tonight/iu.test(
                text,
              )
            ? ([18, 23] as const)
            : /\u591c\u91cc|\u6df1\u591c|night/iu.test(text)
              ? ([20, 24] as const)
              : undefined;

  const chineseWeekday =
    /(?:(\u4e0b\u5468|\u4e0b\u661f\u671f|\u672c\u5468|\u672c\u661f\u671f|\u8fd9\u5468|\u8fd9\u661f\u671f)\s*([\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u65e5\u5929])|(?:\u5468|\u661f\u671f)\s*([\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u65e5\u5929]))/u.exec(
      text,
    );
  const englishWeekday =
    /\b(next|this)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu.exec(
      text,
    );
  if (chineseWeekday !== null || englishWeekday !== null) {
    const marker = (
      chineseWeekday?.[1] ??
      englishWeekday?.[1] ??
      ""
    ).toLowerCase();
    const weekdayText =
      chineseWeekday?.[2] ?? chineseWeekday?.[3] ?? englishWeekday?.[2] ?? "";
    const chineseWeekdays = "\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u65e5\u5929";
    const englishWeekdays = [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ];
    const chineseIndex = chineseWeekdays.indexOf(weekdayText);
    const weekday =
      chineseIndex >= 0
        ? Math.min(chineseIndex + 1, 7)
        : englishWeekdays.indexOf(weekdayText.toLowerCase()) + 1;
    const explicitlyNext = /\u4e0b|next/iu.test(marker);
    const explicitlyThis = /\u672c|\u8fd9|this/iu.test(marker);
    let day = now
      .startOf("week")
      .plus({ weeks: explicitlyNext ? 1 : 0, days: weekday - 1 });
    const endHour = period?.[1] ?? 24;
    if (
      !explicitlyNext &&
      !explicitlyThis &&
      day.plus({ hours: endHour }) <= now
    ) {
      day = day.plus({ weeks: 1 });
    }
    return makeWindow(
      day.plus({ hours: period?.[0] ?? 0 }),
      day.plus({ hours: endHour }),
      now,
    );
  }

  if (/\u4e0b\u5468|next week/iu.test(text)) {
    const start = now.startOf("week").plus({ weeks: 1 });
    return makeWindow(start, start.plus({ weeks: 1 }), now);
  }
  if (/\u672c\u5468|\u8fd9\u5468|this week/iu.test(text)) {
    return makeWindow(now, now.startOf("week").plus({ weeks: 1 }), now);
  }
  if (/\u5468\u672b|weekend/iu.test(text)) {
    const untilSaturday = (6 - now.weekday + 7) % 7;
    const start = now.startOf("day").plus({ days: untilSaturday });
    const effectiveStart = now.weekday === 7 ? now : start;
    const end =
      now.weekday === 7
        ? now.startOf("day").plus({ days: 1 })
        : start.plus({ days: 2 });
    return makeWindow(effectiveStart, end, now);
  }

  const explicitDay = /\u4eca\u5929|\u4eca\u65e5|today/iu.test(text)
    ? 0
    : /\u540e\u5929|day after tomorrow/iu.test(text)
      ? 2
      : /\u660e\u5929|\u660e\u65e5|tomorrow/iu.test(text)
        ? 1
        : undefined;
  if (explicitDay === undefined && period === undefined) return {};
  let day = now.startOf("day").plus({ days: explicitDay ?? 0 });
  if (period === undefined) return makeWindow(day, day.plus({ days: 1 }), now);
  let start = day.plus({ hours: period[0] });
  let end = day.plus({ hours: period[1] });
  if (explicitDay === undefined && end <= now) {
    day = day.plus({ days: 1 });
    start = day.plus({ hours: period[0] });
    end = day.plus({ hours: period[1] });
  }
  return makeWindow(start, end, now);
}

function normalizeForEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const MEANINGLESS_QUOTES = new Set([
  "\u6211",
  "\u4f60",
  "\u4ed6",
  "\u5979",
  "\u5b83",
  "\u55ef",
  "\u54e6",
  "\u554a",
  "\u597d",
  "\u597d\u7684",
  "\u884c",
  "\u53ef\u4ee5",
  "\u8fd9\u4e2a",
  "\u90a3\u4e2a",
  "ok",
  "okay",
  "yes",
  "no",
  "sure",
]);

export function isMeaningfulPersonalIntentQuote(quote: string): boolean {
  const normalized = normalizeForEvidence(quote);
  if (normalized.length < 2 || MEANINGLESS_QUOTES.has(normalized)) return false;
  if (/^[a-z0-9]+$/iu.test(normalized)) return normalized.length >= 4;
  return true;
}

export function isPersonalIntentQuoteGrounded(
  quote: string,
  userText: string,
): boolean {
  const normalizedQuote = normalizeForEvidence(quote);
  return (
    isMeaningfulPersonalIntentQuote(quote) &&
    normalizeForEvidence(userText).includes(normalizedQuote)
  );
}

function semanticText(value: string): string {
  return normalizeForEvidence(value)
    .replace(/\u62cd\u7167|\u7167\u76f8|\u62cd\u6444/gu, "\u6444\u5f71")
    .replace(
      /\u6162\u8dd1|\u6668\u8dd1|\u591c\u8dd1|\u8dd1\u6b65|\u5065\u8eab|\u953b\u70bc|\u5065\u5eb7/gu,
      "\u8fd0\u52a8",
    )
    .replace(/\u770b\u4e66|\u8bfb\u4e66/gu, "\u9605\u8bfb")
    .replace(/\u542c\u6b4c/gu, "\u97f3\u4e50")
    .replace(/\u770b\u7535\u5f71/gu, "\u7535\u5f71")
    .replace(/\u6b65\u884c/gu, "\u6563\u6b65");
}

function textFeatures(value: string): Set<string> {
  const normalized = semanticText(value);
  const features = new Set<string>();
  for (const word of value.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? []) {
    if (!ENGLISH_STOP_WORDS.has(word)) features.add(word);
  }
  const hanRuns = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const run of hanRuns) {
    for (let index = 0; index < run.length - 1; index += 1) {
      features.add(run.slice(index, index + 2));
    }
  }
  return features;
}

function textsAreRelated(activity: string, sourceText: string): boolean {
  const left = semanticText(activity);
  const right = semanticText(sourceText);
  if (
    Math.min(left.length, right.length) >= 2 &&
    (left.includes(right) || right.includes(left))
  ) {
    return true;
  }
  const sourceFeatures = textFeatures(sourceText);
  for (const feature of textFeatures(activity)) {
    if (sourceFeatures.has(feature)) return true;
  }
  return false;
}

interface GroundingSource {
  id: string;
  text: string;
  category?: ScheduleCategory;
}

function groundSpecReferences(
  input: PersonalIntentGroundingInput,
  context: PersonalIntentGroundingContext,
): PersonalIntentGroundingResult {
  const refs = uniqueSorted(input.basisRefIds ?? []);
  if (refs.length === 0) {
    return rejection(
      "missing_basis_ref",
      `${input.basisKind} intent requires a CharacterSpec reference.`,
    );
  }

  const sources: GroundingSource[] =
    input.basisKind === "goal"
      ? context.spec.persona.goals.map((goal) => ({
          id: goal.id,
          text: `${goal.title} ${goal.description}`,
        }))
      : input.basisKind === "preference"
        ? context.spec.persona.preferences.map((preference) => ({
            id: preference.id,
            text: `${preference.subject} ${preference.preference} ${preference.conditions.join(" ")}`,
          }))
        : context.spec.routines.map((routine) => ({
            id: routine.id,
            text: `${routine.title} ${routine.category} ${routine.recurrence}`,
            category: normalizePersonalIntentCategory(
              routine.category,
              routine.title,
            ),
          }));

  for (const ref of refs) {
    const source = sources.find((candidate) => candidate.id === ref);
    if (source === undefined) {
      return rejection(
        "invalid_basis_ref",
        `${ref} is not a ${input.basisKind} id in the active CharacterSpec.`,
      );
    }
    const categoryMatches = source.category === input.category;
    if (!categoryMatches && !textsAreRelated(input.activity, source.text)) {
      return rejection(
        "unrelated_basis_ref",
        `${ref} is not relevant to the proposed activity.`,
      );
    }
  }
  return {
    ok: true,
    grounding: {
      basisRefIds: refs,
      evidenceMessageIds: uniqueSorted(input.evidenceMessageIds ?? []),
      evidenceQuotes: uniqueSorted(input.evidenceQuotes ?? []),
    },
  };
}

function groundChat(
  input: PersonalIntentGroundingInput,
  context: PersonalIntentGroundingContext,
): PersonalIntentGroundingResult {
  const message = context.currentUserMessage;
  if (message === undefined) {
    return rejection(
      "missing_user_message",
      "A chat intent must reference the current user message.",
    );
  }
  const suppliedMessageIds = uniqueSorted(input.evidenceMessageIds ?? []);
  if (suppliedMessageIds.some((id) => id !== message.id)) {
    return rejection(
      "invalid_message_ref",
      "A chat intent may only reference the current user message.",
    );
  }
  const quotes = uniqueSorted(input.evidenceQuotes ?? []);
  if (quotes.length === 0) {
    return rejection(
      "missing_evidence_quote",
      "A chat intent must retain at least one user quote.",
    );
  }
  for (const quote of quotes) {
    if (!isMeaningfulPersonalIntentQuote(quote)) {
      return rejection(
        "meaningless_evidence_quote",
        "The cited user quote is too short or non-meaningful.",
      );
    }
    if (!isPersonalIntentQuoteGrounded(quote, message.text)) {
      return rejection(
        "ungrounded_evidence_quote",
        "The cited quote does not appear in the current user message.",
      );
    }
  }
  return {
    ok: true,
    grounding: {
      basisRefIds: [],
      evidenceMessageIds: [message.id],
      evidenceQuotes: quotes,
    },
  };
}

function groundSpontaneous(
  input: PersonalIntentGroundingInput,
  context: PersonalIntentGroundingContext,
): PersonalIntentGroundingResult {
  const policy = context.spontaneousPolicy;
  if (policy?.enabled !== true) {
    return rejection(
      "spontaneous_disabled",
      "Spontaneous intent generation is disabled by default in P0.",
    );
  }
  if (policy.budgetAvailable !== true) {
    return rejection(
      "spontaneity_budget_exhausted",
      "The spontaneity budget is unavailable.",
    );
  }
  if (!policy.categoryAllowlist?.includes(input.category)) {
    return rejection(
      "spontaneous_category_blocked",
      "The category is not on the spontaneous allowlist.",
    );
  }
  if (policy.riskAllowed !== true) {
    return rejection(
      "spontaneous_risk_blocked",
      "The spontaneous risk policy rejected the intent.",
    );
  }
  if (policy.frequencyAllowed !== true) {
    return rejection(
      "spontaneous_frequency_blocked",
      "The spontaneous frequency policy rejected the intent.",
    );
  }
  if (policy.personaBoundaryAllowed !== true) {
    return rejection(
      "persona_boundary_blocked",
      "The intent conflicts with a persona boundary.",
    );
  }
  if (policy.scheduleAllowed !== true) {
    return rejection(
      "schedule_validation_blocked",
      "The schedule validator rejected the intent.",
    );
  }
  return {
    ok: true,
    grounding: { basisRefIds: [], evidenceMessageIds: [], evidenceQuotes: [] },
  };
}

export function groundPersonalIntent(
  input: PersonalIntentGroundingInput,
  context: PersonalIntentGroundingContext,
): PersonalIntentGroundingResult {
  if (input.basisKind === "chat") return groundChat(input, context);
  if (input.basisKind === "spontaneous") {
    return groundSpontaneous(input, context);
  }
  return groundSpecReferences(input, context);
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function buildPersonalIntentDedupeKey(input: {
  agentId: string;
  activity: string;
  category: ScheduleCategory;
  basisKind: PersonalIntentBasis;
  basisRefIds?: readonly string[];
}): string {
  const material = [
    input.agentId.trim(),
    input.basisKind,
    uniqueSorted(input.basisRefIds ?? []).join(","),
    input.category,
    semanticText(normalizePersonalIntentActivity(input.activity)),
  ].join("|");
  return `pi:v1:${fnv1a64(material)}`;
}

export function normalizePersonalIntentCandidate(
  input: NormalizePersonalIntentCandidateInput,
): NormalizePersonalIntentCandidateResult {
  const activity = normalizePersonalIntentActivity(input.candidate.activity);
  const category = normalizePersonalIntentCategory(
    input.candidate.category,
    activity,
  );
  const grounding = groundPersonalIntent(
    {
      activity,
      category,
      basisKind: "chat",
      evidenceMessageIds: [input.currentUserMessage.id],
      evidenceQuotes: input.candidate.evidenceQuotes,
    },
    { spec: input.spec, currentUserMessage: input.currentUserMessage },
  );
  if (!grounding.ok) {
    return { accepted: false, rejection: grounding.rejection };
  }
  const window = parsePersonalIntentTimingHint(input.candidate.timingHint, {
    nowUtc: input.nowUtc,
    timezone: input.timezone,
  });
  const basisRefIds = grounding.grounding.basisRefIds;
  return {
    accepted: true,
    intent: {
      agentId: input.agentId,
      activity,
      category,
      desiredDurationMinutes: normalizePersonalIntentDuration(
        input.candidate.durationHint,
        category,
      ),
      ...window,
      basisKind: "chat",
      basisRefIds,
      evidenceMessageIds: grounding.grounding.evidenceMessageIds,
      evidenceQuotes: grounding.grounding.evidenceQuotes,
      priority: clamp01(input.priority ?? 0.6),
      freshness: clamp01(input.freshness ?? 1),
      dedupeKey: buildPersonalIntentDedupeKey({
        agentId: input.agentId,
        activity,
        category,
        basisKind: "chat",
        basisRefIds,
      }),
      specVersion: input.spec.version,
      schemaVersion: 1,
      reasonCode: input.candidate.reasonCode,
      reasonSummary: input.candidate.reasonSummary,
    },
  };
}

function activeForDedupe(intent: PersonalIntent): boolean {
  return intent.status === "pending" || intent.status === "planned";
}

export function findPersonalIntentDuplicate(
  intents: readonly PersonalIntent[],
  candidate: Pick<PersonalIntent, "agentId" | "dedupeKey">,
): PersonalIntent | undefined {
  return intents.find(
    (intent) =>
      activeForDedupe(intent) &&
      intent.agentId === candidate.agentId &&
      intent.dedupeKey === candidate.dedupeKey,
  );
}

function earlier(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function later(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function mergePersonalIntents(
  existing: PersonalIntent,
  incoming: PersonalIntent,
  updatedAtUtc: string,
): PersonalIntent {
  if (
    existing.agentId !== incoming.agentId ||
    existing.dedupeKey !== incoming.dedupeKey ||
    existing.basisKind !== incoming.basisKind
  ) {
    throw new Error(
      "Only intents with the same owner, dedupe key and basis may merge",
    );
  }
  const preferIncoming = incoming.freshness >= existing.freshness;
  const earliestAtUtc = earlier(existing.earliestAtUtc, incoming.earliestAtUtc);
  const latestAtUtc = later(existing.latestAtUtc, incoming.latestAtUtc);
  const lastAttemptAtUtc = later(
    existing.lastAttemptAtUtc,
    incoming.lastAttemptAtUtc,
  );
  return {
    ...existing,
    activity: preferIncoming ? incoming.activity : existing.activity,
    category: preferIncoming ? incoming.category : existing.category,
    desiredDurationMinutes: preferIncoming
      ? incoming.desiredDurationMinutes
      : existing.desiredDurationMinutes,
    ...(earliestAtUtc === undefined ? {} : { earliestAtUtc }),
    ...(latestAtUtc === undefined ? {} : { latestAtUtc }),
    basisRefIds: uniqueSorted([
      ...existing.basisRefIds,
      ...incoming.basisRefIds,
    ]),
    evidenceMessageIds: uniqueSorted([
      ...existing.evidenceMessageIds,
      ...incoming.evidenceMessageIds,
    ]),
    priority: Math.max(existing.priority, incoming.priority),
    freshness: Math.max(existing.freshness, incoming.freshness),
    specVersion: Math.max(existing.specVersion, incoming.specVersion),
    schemaVersion: Math.max(existing.schemaVersion, incoming.schemaVersion),
    attemptCount: existing.attemptCount,
    ...(lastAttemptAtUtc === undefined ? {} : { lastAttemptAtUtc }),
    updatedAtUtc,
  };
}

export type ResolvePersonalIntentDedupeResult =
  | { action: "create"; intent: PersonalIntent }
  | { action: "merge"; intent: PersonalIntent; duplicateId: string };

export function resolvePersonalIntentDedupe(
  existing: readonly PersonalIntent[],
  incoming: PersonalIntent,
  updatedAtUtc: string,
): ResolvePersonalIntentDedupeResult {
  const duplicate = findPersonalIntentDuplicate(existing, incoming);
  if (duplicate === undefined) return { action: "create", intent: incoming };
  return {
    action: "merge",
    intent: mergePersonalIntents(duplicate, incoming, updatedAtUtc),
    duplicateId: duplicate.id,
  };
}

export interface PersonalIntentExpiryEvaluation {
  expired: boolean;
  expiresAtUtc: string;
  reasonCode?: "already_expired" | "latest_window_elapsed" | "ttl_elapsed";
}

export function evaluatePersonalIntentExpiry(
  intent: PersonalIntent,
  nowUtc: string,
  ttlDays: Partial<Record<PersonalIntentBasis, number>> = {},
): PersonalIntentExpiryEvaluation {
  const configuredTtl =
    ttlDays[intent.basisKind] ??
    DEFAULT_PERSONAL_INTENT_TTL_DAYS[intent.basisKind] ??
    14;
  const ttl =
    Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 14;
  const ttlExpiryMs = Date.parse(intent.createdAtUtc) + ttl * 86_400_000;
  const latestMs =
    intent.latestAtUtc === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(intent.latestAtUtc);
  const expiryMs = Math.min(ttlExpiryMs, latestMs);
  const expiresAtUtc = new Date(expiryMs).toISOString();
  if (intent.status === "expired") {
    return { expired: true, expiresAtUtc, reasonCode: "already_expired" };
  }
  if (intent.status !== "pending" || Date.parse(nowUtc) < expiryMs) {
    return { expired: false, expiresAtUtc };
  }
  return {
    expired: true,
    expiresAtUtc,
    reasonCode:
      latestMs <= ttlExpiryMs ? "latest_window_elapsed" : "ttl_elapsed",
  };
}

export function expirePersonalIntent(
  intent: PersonalIntent,
  nowUtc: string,
  ttlDays?: Partial<Record<PersonalIntentBasis, number>>,
): PersonalIntent {
  const evaluation = evaluatePersonalIntentExpiry(intent, nowUtc, ttlDays);
  if (!evaluation.expired || intent.status === "expired") return intent;
  return { ...intent, status: "expired", updatedAtUtc: nowUtc };
}

export function canConsumePersonalIntent(
  intent: PersonalIntent,
  nowUtc: string,
  ttlDays?: Partial<Record<PersonalIntentBasis, number>>,
): boolean {
  return (
    intent.status === "pending" &&
    !evaluatePersonalIntentExpiry(intent, nowUtc, ttlDays).expired
  );
}

export interface PersonalIntentSpecVersionEvaluation {
  outcome: "current" | "revalidated" | "requires_revalidation" | "incompatible";
  targetSpecVersion: number;
  reasonCode?: string;
}

export function evaluatePersonalIntentSpecVersion(
  intent: PersonalIntent,
  spec: PersonalIntentSpecSnapshot,
): PersonalIntentSpecVersionEvaluation {
  if (intent.specVersion === spec.version) {
    return { outcome: "current", targetSpecVersion: spec.version };
  }
  if (intent.specVersion > spec.version) {
    return {
      outcome: "incompatible",
      targetSpecVersion: spec.version,
      reasonCode: "future_spec_version",
    };
  }
  if (intent.basisKind === "chat" || intent.basisKind === "spontaneous") {
    return {
      outcome: "requires_revalidation",
      targetSpecVersion: spec.version,
      reasonCode: "persona_policy_may_have_changed",
    };
  }
  const grounded = groundPersonalIntent(
    {
      activity: intent.activity,
      category: intent.category,
      basisKind: intent.basisKind,
      basisRefIds: intent.basisRefIds,
      evidenceMessageIds: intent.evidenceMessageIds,
    },
    { spec },
  );
  return grounded.ok
    ? { outcome: "revalidated", targetSpecVersion: spec.version }
    : {
        outcome: "incompatible",
        targetSpecVersion: spec.version,
        reasonCode: grounded.rejection.reasonCode,
      };
}
