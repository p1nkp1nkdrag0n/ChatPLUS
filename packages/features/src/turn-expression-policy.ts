import type {
  ConversationContextPlan,
  PersonaAdaptation,
} from "@personasim/contracts";
import {
  deriveCurrentConversationRequests,
  withoutQuotedConversationText,
} from "./conversation-requests.js";
import {
  deriveFactQueryNeeds,
  extractExplicitCurrentFactProjections,
} from "./memory-claim.js";

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
  recentDialogue?: readonly { role: "user" | "assistant"; text: string }[];
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
    ...(input.recentDialogue === undefined
      ? {}
      : {
          recentDialogue: input.recentDialogue
            .slice(-6)
            .filter(
              (message) =>
                message.text.length > 0 && message.text.length <= 1_200,
            )
            .map(({ role, text }) => ({ role, text })),
        }),
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
  let invitation = false;
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
      ...[...clause.matchAll(INVITE_QUESTIONS)].map((match) => ({
        match,
        kind: "invite" as const,
      })),
      ...[...clause.matchAll(END_TURN)].map((match) => ({
        match,
        kind: "stop" as const,
      })),
    ].sort((a, b) => a.match.index - b.match.index);
    for (const { match, kind } of events) {
      const prefix = clause.slice(0, match.index);
      const lastTiming = [
        ...prefix.matchAll(/以后|今后|往后|将来|现在|今晚|今天|这轮/gu),
      ].at(-1)?.[0];
      if (
        noQuestions &&
        kind !== "stop" &&
        /^(?:以后|今后|往后|将来)$/u.test(lastTiming ?? "")
      )
        continue;
      if (NEGATED_REQUEST.test(prefix)) {
        if (kind === "ask" || kind === "invite") {
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
        invitation = false;
        noQuestions = true;
      } else {
        clarification =
          kind === "ask" && /(?:缺|信息|条件|补充|确认|澄清)/u.test(clause);
        invitation = !clarification;
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
  if (invitation)
    return {
      questionIntent: "natural_optional",
      questionIntentReason: "ordinary",
    };
  const independentTask = operative.some((clause) =>
    [
      ...clause.matchAll(
        /(?:请(?:你)?|帮我|替我).{0,6}(?:写|草拟|翻译|总结|计算|解释|比较|设计|起草)/gu,
      ),
    ].some((match) => !NEGATED_REQUEST.test(clause.slice(0, match.index))),
  );
  if (
    requests.adviceRequested ||
    requests.detailedAnalysisRequested ||
    independentTask
  )
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
  const completedCorrection = extractExplicitCurrentFactProjections(
    active,
  ).some((fact) => fact.revisionIntent === "explicit_correction");
  if (completedCorrection || deriveFactQueryNeeds(active).length > 0)
    return { questionIntent: "none", questionIntentReason: "ordinary" };
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
  /(?:不用|不要|不必|无需|别)(?:再|继续|先)?(?:追问|问|向我确认|帮我澄清)|(?:今晚|这轮|现在|今天)?(?:少问|少追问)/giu;
const INVITE_QUESTIONS =
  /(?:你|请你|可以|主动)(?:也|来|先|再)?(?:主动)?(?:问(?:我)?(?:一|几)?(?:点|个|些|句)|带(?:一点)?话题)/giu;
const END_TURN =
  /(?:不想|不用|不要|不必)(?:再|继续)?展开|(?:只|就)(?:说|吐槽)一句|说到这(?:里)?|到此为止|先聊到这|不聊了|^(?:那就|先)?晚安(?:啦|了|吧)?$/giu;
const NEGATED_REQUEST =
  /(?:不是|并非|不用|不要|不必|不想|不希望|没让|没有让|无需|别)(?:你|请你|让你|让|要你|要)?\s*$/u;

/** Shared by initial generation and every bounded repair path. */
export function turnExpressionPromptView(
  plan: ConversationContextPlan,
  practices: readonly Pick<PersonaAdaptation, "proposal">[] = [],
) {
  return {
    questionIntent: plan.questionIntent ?? "natural_optional",
    questionIntentReason: plan.questionIntentReason,
    recentExpression: plan.expressionContext,
    applicablePractices: practices.map(({ proposal }) => ({
      practice: proposal.practice,
      scope: proposal.scope,
    })),
    practiceGuidance:
      "These are already verified practices in the current user/topic scope. plain_expression favors direct concrete language; natural_questions welcomes a small opening when appropriate; fewer_questions lowers question prominence. Current explicit closure, invitation, creative request and task needs take precedence. Apply preferences silently and never turn them into question quotas.",
    questionGuidance:
      "none: answer or acknowledge the present content and let this turn end; do not request more details, say 'keep talking', or move to an unrelated question to keep the turn open. Complete independent requests in the same message. For a closed vent, do not announce that you are following a listening policy. natural_optional: first respond to the content; when useful, offer one concrete, easy opening or question, without requiring a question or a final question mark. When invited to lead, offer a small starting point instead of asking what the user wants to discuss or presenting a menu. necessary_for_explicit_task: use the supplied reliable facts first and ask only for genuinely missing information; if it is already supplied, answer directly. A ban on advice does not forbid a fitting content question, but an action suggestion phrased as a question still follows advicePolicy. Current closure overrides stored preferences. Use recentDialogue to receive an answer before considering another question, follow a topic change, and reduce pressure after short responses; do not infer a lasting preference, personality, relationship loss, or an unanswered task. Never ask again for known or skipped details; missing context does not prove the user never told you.",
    expressionGuidance:
      "Respond concretely and plainly to the user's present subject. Warmth, specific observations and light humor are welcome; do not routinely add metaphors, psychological traits or abilities, or a life lesson to ordinary sharing. Honor an explicit request for analogy, poetry or creative style and authored phrase requirements. A current style request does not establish a lasting preference. When a nonessential opening is repeated in recentExpression, lower its prominence without replacing it with another stock template. After a sufficient factual correction, briefly acknowledge and use the correct content; do not ask why it changed, retell the old mistake, invent a cause, or turn it into relationship growth unless history is explicitly requested. Speak naturally without announcing a policy or mode. Use semantic units for chunks; keep a list number with its content and do not force a question into its own bubble.",
    analysisGuidance:
      "For substantive help, distinguish what the user has established, possible explanations, and what would verify them. Multiple causes can coexist; a personal mistake, changing requirements, and fatigue need not exclude one another. A diagnostic clue is not proof that another cause is absent. Do not redefine an actual mistake as requiring irreversible harm, major consequences, or a particular feeling of guilt; compare concrete discrepancies with the agreed requirements. Separate responsibility for those discrepancies from the user's worth. Match certainty to evidence and give useful concrete next checks when requested, without a fixed disclaimer or automatic reassurance.",
  };
}
