import type { ConversationContextPlan } from "@personasim/contracts";
import {
  deriveQuestionIntent,
  hasProtectedTurnOpening,
  TURN_EXPRESSION_OPENINGS,
} from "@personasim/features";

export type QualityReviewAxis =
  "unnecessaryFollowUp" | "reguessedClarifiedIntent" | "overconfidentAnalysis";

export interface ConversationQualityTurn {
  turnId: string;
  userText: string;
  /** Exactly one final visible reply per logical turn, not each chunk/attempt. */
  assistantText: string;
  /** Actual delivered bubbles, in order. Omit when the artifact did not capture them. */
  assistantChunks?: readonly string[];
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
  for (const turn of input.turns) {
    if (
      turn.assistantChunks !== undefined &&
      (turn.assistantChunks.length === 0 ||
        turn.assistantChunks.some((chunk) => !chunk.trim()) ||
        compactVisibleText(turn.assistantChunks.join("")) !==
          compactVisibleText(turn.assistantText))
    )
      throw new Error("quality_metrics_chunks_must_match_final_reply");
  }
  const judgments = new Map<string, ConversationQualityJudgment>();
  for (const judgment of input.judgments ?? []) {
    if (!ids.has(judgment.turnId))
      throw new Error("quality_metrics_unknown_review_turn");
    if (judgments.has(judgment.turnId))
      throw new Error("quality_metrics_duplicate_review_turn");
    judgments.set(judgment.turnId, judgment);
  }
  const openingMetrics = phrases.map((phrase) => {
    // This worksheet counts literal phrase starts. Runtime cue detection is
    // deliberately narrower and must not turn "听起来很惬意" into a zero start.
    const isOpening = (turn: ConversationQualityTurn) =>
      turn.assistantText.trimStart().startsWith(phrase);
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
    responseForm: responseFormMetrics(input.turns),
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
      "Form distributions describe this ordered conversation, not quality: identical shapes may fit repeated requests, while varied lengths or openings do not establish naturalness.",
      "Chunk counts are observed only when actual delivered bubbles are supplied; paragraphs and sentence segments never stand in for missing bubbles.",
    ],
  };
}

const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });
const sentences = new Intl.Segmenter("zh", { granularity: "sentence" });

function compactVisibleText(text: string): string {
  return text.normalize("NFC").replace(/\s/gu, "");
}

function responseFormMetrics(turns: readonly ConversationQualityTurn[]) {
  const perTurn = turns.map((turn) => {
    const text = turn.assistantText.normalize("NFC").trim();
    const visibleCharacters = [...graphemes.segment(compactVisibleText(text))]
      .length;
    const sentenceCount = [...sentences.segment(text)].filter(({ segment }) =>
      segment.trim(),
    ).length;
    const paragraphCount = text
      .split(/\n\s*\n/u)
      .filter((part) => part.trim()).length;
    const chunkCount = turn.assistantChunks?.length ?? null;
    // An observed leading clause, capped at twelve graphemes. This deliberately
    // makes no claim to recognize equivalent syntax or a semantic template.
    const firstClause = text.split(/[，,。.!！?？:：;；\n]/u)[0] ?? "";
    const openingSpan = [...graphemes.segment(firstClause.trim())]
      .slice(0, 12)
      .map(({ segment }) => segment)
      .join("");
    return {
      turnId: turn.turnId,
      visibleCharacters,
      sentenceCount,
      paragraphCount,
      chunkCount,
      openingSpan,
      shape: `${sentenceCount}s/${paragraphCount}p/${chunkCount ?? "unknown"}c`,
    };
  });
  const repetitions = (field: "openingSpan" | "shape") => {
    const groups = new Map<string, string[]>();
    for (const turn of perTurn) {
      const signature = turn[field];
      if (!signature) continue;
      const ids = groups.get(signature) ?? [];
      ids.push(turn.turnId);
      groups.set(signature, ids);
    }
    const repeated = [...groups].filter(([, ids]) => ids.length > 1);
    return repeated
      .map(([signature, turnIds]) => ({
        signature,
        count: turnIds.length,
        share: turnIds.length / turns.length,
        turnIds,
        maximumConsecutiveTurns: Math.max(
          ...openingRuns(turns, (turn) => turnIds.includes(turn.turnId)).map(
            (run) => run.length,
          ),
        ),
      }))
      .sort((left, right) => right.count - left.count);
  };
  return {
    counting: "NFC_non_whitespace_graphemes" as const,
    order: "supplied_conversation_order" as const,
    sentenceCounting: "Intl.Segmenter_zh_sentence" as const,
    visibleCharacters: distribution(
      perTurn.map((turn) => turn.visibleCharacters),
    ),
    sentenceCount: distribution(perTurn.map((turn) => turn.sentenceCount)),
    paragraphCount: distribution(perTurn.map((turn) => turn.paragraphCount)),
    chunkCount: distribution(perTurn.flatMap((turn) => turn.chunkCount ?? [])),
    turnsWithUnknownChunks: perTurn
      .filter((turn) => turn.chunkCount === null)
      .map((turn) => turn.turnId),
    repeatedOpeningSpans: repetitions("openingSpan"),
    repeatedShapes: repetitions("shape"),
    perTurn,
  };
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
  const middle = Math.floor(sorted.length / 2);
  return {
    observedTurns: values.length,
    minimum: sorted[0] ?? null,
    maximum: sorted.at(-1) ?? null,
    mean,
    median: values.length
      ? sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!
      : null,
    sampleStandardDeviation:
      values.length > 1 && mean !== null
        ? Math.sqrt(
            values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
              (values.length - 1),
          )
        : null,
    distinctValues: [...new Set(sorted)],
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
