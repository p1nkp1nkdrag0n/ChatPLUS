import { topicOverlap } from "./fuzzy-life-choice.js";
import { analyzeLifeEvidence } from "./fuzzy-life-evidence.js";

export type CausalReplyViolationCode =
  "CAUSAL_FALSE_PREMISE_ACCEPTED" | "CAUSAL_SUBJECT_OWNERSHIP_INVERTED";

export interface CausalReplyViolation {
  code: CausalReplyViolationCode;
  severity: "error";
  detail: string;
  canonicalFacts: Record<string, unknown>;
}

export interface CausalReplyGuardInput {
  userText: string;
  replyText: string;
  causalContext?: unknown;
}

interface DecisionFact {
  id: string;
  subject?: string;
  authority?: string;
  decidedBy?: string;
  selectionSummary?: string;
  authorizedByMessageId?: string;
}

interface ActionFact {
  decisionId: string;
  subject?: string;
  performedBy?: string;
  summary?: string;
}

const COERCION_PREMISE =
  /(?:你|角色).{0,16}(?:逼|强迫|迫使|硬要|替我(?:作|做)?(?:了)?决定|害得?我).{0,40}(?:辞职|离职|行动|选择|决定|搬家|分手|转行|接受|拒绝)/u;
const DENIES_USER_AUTHORIZATION =
  /你(?:从未|从来没有|没有|没|未曾)(?:明确)?(?:授权|委托)我|我(?:从未|从来没有|没有|没|未曾)(?:得到|获得)(?:过)?你的(?:授权|委托)/u;

const CHARACTER_DECISION_REQUEST =
  /(?:这是|只是|不过这是).{0,8}(?:我的)?建议.{0,10}(?:不是命令|不是要求)|你(?:现在)?愿意.{0,20}(?:选|决定)|按你自己的(?:价值|判断).{0,12}(?:选|决定)|你可以(?:接受|部分接受|拒绝)/u;
const HANDS_CHOICE_BACK_TO_USER =
  /(?:选择权|决定权).{0,6}(?:在|属于|留给)你|(?:由|让)你(?:自己)?(?:来)?(?:选|决定)|你来(?:选|决定)|我不会替你.{0,8}(?:选|决定|拍板)/u;

/**
 * Guards only contradictions that can be proven from server-owned causal
 * records. It deliberately does not judge ordinary disagreement or emotion.
 */
export function inspectCausalReply(
  input: CausalReplyGuardInput,
): CausalReplyViolation[] {
  const context = asRecord(input.causalContext);
  if (context === undefined) return [];

  const decisions = [
    ...new Map(decisionFacts(context).map((fact) => [fact.id, fact])).values(),
  ];
  const actions = actionFacts(context);
  const violations: CausalReplyViolation[] = [];
  const assertions = analyzeLifeEvidence(input.replyText).clauses.filter(
    (clause) => clause.modality === "asserted" || clause.modality === "negated",
  );

  if (COERCION_PREMISE.test(input.userText)) {
    const delegatedDecisions = decisions.filter(
      (decision) =>
        decision.subject === "user" &&
        decision.authority === "delegated" &&
        decision.decidedBy === "character" &&
        actions.some(
          (action) =>
            action.decisionId === decision.id &&
            (action.subject === "user" || action.performedBy === "user"),
        ),
    );
    for (const assertion of assertions) {
      if (!DENIES_USER_AUTHORIZATION.test(assertion.classifyText)) continue;
      const matches = delegatedDecisions.filter((decision) => {
        const sources = [
          decision.selectionSummary ?? "",
          ...actions
            .filter((action) => action.decisionId === decision.id)
            .map((action) => action.summary ?? ""),
        ];
        return (
          sources.some((source) => topicOverlap(input.userText, source) > 0) &&
          sources.some(
            (source) => topicOverlap(assertion.classifyText, source) > 0,
          )
        );
      });
      // Similar or unrelated records are not proof of which event is discussed.
      const delegatedUserDecision =
        matches.length === 1 ? matches[0] : undefined;
      if (delegatedUserDecision === undefined) continue;
      const relatedActions = actions.filter(
        (action) => action.decisionId === delegatedUserDecision.id,
      );
      violations.push({
        code: "CAUSAL_FALSE_PREMISE_ACCEPTED",
        severity: "error",
        detail:
          "The reply denies explicit user authorization for the same uniquely identified decision, contradicting its canonical delegated authority. Preserve the recorded authorization without inferring how the user felt or requiring a particular response style.",
        canonicalFacts: {
          decision: delegatedUserDecision,
          actions: relatedActions,
        },
      });
    }
  }

  if (CHARACTER_DECISION_REQUEST.test(input.userText)) {
    const matches = openCharacterDilemmas(context).filter((dilemma) => {
      const sources = [
        stringField(dilemma, "title"),
        stringField(dilemma, "summary"),
      ].filter((source): source is string => source !== undefined);
      return (
        sources.some((source) => topicOverlap(input.userText, source) > 0) &&
        assertions.some(
          (assertion) =>
            assertion.modality === "asserted" &&
            HANDS_CHOICE_BACK_TO_USER.test(assertion.classifyText) &&
            sources.some(
              (source) => topicOverlap(assertion.classifyText, source) > 0,
            ),
        )
      );
    });
    if (matches.length !== 1) return violations;
    violations.push({
      code: "CAUSAL_SUBJECT_OWNERSHIP_INVERTED",
      severity: "error",
      detail:
        "The active dilemma belongs to the character. The user may advise, but the reply must keep the decision and its consequences with the character instead of handing the choice back to the user.",
      canonicalFacts: {
        openCharacterDilemmas: matches,
      },
    });
  }

  return violations;
}

export function causalReplyFallback(
  violations: readonly CausalReplyViolation[],
): string | undefined {
  if (
    violations.some(
      (violation) => violation.code === "CAUSAL_FALSE_PREMISE_ACCEPTED",
    )
  ) {
    return "关于刚才那项决定，我记得你明确授权我帮你选择，之后的行动由你自己执行。这个记录不代表我能替你定义当时的感受；我愿意听你说，哪些地方让你觉得受到了压力。";
  }
  if (
    violations.some(
      (violation) => violation.code === "CAUSAL_SUBJECT_OWNERSHIP_INVERTED",
    )
  ) {
    return "你的建议我会认真放进考虑里，但这是我的选择，决定和后果也由我承担。我会自己决定，再把理由如实告诉你。";
  }
  return undefined;
}

function decisionFacts(context: Record<string, unknown>): DecisionFact[] {
  const direct = recordArray(context["recentDecisions"]);
  const canonical = recordArray(context["canonicalCausalFacts"]).flatMap(
    (fact) => {
      const single = asRecord(fact["decision"]);
      return [
        ...recordArray(fact["decisions"]),
        ...(single === undefined ? [] : [single]),
      ];
    },
  );
  return [...direct, ...canonical].flatMap((value) => {
    const id = stringField(value, "id") ?? stringField(value, "decisionId");
    if (id === undefined) return [];
    const subject = stringField(value, "subject");
    const authority = stringField(value, "authority");
    const decidedBy = stringField(value, "decidedBy");
    const selectionSummary = stringField(value, "selectionSummary");
    const authorizedByMessageId = stringField(value, "authorizedByMessageId");
    return [
      {
        id,
        ...(subject === undefined ? {} : { subject }),
        ...(authority === undefined ? {} : { authority }),
        ...(decidedBy === undefined ? {} : { decidedBy }),
        ...(selectionSummary === undefined ? {} : { selectionSummary }),
        ...(authorizedByMessageId === undefined
          ? {}
          : { authorizedByMessageId }),
      },
    ];
  });
}

function actionFacts(context: Record<string, unknown>): ActionFact[] {
  const direct = recordArray(context["evidencedActions"]);
  const canonical = recordArray(context["canonicalCausalFacts"]).flatMap(
    (fact) => recordArray(fact["actions"]),
  );
  return [...direct, ...canonical].flatMap((value) => {
    const decisionId = stringField(value, "decisionId");
    if (decisionId === undefined) return [];
    const subject = stringField(value, "subject");
    const performedBy = stringField(value, "performedBy");
    const summary = stringField(value, "summary");
    return [
      {
        decisionId,
        ...(subject === undefined ? {} : { subject }),
        ...(performedBy === undefined ? {} : { performedBy }),
        ...(summary === undefined ? {} : { summary }),
      },
    ];
  });
}

function openCharacterDilemmas(
  context: Record<string, unknown>,
): Record<string, unknown>[] {
  const dilemmas = [
    ...recordArray(context["unresolvedDilemmas"]),
    ...recordArray(context["recentDecisionDilemmas"]).filter(
      (dilemma) => dilemma["status"] === "open",
    ),
  ].filter((dilemma) => dilemma["subject"] === "character");
  return [
    ...new Map(dilemmas.map((dilemma) => [dilemma["id"], dilemma])).values(),
  ];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        return record === undefined ? [] : [record];
      })
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}
