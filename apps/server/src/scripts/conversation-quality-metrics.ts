import type { ConversationContextPlan } from "@personasim/contracts";
import {
  deriveQuestionIntent,
  hasProtectedTurnOpening,
  turnOpening,
  TURN_EXPRESSION_OPENINGS,
} from "@personasim/features";

export type QualityReviewAxis =
  "unnecessaryFollowUp" | "reguessedClarifiedIntent" | "overconfidentAnalysis";

export interface ConversationQualityTurn {
  turnId: string;
  userText: string;
  /** Exactly one final visible reply per logical turn, not each chunk/attempt. */
  assistantText: string;
  frozenPlan?: Pick<
    ConversationContextPlan,
    | "questionIntent"
    | "questionIntentReason"
    | "adviceRequested"
    | "detailedAnalysisRequested"
  >;
}

export interface ConversationQualityJudgment {
  turnId: string;
  unnecessaryFollowUp?: boolean;
  reguessedClarifiedIntent?: boolean;
  overconfidentAnalysis?: boolean;
  /** Reviewer-provided reasoning, not a generated quality judgment. */
  notes?: string;
}

const REVIEW_AXES: readonly QualityReviewAxis[] = [
  "unnecessaryFollowUp",
  "reguessedClarifiedIntent",
  "overconfidentAnalysis",
];

interface OpeningRun {
  firstTurnId: string;
  lastTurnId: string;
  turnIds: string[];
  length: number;
}

/** An offline descriptive worksheet. These metrics never authorize generation,
 * change a persona, or contribute to advice/attribution acceptance denominators.
 * All semantic quality counts remain unknown until reviewers supply judgments.
 */
export function buildConversationQualityMetrics(input: {
  turns: readonly ConversationQualityTurn[];
  protectedPhrases?: readonly string[];
  trackedPhrases?: readonly string[];
  judgments?: readonly ConversationQualityJudgment[];
}) {
  const protectedPhrases = [
    ...new Set(
      (input.protectedPhrases ?? [])
        .map((phrase) => phrase.trim())
        .filter(Boolean),
    ),
  ];
  const phrases = [
    ...new Set([
      ...(input.trackedPhrases ?? TURN_EXPRESSION_OPENINGS),
      ...protectedPhrases,
    ]),
  ].filter(Boolean);
  const ids = new Set(input.turns.map((turn) => turn.turnId));
  if (ids.size !== input.turns.length)
    throw new Error("quality_metrics_duplicate_logical_turn");
  if (
    input.turns.some(
      (turn) => !turn.turnId.trim() || !turn.assistantText.trim(),
    )
  )
    throw new Error("quality_metrics_requires_final_visible_reply");
  const judgments = new Map<string, ConversationQualityJudgment>();
  for (const judgment of input.judgments ?? []) {
    if (!ids.has(judgment.turnId))
      throw new Error("quality_metrics_unknown_review_turn");
    if (judgments.has(judgment.turnId))
      throw new Error("quality_metrics_duplicate_review_turn");
    judgments.set(judgment.turnId, judgment);
  }
  const openingMetrics = phrases.map((phrase) => {
    const isCommonMarker = (
      TURN_EXPRESSION_OPENINGS as readonly string[]
    ).includes(phrase);
    const isOpening = (turn: ConversationQualityTurn) =>
      isCommonMarker
        ? turnOpening(turn.assistantText) === phrase
        : turn.assistantText.trimStart().startsWith(phrase);
    const occurrenceTurnIds = input.turns
      .filter((turn) => turn.assistantText.includes(phrase))
      .map((turn) => turn.turnId);
    const openingTurnIds = input.turns
      .filter(isOpening)
      .map((turn) => turn.turnId);
    const protectedOpeningTurnIds = input.turns
      .filter(
        (turn) =>
          isOpening(turn) &&
          hasProtectedTurnOpening(turn.assistantText, protectedPhrases),
      )
      .map((turn) => turn.turnId);
    const consecutiveOpeningRuns = openingRuns(input.turns, isOpening);
    const nonessentialOpeningRuns = openingRuns(
      input.turns,
      (turn) =>
        isOpening(turn) &&
        !hasProtectedTurnOpening(turn.assistantText, protectedPhrases),
    );
    return {
      phrase,
      // One occurrence turn can contain the phrase several times; count it once.
      occurrenceTurns: occurrenceTurnIds.length,
      openingTurns: openingTurnIds.length,
      occurrenceTurnIds,
      openingTurnIds,
      protectedOpeningTurnIds,
      consecutiveOpeningRuns,
      maximumConsecutiveOpenings: Math.max(
        0,
        ...consecutiveOpeningRuns.map((run) => run.length),
      ),
      repetitionReviewCandidates: nonessentialOpeningRuns.filter(
        (run) => run.length >= 3,
      ),
    };
  });
  const manualReviewCases = input.turns.map((turn) => {
    const frozen = turn.frozenPlan?.questionIntent !== undefined;
    const question = frozen
      ? turn.frozenPlan
      : deriveQuestionIntent(turn.userText);
    const substantiveHelp =
      turn.frozenPlan === undefined
        ? null
        : turn.frozenPlan.adviceRequested ||
          turn.frozenPlan.detailedAnalysisRequested;
    const supplied = judgments.get(turn.turnId);
    return {
      turnId: turn.turnId,
      userText: turn.userText,
      finalVisibleReply: turn.assistantText,
      questionIntent: question?.questionIntent ?? "natural_optional",
      questionIntentReason: question?.questionIntentReason ?? "ordinary",
      questionPlanSource: frozen
        ? ("frozen_turn_plan" as const)
        : ("rederived_for_offline_review" as const),
      requestedSubstantiveHelp: substantiveHelp,
      suggestedReviewAxes: [
        ...(question?.questionIntent === "none"
          ? ["unnecessaryFollowUp" as const]
          : []),
        ...(question?.questionIntentReason === "clarified_third_party"
          ? ["reguessedClarifiedIntent" as const]
          : []),
        ...(substantiveHelp !== false
          ? ["overconfidentAnalysis" as const]
          : []),
      ],
      // Question marks and lexical invitations are only locating aids. A quote
      // or rhetorical question can match; missing a match is not semantic PASS.
      followUpCandidateSpans: followUpCandidates(turn.assistantText),
      judgments: Object.fromEntries(
        REVIEW_AXES.map((axis) => [axis, supplied?.[axis] ?? null]),
      ) as Record<QualityReviewAxis, boolean | null>,
      notes: supplied?.notes ?? null,
    };
  });
  const manualCounts = Object.fromEntries(
    REVIEW_AXES.map((axis) => {
      const reviewed = manualReviewCases.filter(
        (review) => review.judgments[axis] !== null,
      );
      const positiveTurnIds = reviewed
        .filter((review) => review.judgments[axis] === true)
        .map((review) => review.turnId);
      return [
        axis,
        {
          reviewedTurns: reviewed.length,
          positiveTurnIds,
          count:
            reviewed.length === input.turns.length && input.turns.length > 0
              ? positiveTurnIds.length
              : null,
        },
      ];
    }),
  ) as Record<
    QualityReviewAxis,
    { reviewedTurns: number; positiveTurnIds: string[]; count: number | null }
  >;
  return {
    schema: "conversation-quality-metrics-v1" as const,
    surface: "final_visible_replies" as const,
    observedLogicalTurns: input.turns.length,
    openingMetrics,
    styleReviewTrigger: {
      minimumConsecutiveNonessentialOpenings: 3,
      meaning: "review_candidate_only" as const,
    },
    manualReviewCases,
    manualCounts,
    limitations: [
      "This independent quality worksheet does not alter the advice or attribution scoring denominators.",
      "Literal occurrence and bounded opening counts do not prove natural conversation or template diversity.",
      "Author-protected phrases remain visible in counts and are excluded only from nonessential repetition triggers.",
      "Question necessity, renewed intent guessing and analysis calibration require contextual human or independent review; certainty words are not forbidden.",
      "When an old artifact lacks a frozen question plan, the offline derived plan is explicitly labeled and cannot be presented as what generation saw.",
    ],
  };
}

function openingRuns(
  turns: readonly ConversationQualityTurn[],
  matches: (turn: ConversationQualityTurn) => boolean,
): OpeningRun[] {
  const runs: OpeningRun[] = [];
  let active: OpeningRun | undefined;
  for (const turn of turns) {
    if (!matches(turn)) {
      active = undefined;
      continue;
    }
    if (active === undefined) {
      active = {
        firstTurnId: turn.turnId,
        lastTurnId: turn.turnId,
        turnIds: [],
        length: 0,
      };
      runs.push(active);
    }
    active.turnIds.push(turn.turnId);
    active.lastTurnId = turn.turnId;
    active.length += 1;
  }
  return runs;
}

function followUpCandidates(text: string) {
  const matches = [
    ...text.matchAll(
      /[^。.!！?？\n]*[?？]|(?:能不能|可不可以|可以).{0,8}(?:说说|讲讲|展开)|(?:再|接着|具体)(?:说说|讲讲|解释)|说来听听/gu,
    ),
  ];
  return matches.map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
    judgment: "pending" as const,
  }));
}
