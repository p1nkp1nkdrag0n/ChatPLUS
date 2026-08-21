import type { DateTime } from "luxon";

import { parseInstant, parseZone } from "./shared.js";

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

export interface FollowUpWindow {
  earliestAtUtc: string;
  expiresAtUtc: string;
}

export type FollowUpCandidateRejectionCode =
  | "invalid_source_role"
  | "missing_grounded_quote"
  | "unrelated_context"
  | "ambiguous_timing";

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
        dedupeKey: string;
        reasonCode: string;
        reasonSummary: string;
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

  const window = resolveFollowUpWindow(
    [input.candidate.timingHint, input.sourceMessage.text].join(" "),
    input.nowUtc,
    input.timezone,
  );
  if (window === undefined) {
    return rejectCandidate(
      "ambiguous_timing",
      "The follow-up timing is too ambiguous to schedule safely.",
    );
  }

  const contextSummary = compactText(input.candidate.contextSummary, 1_000);
  const expectedOutcomeDescription = compactText(
    input.candidate.expectedOutcomeDescription,
    1_000,
  );
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
    },
  };
}

export function resolveFollowUpWindow(
  timingHint: string,
  nowUtc: string,
  timezone: string,
): FollowUpWindow | undefined {
  parseZone(timezone);
  const now = parseInstant(nowUtc).setZone(timezone);
  const text = timingHint.normalize("NFKC").trim().toLowerCase();
  if (text === "" || /\d{4}-\d{2}-\d{2}|T\d{2}:/u.test(text)) {
    return undefined;
  }

  let targetDay: DateTime | undefined;
  if (/\u540e\u5929|day after tomorrow/iu.test(text)) {
    targetDay = now.startOf("day").plus({ days: 2 });
  } else if (/\u660e\u5929|\u660e\u65e5|tomorrow/iu.test(text)) {
    targetDay = now.startOf("day").plus({ days: 1 });
  } else if (/\u4eca\u5929|\u4eca\u65e5|today/iu.test(text)) {
    targetDay = now.startOf("day");
  } else if (/\u4e0b\u5468|next week/iu.test(text)) {
    targetDay = now.startOf("week").plus({ weeks: 2 }).minus({ days: 1 });
  } else {
    const relative =
      /(?:in\s*)?(\d{1,2})\s*days?/iu.exec(text) ??
      /(\d{1,2})\s*\u5929\u540e/iu.exec(text);
    if (relative !== null) {
      const days = Number(relative[1]);
      if (days >= 1 && days <= 30) {
        targetDay = now.startOf("day").plus({ days });
      }
    }
  }
  if (targetDay === undefined) return undefined;

  const explicitClock = parseExplicitFollowUpClock(text);
  const followUpHour =
    explicitClock?.hour ??
    (/\u65e9\u4e0a|\u65e9\u6668|\u4e0a\u5348|morning/iu.test(text)
      ? 12
      : /\u4e2d\u5348|\bnoon\b/iu.test(text)
        ? 14
        : /\u4e0b\u5348|afternoon/iu.test(text)
          ? 18
          : /\u665a\u4e0a|\u508d\u665a|evening|tonight/iu.test(text)
            ? 23
            : 20);
  const earliest = targetDay.set({
    hour: followUpHour,
    minute: explicitClock?.minute ?? 0,
    second: 0,
    millisecond: 0,
  });
  if (!earliest.isValid || earliest <= now) return undefined;
  const expires = earliest.plus({ hours: 72 });
  return {
    earliestAtUtc: earliest.toUTC().toISO()!,
    expiresAtUtc: expires.toUTC().toISO()!,
  };
}
interface ExplicitFollowUpClock {
  hour: number;
  minute: number;
}

function parseExplicitFollowUpClock(
  text: string,
): ExplicitFollowUpClock | undefined {
  const colon =
    /(?:(midnight|morning|noon|afternoon|evening|凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)\s*)?(\d{1,2})\s*[:：]\s*(\d{1,2})(?:\s*(am|pm)\b)?/iu.exec(
      text,
    );
  const chinese =
    /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)\s*(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分?)?/iu.exec(
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
  } else if (/下午|傍晚|晚上|afternoon|evening/iu.test(period ?? "")) {
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
  /\u53d6\u6d88|\u4e0d(?:\u53bb|\u53c2\u52a0|\u505a|\u8003)|\u653e\u5f03|\u6539\u4e3b\u610f|\u4e0d\u518d|cancel(?:led|ed)?|called off|won'?t|will not|not going|gave up|decided not/iu;
const DECLINE_PATTERN =
  /\u522b(?:\u518d)?(?:\u95ee|\u63d0)|\u4e0d\u60f3\u804a|\u522b\u518d\u8bf4|do not ask|don'?t ask|rather not talk|stop bringing/iu;
const OUTCOME_PATTERN = new RegExp(
  [
    "\\u7ed3\\u675f(?:\\u4e86)?",
    "\\u5b8c\\u6210(?:\\u4e86)?",
    "\\u505a\\u5b8c|\\u5f04\\u5b8c|\\u4ea4\\u5b8c|\\u4ea4\\u4e86",
    "\\u901a\\u8fc7|\\u8fc7\\u4e86|\\u6210\\u529f|\\u5931\\u8d25",
    "\\u6ca1\\u8fc7|\\u641e\\u5b9a",
    "finished|completed|done|passed|failed|submitted",
    "it is over|it'?s over|went well|didn'?t pass",
  ].join("|"),
  "iu",
);
const STILL_PENDING_PATTERN =
  /\u8fd8\u6ca1|\u5c1a\u672a|\u6b63\u5728|\u9a6c\u4e0a\u8981|\u660e\u5929|\u4e0b\u5468|not yet|still (?:working|waiting)|will (?:do|take|submit|attend)|tomorrow|next week/iu;

export function evaluateFollowUpMessage(
  followUp: Pick<FollowUpLike, "contextSummary" | "expectedOutcomeDescription">,
  userText: string,
): FollowUpMessageEvaluation {
  if (
    !followUpTextsAreRelated(
      followUp.contextSummary + " " + followUp.expectedOutcomeDescription,
      userText,
    )
  ) {
    return { outcome: "none", reasonCode: "subject_mismatch" };
  }
  const evidenceText = compactText(userText, 1_000);
  if (DECLINE_PATTERN.test(userText)) {
    return {
      outcome: "cancelled",
      reasonCode: "user_declined_followup",
      evidenceText,
    };
  }
  if (CANCELLATION_PATTERN.test(userText)) {
    return {
      outcome: "cancelled",
      reasonCode: "explicit_cancellation",
      evidenceText,
    };
  }
  if (STILL_PENDING_PATTERN.test(userText)) {
    return { outcome: "none", reasonCode: "no_explicit_outcome" };
  }
  if (OUTCOME_PATTERN.test(userText)) {
    return {
      outcome: "resolved",
      reasonCode: "explicit_outcome",
      evidenceText,
    };
  }
  return { outcome: "none", reasonCode: "no_explicit_outcome" };
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
      return textsAreRelated(
        cue.contextSummary + " " + cue.mentionGuidance,
        input.userText,
      );
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
  return textsAreRelated(
    cue.contextSummary + " " + cue.mentionGuidance,
    assistantText,
  );
}

export function shouldDismissCareCue(
  cue: Pick<CareCueLike, "contextSummary" | "mentionGuidance">,
  userText: string,
): boolean {
  return (
    DECLINE_PATTERN.test(userText) &&
    textsAreRelated(cue.contextSummary + " " + cue.mentionGuidance, userText)
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
    subjectValue.replace(/\u3010[^\u3011]*\u3011/gu, " "),
  );
  const messageFeatures = textFeatures(
    messageValue.replace(/\u3010[^\u3011]*\u3011/gu, " "),
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

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
