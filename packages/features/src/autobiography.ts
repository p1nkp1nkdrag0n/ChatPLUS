import {
  isCompleteEvidenceSelection,
  validateEvidenceSemantics,
} from "./evidence-semantics.js";

export type AutobiographyEvidenceSourceTypeLike =
  "message_archive" | "activity_event" | "memory_evidence" | "domain_event";

export type AutobiographyEvidenceReliabilityLike =
  "fact" | "reported" | "context";

export interface AutobiographyEvidenceRefLike {
  id: string;
  sourceType: AutobiographyEvidenceSourceTypeLike;
  sourceId: string;
}

export interface AutobiographyEvidenceCatalogItemLike extends AutobiographyEvidenceRefLike {
  text: string;
  temporalStatus?:
    "planned" | "in_progress" | "occurred" | "cancelled" | "unknown";
  reliability: AutobiographyEvidenceReliabilityLike;
  /** A server-derived receipt for an oversized archived message. Never model-authored. */
  sourceReceipt?: string;
  /** Server-owned full quote with verified speaker attribution. */
  sourceReport?: string;
}

export type AutobiographyEntryKindLike =
  | "important_experience"
  | "relationship_change"
  | "active_goal"
  | "unresolved_thread"
  | "commitment";

export interface AutobiographyEntryProposalLike {
  entryKind: AutobiographyEntryKindLike;
  content: string;
  temporalStatus:
    "planned" | "in_progress" | "occurred" | "cancelled" | "unknown";
  evidence: readonly AutobiographyEvidenceRefLike[];
}

export interface AutobiographyRevisionProposalLike {
  summaryFirstPerson: string;
  entries: readonly AutobiographyEntryProposalLike[];
}

export type AutobiographyValidationIssueCode =
  | "empty_entries"
  | "duplicate_evidence"
  | "evidence_not_found"
  | "evidence_source_mismatch"
  | "entry_not_grounded"
  | "occurred_without_occurrence_evidence"
  | "summary_not_grounded";

export interface AutobiographyValidationIssue {
  code: AutobiographyValidationIssueCode;
  message: string;
  entryIndex?: number;
  evidenceId?: string;
}

export interface AutobiographyValidationResult {
  accepted: boolean;
  issues: AutobiographyValidationIssue[];
  sourceEvidenceIds: string[];
}

export interface AutobiographyProjection {
  summaryFirstPerson: string;
  importantExperiences: string[];
  relationshipChanges: string[];
  activeGoals: string[];
  unresolvedThreads: string[];
  commitments: string[];
  sourceEvidenceIds: string[];
}

function supportsOccurrence(
  evidence: AutobiographyEvidenceCatalogItemLike,
): boolean {
  return (
    (evidence.reliability === "fact" || evidence.reliability === "reported") &&
    (evidence.temporalStatus === "occurred" ||
      evidence.temporalStatus === "in_progress")
  );
}

export function validateAutobiographyRevision(input: {
  proposal: AutobiographyRevisionProposalLike;
  evidenceCatalog: readonly AutobiographyEvidenceCatalogItemLike[];
}): AutobiographyValidationResult {
  const issues: AutobiographyValidationIssue[] = [];
  const catalog = new Map(input.evidenceCatalog.map((item) => [item.id, item]));
  const sourceEvidenceIds: string[] = [];

  if (input.proposal.entries.length === 0) {
    issues.push({
      code: "empty_entries",
      message: "An autobiography revision requires at least one entry.",
    });
  }

  for (const [entryIndex, entry] of input.proposal.entries.entries()) {
    const seen = new Set<string>();
    const resolved: AutobiographyEvidenceCatalogItemLike[] = [];
    for (const reference of entry.evidence) {
      if (seen.has(reference.id)) {
        issues.push({
          code: "duplicate_evidence",
          message: "An entry cannot cite the same evidence twice.",
          entryIndex,
          evidenceId: reference.id,
        });
        continue;
      }
      seen.add(reference.id);
      const evidence = catalog.get(reference.id);
      if (evidence === undefined) {
        issues.push({
          code: "evidence_not_found",
          message: "The cited evidence does not exist in the verified catalog.",
          entryIndex,
          evidenceId: reference.id,
        });
        continue;
      }
      if (
        evidence.sourceType !== reference.sourceType ||
        evidence.sourceId !== reference.sourceId
      ) {
        issues.push({
          code: "evidence_source_mismatch",
          message: "The evidence source does not match the verified catalog.",
          entryIndex,
          evidenceId: reference.id,
        });
        continue;
      }
      resolved.push(evidence);
      if (!sourceEvidenceIds.includes(evidence.id)) {
        sourceEvidenceIds.push(evidence.id);
      }
    }

    const sourceReceipt =
      resolved.length === 1 &&
      entry.temporalStatus === "unknown" &&
      resolved[0]?.sourceType === "message_archive" &&
      resolved[0].reliability === "reported" &&
      resolved[0].temporalStatus === "unknown" &&
      resolved[0].sourceReceipt === entry.content;
    if (
      resolved.length > 0 &&
      !sourceReceipt &&
      !resolved.some(
        (evidence) =>
          validateEvidenceSemantics({
            candidate: entry.content,
            sourceText: evidence.text,
            allowVerbatim: evidence.sourceType !== "message_archive",
            ...(evidence.sourceReport === undefined
              ? {}
              : { verifiedReport: evidence.sourceReport }),
          }).verdict === "supported",
      )
    ) {
      issues.push({
        code: "entry_not_grounded",
        message: "The autobiography entry is not grounded in its evidence.",
        entryIndex,
      });
    }
    if (
      (entry.temporalStatus === "occurred" ||
        entry.temporalStatus === "in_progress") &&
      !resolved.some(supportsOccurrence)
    ) {
      issues.push({
        code: "occurred_without_occurrence_evidence",
        message:
          "An occurred autobiography entry requires reliable occurrence evidence.",
        entryIndex,
      });
    }
  }

  if (
    input.proposal.entries.length > 0 &&
    !isCompleteEvidenceSelection(
      input.proposal.summaryFirstPerson,
      input.proposal.entries.map((entry) => entry.content),
    )
  ) {
    issues.push({
      code: "summary_not_grounded",
      message: "The first-person summary is not grounded in accepted entries.",
    });
  }

  return {
    accepted: issues.length === 0,
    issues,
    sourceEvidenceIds,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function buildAutobiographyProjection(input: {
  proposal: AutobiographyRevisionProposalLike;
  validation: AutobiographyValidationResult;
}): AutobiographyProjection | undefined {
  if (!input.validation.accepted) return undefined;
  const entries = input.proposal.entries;
  return {
    summaryFirstPerson: input.proposal.summaryFirstPerson.trim(),
    importantExperiences: unique(
      entries
        .filter((entry) => entry.entryKind === "important_experience")
        .map((entry) => entry.content.trim()),
    ),
    relationshipChanges: unique(
      entries
        .filter((entry) => entry.entryKind === "relationship_change")
        .map((entry) => entry.content.trim()),
    ),
    activeGoals: unique(
      entries
        .filter((entry) => entry.entryKind === "active_goal")
        .map((entry) => entry.content.trim()),
    ),
    unresolvedThreads: unique(
      entries
        .filter((entry) => entry.entryKind === "unresolved_thread")
        .map((entry) => entry.content.trim()),
    ),
    commitments: unique(
      entries
        .filter((entry) => entry.entryKind === "commitment")
        .map((entry) => entry.content.trim()),
    ),
    sourceEvidenceIds: [...input.validation.sourceEvidenceIds],
  };
}
