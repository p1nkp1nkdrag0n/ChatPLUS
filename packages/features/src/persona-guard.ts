import type { ScheduleEffectProposalLike } from "./schedule-validator.js";

export type PersonaViolationCode =
  | "EMPTY_REPLY"
  | "AI_META_DISCLOSURE"
  | "FORBIDDEN_KNOWLEDGE"
  | "AVOIDED_PHRASE"
  | "UNCOMMITTED_SCHEDULE_CLAIM"
  | "REASON_SUMMARY_TOO_LONG";

export interface PersonaViolation {
  code: PersonaViolationCode;
  severity: "warning" | "error";
  detail: string;
}

export interface PersonaGuardInput {
  text: string;
  avoidedPhrases?: readonly string[];
  forbiddenMetaKnowledge?: readonly string[];
  acceptedScheduleEffects?: readonly ScheduleEffectProposalLike[];
  reasonSummary?: string;
}

export interface PersonaGuardResult {
  allowed: boolean;
  violations: PersonaViolation[];
  text: string;
}

const AI_META_PATTERNS = [
  /作为(?:一个)?(?:AI|人工智能|语言模型)/iu,
  /as an? (?:ai|language model)/iu,
  /my system prompt/iu,
  /我的系统提示(?:词)?/u,
];
const SCHEDULE_CLAIM =
  /(?:已经|已|刚刚).{0,8}(?:修改|取消|移动|改了|安排).{0,10}(?:日程|计划)|(?:i(?:'ve| have)) (?:rescheduled|cancelled|added it to my schedule)/iu;

function includesPhrase(text: string, phrase: string): boolean {
  return (
    phrase.trim() !== "" &&
    text.toLocaleLowerCase().includes(phrase.trim().toLocaleLowerCase())
  );
}

export function guardPersonaReply(
  input: PersonaGuardInput,
): PersonaGuardResult {
  const text = input.text.trim();
  const violations: PersonaViolation[] = [];
  if (text === "") {
    violations.push({
      code: "EMPTY_REPLY",
      severity: "error",
      detail: "Reply cannot be empty",
    });
  }
  if (AI_META_PATTERNS.some((pattern) => pattern.test(text))) {
    violations.push({
      code: "AI_META_DISCLOSURE",
      severity: "error",
      detail: "Reply breaks character with generic assistant meta-language",
    });
  }
  for (const phrase of input.forbiddenMetaKnowledge ?? []) {
    if (includesPhrase(text, phrase)) {
      violations.push({
        code: "FORBIDDEN_KNOWLEDGE",
        severity: "error",
        detail: `Reply includes forbidden meta-knowledge: ${phrase.slice(0, 80)}`,
      });
    }
  }
  for (const phrase of input.avoidedPhrases ?? []) {
    if (includesPhrase(text, phrase)) {
      violations.push({
        code: "AVOIDED_PHRASE",
        severity: "warning",
        detail: `Reply uses an avoided phrase: ${phrase.slice(0, 80)}`,
      });
    }
  }
  if (
    SCHEDULE_CLAIM.test(text) &&
    (input.acceptedScheduleEffects?.length ?? 0) === 0
  ) {
    violations.push({
      code: "UNCOMMITTED_SCHEDULE_CLAIM",
      severity: "error",
      detail: "Reply claims a schedule mutation without a validated effect",
    });
  }
  if ((input.reasonSummary?.length ?? 0) > 240) {
    violations.push({
      code: "REASON_SUMMARY_TOO_LONG",
      severity: "error",
      detail: "reasonSummary exceeds 240 characters",
    });
  }
  return {
    allowed: violations.every((violation) => violation.severity !== "error"),
    violations,
    text,
  };
}

export function createSafeFallbackReply(characterName?: string): string {
  return characterName === undefined
    ? "我得先确认一下时间安排，暂时不能说这件事已经定下来了。"
    : `${characterName}得先确认一下时间安排，暂时不能说这件事已经定下来了。`;
}

export const checkPersonaResponse = guardPersonaReply;
