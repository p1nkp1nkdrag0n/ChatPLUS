import type { ConversationContextPlan } from "@personasim/contracts";
import {
  deriveCurrentConversationRequests,
  withoutQuotedConversationText,
} from "./conversation-requests.js";

export const TURN_EXPRESSION_OPENINGS = [
  "这样啊",
  "原来如此",
  "嗯",
  "明白了",
  "听起来",
  "其实",
  "说实话",
  "我觉得",
] as const;
const OPENING =
  /^(这样啊|原来如此|嗯|明白了|听起来|其实|说实话|我觉得)(?=[，,。.!！?？：:；;、…—\s]|$)/u;

/** A lexical opening marker, not a judgment about the reply's quality. */
export function turnOpening(text: string): string | undefined {
  return OPENING.exec(text.trimStart())?.[1];
}

export function hasProtectedTurnOpening(
  text: string,
  protectedPhrases: readonly string[],
): boolean {
  return protectedPhrases.some(
    (phrase) =>
      phrase.trim().length > 0 && text.trimStart().startsWith(phrase.trim()),
  );
}

/** A bounded view of final visible replies, never a persistent preference. */
export function buildTurnExpressionContext(input: {
  assistantTexts: readonly string[];
  protectedPhrases?: readonly string[];
}): NonNullable<ConversationContextPlan["expressionContext"]> {
  const allProtectedPhrases = [
    ...new Set(
      (input.protectedPhrases ?? [])
        .map((phrase) => phrase.trim())
        .filter(Boolean),
    ),
  ];
  // The compact prompt view is bounded; the author's protection is not capped.
  const protectedPhrases = allProtectedPhrases.slice(0, 24);
  const counts = new Map<string, number>();
  for (const text of input.assistantTexts.slice(-5)) {
    const opening = turnOpening(text);
    if (
      opening === undefined ||
      hasProtectedTurnOpening(text, allProtectedPhrases)
    )
      continue;
    counts.set(opening, (counts.get(opening) ?? 0) + 1);
  }
  return {
    policyVersion: "turn_expression_v1",
    windowSize: 5,
    repeatedOpenings: [...counts]
      .filter(([, count]) => count >= 2)
      .map(([text, count]) => ({ text, count })),
    protectedPhrases,
  };
}

export function deriveQuestionIntent(
  text: string,
): Pick<ConversationContextPlan, "questionIntent" | "questionIntentReason"> {
  // A disclaimer about somebody else's request cannot cancel a separate actual
  // task. Conversely a quoted, negated or hypothetical task is not authorization.
  const clauses = withoutQuotedConversationText(text)
    .replace(
      /(?<!不)(?:但是|但|不过|而是|改成|改为)|\b(?:but|instead)\b/giu,
      "，$&",
    )
    .split(/[，,。.!！?？;；\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const directClauses = clauses.filter(
    (clause) =>
      !REPORTED_OR_HYPOTHETICAL.test(
        clause.replace(/^(?:但是|但|不过|而是|现在)\s*/u, ""),
      ),
  );
  const clarifiedThirdParty = directClauses.some((clause) =>
    THIRD_PARTY_CLARIFICATION.test(clause),
  );
  const operative = directClauses.filter(
    (clause) => !THIRD_PARTY_CLARIFICATION.test(clause),
  );
  const active = operative.join("，");
  const requests = deriveCurrentConversationRequests(active);
  const closedVent =
    /(?:单纯|只是|只想|就想).{0,8}(?:吐槽|说|抱怨)(?:一句|一下|两句)?/u.test(
      active,
    ) &&
    /不用.{0,6}(?:解决|分析|建议)|不(?:用|必).{0,5}(?:追问|问)|说到这|到此为止/u.test(
      active,
    );
  let clarification = false;
  let noQuestions = false;
  for (const clause of operative) {
    const events = [
      ...[...clause.matchAll(CLARIFICATION_REQUEST)].map((match) => ({
        match,
        kind: "ask" as const,
      })),
      ...[...clause.matchAll(NO_QUESTIONS)].map((match) => ({
        match,
        kind: "stop" as const,
      })),
    ].sort((a, b) => a.match.index - b.match.index);
    for (const { match, kind } of events) {
      const prefix = clause.slice(0, match.index);
      if (NEGATED_REQUEST.test(prefix)) {
        if (kind === "ask") {
          clarification = false;
          noQuestions = true;
        }
        continue;
      }
      if (
        kind === "stop" ||
        /(?:不用|不要|不必|无需|别).{0,3}(?:问我|向我确认|帮我澄清)/u.test(
          match[0],
        )
      ) {
        clarification = false;
        noQuestions = true;
      } else {
        clarification = true;
        noQuestions = false;
      }
    }
  }
  if (noQuestions || requests.helpTiming === "after_user_finishes")
    return {
      questionIntent: "none",
      questionIntentReason: closedVent ? "closed_vent" : "ordinary",
    };
  if (clarification)
    return {
      questionIntent: "necessary_for_explicit_task",
      questionIntentReason: "explicit_clarification",
    };
  if (requests.adviceRequested || requests.detailedAnalysisRequested)
    return {
      questionIntent: "natural_optional",
      questionIntentReason: "ordinary",
    };
  if (clarifiedThirdParty)
    return {
      questionIntent: "none",
      questionIntentReason: "clarified_third_party",
    };
  if (closedVent)
    return { questionIntent: "none", questionIntentReason: "closed_vent" };
  return {
    questionIntent: "natural_optional",
    questionIntentReason: "ordinary",
  };
}

const THIRD_PARTY_CLARIFICATION =
  /(?:不是|并非|没有)(?:在)?(?:替我|代我|我在|我要|我的).{0,12}(?:提要求|要求|请求|需要)/u;
const REPORTED_OR_HYPOTHETICAL =
  /^(?:(?:朋友|他|她|别人|同事|我(?:以前|之前|当时|刚才)).{0,8}(?:说|让|要求)|(?:假设|如果|假如|要是)|(?:she|he|they) (?:said|asked)|if\b)/iu;
const CLARIFICATION_REQUEST =
  /(?:请|可以|先|需要).{0,8}(?:问我|向我确认|帮我澄清)|有哪些.{0,5}(?:信息|条件).{0,5}(?:要|需要).{0,3}(?:补充|确认)/giu;
const NO_QUESTIONS =
  /(?:不用|不要|不必|无需|别)(?:再|继续|先)?(?:追问|问|向我确认|帮我澄清)/giu;
const NEGATED_REQUEST =
  /(?:不是|并非|不用|不要|不必|没让|没有让|无需|别)(?:你|请你|让你)?\s*$/u;

/** Shared by initial generation and every bounded repair path. */
export function turnExpressionPromptView(plan: ConversationContextPlan) {
  return {
    questionIntent: plan.questionIntent ?? "natural_optional",
    questionIntentReason: plan.questionIntentReason,
    recentExpression: plan.expressionContext,
    questionGuidance:
      "none: acknowledge the present content and let this turn end; do not request more details or guess a need the user has already disclaimed. natural_optional: ask only if it advances this conversation. necessary_for_explicit_task: ask the specific missing information needed for the requested task. A listen-first practice is not a duty to keep asking questions.",
    expressionGuidance:
      "When a nonessential opening is repeated in recentExpression, lower its prominence and respond directly to the content. This is a temporary cue, not a forbidden word or a new persona trait. Preserve explicitly authored phrase requirements. Do not replace one repeated opening with another stock template.",
    analysisGuidance:
      "For substantive help, distinguish what the user has established, possible explanations, and what would verify them. Multiple causes can coexist; a personal mistake, changing requirements, and fatigue need not exclude one another. Match certainty to evidence and give useful concrete next checks when requested, without a fixed disclaimer or automatic reassurance.",
  };
}
