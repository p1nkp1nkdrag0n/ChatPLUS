import { createHash } from "node:crypto";
import type {
  ConversationContextPlan,
  InteractionEvidenceSnapshot,
} from "@personasim/contracts";
import {
  deriveAdvicePolicy,
  inspectAdviceLoad,
  inspectInteractionAttribution,
} from "@personasim/features";
import type { AgentTurnDecision } from "../domain/schemas.js";
import { projectReplySentences } from "./reply-text-projection.js";

/** A single mutable allowance owned by one chat orchestration, never persisted. */
export interface ReplyRepairBudget {
  remaining: number;
  attempts: number;
}

export interface SemanticReplyContext {
  conversationPlan?: ConversationContextPlan;
  interactionEvidence?: InteractionEvidenceSnapshot;
  repairBudget?: ReplyRepairBudget;
}

export function sharedSemanticContext(input: SemanticReplyContext) {
  return {
    ...(input.interactionEvidence === undefined
      ? {}
      : { interactionEvidence: input.interactionEvidence }),
    ...(input.repairBudget === undefined
      ? {}
      : { repairBudget: input.repairBudget }),
  };
}

export function inspectSemanticReply(
  input: SemanticReplyContext & {
    decision: AgentTurnDecision;
  },
) {
  const enabled =
    input.interactionEvidence !== undefined ||
    input.conversationPlan !== undefined;
  const interaction =
    input.interactionEvidence === undefined
      ? undefined
      : inspectInteractionAttribution({
          text: input.decision.reply.text,
          chunks: input.decision.reply.chunks,
          evidence: input.interactionEvidence,
        });
  const advice =
    input.conversationPlan === undefined
      ? undefined
      : inspectAdviceLoad({
          text: input.decision.reply.text,
          policy: deriveAdvicePolicy(input.conversationPlan),
        });
  const chunkAdvice =
    input.conversationPlan === undefined
      ? []
      : input.decision.reply.chunks.flatMap((text, chunkIndex) =>
          inspectAdviceLoad({
            text,
            policy: deriveAdvicePolicy(input.conversationPlan!),
          }).issues.map((issue) => ({
            ...issue,
            surface: "chunk",
            chunkIndex,
          })),
        );
  const visible = input.decision.reply.chunks.join("\n");
  const combinedAdvice =
    input.conversationPlan === undefined
      ? []
      : inspectAdviceLoad({
          text: visible,
          policy: deriveAdvicePolicy(input.conversationPlan),
        }).issues.map((issue) => ({ ...issue, surface: "chunks" as const }));
  const coherence =
    !enabled ||
    visible.replace(/\s/gu, "") ===
      input.decision.reply.text.replace(/\s/gu, "")
      ? []
      : [
          {
            code: "REPLY_SURFACES_DIVERGED",
            text: visible,
            start: 0,
            end: visible.length,
            surface: "chunks" as const,
          },
        ];
  return {
    interaction,
    advice,
    issues: [
      ...(interaction?.violations ?? []),
      ...(advice?.issues ?? []),
      ...chunkAdvice,
      ...combinedAdvice,
      ...coherence,
    ],
  };
}

export function replyTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Remove offending complete sentences, not pronouns. The original stays in the
 * provider audit. This is only the deterministic fallback after bounded repair. */
export function conservativeSemanticReply(
  input: SemanticReplyContext & {
    decision: AgentTurnDecision;
  },
): AgentTurnDecision {
  const issues = inspectSemanticReply(input).issues;
  const retained = projectReplySentences(
    input.decision.reply.text,
    issues.filter((issue) => !("surface" in issue) || issue.surface === "text"),
  ).text;
  const text = retained || "我刚才这段没有表达准确。";
  const candidate = {
    ...input.decision,
    reply: { ...input.decision.reply, text, chunks: [text] },
    reasonCode: "semantic_reply_guard_fallback",
    reasonSummary:
      "Removed unsupported interaction claims or unrequested action instructions after the bounded repair allowance.",
  };
  if (
    inspectSemanticReply({ ...input, decision: candidate }).issues.length === 0
  )
    return candidate;
  return {
    ...candidate,
    reply: {
      ...candidate.reply,
      text: "我刚才这段没有表达准确。",
      chunks: ["我刚才这段没有表达准确。"],
    },
  };
}

export interface SemanticReplyAudit {
  policyVersion: "conversation_semantic_boundaries_v1";
  originalTextSha256: string;
  finalTextSha256: string;
  initialIssues: unknown[];
  finalIssues: unknown[];
  sourceMessageIds: string[];
  repairCalls: number;
  finalAdvice?: ReturnType<typeof inspectAdviceLoad>;
}

export function semanticReplyAudit(
  input: SemanticReplyContext & {
    originalText: string;
    finalDecision: AgentTurnDecision;
    initialIssues: unknown[];
  },
): SemanticReplyAudit {
  const final = inspectSemanticReply({
    ...input,
    decision: input.finalDecision,
  });
  return {
    policyVersion: "conversation_semantic_boundaries_v1",
    originalTextSha256: replyTextHash(input.originalText),
    finalTextSha256: replyTextHash(input.finalDecision.reply.text),
    initialIssues: input.initialIssues,
    finalIssues: final.issues,
    sourceMessageIds: [
      ...new Set(
        input.interactionEvidence?.historicalAnchors.flatMap(
          (anchor) => anchor.sourceMessageIds,
        ) ?? [],
      ),
    ],
    repairCalls: input.repairBudget?.attempts ?? 0,
    ...(final.advice === undefined ? {} : { finalAdvice: final.advice }),
  };
}
