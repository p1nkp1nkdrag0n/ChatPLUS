import type { DateTime } from "luxon";

import { parseInstant, parseZone } from "./shared.js";
import {
  groundFollowUpCandidate,
  type FollowUpEvidenceMessage,
  type FollowUpGroundingBasis,
  type FollowUpGroundingRejectionCode,
} from "./follow-up-grounding.js";

export type FollowUpSubjectTypeLike =
  "user_goal" | "user_event" | "shared_commitment" | "character_commitment";

export type FollowUpStatusLike =
  "pending" | "resolved" | "sent" | "expired" | "cancelled";

export interface FollowUpLike {
  id: string;
  agentId: string;
  subjectType: FollowUpSubjectTypeLike;
  contextSummary: string;
  expectedOutcomeDescription: string;
  earliestAtUtc: string;
  expiresAtUtc: string;
  status: FollowUpStatusLike;
  maxAttempts: 1;
  attemptCount: number;
  dedupeKey: string;
  sentMessageId?: string;
  resolutionMessageId?: string;
  revision: number;
  generationEpoch: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface FollowUpCandidateLike {
  subjectType: FollowUpSubjectTypeLike;
  contextSummary: string;
  expectedOutcomeDescription: string;
  timingHint: string;
  evidenceQuotes: readonly string[];
  reasonCode: string;
  reasonSummary: string;
}

/** Source-grounded arrangement, distinct from the later contact window. */
export interface FollowUpSchedule {
  timezone: string;
  referenceAtUtc: string;
  localDate: string;
  precision: "minute" | "period" | "day";
  localTime?: string;
  period?: "morning" | "noon" | "afternoon" | "evening";
  atUtc?: string;
}

export interface FollowUpWindow {
  earliestAtUtc: string;
  expiresAtUtc: string;
  currentSchedule: FollowUpSchedule;
}

export type FollowUpCandidateRejectionCode =
  | "invalid_source_role"
  | "missing_grounded_quote"
  | "unrelated_context"
  | "ambiguous_timing"
  | FollowUpGroundingRejectionCode;

export type NormalizeFollowUpCandidateResult =
  | {
      accepted: true;
      followUp: {
        agentId: string;
        subjectType: FollowUpSubjectTypeLike;
        contextSummary: string;
        expectedOutcomeDescription: string;
        sourceMessageId: string;
        evidenceQuotes: string[];
        earliestAtUtc: string;
        expiresAtUtc: string;
        currentSchedule: FollowUpSchedule;
        dedupeKey: string;
        reasonCode: string;
        reasonSummary: string;
        grounding: FollowUpGroundingBasis;
      };
    }
  | {
      accepted: false;
      rejection: {
        reasonCode: FollowUpCandidateRejectionCode;
        reasonSummary: string;
      };
    };

export function normalizeFollowUpCandidate(input: {
  candidate: FollowUpCandidateLike;
  agentId: string;
  sourceMessage: { id: string; role: "user" | "assistant"; text: string };
  supportingMessages?: readonly FollowUpEvidenceMessage[];
  nowUtc: string;
  timezone: string;
}): NormalizeFollowUpCandidateResult {
  if (
    (input.sourceMessage.role === "user" &&
      input.candidate.subjectType === "character_commitment") ||
    (input.sourceMessage.role === "assistant" &&
      (input.candidate.subjectType === "user_goal" ||
        input.candidate.subjectType === "user_event"))
  ) {
    return rejectCandidate(
      "invalid_source_role",
      "The follow-up subject is incompatible with its evidence author.",
    );
  }

  const groundedQuotes = uniqueStrings(input.candidate.evidenceQuotes).filter(
    (quote) => isGroundedQuote(quote, input.sourceMessage.text),
  );
  if (groundedQuotes.length === 0) {
    return rejectCandidate(
      "missing_grounded_quote",
      "A follow-up needs a meaningful quote from its source message.",
    );
  }
  if (
    !groundedQuotes.some((quote) =>
      textsAreRelated(input.candidate.contextSummary, quote),
    )
  ) {
    return rejectCandidate(
      "unrelated_context",
      "The follow-up context is not grounded in the cited source text.",
    );
  }

  if (/\d{4}-\d{2}-\d{2}|T\d{2}:/u.test(input.candidate.timingHint)) {
    return rejectCandidate(
      "ambiguous_timing",
      "An exact model timestamp cannot authorize a follow-up window.",
    );
  }
  const grounding = groundFollowUpCandidate(input);
  if (!grounding.accepted) return grounding;
  const window = resolveFollowUpWindow(
    grounding.timingText,
    input.nowUtc,
    input.timezone,
    grounding.basis.timingIntent,
  );
  if (window === undefined) {
    return rejectCandidate(
      "ambiguous_timing",
      "The follow-up timing is too ambiguous to schedule safely.",
    );
  }

  const contextSummary = grounding.contextSummary;
  const expectedOutcomeDescription = grounding.expectedOutcomeDescription;
  return {
    accepted: true,
    followUp: {
      agentId: input.agentId,
      subjectType: input.candidate.subjectType,
      contextSummary,
      expectedOutcomeDescription,
      sourceMessageId: input.sourceMessage.id,
      evidenceQuotes: groundedQuotes,
      ...window,
      dedupeKey: buildFollowUpDedupeKey({
        agentId: input.agentId,
        subjectType: input.candidate.subjectType,
        contextSummary,
        earliestAtUtc: window.earliestAtUtc,
        timezone: input.timezone,
      }),
      reasonCode: input.candidate.reasonCode,
      reasonSummary: input.candidate.reasonSummary,
      grounding: grounding.basis,
    },
  };
}

export type FollowUpTimingIntent =
  "reminder" | "appointment" | "event_aftermath";

export function resolveFollowUpWindow(
  timingHint: string,
  nowUtc: string,
  timezone: string,
  timingIntent?: FollowUpTimingIntent,
): FollowUpWindow | undefined {
  parseZone(timezone);
  const now = parseInstant(nowUtc).setZone(timezone);
  const text = normalizeFollowUpClockText(
    timingHint.normalize("NFKC").trim().toLowerCase(),
  );
  if (text === "" || /\d{4}-\d{2}-\d{2}|T\d{2}:/u.test(text)) return undefined;

  let targetDay: DateTime | undefined;
  const weekday =
    /(?:(下下|下|本|这)\s*)?(?:周|星期)([一二三四五六日天])/u.exec(text);
  const englishWeekday =
    /\b(?:(next|this)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu.exec(
      text,
    );
  if (/后天|day after tomorrow/iu.test(text)) {
    targetDay = now.startOf("day").plus({ days: 2 });
  } else if (/明天|明日|明晚|明早|次日|翌日|tomorrow/iu.test(text)) {
    targetDay = now.startOf("day").plus({ days: 1 });
  } else if (/今天|今日|今晚|今早|today|tonight/iu.test(text)) {
    targetDay = now.startOf("day");
  } else if (weekday !== null || englishWeekday !== null) {
    const day =
      weekday !== null
        ? "一二三四五六日天".indexOf(weekday[2]!) + 1
        : [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
          ].indexOf(englishWeekday![2]!.toLowerCase()) + 1;
    const normalizedDay = Math.min(day, 7);
    const prefix = weekday?.[1] ?? englishWeekday?.[1]?.toLowerCase();
    targetDay = now.startOf("week").plus({
      weeks:
        prefix === "下下" ? 2 : prefix === "下" || prefix === "next" ? 1 : 0,
      days: normalizedDay - 1,
    });
    if (prefix === undefined && normalizedDay < now.weekday)
      targetDay = targetDay.plus({ weeks: 1 });
  } else if (/下周|next week/iu.test(text)) {
    // A whole week does not identify a safe day. Do not silently choose Sunday.
    return undefined;
  } else {
    const relative =
      /(?:in\s*)?(\d{1,2})\s*days?/iu.exec(text) ??
      /(\d{1,2})\s*天后/iu.exec(text);
    if (relative !== null) {
      const days = Number(relative[1]);
      if (days >= 1 && days <= 30)
        targetDay = now.startOf("day").plus({ days });
    }
  }
  if (targetDay === undefined) return undefined;

  const explicitClock = parseExplicitFollowUpClock(text);
  if (
    explicitClock === undefined &&
    /\d{1,2}\s*[:：点]|\d{1,2}\s*(?:am|pm)\b/iu.test(text)
  )
    return undefined;
  const morning = /早上|早晨|上午|明早|今早|morning/iu.test(text);
  const noon = /中午|\bnoon\b/iu.test(text);
  const afternoon = /下午|afternoon/iu.test(text);
  const evening = /晚上|傍晚|明晚|今晚|evening|tonight/iu.test(text);
  const exactRequest =
    timingIntent === "reminder" || timingIntent === "appointment";
  const followUpHour =
    explicitClock?.hour ??
    (morning
      ? exactRequest
        ? 9
        : 12
      : noon
        ? exactRequest
          ? 12
          : 14
        : afternoon
          ? exactRequest
            ? 15
            : 18
          : evening
            ? 20
            : 20);
  let earliest = targetDay.set({
    hour: followUpHour,
    minute: explicitClock?.minute ?? 0,
    second: 0,
    millisecond: 0,
  });
  const period = morning
    ? "morning"
    : noon
      ? "noon"
      : afternoon
        ? "afternoon"
        : evening
          ? "evening"
          : undefined;
  const currentSchedule: FollowUpSchedule = {
    timezone,
    referenceAtUtc: now.toUTC().toISO()!,
    localDate: targetDay.toISODate()!,
    precision:
      explicitClock !== undefined
        ? "minute"
        : period !== undefined
          ? "period"
          : "day",
    ...(period === undefined ? {} : { period }),
    ...(explicitClock === undefined
      ? {}
      : {
          localTime: earliest.toFormat("HH:mm"),
          atUtc: earliest.toUTC().toISO()!,
        }),
  };
  if (timingIntent === "event_aftermath") {
    if (explicitClock !== undefined) earliest = earliest.plus({ hours: 2 });
    if ((evening && explicitClock === undefined) || earliest.hour >= 22) {
      earliest = earliest.plus({ days: 1 }).startOf("day").set({ hour: 10 });
    }
  }
  if (!earliest.isValid || earliest <= now) return undefined;
  return {
    currentSchedule,
    earliestAtUtc: earliest.toUTC().toISO()!,
    expiresAtUtc: earliest
      .plus({ hours: exactRequest ? 2 : 72 })
      .toUTC()
      .toISO()!,
  };
}
interface ExplicitFollowUpClock {
  hour: number;
  minute: number;
}

function normalizeFollowUpClockText(text: string): string {
  const number = (value: string): number => {
    if (/^\d+$/u.test(value)) return Number(value);
    const digits = "零一二三四五六七八九";
    const normalized = value.replace(/两/gu, "二").replace(/〇/gu, "零");
    if (normalized.includes("十")) {
      const [tens, units] = normalized.split("十");
      return (
        (tens === "" ? 1 : digits.indexOf(tens!)) * 10 +
        (units === "" ? 0 : digits.indexOf(units!))
      );
    }
    return digits.indexOf(normalized);
  };
  return text.replace(
    /([零〇一二两三四五六七八九十\d]{1,3})点(半|一刻|三刻|[零〇一二两三四五六七八九十\d]{1,3}分?)?/gu,
    (_match, hour: string, minute: string | undefined) => {
      const minutes =
        minute === "半"
          ? 30
          : minute === "一刻"
            ? 15
            : minute === "三刻"
              ? 45
              : minute === undefined
                ? 0
                : number(minute.replace(/分$/u, ""));
      const hours = number(hour);
      return `${hours >= 0 && hours <= 23 ? hours : 99}:${minutes >= 0 && minutes <= 59 ? String(minutes).padStart(2, "0") : "99"}`;
    },
  );
}

function parseExplicitFollowUpClock(
  text: string,
): ExplicitFollowUpClock | undefined {
  const colon =
    /(?<!\d)(?:(midnight|morning|noon|afternoon|evening|凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|明晚|今晚)\s*)?(\d{1,2})\s*[:：]\s*(\d{1,2})(?!\d)(?:\s*(am|pm)\b)?/iu.exec(
      text,
    );
  const chinese =
    /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|明晚|今晚)?\s*(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分?)?/iu.exec(
      text,
    );
  const english = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/iu.exec(text);

  const period = (colon?.[1] ?? chinese?.[1] ?? english?.[3])?.toLowerCase();
  const rawHour = Number(colon?.[2] ?? chinese?.[2] ?? english?.[1]);
  const rawMinute = Number(colon?.[3] ?? chinese?.[3] ?? english?.[2] ?? 0);
  if (
    !Number.isInteger(rawHour) ||
    !Number.isInteger(rawMinute) ||
    rawHour < 0 ||
    rawHour > 23 ||
    rawMinute < 0 ||
    rawMinute > 59
  ) {
    return undefined;
  }

  let hour = rawHour;
  if (period === "am") {
    if (hour < 1 || hour > 12) return undefined;
    if (hour === 12) hour = 0;
  } else if (period === "pm") {
    if (hour < 1 || hour > 12) return undefined;
    if (hour < 12) hour += 12;
  } else if (/凌晨|midnight/iu.test(period ?? "")) {
    if (hour === 12) hour = 0;
  } else if (/中午|noon/iu.test(period ?? "")) {
    if (hour < 11) hour += 12;
  } else if (
    /下午|傍晚|晚上|明晚|今晚|afternoon|evening/iu.test(period ?? "")
  ) {
    if (hour < 12) hour += 12;
  } else if (/早上|早晨|上午|morning/iu.test(period ?? "")) {
    if (hour === 12) hour = 0;
  }

  if (hour < 0 || hour > 23) return undefined;
  return { hour, minute: rawMinute };
}

export function buildFollowUpDedupeKey(input: {
  agentId: string;
  subjectType: FollowUpSubjectTypeLike;
  contextSummary: string;
  earliestAtUtc: string;
  timezone: string;
}): string {
  parseZone(input.timezone);
  const dateBucket =
    parseInstant(input.earliestAtUtc).setZone(input.timezone).toISODate() ?? "";
  const material = [
    input.agentId.trim(),
    input.subjectType,
    dateBucket,
    semanticText(input.contextSummary),
  ].join("|");
  return "followup:v1:" + fnv1a64(material);
}

export type FollowUpMessageEvaluation =
  | { outcome: "none"; reasonCode: "no_explicit_outcome" | "subject_mismatch" }
  | {
      outcome: "resolved";
      reasonCode: "explicit_outcome";
      evidenceText: string;
    }
  | {
      outcome: "cancelled";
      reasonCode: "explicit_cancellation" | "user_declined_followup";
      evidenceText: string;
    };

const CANCELLATION_PATTERN =
  /取消|不(?:去|参加|做|考)|放弃|改主意|不再|cancel(?:led|ed)?|called off|won'?t|will not|not going|gave up|decided not/iu;
const DECLINE_PATTERN =
  /别(?:再)?(?:问|提)|不想聊|别再说|不(?:用|要)(?:再)?(?:问|提醒|跟进)|do not ask|don'?t ask|rather not talk|stop bringing/iu;
const OUTCOME_PATTERN =
  /结束(?:了)?|完成(?:了)?|做完|弄完|交完|交了|通过|过了|成功|失败|没过|搞定|finished|completed|done|passed|failed|submitted|it is over|it'?s over|went well|didn'?t pass/iu;
const RESULT_PATTERN =
  /通过|过了|成功|失败|没过|录取|拒绝|拿到.{0,8}(?:结果|成绩)|(?:结果|成绩).{0,8}(?:出了|出来|公布)|passed|failed|accepted|rejected|result.{0,12}(?:arrived|received|available)/iu;
const STILL_PENDING_PATTERN =
  /还没|尚未|正在|还在等|仍在等|等(?:待)?结果|等通知|结果.{0,5}(?:没|未)|没(?:有)?(?:结束|完成|做完|弄完|提交)|马(?:上)?要|明天|下周|not yet|not (?:finished|completed|done|submitted|over)|haven'?t (?:finished|completed|submitted)|still (?:working|waiting)|waiting for|will (?:do|take|submit|attend)|tomorrow|next week/iu;
const UNCERTAIN_OUTCOME_PATTERN =
  /如果|要是|假如|可能|也许|不一定|假设|假定|据说|听说|希望|但愿|以为|[?？]|吗[。!！]?$|\b(?:if|might|maybe|perhaps|hopefully|wish)\b/iu;

/** Relation checks use the factual subject only: generated guidance and dates
 * must not make an unrelated result or cancellation look related. */
export function followUpMessageMatchesSubject(
  followUp: Pick<FollowUpLike, "contextSummary">,
  text: string,
): boolean {
  return followUpTextsAreRelated(followUp.contextSummary, text);
}

export function evaluateFollowUpMessage(
  followUp: Pick<FollowUpLike, "contextSummary" | "expectedOutcomeDescription">,
  userText: string,
  options: { contextualSubjectMatch?: boolean } = {},
): FollowUpMessageEvaluation {
  const clauses = userText
    .split(/[，,]|(?<=[。！？!?；;\n])|但是|不过|但|\b(?:but|and)\b/iu)
    .map((part) => part.trim())
    .filter(Boolean);
  const related = clauses.flatMap((clause, index) =>
    followUpMessageMatchesSubject(followUp, clause) ? [index] : [],
  );
  if (related.length === 0 && !options.contextualSubjectMatch) {
    return { outcome: "none", reasonCode: "subject_mismatch" };
  }
  const subjectClauses = (
    related.length === 0 ? clauses : related.map((index) => clauses[index]!)
  ).filter((clause) => !UNCERTAIN_OUTCOME_PATTERN.test(clause));
  const evidenceText = compactText(userText, 1_000);
  if (
    subjectClauses.some((clause) => DECLINE_PATTERN.test(clause)) ||
    (options.contextualSubjectMatch &&
      !UNCERTAIN_OUTCOME_PATTERN.test(userText) &&
      DECLINE_PATTERN.test(userText))
  ) {
    return {
      outcome: "cancelled",
      reasonCode: "user_declined_followup",
      evidenceText,
    };
  }
  if (
    subjectClauses.some(
      (clause) =>
        CANCELLATION_PATTERN.test(clause) &&
        !/没(?:有)?取消|尚未取消|不(?:想|能|用|要|必|会|打算)?取消|别取消|没有放弃|not (?:been )?cancel|won'?t be cancel|not giving up/iu.test(
          clause,
        ),
    )
  ) {
    return {
      outcome: "cancelled",
      reasonCode: "explicit_cancellation",
      evidenceText,
    };
  }
  const awaitingResult = /结果|成绩|录取|result|passed|accepted/iu.test(
    followUp.expectedOutcomeDescription,
  );
  const continuedPending = related.some((index) => {
    const next = clauses[index + 1] ?? "";
    return (
      /^(?:我)?(?:还|仍|但|不过|等)|^(?:i am |i'm )?still|^waiting/iu.test(
        next,
      ) && STILL_PENDING_PATTERN.test(next)
    );
  });
  if (
    awaitingResult &&
    continuedPending &&
    !subjectClauses.some((clause) => RESULT_PATTERN.test(clause))
  ) {
    return { outcome: "none", reasonCode: "no_explicit_outcome" };
  }
  const hasOutcome = subjectClauses.some(
    (clause) =>
      (OUTCOME_PATTERN.test(clause) || RESULT_PATTERN.test(clause)) &&
      !STILL_PENDING_PATTERN.test(clause) &&
      (!awaitingResult || RESULT_PATTERN.test(clause)),
  );
  return hasOutcome
    ? { outcome: "resolved", reasonCode: "explicit_outcome", evidenceText }
    : { outcome: "none", reasonCode: "no_explicit_outcome" };
}

export function isFollowUpReschedule(text: string): boolean {
  return (
    !UNCERTAIN_OUTCOME_PATTERN.test(text) &&
    /改(?:到|成|为|在)|改期|推迟(?:到|至)?|延(?:期|后)|提前(?:到|至)|reschedul|postpon|moved? to|instead/iu.test(
      text,
    ) &&
    !/不(?:要|用|想)改|别.{0,20}改|没有改|没改|not (?:reschedul|postpon)|don'?t (?:reschedul|postpon)/iu.test(
      text,
    )
  );
}

export function applyFollowUpMessageEvaluation<T extends FollowUpLike>(
  followUp: T,
  evaluation: FollowUpMessageEvaluation,
  resolutionMessageId: string,
  nowUtc: string,
): T {
  if (
    evaluation.outcome === "none" ||
    (followUp.status !== "pending" && followUp.status !== "sent")
  ) {
    return followUp;
  }
  return {
    ...followUp,
    status: evaluation.outcome,
    resolutionMessageId,
    revision: followUp.revision + 1,
    updatedAtUtc: nowUtc,
  };
}

export function canAttemptFollowUp(
  followUp: Pick<
    FollowUpLike,
    "status" | "attemptCount" | "maxAttempts" | "earliestAtUtc" | "expiresAtUtc"
  >,
  nowUtc: string,
): boolean {
  const now = parseInstant(nowUtc);
  return (
    followUp.status === "pending" &&
    followUp.attemptCount < followUp.maxAttempts &&
    parseInstant(followUp.earliestAtUtc) <= now &&
    parseInstant(followUp.expiresAtUtc) > now
  );
}

export function markFollowUpSent<T extends FollowUpLike>(
  followUp: T,
  messageId: string,
  nowUtc: string,
): T {
  if (!canAttemptFollowUp(followUp, nowUtc)) return followUp;
  return {
    ...followUp,
    status: "sent",
    attemptCount: 1,
    sentMessageId: messageId,
    revision: followUp.revision + 1,
    updatedAtUtc: nowUtc,
  };
}

export function expireFollowUp<T extends FollowUpLike>(
  followUp: T,
  nowUtc: string,
): T {
  if (
    (followUp.status !== "pending" && followUp.status !== "sent") ||
    parseInstant(followUp.expiresAtUtc) > parseInstant(nowUtc)
  ) {
    return followUp;
  }
  return {
    ...followUp,
    status: "expired",
    revision: followUp.revision + 1,
    updatedAtUtc: nowUtc,
  };
}

export type CareCueStatusLike =
  "active" | "dismissed" | "expired" | "exhausted";

export interface CareCueLike {
  id: string;
  contextSummary: string;
  mentionGuidance: string;
  earliestAtUtc?: string;
  expiresAtUtc: string;
  status: CareCueStatusLike;
  maxMentions: number;
  mentionCount: number;
  dedupeKey: string;
  lastMentionedMessageId?: string;
  dismissedByMessageId?: string;
  revision: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface CareCueCandidateLike {
  contextSummary: string;
  mentionGuidance: string;
  timingHint?: string;
  evidenceQuotes: readonly string[];
  reasonCode: string;
  reasonSummary: string;
}

export function buildCareCueDedupeKey(input: {
  agentId: string;
  contextSummary: string;
  expiresAtUtc: string;
  timezone: string;
}): string {
  parseZone(input.timezone);
  const dateBucket =
    parseInstant(input.expiresAtUtc).setZone(input.timezone).toISODate() ?? "";
  return (
    "carecue:v1:" +
    fnv1a64(
      [
        input.agentId.trim(),
        dateBucket,
        semanticText(input.contextSummary),
      ].join("|"),
    )
  );
}

export function selectRelevantCareCues<T extends CareCueLike>(input: {
  cues: readonly T[];
  userText: string;
  nowUtc: string;
  limit?: number;
}): T[] {
  const now = parseInstant(input.nowUtc);
  const limit = Math.max(0, Math.min(input.limit ?? 2, 2));
  return input.cues
    .filter((cue) => {
      if (
        cue.status !== "active" ||
        cue.mentionCount >= cue.maxMentions ||
        parseInstant(cue.expiresAtUtc) <= now
      ) {
        return false;
      }
      if (
        cue.earliestAtUtc !== undefined &&
        parseInstant(cue.earliestAtUtc) > now
      ) {
        return false;
      }
      return textsAreRelated(cue.contextSummary, input.userText);
    })
    .sort((left, right) => {
      const expiry = left.expiresAtUtc.localeCompare(right.expiresAtUtc);
      return expiry !== 0
        ? expiry
        : left.createdAtUtc.localeCompare(right.createdAtUtc);
    })
    .slice(0, limit);
}

export function didMentionCareCue(
  cue: Pick<CareCueLike, "contextSummary" | "mentionGuidance">,
  assistantText: string,
): boolean {
  return textsAreRelated(cue.contextSummary, assistantText);
}

export function shouldDismissCareCue(
  cue: Pick<CareCueLike, "contextSummary" | "mentionGuidance">,
  userText: string,
): boolean {
  return (
    DECLINE_PATTERN.test(userText) &&
    textsAreRelated(cue.contextSummary, userText)
  );
}

export function recordCareCueMention<T extends CareCueLike>(
  cue: T,
  messageId: string,
  nowUtc: string,
): T {
  if (cue.status !== "active" || cue.mentionCount >= cue.maxMentions) {
    return cue;
  }
  const mentionCount = cue.mentionCount + 1;
  return {
    ...cue,
    status: mentionCount >= cue.maxMentions ? "exhausted" : "active",
    mentionCount,
    lastMentionedMessageId: messageId,
    revision: cue.revision + 1,
    updatedAtUtc: nowUtc,
  };
}

export function dismissCareCue<T extends CareCueLike>(
  cue: T,
  messageId: string,
  nowUtc: string,
): T {
  if (cue.status !== "active") return cue;
  return {
    ...cue,
    status: "dismissed",
    dismissedByMessageId: messageId,
    revision: cue.revision + 1,
    updatedAtUtc: nowUtc,
  };
}

export function expireCareCue<T extends CareCueLike>(
  cue: T,
  nowUtc: string,
): T {
  if (
    cue.status !== "active" ||
    parseInstant(cue.expiresAtUtc) > parseInstant(nowUtc)
  ) {
    return cue;
  }
  return {
    ...cue,
    status: "expired",
    revision: cue.revision + 1,
    updatedAtUtc: nowUtc,
  };
}

function rejectCandidate(
  reasonCode: FollowUpCandidateRejectionCode,
  reasonSummary: string,
): NormalizeFollowUpCandidateResult {
  return { accepted: false, rejection: { reasonCode, reasonSummary } };
}

function compactText(value: string, maximum: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maximum ? compact : compact.slice(0, maximum);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function isGroundedQuote(quote: string, sourceText: string): boolean {
  const normalizedQuote = normalizedEvidence(quote);
  if (normalizedQuote.length < 2) return false;
  if (/^[a-z0-9]+$/iu.test(normalizedQuote) && normalizedQuote.length < 4) {
    return false;
  }
  return normalizedEvidence(sourceText).includes(normalizedQuote);
}

const ENGLISH_STOP_WORDS = new Set([
  "the",
  "and",
  "but",
  "has",
  "had",
  "was",
  "were",
  "not",
  "for",
  "can",
  "ask",
  "about",
  "after",
  "again",
  "ask",
  "been",
  "from",
  "have",
  "later",
  "that",
  "their",
  "there",
  "this",
  "user",
  "will",
  "with",
]);

function semanticText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function textFeatures(value: string): Set<string> {
  const features = new Set<string>();
  for (const word of value.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? []) {
    if (!ENGLISH_STOP_WORDS.has(word)) features.add(word);
  }
  const normalized = semanticText(value);
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    if (run.length <= 4) features.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      features.add(run.slice(index, index + 2));
    }
  }
  return features;
}

function textsAreRelated(leftValue: string, rightValue: string): boolean {
  const left = semanticText(leftValue);
  const right = semanticText(rightValue);
  if (
    Math.min(left.length, right.length) >= 2 &&
    (left.includes(right) || right.includes(left))
  ) {
    return true;
  }
  const rightFeatures = textFeatures(rightValue);
  for (const feature of textFeatures(leftValue)) {
    if (rightFeatures.has(feature)) return true;
  }
  return false;
}

const FOLLOW_UP_RELATION_STOP_FEATURES = new Set([
  "\u865a\u6784",
  "\u6d4b\u8bd5",
  "\u573a\u666f",
  "\u4e8b\u5b9e",
  "\u7528\u6237",
  "\u6240\u8ff0",
  "\u4e8b\u9879",
  "\u662f\u5426",
  "\u5df2\u7ecf",
  "\u5b8c\u6210",
  "\u7ed3\u675f",
  "\u7ed3\u679c",
  "\u63d0\u9192",
  "\u660e\u5929",
  "\u4eca\u5929",
  "\u4ee5\u540e",
  "\u65e5\u7a0b",
  "\u5b89\u6392",
  "about",
  "completed",
  "done",
  "finished",
  "result",
  "test",
  "testing",
]);

function followUpTextsAreRelated(
  subjectValue: string,
  messageValue: string,
): boolean {
  const subjectFeatures = textFeatures(
    stripFollowUpRelationBoilerplate(subjectValue),
  );
  const messageFeatures = textFeatures(
    stripFollowUpRelationBoilerplate(messageValue),
  );
  for (const feature of subjectFeatures) {
    if (
      !FOLLOW_UP_RELATION_STOP_FEATURES.has(feature) &&
      messageFeatures.has(feature)
    ) {
      return true;
    }
  }
  return false;
}

function stripFollowUpRelationBoilerplate(value: string): string {
  return value
    .replace(/【[^】]*】/gu, " ")
    .replace(
      /明天|明日|后天|今天|今日|明晚|今晚|下周[一二三四五六日天]?|(?:周|星期)[一二三四五六日天]|下午|上午|晚上|早上|中午|用户|所述|事项|这件事|那件事|是否|有没有|已经|完成|结束|结果|提醒|安排|取消|通过|我有|我会|我将|我要|我的|你有|你会|\d+(?:点|分)?/gu,
      " ",
    );
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
