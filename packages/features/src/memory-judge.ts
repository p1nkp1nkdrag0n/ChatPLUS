import type {
  MemoryCandidate,
  MemoryEvidenceInput,
} from "@personasim/contracts";

import { normalizeText } from "./shared.js";

export type MemoryJudgeIssueCode =
  | "SHOULD_WRITE_FALSE"
  | "MISSING_SEMANTIC_METADATA"
  | "MISSING_FORMAL_EVIDENCE"
  | "FORBIDDEN_OVERCLAIM"
  | "INFERENCE_MARKED_EXPLICIT"
  | "EXPLICIT_USER_CLAIM_UNGROUNDED"
  | "SIMULATION_EVENT_UNGROUNDED"
  | "ACTIVITY_OUTCOME_UNGROUNDED"
  | "ACTIVITY_OUTCOME_NOT_OCCURRED"
  | "SHARED_EXPERIENCE_UNGROUNDED"
  | "STABLE_USER_MODEL_UNGROUNDED"
  | "TEMPORAL_METADATA_CONFLICT"
  | "LOW_CONFIDENCE"
  | "LOW_IMPORTANCE";

export interface MemoryJudgeIssue {
  code: MemoryJudgeIssueCode;
  message: string;
}

export interface MemoryJudgeResult {
  decision: "write" | "reject";
  accepted: boolean;
  shouldWrite: boolean;
  issues: MemoryJudgeIssue[];
  errors: string[];
  forbiddenOverclaims: string[];
  candidate?: MemoryCandidate;
}

function hasQuotedMessageEvidence(
  evidence: readonly MemoryEvidenceInput[],
): boolean {
  return evidence.some(
    (item) =>
      item.sourceType === "message" &&
      item.quote !== undefined &&
      item.quote.trim().length > 0,
  );
}

function reliableEvidenceCount(
  evidence: readonly MemoryEvidenceInput[],
): number {
  return new Set(evidence.map((item) => `${item.sourceType}:${item.sourceId}`))
    .size;
}

function hasActivityEvidence(
  evidence: readonly MemoryEvidenceInput[],
): boolean {
  return evidence.some((item) => item.sourceType === "activity_event");
}

function marker(value: string): string {
  return normalizeText(value).replaceAll(" ", "_");
}

function isActivityOutcome(candidate: MemoryCandidate): boolean {
  return [candidate.reasonCode, ...candidate.tags]
    .map(marker)
    .some(
      (value) =>
        value === "activity_outcome" ||
        value.startsWith("activity_outcome_") ||
        value.endsWith("_activity_outcome"),
    );
}

function isSharedExperience(candidate: MemoryCandidate): boolean {
  return (
    (candidate.namespace === "shared_relationship" &&
      (candidate.kind === "episodic" || candidate.kind === "relationship")) ||
    candidate.tags.some((tag) => marker(tag) === "shared_experience")
  );
}

export function judgeMemoryCandidate(
  candidate: MemoryCandidate,
): MemoryJudgeResult {
  const issues: MemoryJudgeIssue[] = [];
  const add = (code: MemoryJudgeIssueCode, message: string): void => {
    if (!issues.some((issue) => issue.code === code)) {
      issues.push({ code, message });
    }
  };

  if (candidate.shouldWrite !== true) {
    add(
      "SHOULD_WRITE_FALSE",
      "The candidate did not explicitly request a conservative memory write.",
    );
  }
  if (
    candidate.namespace === undefined ||
    candidate.certainty === undefined ||
    candidate.attribution === undefined ||
    candidate.stability === undefined ||
    (candidate.temporalMetadata === undefined &&
      candidate.temporal === undefined)
  ) {
    add(
      "MISSING_SEMANTIC_METADATA",
      "Namespace, certainty, attribution, stability, and temporal metadata are required.",
    );
  }

  const evidence = candidate.evidence ?? [];
  if (evidence.length === 0) {
    add(
      "MISSING_FORMAL_EVIDENCE",
      "Long-term memory requires formal evidence.",
    );
  }

  const forbiddenOverclaims = (candidate.forbiddenOverclaims ?? [])
    .map((claim) => claim.trim())
    .filter(Boolean);
  if (forbiddenOverclaims.length > 0) {
    add(
      "FORBIDDEN_OVERCLAIM",
      "The candidate reports an overclaim and must not be written.",
    );
  }
  if (candidate.confidence < 0.5) {
    add("LOW_CONFIDENCE", "Low-confidence claims are not persisted.");
  }
  if (candidate.importance < 0.2) {
    add(
      "LOW_IMPORTANCE",
      "Low-importance details remain in conversation history.",
    );
  }

  if (
    candidate.attribution === "model_inference" &&
    candidate.certainty === "explicit"
  ) {
    add(
      "INFERENCE_MARKED_EXPLICIT",
      "A model inference can never be represented as explicit fact.",
    );
  }
  if (
    candidate.attribution === "user_explicit" &&
    !hasQuotedMessageEvidence(evidence)
  ) {
    add(
      "EXPLICIT_USER_CLAIM_UNGROUNDED",
      "An explicit user claim requires quoted message evidence.",
    );
  }
  if (
    candidate.attribution === "simulation_event" &&
    !hasActivityEvidence(evidence)
  ) {
    add(
      "SIMULATION_EVENT_UNGROUNDED",
      "A simulation event memory requires ActivityEvent evidence.",
    );
  }

  if (isActivityOutcome(candidate)) {
    if (!hasActivityEvidence(evidence)) {
      add(
        "ACTIVITY_OUTCOME_UNGROUNDED",
        "An activity outcome requires ActivityEvent evidence.",
      );
    }
    const temporal = candidate.temporalMetadata ?? candidate.temporal;
    if (temporal?.temporalStatus !== "occurred") {
      add(
        "ACTIVITY_OUTCOME_NOT_OCCURRED",
        "A planned or in-progress activity cannot be recorded as an outcome.",
      );
    }
  }

  if (isSharedExperience(candidate)) {
    const temporal = candidate.temporalMetadata ?? candidate.temporal;
    const direct =
      hasActivityEvidence(evidence) ||
      (temporal?.temporalStatus === "occurred" &&
        hasQuotedMessageEvidence(evidence));
    if (!direct || candidate.attribution === "model_inference") {
      add(
        "SHARED_EXPERIENCE_UNGROUNDED",
        "A shared experience requires direct message or ActivityEvent evidence.",
      );
    }
  }

  if (
    candidate.namespace === "user_model" &&
    candidate.stability === "stable"
  ) {
    const explicit =
      candidate.attribution === "user_explicit" &&
      hasQuotedMessageEvidence(evidence);
    const repeated =
      candidate.certainty !== "explicit" &&
      reliableEvidenceCount(evidence) >= 2;
    if (!explicit && !repeated) {
      add(
        "STABLE_USER_MODEL_UNGROUNDED",
        "A stable user model requires an explicit quoted user statement or multiple reliable sources.",
      );
    }
  }

  if (
    candidate.occurredAtUtc !== undefined &&
    (candidate.temporalMetadata ?? candidate.temporal)?.temporalStatus ===
      "planned"
  ) {
    add(
      "TEMPORAL_METADATA_CONFLICT",
      "Legacy occurredAtUtc cannot be attached to a merely planned event.",
    );
  }

  const accepted = issues.length === 0;
  return {
    decision: accepted ? "write" : "reject",
    accepted,
    shouldWrite: accepted,
    issues,
    errors: issues.map((issue) => issue.message),
    forbiddenOverclaims,
    ...(accepted ? { candidate } : {}),
  };
}

export const evaluateMemoryCandidate = judgeMemoryCandidate;

export function isMemoryCandidateWritable(candidate: MemoryCandidate): boolean {
  return judgeMemoryCandidate(candidate).accepted;
}
