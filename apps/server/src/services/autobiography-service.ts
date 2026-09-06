import {
  AgentAutobiographySnapshotSchema,
  AutobiographyEntrySchema,
  AutobiographyRevisionProposalSchema,
  type AutobiographyRevisionProposal,
  type ContinuityEvidenceRef,
} from "@personasim/contracts";
import {
  buildAutobiographyProjection,
  stableId,
  validateAutobiographyRevision,
  type AutobiographyValidationIssue,
} from "@personasim/features";

import type {
  ArchivedMessage,
  AutobiographyBundle,
  ContinuityRepository,
} from "./continuity-repository.js";
import {
  continuitySemanticCatalog,
  preserveUnverifiedAutobiographySources,
} from "./evidence-validation-service.js";

export interface VerifiedContinuityEvidence extends ContinuityEvidenceRef {
  text: string;
}

export type PreparedAutobiographyRevision =
  | {
      accepted: true;
      bundle: AutobiographyBundle;
      expectedPreviousSnapshotId?: string;
      expectedPreviousRevision: number;
    }
  | {
      accepted: false;
      issues: AutobiographyValidationIssue[];
    };

export class AutobiographyService {
  constructor(private readonly repository: ContinuityRepository) {}

  latest(agentId: string): AutobiographyBundle | undefined {
    return this.repository.getLatestAutobiography(agentId);
  }

  prepareRevision(input: {
    agentId: string;
    checkpointId: string;
    sourceMessages: readonly ArchivedMessage[];
    proposal: AutobiographyRevisionProposal;
    evidenceCatalog: readonly VerifiedContinuityEvidence[];
    nowUtc: string;
  }): PreparedAutobiographyRevision {
    const parsedProposal = AutobiographyRevisionProposalSchema.safeParse(
      input.proposal,
    );
    if (!parsedProposal.success) {
      return {
        accepted: false,
        issues: [
          {
            code: "entry_not_grounded",
            message: parsedProposal.error.issues
              .map((issue) => issue.message)
              .join("; "),
          },
        ],
      };
    }
    const catalogById = new Map(
      input.evidenceCatalog.map((evidence) => [evidence.id, evidence]),
    );
    let authoritativeProposal = {
      ...parsedProposal.data,
      entries: parsedProposal.data.entries.map((entry) => ({
        ...entry,
        evidence: entry.evidence.map((reference) => {
          const verified = catalogById.get(reference.id);
          if (
            verified === undefined ||
            verified.sourceType !== reference.sourceType ||
            verified.sourceId !== reference.sourceId
          ) {
            return reference;
          }
          return evidenceRef(verified);
        }),
      })),
    };
    const semanticCatalog = continuitySemanticCatalog({
      messages: input.sourceMessages,
      evidence: input.evidenceCatalog,
    });
    authoritativeProposal = preserveUnverifiedAutobiographySources({
      proposal: authoritativeProposal,
      catalog: semanticCatalog,
    });
    const validation = validateAutobiographyRevision({
      proposal: authoritativeProposal,
      evidenceCatalog: semanticCatalog,
    });
    const projection = buildAutobiographyProjection({
      proposal: authoritativeProposal,
      validation,
    });
    if (projection === undefined) {
      return { accepted: false, issues: validation.issues };
    }
    const first = input.sourceMessages[0];
    const last = input.sourceMessages.at(-1);
    if (first === undefined || last === undefined) {
      return {
        accepted: false,
        issues: [
          {
            code: "empty_entries",
            message: "Autobiography revision requires checkpoint messages.",
          },
        ],
      };
    }
    const previous = this.repository.getLatestAutobiography(input.agentId);
    const snapshotId = stableId("autobio", input.checkpointId);
    const snapshot = AgentAutobiographySnapshotSchema.parse({
      id: snapshotId,
      agentId: input.agentId,
      sourceCheckpointId: input.checkpointId,
      ...(previous === undefined
        ? {}
        : { previousSnapshotId: previous.snapshot.id }),
      revision: (previous?.snapshot.revision ?? 0) + 1,
      ...projection,
      fromUtc: first.createdAtUtc,
      throughUtc: last.createdAtUtc,
      createdAtUtc: input.nowUtc,
    });
    const entries = authoritativeProposal.entries.map((entry, ordinal) =>
      AutobiographyEntrySchema.parse({
        id: stableId("autobio_entry", `${snapshotId}:${ordinal}`),
        snapshotId,
        agentId: input.agentId,
        ordinal,
        ...entry,
        sourceEvidenceIds: entry.evidence.map((evidence) => evidence.id),
        createdAtUtc: input.nowUtc,
      }),
    );
    return {
      accepted: true,
      bundle: { snapshot, entries },
      ...(previous === undefined
        ? {}
        : { expectedPreviousSnapshotId: previous.snapshot.id }),
      expectedPreviousRevision: previous?.snapshot.revision ?? 0,
    };
  }

  isCurrent(
    prepared: Extract<PreparedAutobiographyRevision, { accepted: true }>,
  ): boolean {
    const current = this.repository.getLatestAutobiography(
      prepared.bundle.snapshot.agentId,
    );
    return (
      (current?.snapshot.revision ?? 0) === prepared.expectedPreviousRevision &&
      current?.snapshot.id === prepared.expectedPreviousSnapshotId
    );
  }

  persistPrepared(
    prepared: Extract<PreparedAutobiographyRevision, { accepted: true }>,
  ): boolean {
    if (!this.isCurrent(prepared)) return false;
    this.repository.insertAutobiography(prepared.bundle);
    return true;
  }
}

export function messageEvidence(
  message: ArchivedMessage,
): VerifiedContinuityEvidence {
  return {
    id: stableId("evidence", `message_archive:${message.id}`),
    sourceType: "message_archive",
    sourceId: message.id,
    ...(message.content.length <= 2_000
      ? { quote: message.content }
      : { contextSummary: "完整原文保存在消息档案中；本条不提供截断引文。" }),
    temporalStatus: "unknown",
    reliability: "reported",
    recordedAtUtc: message.createdAtUtc,
    text: message.content,
  };
}

function evidenceRef(
  evidence: VerifiedContinuityEvidence,
): ContinuityEvidenceRef {
  return {
    id: evidence.id,
    sourceType: evidence.sourceType,
    sourceId: evidence.sourceId,
    ...(evidence.quote === undefined ? {} : { quote: evidence.quote }),
    ...(evidence.contextSummary === undefined
      ? {}
      : { contextSummary: evidence.contextSummary }),
    ...(evidence.temporalStatus === undefined
      ? {}
      : { temporalStatus: evidence.temporalStatus }),
    reliability: evidence.reliability,
    recordedAtUtc: evidence.recordedAtUtc,
  };
}
