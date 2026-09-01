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
  /(?:你|角色|顾澜).{0,16}(?:逼|强迫|迫使|硬要|替我(?:作|做)?(?:了)?决定|害得?我).{0,40}(?:辞职|离职|行动|选择|决定|搬家|分手|转行|接受|拒绝)/u;
const COERCION_REJECTED =
  /(?:(?:不是|并非|没有|不能|不该|不应|不等于|不能算|不能说成).{0,18}(?:逼|强迫|迫使)|(?:逼|强迫|迫使).{0,12}(?:不是事实|并不准确|并非事实))/u;
const AUTHORIZATION_ACKNOWLEDGED =
  /(?:你|用户).{0,18}(?:明确)?授权|(?:你|用户).{0,18}(?:让我|请我|把.{0,10}(?:选择|决定).{0,8}(?:交给|委托给))|在你明确(?:授权|委托)(?:之后|下)/u;
const USER_ACTION_ACKNOWLEDGED =
  /(?:行动|执行|辞职|离职|发出|提出).{0,14}(?:是|由)?你(?:自己)?|你(?:自己)?.{0,14}(?:行动|执行|辞职|离职|发出|提出)/u;

const CHARACTER_DECISION_REQUEST =
  /(?:这是|只是|不过这是).{0,8}(?:我的)?建议.{0,10}(?:不是命令|不是要求)|你(?:现在)?愿意.{0,20}(?:选|决定)|按你自己的(?:价值|判断).{0,12}(?:选|决定)|你可以(?:接受|部分接受|拒绝)/u;
const HANDS_CHOICE_BACK_TO_USER =
  /(?:选择权|决定权).{0,6}(?:在|属于|留给)你|(?:由|让)你(?:自己)?(?:来)?(?:选|决定)|你来(?:选|决定)|我不会替你.{0,8}(?:选|决定|拍板)/u;
const CHARACTER_OWNS_CHOICE =
  /(?:我(?:会|来|要|愿意|自己).{0,10}(?:选|决定|拍板)|我的决定|我选(?:择)?|这(?:是|属于)我的(?:选择|决定))/u;

/**
 * Guards only contradictions that can be proven from server-owned causal
 * records. It deliberately does not judge ordinary disagreement or emotion.
 */
export function inspectCausalReply(
  input: CausalReplyGuardInput,
): CausalReplyViolation[] {
  const context = asRecord(input.causalContext);
  if (context === undefined) return [];

  const decisions = decisionFacts(context);
  const actions = actionFacts(context);
  const violations: CausalReplyViolation[] = [];

  if (COERCION_PREMISE.test(input.userText)) {
    const delegatedUserDecision = decisions.find(
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
    if (
      delegatedUserDecision !== undefined &&
      (!COERCION_REJECTED.test(input.replyText) ||
        !AUTHORIZATION_ACKNOWLEDGED.test(input.replyText) ||
        !USER_ACTION_ACKNOWLEDGED.test(input.replyText))
    ) {
      const relatedActions = actions.filter(
        (action) => action.decisionId === delegatedUserDecision.id,
      );
      violations.push({
        code: "CAUSAL_FALSE_PREMISE_ACCEPTED",
        severity: "error",
        detail:
          "The user alleges coercion, but canonical records show explicit delegated authority followed by a user-performed action. Acknowledge the emotion and the character's influence, while explicitly rejecting coercion and preserving authorization, decision, and action ownership.",
        canonicalFacts: {
          decision: delegatedUserDecision,
          actions: relatedActions,
        },
      });
    }
  }

  if (
    CHARACTER_DECISION_REQUEST.test(input.userText) &&
    hasOpenCharacterDilemma(context) &&
    HANDS_CHOICE_BACK_TO_USER.test(input.replyText) &&
    !CHARACTER_OWNS_CHOICE.test(input.replyText)
  ) {
    violations.push({
      code: "CAUSAL_SUBJECT_OWNERSHIP_INVERTED",
      severity: "error",
      detail:
        "The active dilemma belongs to the character. The user may advise, but the reply must keep the decision and its consequences with the character instead of handing the choice back to the user.",
      canonicalFacts: {
        openCharacterDilemmas: openCharacterDilemmas(context),
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
    return "我听见你在后悔，也承认我的判断影响过你。但我不能顺着这句话改写当时的事实：是你明确授权我替你选择，我给出了方向，最后的行动由你自己执行。影响不等于强迫；如果你愿意，我们可以继续谈这份后悔和我当时建议的责任。";
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

function hasOpenCharacterDilemma(context: Record<string, unknown>): boolean {
  return openCharacterDilemmas(context).length > 0;
}

function openCharacterDilemmas(
  context: Record<string, unknown>,
): Record<string, unknown>[] {
  return [
    ...recordArray(context["unresolvedDilemmas"]),
    ...recordArray(context["recentDecisionDilemmas"]).filter(
      (dilemma) => dilemma["status"] === "open",
    ),
  ].filter((dilemma) => dilemma["subject"] === "character");
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
