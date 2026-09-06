import type {
  ConversationContextPlan,
  FuzzyLifePromptContext,
} from "@personasim/contracts";

/** Selects expression context only. Callers retain the full snapshot for validation. */
export function selectLifeContextForTurn(input: {
  context: FuzzyLifePromptContext;
  plan: ConversationContextPlan;
}): { context?: FuzzyLifePromptContext; omittedSections: string[] } {
  const { context, plan } = input;
  const sourceIds = new Set(plan.contextMessageIds);
  const relevantSource = [
    ...context.recentDecisions,
    ...context.recentDecisionDilemmas,
    ...context.activePressure,
    ...context.reflections,
  ].some((item) => item.sourceMessageIds.some((id) => sourceIds.has(id)));
  const query = [plan.originalQuery, ...plan.expandedQueries].join("\n");
  const relevantTitle = [
    ...context.unresolvedDilemmas,
    ...context.recentDecisionDilemmas,
    ...context.ongoingThreads,
  ].some((item) => item.title.length >= 2 && query.includes(item.title));
  const continuingCausalTopic =
    (relevantSource || relevantTitle) &&
    (plan.intent === "help" ||
      plan.intent === "recollection" ||
      plan.intent === "relationship_repair" ||
      plan.contextMessageIds.length > 0);
  if (plan.allowCharacterLifeMention || continuingCausalTopic) {
    // The service has already bounded this snapshot. Preserve the whole causal
    // chain when selected instead of detaching outcomes from actions/decisions.
    return { context: structuredClone(context), omittedSections: [] };
  }
  return {
    omittedSections: Object.keys(context).filter(
      (key) => key !== "authority" && key !== "semantics",
    ),
  };
}
