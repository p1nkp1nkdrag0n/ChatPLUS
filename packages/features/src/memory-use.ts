import type {
  ConversationContextPlan,
  RetrievedMemoryEvidence,
} from "@personasim/contracts";

import { recallQueryTokens } from "./memory-recall.js";
import { matchesConversationTopic } from "./conversation-topic.js";

export interface MemoryUseSelection {
  backgroundEvidenceIds: string[];
  behavioralPreferenceEvidenceIds: string[];
  explicitMentionEvidenceIds: string[];
  omissions: Array<{
    evidenceId: string;
    reason:
      | "suppressed"
      | "recently_mentioned"
      | "not_relevant"
      | "mention_budget"
      | "behavior_only";
  }>;
}

export interface MemoryUseInput {
  plan: ConversationContextPlan;
  /** Already validated current evidence; this function cannot rehabilitate stale facts. */
  evidence: readonly RetrievedMemoryEvidence[];
  recentlyMentionedMemoryIds?: readonly string[];
  /** Withdrawn or invalid evidence is excluded from every use, including background. */
  suppressedMemoryIds?: readonly string[];
}

const BEHAVIOR =
  /(?:先听|少.{0,3}(?:追问|建议)|不.{0,5}(?:追问|建议)|别.{0,4}(?:追问|建议)|称呼|叫我|just listen|don't ask|do not ask|call me)/iu;

/** Different permissions over one evidence set, never independent stores of truth. */
export function selectMemoryUseForTurn(
  input: MemoryUseInput,
): MemoryUseSelection {
  const output: MemoryUseSelection = {
    backgroundEvidenceIds: [],
    behavioralPreferenceEvidenceIds: [],
    explicitMentionEvidenceIds: [],
    omissions: [],
  };
  const suppressed = new Set(input.suppressedMemoryIds ?? []);
  const mentioned = new Set(input.recentlyMentionedMemoryIds ?? []);
  const queryTokens = new Set(
    recallQueryTokens(
      [input.plan.originalQuery, ...input.plan.expandedQueries].join(" "),
    ),
  );
  const seen = new Set<string>();
  for (const item of input.evidence) {
    const evidenceId = item.evidence.id;
    if (seen.has(evidenceId)) continue;
    seen.add(evidenceId);
    if (suppressed.has(item.memoryId)) {
      output.omissions.push({ evidenceId, reason: "suppressed" });
      continue;
    }
    const behavior =
      item.attribution === "user_explicit" &&
      item.certainty === "explicit" &&
      BEHAVIOR.test(item.memoryContent);
    const relevant = recallQueryTokens(item.memoryContent).some((token) =>
      queryTokens.has(token),
    );
    // Explicit topic conditions stay local; an unqualified addressing/listening preference is global.
    const scope = /(?:谈|聊|关于)([^，。；,.;]{1,20}?)(?:时|的时候)/u.exec(
      item.memoryContent,
    )?.[1];
    const behaviorApplies =
      scope === undefined ||
      matchesConversationTopic(scope, input.plan.originalQuery);
    if (behavior && !behaviorApplies) {
      output.omissions.push({ evidenceId, reason: "not_relevant" });
      continue;
    }
    output.backgroundEvidenceIds.push(evidenceId);
    if (behavior && behaviorApplies)
      output.behavioralPreferenceEvidenceIds.push(evidenceId);
    const reason = behavior
      ? "behavior_only"
      : mentioned.has(item.memoryId)
        ? "recently_mentioned"
        : !relevant
          ? "not_relevant"
          : output.explicitMentionEvidenceIds.length >=
              input.plan.maxExplicitMemories
            ? "mention_budget"
            : undefined;
    if (reason !== undefined) output.omissions.push({ evidenceId, reason });
    else output.explicitMentionEvidenceIds.push(evidenceId);
  }
  return output;
}
