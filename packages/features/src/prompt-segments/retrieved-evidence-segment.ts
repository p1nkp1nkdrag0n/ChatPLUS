import {
  EvidenceBundleSchema,
  type EvidenceBundle,
  type RetrievedMemoryEvidence,
} from "@personasim/contracts";

import type { PromptContext, PromptSegment } from "./types.js";

export interface RetrievedEvidencePromptContext extends PromptContext {
  readonly retrievedEvidence?: EvidenceBundle | null;
  readonly retrievedEvidenceUses?: Readonly<Record<string, readonly string[]>>;
}

/** The validated current value is expression data; its correction quote stays
 * in retrieval audit. Keep source identity without retelling a rejected value. */
export function currentFactPromptEvidence(
  item: RetrievedMemoryEvidence,
): RetrievedMemoryEvidence {
  if (item.currentFact === undefined) return item;
  return {
    ...item,
    evidence: {
      id: item.evidence.id,
      memoryId: item.evidence.memoryId,
      sourceType: item.evidence.sourceType,
      sourceId: item.evidence.sourceId,
      recordedAtUtc: item.evidence.recordedAtUtc,
    },
  };
}

export function renderRetrievedEvidenceSegment(
  value: unknown,
  uses?: Readonly<Record<string, readonly string[]>>,
): string | null {
  const parsed = EvidenceBundleSchema.safeParse(value);
  if (!parsed.success) return null;
  const bundle = {
    ...parsed.data,
    evidence: parsed.data.evidence.map(currentFactPromptEvidence),
  };
  return [
    "RETRIEVED_EVIDENCE_JSON",
    JSON.stringify({
      query: bundle.query,
      mode: bundle.mode,
      generatedAtUtc: bundle.generatedAtUtc,
      score: bundle.score,
      ...(bundle.factCoverage === undefined
        ? {}
        : {
            factCoverage: bundle.factCoverage,
            factGuidance:
              "Use covered current values directly, without the old mistake or a correction story. Answer known parts; uncovered means not retrieved this time, never proof the user has never told you. Historical comparisons are separate and need their own retained evidence.",
          }),
      evidence: bundle.evidence.map((item) => ({
        ...(uses === undefined
          ? {}
          : { allowedUses: uses[item.evidence.id] ?? [] }),
        memoryId: item.memoryId,
        memoryContent: item.memoryContent,
        ...(item.currentFact === undefined
          ? {}
          : { currentFact: item.currentFact }),
        memoryKind: item.memoryKind,
        namespace: item.namespace,
        certainty: item.certainty,
        attribution: item.attribution,
        stability: item.stability,
        ...(item.temporalMetadata === undefined
          ? {}
          : { temporalMetadata: item.temporalMetadata }),
        evidence: item.evidence,
        score: item.score,
        scoreBreakdown: item.scoreBreakdown,
      })),
    }),
  ].join("\n");
}

export function createRetrievedEvidencePromptSegment<
  TContext extends RetrievedEvidencePromptContext =
    RetrievedEvidencePromptContext,
>(): PromptSegment<TContext> {
  return {
    id: "13_retrieved_evidence",
    placement: "prompt",
    priority: 90,
    tokenBudget: 4_000,
    required: false,
    cacheable: false,
    render: (context) =>
      renderRetrievedEvidenceSegment(
        context.retrievedEvidence,
        context.retrievedEvidenceUses,
      ),
  };
}
