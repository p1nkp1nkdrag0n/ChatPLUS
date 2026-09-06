export const EVIDENCE_SEMANTICS_VERSION = "complete_source_v1";

export type EvidenceSemanticVerdict =
  "supported" | "contradicted" | "insufficient";

export interface EvidenceSemanticResult {
  verdict: EvidenceSemanticVerdict;
  validatorVersion: typeof EVIDENCE_SEMANTICS_VERSION;
  reason:
    | "complete_source"
    | "verified_report"
    | "invalid_span"
    | "abstraction_requires_review";
}

/** Exact offsets establish provenance, not entailment. A substring may omit a
 * negation, condition, speaker or later correction from the same utterance. */
export function validateEvidenceSpan(input: {
  sourceId: string;
  citedSourceId: string;
  text: string;
  quote: string;
  start: number;
  end: number;
}): boolean {
  return (
    input.sourceId === input.citedSourceId &&
    Number.isInteger(input.start) &&
    Number.isInteger(input.end) &&
    input.start >= 0 &&
    input.end > input.start &&
    input.end <= input.text.length &&
    input.text.slice(input.start, input.end) === input.quote
  );
}

/** Deliberately incomplete: lexical overlap is never evidence of entailment.
 * verifiedReport must be constructed by the server from the complete source,
 * including its speaker; it must never come from a model proposal. */
export function validateEvidenceSemantics(input: {
  candidate: string;
  sourceText: string;
  verifiedReport?: string;
  allowVerbatim?: boolean;
}): EvidenceSemanticResult {
  const candidate = input.candidate.trim();
  const result = (
    verdict: EvidenceSemanticVerdict,
    reason: EvidenceSemanticResult["reason"],
  ): EvidenceSemanticResult => ({
    verdict,
    reason,
    validatorVersion: EVIDENCE_SEMANTICS_VERSION,
  });
  if (
    candidate &&
    input.verifiedReport !== undefined &&
    candidate === input.verifiedReport.trim()
  )
    return result("supported", "verified_report");
  if (
    candidate &&
    input.allowVerbatim !== false &&
    candidate === input.sourceText.trim()
  )
    return result("supported", "complete_source");
  return result("insufficient", "abstraction_requires_review");
}

/** Summary budgets may omit complete entries, but cannot clip or rewrite them. */
export function isCompleteEvidenceSelection(
  summary: string,
  entries: readonly string[],
): boolean {
  let remainder = summary.trim();
  const remaining = entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!remainder) return false;
  while (remainder) {
    const index = remaining.findIndex(
      (entry) => remainder === entry || remainder.startsWith(entry + "\n"),
    );
    if (index < 0) return false;
    const entry = remaining.splice(index, 1)[0]!;
    remainder = remainder.slice(entry.length).trim();
  }
  return true;
}
