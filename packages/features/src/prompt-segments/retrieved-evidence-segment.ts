import {
  EvidenceBundleSchema,
  type EvidenceBundle,
} from "@personasim/contracts";

import type { PromptContext, PromptSegment } from "./types.js";

export interface RetrievedEvidencePromptContext extends PromptContext {
  readonly retrievedEvidence?: EvidenceBundle | null;
}

export function renderRetrievedEvidenceSegment(value: unknown): string | null {
  const parsed = EvidenceBundleSchema.safeParse(value);
  if (!parsed.success) return null;
  const bundle = parsed.data;
  return [
    "RETRIEVED_EVIDENCE_JSON",
    JSON.stringify({
      query: bundle.query,
      mode: bundle.mode,
      generatedAtUtc: bundle.generatedAtUtc,
      score: bundle.score,
      evidence: bundle.evidence.map((item) => ({
        memoryId: item.memoryId,
        memoryContent: item.memoryContent,
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
      renderRetrievedEvidenceSegment(context.retrievedEvidence),
  };
}
