import type {
  ConversationContextPlan,
  FuzzyLifePromptContext,
} from "@personasim/contracts";

import { deriveCurrentConversationRequests } from "./conversation-requests.js";

const PROGRESS_REQUEST =
  /(?:怎么样|怎样|如何|做完了吗|画完了吗|写完了吗|完成了吗|(?:有|有什么).{0,8}(?:进展|进度|变化|消息).{0,3}(?:吗|没|呢)|(?:说说|讲讲|告诉我).{0,12}(?:进展|进度|近况)|(?:进展|进度|近况).{0,4}[?？]|how (?:is|was|did)|what happened|any (?:news|progress)|(?:is it|have you) finished)/iu;
const OTHER_OWNER =
  /(?:别人|他人|其他人|(?:我|他|她|朋友|同事|妹妹|姐姐|弟弟|哥哥)的|(?:他|她|朋友|同事).{0,5}(?:有|画|写)|\b(?:someone else|their|her|his|my)\b)/iu;
const EXCLUDED_LIFE =
  /(?:(?:先|暂时)?(?:别|不要|不用|不想|不必|不是(?:在|要)?|没(?:有|打算)).{0,6}(?:聊|谈|说|提|问)|(?:don't|do not|no need to|not asking).{0,12}(?:discuss|talk|ask|mention|about))/iu;
const QUOTED_TEXT = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/gu;

// Only a small, unambiguous artifact alias may stand in for an existing title.
// Generic words such as "项目" do not authorize an arbitrary life thread.
const ARTIFACT_ALIASES = [
  /(?:稿子|稿件|文稿|手稿)/u,
  /(?:速写)/u,
  /(?:画册)/u,
  /(?:剪辑)/u,
] as const;

function matchingTitles(query: string, titles: readonly string[]): string[] {
  const matches = new Set<string>();
  const activeQuery = query.replace(QUOTED_TEXT, (quoted) => {
    const content = quoted.slice(1, -1);
    return titles.includes(content) ? content : "";
  });
  for (const clause of activeQuery.split(/(?<=[。！？!?；;\n])/u)) {
    const requests = deriveCurrentConversationRequests(clause);
    const requestedHelp =
      requests.adviceRequested ||
      requests.detailedAnalysisRequested ||
      /(?:还记得|记不记得|回顾|回想|do you remember|look back)/iu.test(clause);
    if (
      OTHER_OWNER.test(clause) ||
      (!PROGRESS_REQUEST.test(clause) && !requestedHelp)
    )
      continue;
    for (const title of titles) {
      if (title.length >= 2 && clause.includes(title)) matches.add(title);
    }
    for (const alias of ARTIFACT_ALIASES) {
      if (!alias.test(clause)) continue;
      const candidates = titles.filter((title) => alias.test(title));
      if (candidates.length === 1) matches.add(candidates[0]!);
    }
  }
  return [...matches].slice(0, 3);
}

function selectRelatedContext(
  context: FuzzyLifePromptContext,
  titles: readonly string[],
  sourceIds: ReadonlySet<string>,
): FuzzyLifePromptContext {
  const named = (text: string | undefined) =>
    text !== undefined && titles.some((title) => text.includes(title));
  const sourced = (ids: readonly string[]) =>
    ids.some((id) => sourceIds.has(id));
  const dilemmaIds = new Set<string>();
  const decisionIds = new Set<string>();
  for (const item of context.unresolvedDilemmas) {
    if (named(item.title) || named(item.summary)) dilemmaIds.add(item.id);
  }
  for (const item of context.recentDecisionDilemmas) {
    if (
      named(item.title) ||
      named(item.summary) ||
      sourced(item.sourceMessageIds)
    )
      dilemmaIds.add(item.id);
  }
  for (const item of context.activePressure) {
    if (named(item.triggerSummary) || sourced(item.sourceMessageIds)) {
      if (item.dilemmaId !== undefined) dilemmaIds.add(item.dilemmaId);
    }
  }
  for (const item of context.evidencedSupport) {
    if (named(item.summary) || sourceIds.has(item.sourceMessageId)) {
      if (item.dilemmaId !== undefined) dilemmaIds.add(item.dilemmaId);
    }
  }
  for (const item of context.recentDecisions) {
    if (named(item.selectionSummary) || sourced(item.sourceMessageIds))
      decisionIds.add(item.id);
  }
  for (const item of [
    ...context.evidencedActions,
    ...context.evidencedConsequences,
  ]) {
    if (named(item.summary) || sourced(item.sourceEvidenceIds))
      decisionIds.add(item.decisionId);
  }
  for (const item of context.reflections) {
    if (
      item.decisionId !== undefined &&
      (named(item.summary) || sourced(item.sourceMessageIds))
    )
      decisionIds.add(item.decisionId);
  }
  for (const fact of context.canonicalCausalFacts) {
    if (
      named(fact.decision.selectionSummary) ||
      sourced(fact.decision.sourceMessageIds) ||
      [...fact.actions, ...fact.outcomes, ...fact.reflections].some((item) =>
        named(item.summary),
      )
    )
      decisionIds.add(fact.decision.decisionId);
  }
  // Close over explicit decision/dilemma links, not shared words or guessed causes.
  const links = [
    ...context.recentDecisions.map((item) => ({
      dilemmaId: item.dilemmaId,
      decisionId: item.id,
    })),
    ...context.canonicalCausalFacts.map((item) => ({
      dilemmaId: item.dilemmaId,
      decisionId: item.decision.decisionId,
    })),
    ...context.recentDecisionDilemmas.flatMap((item) =>
      item.closingDecisionId === undefined
        ? []
        : [{ dilemmaId: item.id, decisionId: item.closingDecisionId }],
    ),
  ];
  let previousSize = -1;
  while (previousSize !== dilemmaIds.size + decisionIds.size) {
    previousSize = dilemmaIds.size + decisionIds.size;
    for (const link of links) {
      if (dilemmaIds.has(link.dilemmaId) || decisionIds.has(link.decisionId)) {
        dilemmaIds.add(link.dilemmaId);
        decisionIds.add(link.decisionId);
      }
    }
  }
  const activePressure = context.activePressure.filter(
    (item) =>
      named(item.triggerSummary) ||
      sourced(item.sourceMessageIds) ||
      (item.dilemmaId !== undefined && dilemmaIds.has(item.dilemmaId)),
  );
  const pressureIds = new Set(activePressure.map((item) => item.id));
  const evidencedSupport = context.evidencedSupport.filter(
    (item) =>
      named(item.summary) ||
      sourceIds.has(item.sourceMessageId) ||
      (item.dilemmaId !== undefined && dilemmaIds.has(item.dilemmaId)) ||
      (item.pressureEpisodeId !== undefined &&
        pressureIds.has(item.pressureEpisodeId)),
  );
  const canonicalCausalFacts = context.canonicalCausalFacts.filter((item) =>
    decisionIds.has(item.decision.decisionId),
  );
  const evidencedConsequences = context.evidencedConsequences.filter((item) =>
    decisionIds.has(item.decisionId),
  );
  const outcomeIds = new Set([
    ...evidencedConsequences.map((item) => item.id),
    ...canonicalCausalFacts.flatMap((item) =>
      item.outcomes.map((outcome) => outcome.outcomeId),
    ),
  ]);
  const reflections = context.reflections.filter(
    (item) =>
      named(item.summary) ||
      sourced(item.sourceMessageIds) ||
      (item.decisionId !== undefined && decisionIds.has(item.decisionId)) ||
      (item.outcomeId !== undefined && outcomeIds.has(item.outcomeId)),
  );
  const supportIds = new Set(evidencedSupport.map((item) => item.id));
  const reflectionIds = new Set(reflections.map((item) => item.id));
  return structuredClone({
    authority: context.authority,
    semantics: context.semantics,
    today: {
      subject: context.today.subject,
      localDate: context.today.localDate,
      currentPeriod: context.today.currentPeriod,
      availability: context.today.availability,
      ...(named(context.today.currentFocus)
        ? { currentFocus: context.today.currentFocus }
        : {}),
      intentions: context.today.intentions.filter((item) => named(item.title)),
    },
    ongoingThreads: context.ongoingThreads.filter((item) =>
      titles.includes(item.title),
    ),
    verifiedRecentOutcomes: context.verifiedRecentOutcomes.filter((item) =>
      named(item.summary),
    ),
    unresolvedDilemmas: context.unresolvedDilemmas.filter((item) =>
      dilemmaIds.has(item.id),
    ),
    recentDecisionDilemmas: context.recentDecisionDilemmas.filter((item) =>
      dilemmaIds.has(item.id),
    ),
    activePressure,
    relationshipMilestones: context.relationshipMilestones.filter(
      (item) =>
        named(item.summary) ||
        item.decisionIds.some((id) => decisionIds.has(id)) ||
        item.outcomeIds.some((id) => outcomeIds.has(id)) ||
        item.interventionIds.some((id) => supportIds.has(id)) ||
        item.reflectionIds.some((id) => reflectionIds.has(id)),
    ),
    evidencedSupport,
    recentDecisions: context.recentDecisions.filter((item) =>
      decisionIds.has(item.id),
    ),
    canonicalCausalFacts,
    evidencedActions: context.evidencedActions.filter((item) =>
      decisionIds.has(item.decisionId),
    ),
    evidencedConsequences,
    reflections,
  });
}

/** Selects expression context only. Callers retain the full snapshot for validation. */
export function selectLifeContextForTurn(input: {
  context: FuzzyLifePromptContext;
  plan: ConversationContextPlan;
}): { context?: FuzzyLifePromptContext; omittedSections: string[] } {
  const { context, plan } = input;
  const keys = Object.keys(context) as Array<keyof FuzzyLifePromptContext>;
  const omitted = () => ({
    omittedSections: keys.filter(
      (key) => key !== "authority" && key !== "semantics",
    ),
  });
  const availableTitles = [
    ...new Set(
      [
        ...context.ongoingThreads,
        ...context.unresolvedDilemmas,
        ...context.recentDecisionDilemmas,
      ].map((item) => item.title),
    ),
  ];
  const activeQuery = plan.originalQuery.replace(QUOTED_TEXT, (quoted) =>
    availableTitles.includes(quoted.slice(1, -1)) ? quoted.slice(1, -1) : "",
  );
  if (
    activeQuery
      .split(/[，,。！？!?；;\n]/u)
      .some(
        (clause) =>
          EXCLUDED_LIFE.test(clause) &&
          (availableTitles.some((title) => clause.includes(title)) ||
            /(?:你的|你(?:最近|今天)|项目|近况|生活|your (?:project|life|day))/iu.test(
              clause,
            )),
      )
  )
    return omitted();
  const titles = matchingTitles(plan.originalQuery, availableTitles);
  // Retrieval expansions are candidate discovery, never permission to mention a life topic.
  const sourceIds = new Set(
    plan.resolvedCurrentTopic?.basis === "recent_user_continuity"
      ? plan.resolvedCurrentTopic.sourceMessageIds
      : [],
  );
  if (titles.length > 0 || sourceIds.size > 0) {
    const selected = selectRelatedContext(context, titles, sourceIds);
    const hasSelectedEvidence = keys.some(
      (key) => Array.isArray(selected[key]) && selected[key].length > 0,
    );
    if (!hasSelectedEvidence) return omitted();
    return {
      context: selected,
      omittedSections: keys.filter(
        (key) => JSON.stringify(context[key]) !== JSON.stringify(selected[key]),
      ),
    };
  }
  if (plan.allowCharacterLifeMention && !OTHER_OWNER.test(plan.originalQuery))
    return { context: structuredClone(context), omittedSections: [] };
  return omitted();
}
