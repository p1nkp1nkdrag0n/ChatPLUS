import type {
  ActionRecord,
  DecisionRecord,
  DilemmaEpisode,
  Message,
  OutcomeRecord,
} from "@personasim/contracts";

import {
  analyzeLifeEvidence,
  type LifeEvidenceAnalysis,
  type LifeEvidenceClause,
} from "./fuzzy-life-evidence.js";
import { matchDilemmaOption, topicOverlap } from "./fuzzy-life-choice.js";
import {
  hasStructuredLifeEvidence,
  type StructuredLifeEvidenceSources,
} from "./fuzzy-life-structured-evidence.js";

export type LifeAssociationStage = "action" | "outcome" | "reflection";

export interface LifeAssociationCandidate {
  decision: DecisionRecord;
  dilemma?: DilemmaEpisode | undefined;
  actions: readonly ActionRecord[];
  outcomes: readonly OutcomeRecord[];
}

export interface LifeAssociationInput {
  stage: LifeAssociationStage;
  clause: LifeEvidenceClause;
  candidates: readonly LifeAssociationCandidate[];
  sessionId: string;
  atUtc: string;
  /** The service may translate an assistant's first person into character. */
  subject?: "user" | "character";
  recentMessages?: readonly (Pick<
    Message,
    "id" | "agentId" | "sessionId" | "createdAtUtc" | "text"
  > & { role: Message["role"] | "system" })[];
  structuredSources?: StructuredLifeEvidenceSources;
}

export interface LifeEvidenceAssociation {
  decision: DecisionRecord;
  dilemma?: DilemmaEpisode;
  actionIds: string[];
  outcomeId?: string;
}

const RECENT_EVIDENCE_MS = 6 * 60 * 60 * 1_000;
const DECISION_DECLARATION_SOURCE =
  "(?:我的(?:最终)?决定|我(?:现在|已经|最终|最后|明确)?(?:决定了?|选择了?|选))";
const DECISION_DECLARATION = new RegExp(DECISION_DECLARATION_SOURCE, "u");
const DECISION_HEADING = new RegExp(
  `^${DECISION_DECLARATION_SOURCE}(?:是)?$`,
  "u",
);
const EXPLICIT_RESULT_FRAME =
  /^(?:几天后(?:的)?|这几天(?:的)?|后来(?:的)?)?(?:结果|后果)(?:已经)?(?:是|出现)/u;
const TOPIC_FILLER =
  /(?:回头看|回过头看|几天后|这几天|实际上|我的|你的|我们|你们|他们|她们|自己|今天|昨天|昨晚|刚刚|刚才|后来|现在|已经|仍然|这次|这个|那个|上述|决定|选择|方向|结果|后果|反馈|行动|执行|落实|提交|申请|接受|拒绝|完成|开始|获得|收到|同意|成功|失败|导致|带来|产生|为了|按照|照着|确实|终于|还是|一封|一些|一份|一个|一段|一种|明显|感觉|理解|认为|认同|庆幸|感受|不是|应该|需要|时候|事情|公司|对方|机构|学校|工作|项目|合同|平台|普通|日常|杂事|时间|分钟|小时|压力|轻松|难受|后悔|缓解|增加|减少|稳定|好多|很多|多了|少了|了|的|我|你|他|她|是|和|但|把|在|就|也|又|而|更|仍)/gu;

/** Common stage verbs and boilerplate do not establish the matter involved. */
function topicParts(text: string): string[] {
  return (
    analyzeLifeEvidence(text)
      .classifyText.toLowerCase()
      .replace(TOPIC_FILLER, " ")
      .match(/[\p{L}\p{N}]{2,}/gu) ?? []
  );
}

function topicRelevance(left: string, right: string): number {
  const leftParts = topicParts(left);
  const rightParts = topicParts(right);
  let longest = 0;
  for (const part of leftParts) {
    for (
      let length = Math.min(part.length, 32);
      length > longest;
      length -= 1
    ) {
      if (length < 2) break;
      for (let start = 0; start + length <= part.length; start += 1) {
        const anchor = part.slice(start, start + length);
        if (/^[\p{N}零〇一二两三四五六七八九十百千万]+$/u.test(anchor))
          continue;
        if (rightParts.some((other) => other.includes(anchor))) {
          longest = length;
          break;
        }
      }
    }
  }
  return longest;
}

function selectedSources(candidate: LifeAssociationCandidate): string[] {
  const option = candidate.dilemma?.options.find(
    (item) => item.id === candidate.decision.selectedOptionId,
  );
  return [
    candidate.decision.selectionSummary,
    ...(option === undefined ? [] : [option.label, option.description]),
  ];
}

function relevanceTo(text: string, sources: readonly string[]): number {
  return Math.max(0, ...sources.map((source) => topicRelevance(text, source)));
}

function matchesSelectedOption(
  candidate: LifeAssociationCandidate,
  text: string,
): boolean {
  return (
    candidate.dilemma !== undefined &&
    matchDilemmaOption(candidate.dilemma, text)?.id ===
      candidate.decision.selectedOptionId &&
    selectedSources(candidate).some(
      (source) =>
        topicOverlap(topicParts(text).join(" "), topicParts(source).join(" ")) >
        0,
    )
  );
}

function validStageClause(
  clause: LifeEvidenceClause,
  stage: LifeAssociationStage,
): boolean {
  return (
    clause.modality === "asserted" &&
    clause.subject !== "third_party" &&
    clause[stage]
  );
}

function stageFrame(text: string, stage: LifeAssociationStage): boolean {
  if (stage === "action")
    return /^(?:去(?:办|办理|参加|提交|联系)|为(?:了)?).+/u.test(text);
  return stage === "outcome"
    ? /(?:结果|后果|反馈)(?:是|为)?\s*$/u.test(text)
    : /^(?:回头看|回看)$|(?:理解|看法)(?:是|为)\s*$|(?:回头看|回看|关于).{0,48}(?:决定|选择|结果|行动)\s*$/u.test(
        text,
      );
}

function outcomeElaboration(text: string): boolean {
  return /^(?:但|不过|只是)(?:是)?(?:收入|薪资|薪水|作息|睡眠|精力|压力|心情|能留给|创作时间|个人创作)|^(?:我|我们)(?:重新|又|开始)感到|^这是(?:混合|正面|负面)?结果$/u.test(
    text,
  );
}

/** Keep a stage heading with its asserted details, never with another event. */
export function collectLifeAssociationEvidence(
  analysis: LifeEvidenceAnalysis,
  stage: LifeAssociationStage,
): LifeEvidenceClause[] {
  let cursor = 0;
  const positioned = analysis.clauses.map((clause) => {
    const start = analysis.sourceText.indexOf(clause.sourceText, cursor);
    const end = start < 0 ? -1 : start + clause.sourceText.length;
    if (end >= 0) cursor = end;
    return { clause, start, end };
  });
  const sameSentence = (left: number, right: number): boolean => {
    const before = positioned[left];
    const after = positioned[right];
    return (
      before !== undefined &&
      after !== undefined &&
      before.end >= 0 &&
      after.start >= before.end &&
      !/[。！？!?\n；;]/u.test(
        analysis.sourceText.slice(before.end, after.start),
      )
    );
  };
  const attachedOutcome = (left: number, right: number): boolean => {
    const before = positioned[left];
    const after = positioned[right];
    if (
      before === undefined ||
      after === undefined ||
      before.end < 0 ||
      after.start < before.end ||
      !outcomeElaboration(after.clause.classifyText)
    )
      return false;
    const separator = analysis.sourceText.slice(before.end, after.start);
    return (
      /^[\s；;]+$/u.test(separator) ||
      (/^[\s。.!]+$/u.test(separator) &&
        /^这是(?:混合|正面|负面)?结果$/u.test(after.clause.classifyText))
    );
  };
  const result: LifeEvidenceClause[] = [];
  for (let index = 0; index < positioned.length; index += 1) {
    const current = positioned[index]!.clause;
    if (!validStageClause(current, stage)) continue;
    let firstIndex = index;
    let classificationFirstIndex = index;
    const pieces = [current];
    const previous = positioned[index - 1]?.clause;
    if (
      previous !== undefined &&
      sameSentence(index - 1, index) &&
      previous.modality === "asserted" &&
      previous.subject !== "third_party" &&
      !previous.action &&
      !previous.outcome &&
      !previous.reflection &&
      stageFrame(previous.classifyText, stage)
    ) {
      pieces.unshift(previous);
      firstIndex -= 1;
      classificationFirstIndex = firstIndex;
    }
    if (stage === "action") {
      // A coordinated step retains the source that supplies its tense, while
      // its own classified topic stays separate from the preceding action.
      // This keeps a walk and an application as two independently bound acts.
      while (
        firstIndex > 0 &&
        sameSentence(firstIndex - 1, firstIndex) &&
        validStageClause(positioned[firstIndex - 1]!.clause, "action") &&
        positioned[firstIndex - 1]!.clause.subject === current.subject &&
        /^(?:并且|并|也|还)(?!没|不|未)/u.test(
          positioned[firstIndex]!.clause.classifyText,
        )
      ) {
        firstIndex -= 1;
      }
    } else {
      while (
        sameSentence(index, index + 1) ||
        (stage === "outcome" &&
          EXPLICIT_RESULT_FRAME.test(pieces[0]!.classifyText) &&
          attachedOutcome(index, index + 1))
      ) {
        const next = positioned[index + 1]!.clause;
        const elaboration =
          (stage === "outcome" && outcomeElaboration(next.classifyText)) ||
          (stage === "reflection" && /^因为/u.test(next.classifyText));
        if (
          (!stageFrame(pieces[0]!.classifyText, stage) && !elaboration) ||
          next.modality !== "asserted" ||
          next.subject === "third_party" ||
          next.action ||
          (stage !== "outcome" && next.outcome) ||
          (stage !== "reflection" && next.reflection) ||
          (next[stage] &&
            topicParts(next.classifyText).length > 0 &&
            !elaboration)
        )
          break;
        pieces.push(next);
        index += 1;
      }
    }
    const subjects = new Set(
      pieces
        .map((piece) => piece.subject)
        .filter((value) => value !== "unspecified"),
    );
    if (subjects.size > 1) continue;
    const valences = new Set(pieces.map((piece) => piece.valence));
    const valence =
      valences.has("mixed") ||
      (valences.has("positive") && valences.has("negative"))
        ? "mixed"
        : valences.has("negative")
          ? "negative"
          : valences.has("positive")
            ? "positive"
            : "neutral";
    const start = positioned[firstIndex]!.start;
    const classificationStart = positioned[classificationFirstIndex]!.start;
    const end = positioned[index]!.end;
    result.push({
      ...current,
      // Preserve the actual clause boundary so a persisted summary can be
      // analyzed again without separating its purpose or result heading.
      sourceText:
        start >= 0 && end >= start
          ? analysis.sourceText.slice(start, end)
          : current.sourceText,
      classifyText:
        classificationStart >= 0 && end >= classificationStart
          ? analysis.classifyText.slice(classificationStart, end)
          : current.classifyText,
      subject:
        pieces.find((piece) => piece.subject !== "unspecified")?.subject ??
        current.subject,
      valence,
    });
  }
  return result;
}

function recordedByNow(recordedAtUtc: string, atUtc: string): boolean {
  const elapsed = Date.parse(atUtc) - Date.parse(recordedAtUtc);
  return Number.isFinite(elapsed) && elapsed >= 0;
}

function branchStageText(
  candidate: LifeAssociationCandidate,
  text: string,
  stage: "action" | "outcome",
  assistantFirstPerson = false,
): string {
  return collectLifeAssociationEvidence(analyzeLifeEvidence(text), stage)
    .filter(
      (clause) =>
        (clause.subject === "unspecified" ||
          candidate.decision.subject === "shared" ||
          clause.subject === candidate.decision.subject ||
          (assistantFirstPerson &&
            clause.subject === "user" &&
            candidate.decision.subject === "character")) &&
        (relevanceTo(clause.classifyText, selectedSources(candidate)) > 0 ||
          (stage === "action" &&
            matchesSelectedOption(candidate, clause.classifyText))),
    )
    .map((clause) => clause.classifyText)
    .join("；");
}

type GroundedAction = ActionRecord & { structuredEvidence: boolean };
type GroundedOutcome = OutcomeRecord & { structuredEvidence: boolean };

function actionTexts(action: GroundedAction): string[] {
  // groundedActions already projected only the matching asserted clauses;
  // re-parsing that projection would discard inherited tense and subjects.
  return [action.summary];
}

function outcomeTexts(outcome: GroundedOutcome): string[] {
  return [outcome.summary];
}

function groundedActions(
  candidate: LifeAssociationCandidate,
  input: LifeAssociationInput,
): GroundedAction[] {
  return candidate.actions.flatMap<GroundedAction>((action) => {
    if (!(
      action.agentId === candidate.decision.agentId &&
      action.decisionId === candidate.decision.id &&
      action.subject === candidate.decision.subject &&
      action.sourceEvidenceIds.length > 0 &&
      recordedByNow(action.recordedAtUtc, input.atUtc)
    ))
      return [];
    if (hasStructuredLifeEvidence(action, input.structuredSources, input.atUtc))
      return [{ ...action, structuredEvidence: true }];
    const summary = branchStageText(
      candidate,
      action.summary,
      "action",
      action.performedBy === "character",
    );
    // This is a temporary evidence projection. Persisted records stay intact.
    return summary === ""
      ? []
      : [{ ...action, summary, structuredEvidence: false }];
  });
}

function groundedOutcomes(
  candidate: LifeAssociationCandidate,
  input: LifeAssociationInput,
): GroundedOutcome[] {
  return candidate.outcomes.flatMap<GroundedOutcome>((outcome) => {
    if (!(
      outcome.agentId === candidate.decision.agentId &&
      outcome.decisionId === candidate.decision.id &&
      outcome.status !== "superseded" &&
      outcome.sourceEvidenceIds.length > 0 &&
      recordedByNow(outcome.recordedAtUtc, input.atUtc)
    ))
      return [];
    if (
      hasStructuredLifeEvidence(outcome, input.structuredSources, input.atUtc)
    )
      return [{ ...outcome, structuredEvidence: true }];
    const assistantFirstPerson = (input.recentMessages ?? []).some(
      (message) =>
        outcome.sourceEvidenceIds.includes(message.id) &&
        message.agentId === outcome.agentId &&
        message.sessionId === outcome.sessionId &&
        message.role === "assistant" &&
        recordedByNow(message.createdAtUtc, outcome.recordedAtUtc),
    );
    const summary = branchStageText(
      candidate,
      outcome.summary,
      "outcome",
      assistantFirstPerson,
    );
    return summary === ""
      ? []
      : [{ ...outcome, summary, structuredEvidence: false }];
  });
}

function pureStageReference(text: string): boolean {
  if (bareExternalResponse(text)) return true;
  if (
    !/(?:这个|这次|上述|那个|刚才的|刚刚的)(?:决定|选择|行动|结果|做法)/u.test(
      text,
    )
  )
    return false;
  return topicParts(text)
    .map((part) =>
      part.replace(
        /(?:回头看|回看|承受|做法|去做|做完|照办|按照|照着|执行|落实|带来|产生|造成|得到|怎么样)/gu,
        "",
      ),
    )
    .every((part) => part.length < 2);
}

function bareExternalResponse(text: string): boolean {
  return /^(?:后来|刚才|现在)?(?:公司|对方)(?:已经|终于|最终)?(?:同意|拒绝|通过|确认|回复)了?$/u.test(
    text.trim(),
  );
}

function actualDecisionSource(
  candidate: LifeAssociationCandidate,
  text: string,
): boolean {
  if (candidate.dilemma === undefined) return false;
  const analysis = analyzeLifeEvidence(text);
  return analysis.clauses.some((clause, index) => {
    if (clause.modality !== "asserted" || clause.subject !== "user")
      return false;
    let selectedText = clause.classifyText;
    const next = analysis.clauses[index + 1];
    if (
      DECISION_HEADING.test(selectedText) &&
      next?.modality === "asserted" &&
      next.subject === "user"
    ) {
      const currentStart = analysis.sourceText.indexOf(clause.sourceText);
      const nextStart = analysis.sourceText.indexOf(
        next.sourceText,
        currentStart + clause.sourceText.length,
      );
      if (
        currentStart >= 0 &&
        nextStart >= 0 &&
        !/[。！？!?\n；;]/u.test(
          analysis.sourceText.slice(
            currentStart + clause.sourceText.length,
            nextStart,
          ),
        )
      )
        selectedText += `：${next.classifyText}`;
    }
    return (
      DECISION_DECLARATION.test(selectedText) &&
      matchDilemmaOption(candidate.dilemma!, selectedText)?.id ===
        candidate.decision.selectedOptionId
    );
  });
}

function hasRecentSource(
  input: LifeAssociationInput,
  candidate: LifeAssociationCandidate,
  record:
    | Pick<DecisionRecord, "sessionId" | "recordedAtUtc">
    | Pick<ActionRecord, "sessionId" | "recordedAtUtc">,
  sourceIds: readonly string[],
  summary: string,
  sourceStage: "decision" | "action" | "outcome",
  requireRecent = true,
): boolean {
  const elapsed = Date.parse(input.atUtc) - Date.parse(record.recordedAtUtc);
  if (
    record.sessionId !== input.sessionId ||
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    (requireRecent && elapsed > RECENT_EVIDENCE_MS)
  )
    return false;
  const messages = [...(input.recentMessages ?? [])]
    .filter(
      (message) =>
        message.agentId === candidate.decision.agentId &&
        message.sessionId === input.sessionId &&
        recordedByNow(message.createdAtUtc, input.atUtc),
    )
    .sort(
      (left, right) =>
        Date.parse(right.createdAtUtc) - Date.parse(left.createdAtUtc),
    )
    .slice(0, 8);
  return messages.some(
    (message) =>
      message.role !== "system" &&
      sourceIds.includes(message.id) &&
      (!requireRecent ||
        Date.parse(input.atUtc) - Date.parse(message.createdAtUtc) <=
          RECENT_EVIDENCE_MS) &&
      recordedByNow(message.createdAtUtc, record.recordedAtUtc) &&
      (sourceStage === "decision"
        ? candidate.dilemma !== undefined &&
          (candidate.decision.decidedBy === "character"
            ? message.role === "assistant"
            : message.role === "user") &&
          actualDecisionSource(candidate, message.text)
        : topicRelevance(message.text, summary) > 0 &&
          relevanceTo(message.text, selectedSources(candidate)) > 0 &&
          collectLifeAssociationEvidence(
            analyzeLifeEvidence(message.text),
            sourceStage,
          ).some(
            (clause) =>
              topicRelevance(clause.classifyText, summary) > 0 &&
              (relevanceTo(clause.classifyText, selectedSources(candidate)) >
                0 ||
                (sourceStage === "action" &&
                  matchesSelectedOption(candidate, clause.classifyText))) &&
              (clause.subject === "unspecified" ||
                candidate.decision.subject === "shared" ||
                (message.role === "user"
                  ? clause.subject
                  : clause.subject === "user"
                    ? "character"
                    : "user") === candidate.decision.subject),
          )),
  );
}

/** A unique matter match is required before any contextual continuation. */
export function selectLifeEvidenceAssociation(
  input: LifeAssociationInput,
): LifeEvidenceAssociation | undefined {
  if (!validStageClause(input.clause, input.stage)) return undefined;
  const subject = input.subject ?? input.clause.subject;
  const text = input.clause.classifyText;
  const candidates = input.candidates.filter(
    ({ decision }) =>
      decision.status === "current" &&
      decision.sourceMessageIds.length > 0 &&
      recordedByNow(decision.recordedAtUtc, input.atUtc) &&
      (subject === "unspecified" ||
        decision.subject === subject ||
        decision.subject === "shared"),
  );
  const evaluated = candidates.map((candidate) => {
    const actions = groundedActions(candidate, input);
    const outcomes = groundedOutcomes(candidate, input);
    const sources = [
      ...selectedSources(candidate),
      ...(input.stage === "action" ? [] : actions.flatMap(actionTexts)),
      ...(input.stage === "reflection" ? outcomes.flatMap(outcomeTexts) : []),
    ];
    return {
      candidate,
      actions,
      outcomes,
      relevance: Math.max(
        relevanceTo(text, sources),
        // Reuse the existing option aliases only for an actual action by
        // this decision's subject. Equal candidate matches still abstain.
        input.stage === "action" &&
          subject === candidate.decision.subject &&
          matchesSelectedOption(candidate, text)
          ? 1
          : 0,
      ),
    };
  });
  const topical = evaluated
    .filter((item) => item.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance);
  let selected = topical[0];
  if (selected !== undefined && topical[1]?.relevance === selected.relevance)
    return undefined;
  if (selected === undefined) {
    if (!pureStageReference(text)) return undefined;
    const recent = evaluated.filter(({ candidate, actions, outcomes }) => {
      if (input.stage === "outcome")
        return actions.some(
          (action) =>
            (!bareExternalResponse(text) ||
              /(?:提交|提出|发送|发出).{0,24}(?:申请|请求|邮件)|辞职|入职|签约|报名/u.test(
                action.summary,
              )) &&
            hasRecentSource(
              input,
              candidate,
              action,
              action.sourceEvidenceIds,
              action.summary,
              "action",
            ),
        );
      if (input.stage === "reflection" && /结果|后果/u.test(text))
        return outcomes.some((outcome) =>
          hasRecentSource(
            input,
            candidate,
            outcome,
            outcome.sourceEvidenceIds,
            outcome.summary,
            "outcome",
          ),
        );
      return hasRecentSource(
        input,
        candidate,
        candidate.decision,
        candidate.decision.sourceMessageIds,
        candidate.decision.selectionSummary,
        "decision",
      );
    });
    if (recent.length !== 1) return undefined;
    selected = recent[0]!;
  }
  const { candidate, actions, outcomes } = selected;
  // An explicit result for an already identified matter can follow its
  // source-backed action days later. Generic references still require the
  // short conversational window, and ambiguous predecessors still abstain.
  const topicalResultFrame =
    input.stage === "outcome" &&
    selected.relevance > 0 &&
    EXPLICIT_RESULT_FRAME.test(text);
  const matchingActions = actions
    .map((action) => ({
      action,
      relevance: relevanceTo(text, actionTexts(action)),
    }))
    .filter(
      ({ action, relevance }) =>
        relevance > 0 ||
        ((pureStageReference(text) || topicalResultFrame) &&
          ((topicalResultFrame && action.structuredEvidence) ||
            hasRecentSource(
              input,
              candidate,
              action,
              action.sourceEvidenceIds,
              action.summary,
              "action",
              !topicalResultFrame,
            ))),
    )
    .sort((left, right) => right.relevance - left.relevance);
  const strongestAction = matchingActions[0];
  const uniqueAction =
    strongestAction !== undefined &&
    (matchingActions[1] === undefined ||
      matchingActions[1].relevance < strongestAction.relevance)
      ? strongestAction.action
      : undefined;
  const matchingOutcomes = outcomes
    .map((outcome) => ({
      outcome,
      relevance: relevanceTo(
        text,
        outcomeTexts(outcome).filter(
          (actual) =>
            outcome.structuredEvidence ||
            relevanceTo(actual, selectedSources(candidate)) > 0,
        ),
      ),
    }))
    .filter(
      ({ outcome, relevance }) =>
        relevance > 0 ||
        (pureStageReference(text) &&
          hasRecentSource(
            input,
            candidate,
            outcome,
            outcome.sourceEvidenceIds,
            outcome.summary,
            "outcome",
          )),
    )
    .sort((left, right) => right.relevance - left.relevance);
  const outcome = matchingOutcomes[0];
  const uniqueOutcome =
    outcome !== undefined &&
    (matchingOutcomes[1] === undefined ||
      matchingOutcomes[1].relevance < outcome.relevance)
      ? outcome.outcome
      : undefined;
  return {
    decision: candidate.decision,
    ...(candidate.dilemma === undefined ? {} : { dilemma: candidate.dilemma }),
    actionIds: uniqueAction === undefined ? [] : [uniqueAction.id],
    ...(input.stage !== "reflection" || uniqueOutcome === undefined
      ? {}
      : { outcomeId: uniqueOutcome.id }),
  };
}
