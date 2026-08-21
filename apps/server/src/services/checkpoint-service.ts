import { createHash } from "node:crypto";

import {
  AutobiographyRevisionProposalSchema,
  ConversationCheckpointSchema,
  DEFAULT_CONVERSATION_RETENTION_POLICY,
  type AgentAutobiographySnapshot,
  type AutobiographyEntry,
  type AutobiographyRevisionProposal,
  type ConversationCheckpoint,
  type ConversationRetentionPolicy,
  type EventCard,
  type EventCardDraft,
} from "@personasim/contracts";
import {
  canonicalCheckpointSource,
  selectConversationRetentionWindow,
  type RetentionSelectionReason,
} from "@personasim/features";

import { createEntityId } from "../domain/id.js";
import type { Clock } from "../runtime/clock.js";
import type { AutobiographyService } from "./autobiography-service.js";
import {
  messageEvidence,
  type VerifiedContinuityEvidence,
} from "./autobiography-service.js";
import type { ContinuityIndexService } from "./continuity-index-service.js";
import type {
  ArchivedMessage,
  ContinuityRepository,
} from "./continuity-repository.js";
import type { LlmService } from "./llm-service.js";

export interface CheckpointAutobiographyModelInput {
  agentId: string;
  sessionId: string;
  checkpointId: string;
  messages: readonly ArchivedMessage[];
  evidence: readonly VerifiedContinuityEvidence[];
  previousAutobiography?: AgentAutobiographySnapshot;
}

export interface CheckpointAutobiographyModel {
  generateAutobiography(
    input: CheckpointAutobiographyModelInput,
  ): Promise<AutobiographyRevisionProposal>;
}

export type CheckpointServiceResult =
  | {
      status: "skipped";
      reason: RetentionSelectionReason;
    }
  | {
      status: "busy";
      checkpoint: ConversationCheckpoint;
    }
  | {
      status: "committed";
      checkpoint: ConversationCheckpoint;
      eventCards: EventCard[];
    }
  | {
      status: "invalidated";
      checkpoint: ConversationCheckpoint;
      reason: "source_changed" | "autobiography_changed";
    }
  | {
      status: "failed";
      checkpoint: ConversationCheckpoint;
      reason: "generation_failed" | "artifact_validation_failed";
      errorSummary: string;
    };

interface PendingWork {
  checkpoint: ConversationCheckpoint;
  messages: ArchivedMessage[];
  evidence: VerifiedContinuityEvidence[];
}

export class CheckpointService {
  constructor(
    private readonly repository: ContinuityRepository,
    private readonly clock: Clock,
    private readonly model: CheckpointAutobiographyModel,
    private readonly autobiography: AutobiographyService,
    private readonly continuityIndex: ContinuityIndexService,
    private readonly policy: ConversationRetentionPolicy = DEFAULT_CONVERSATION_RETENTION_POLICY,
  ) {}

  async createIfNeeded(input: {
    agentId: string;
    sessionId: string;
  }): Promise<CheckpointServiceResult> {
    const started = this.repository.transaction(() =>
      this.beginPending(input.agentId, input.sessionId),
    );
    if ("status" in started) return started;

    let proposal: AutobiographyRevisionProposal;
    try {
      const previous = this.autobiography.latest(input.agentId);
      // Intentionally outside a database transaction. The final phase fences
      // this asynchronous result with both the session revision and source hash.
      proposal = await this.model.generateAutobiography({
        agentId: input.agentId,
        sessionId: input.sessionId,
        checkpointId: started.checkpoint.id,
        messages: started.messages,
        evidence: started.evidence,
        ...(previous === undefined
          ? {}
          : { previousAutobiography: previous.snapshot }),
      });
    } catch (error) {
      return this.fail(
        started.checkpoint.id,
        "generation_failed",
        errorMessage(error),
      );
    }

    const nowUtc = this.clock.nowUtc();
    const preparedAutobiography = this.autobiography.prepareRevision({
      agentId: input.agentId,
      checkpointId: started.checkpoint.id,
      sourceMessages: started.messages,
      proposal,
      evidenceCatalog: started.evidence,
      nowUtc,
    });
    if (!preparedAutobiography.accepted) {
      return this.fail(
        started.checkpoint.id,
        "artifact_validation_failed",
        preparedAutobiography.issues.map((issue) => issue.message).join("; "),
      );
    }
    const cardDrafts = preparedAutobiography.bundle.entries.map((entry) =>
      eventCardDraft(started.checkpoint.id, entry),
    );
    const preparedCards = this.continuityIndex.prepareCheckpointCards({
      agentId: input.agentId,
      sessionId: input.sessionId,
      checkpointId: started.checkpoint.id,
      drafts: cardDrafts,
      evidenceCatalog: started.evidence,
      nowUtc,
    });
    if (!preparedCards.accepted) {
      return this.fail(
        started.checkpoint.id,
        "artifact_validation_failed",
        preparedCards.issues.join("; "),
      );
    }

    try {
      return this.repository.transaction(() => {
        const checkpoint = this.repository.getCheckpoint(started.checkpoint.id);
        if (checkpoint?.status !== "pending") {
          return {
            status: "busy",
            checkpoint: checkpoint ?? started.checkpoint,
          };
        }
        const session = this.repository.getSessionRevision(input.sessionId);
        const currentMessages = this.repository.listArchivedMessageRange(
          input.sessionId,
          checkpoint.fromMessageId,
          checkpoint.throughMessageId,
        );
        const currentHash = checkpointSourceHash(currentMessages);
        if (
          session === undefined ||
          session.revision !== checkpoint.sourceRevision ||
          currentMessages.length !== checkpoint.sourceMessageCount ||
          currentHash !== checkpoint.sourceHash
        ) {
          return this.invalidate(checkpoint.id, "source_changed");
        }
        if (!this.autobiography.isCurrent(preparedAutobiography)) {
          return this.invalidate(checkpoint.id, "autobiography_changed");
        }
        if (!this.autobiography.persistPrepared(preparedAutobiography)) {
          return this.invalidate(checkpoint.id, "autobiography_changed");
        }
        this.continuityIndex.persistPrepared(preparedCards);
        const artifact = {
          summaryFirstPerson:
            preparedAutobiography.bundle.snapshot.summaryFirstPerson,
          autobiography: preparedAutobiography.bundle.snapshot,
          eventCards: preparedCards.cards,
          sourceEvidenceIds:
            preparedAutobiography.bundle.snapshot.sourceEvidenceIds,
        };
        if (
          !this.repository.commitCheckpoint({
            checkpointId: checkpoint.id,
            autobiographySnapshotId: preparedAutobiography.bundle.snapshot.id,
            artifact,
            committedAtUtc: nowUtc,
          })
        ) {
          throw new Error("Checkpoint status changed during commit.");
        }
        this.repository.store.insertDomainEvent({
          agentId: input.agentId,
          streamType: "conversation_checkpoint",
          streamId: checkpoint.id,
          streamVersion: 1,
          eventType: "conversation.checkpoint.committed",
          recordedAtUtc: nowUtc,
          payload: {
            sessionId: input.sessionId,
            sourceRevision: checkpoint.sourceRevision,
            sourceHash: checkpoint.sourceHash,
            fromMessageId: checkpoint.fromMessageId,
            throughMessageId: checkpoint.throughMessageId,
            autobiographySnapshotId: preparedAutobiography.bundle.snapshot.id,
          },
          idempotencyKey: `checkpoint:${checkpoint.id}:committed`,
        });
        const committed = this.repository.getCheckpoint(checkpoint.id);
        if (committed === undefined) {
          throw new Error("Committed checkpoint could not be reloaded.");
        }
        return {
          status: "committed",
          checkpoint: committed,
          eventCards: preparedCards.cards,
        };
      });
    } catch (error) {
      return this.fail(
        started.checkpoint.id,
        "artifact_validation_failed",
        errorMessage(error),
      );
    }
  }

  private beginPending(
    agentId: string,
    sessionId: string,
  ):
    | PendingWork
    | Extract<CheckpointServiceResult, { status: "skipped" | "busy" }> {
    const pending = this.repository.getPendingCheckpoint(sessionId);
    if (pending !== undefined) return { status: "busy", checkpoint: pending };
    const session = this.repository.getSessionRevision(sessionId);
    if (session === undefined || session.agentId !== agentId) {
      throw new Error("Conversation session not found.");
    }
    const latest = this.repository.getLatestCommittedCheckpoint(sessionId);
    const messages = this.repository.listArchivedMessages(sessionId);
    const selection = selectConversationRetentionWindow({
      messages,
      nowUtc: this.clock.nowUtc(),
      policy: this.policy,
      ...(latest === undefined
        ? {}
        : { checkpointThroughMessageId: latest.throughMessageId }),
    });
    if (!selection.shouldCheckpoint) {
      return { status: "skipped", reason: selection.reason };
    }
    const selected = selection.checkpointMessages as ArchivedMessage[];
    const first = selected[0];
    const last = selected.at(-1);
    if (first === undefined || last === undefined) {
      return { status: "skipped", reason: "no_visible_messages" };
    }
    const nowUtc = this.clock.nowUtc();
    const checkpoint = ConversationCheckpointSchema.parse({
      id: createEntityId("checkpoint"),
      agentId,
      sessionId,
      ...(latest === undefined ? {} : { previousCheckpointId: latest.id }),
      fromMessageId: first.id,
      throughMessageId: last.id,
      sourceHash: checkpointSourceHash(selected),
      sourceRevision: session.revision,
      sourceMessageCount: selected.length,
      sourceTokenEstimate: selection.sourceTokenEstimate,
      status: "pending",
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    });
    const stored = this.repository.beginCheckpoint(checkpoint);
    if (stored.status === "committed") {
      return { status: "busy", checkpoint: stored };
    }
    return {
      checkpoint: stored,
      messages: selected,
      evidence: selected.map(messageEvidence),
    };
  }

  private invalidate(
    checkpointId: string,
    reason: "source_changed" | "autobiography_changed",
  ): Extract<CheckpointServiceResult, { status: "invalidated" }> {
    const nowUtc = this.clock.nowUtc();
    this.repository.invalidateCheckpoint({
      checkpointId,
      invalidatedAtUtc: nowUtc,
      failureCode: reason,
      failureSummary:
        reason === "source_changed"
          ? "Messages changed while checkpoint generation was in flight."
          : "Autobiography head changed while checkpoint generation was in flight.",
    });
    const checkpoint = this.repository.getCheckpoint(checkpointId);
    if (checkpoint === undefined) {
      throw new Error("Invalidated checkpoint could not be reloaded.");
    }
    return { status: "invalidated", checkpoint, reason };
  }

  private fail(
    checkpointId: string,
    reason: "generation_failed" | "artifact_validation_failed",
    errorSummary: string,
  ): Extract<CheckpointServiceResult, { status: "failed" }> {
    const nowUtc = this.clock.nowUtc();
    this.repository.transaction(() => {
      this.repository.failCheckpoint({
        checkpointId,
        failedAtUtc: nowUtc,
        failureCode: reason,
        failureSummary: errorSummary.slice(0, 1_000),
      });
    });
    const checkpoint = this.repository.getCheckpoint(checkpointId);
    if (checkpoint === undefined) {
      throw new Error("Failed checkpoint could not be reloaded.");
    }
    return { status: "failed", checkpoint, reason, errorSummary };
  }
}

export class LlmCheckpointAutobiographyModel implements CheckpointAutobiographyModel {
  constructor(private readonly llm: Pick<LlmService, "generateObject">) {}

  generateAutobiography(
    input: CheckpointAutobiographyModelInput,
  ): Promise<AutobiographyRevisionProposal> {
    return this.llm.generateObject({
      purpose: "checkpoint_autobiography",
      system:
        "Revise the character's first-person autobiography using only the verified evidence. Planned events must remain planned and must never be described as occurred.",
      prompt: JSON.stringify({
        checkpointId: input.checkpointId,
        previousAutobiography: input.previousAutobiography ?? null,
        messages: input.messages,
        evidence: input.evidence.map(modelEvidence),
      }),
      schema: AutobiographyRevisionProposalSchema,
      agentId: input.agentId,
    });
  }
}

export function checkpointSourceHash(
  messages: readonly ArchivedMessage[],
): string {
  return createHash("sha256")
    .update(canonicalCheckpointSource(messages))
    .digest("hex");
}

function eventCardDraft(
  checkpointId: string,
  entry: AutobiographyEntry,
): EventCardDraft {
  return {
    cardKind: cardKind(entry.entryKind),
    sourceKind: "checkpoint",
    sourceId: checkpointId,
    dedupeKey: `${checkpointId}:${entry.entryKind}:${entry.ordinal}`,
    title: entry.content.slice(0, 240),
    summary: entry.content,
    tags: [entry.entryKind],
    namespace: "character_self",
    certainty: "inferred",
    attribution: "mixed",
    temporalMetadata: temporalMetadata(entry),
    importance:
      entry.entryKind === "commitment" || entry.entryKind === "active_goal"
        ? 0.8
        : 0.6,
    evidence: entry.evidence,
  };
}

function temporalMetadata(
  entry: AutobiographyEntry,
): EventCardDraft["temporalMetadata"] {
  if (entry.temporalStatus === "occurred" && entry.fromUtc !== undefined) {
    return {
      occurredStartAtUtc: entry.fromUtc,
      ...(entry.throughUtc === undefined
        ? {}
        : { occurredEndAtUtc: entry.throughUtc }),
      recordedAtUtc: entry.createdAtUtc,
      temporalCertainty: "exact",
      temporalStatus: "occurred",
    };
  }
  if (entry.temporalStatus === "planned") {
    return {
      ...(entry.fromUtc === undefined
        ? {}
        : { plannedStartAtUtc: entry.fromUtc }),
      ...(entry.throughUtc === undefined
        ? {}
        : { plannedEndAtUtc: entry.throughUtc }),
      recordedAtUtc: entry.createdAtUtc,
      temporalCertainty: entry.fromUtc === undefined ? "unknown" : "exact",
      temporalStatus: "planned",
    };
  }
  if (entry.temporalStatus === "cancelled") {
    return {
      recordedAtUtc: entry.createdAtUtc,
      temporalCertainty: "unknown",
      temporalStatus: "cancelled",
    };
  }
  return {
    mentionedAtUtc: entry.fromUtc ?? entry.createdAtUtc,
    recordedAtUtc: entry.createdAtUtc,
    temporalCertainty: entry.fromUtc === undefined ? "unknown" : "exact",
    temporalStatus: "unknown",
  };
}

function cardKind(
  kind: AutobiographyEntry["entryKind"],
): EventCardDraft["cardKind"] {
  if (kind === "relationship_change") return "relationship_change";
  if (kind === "active_goal") return "goal";
  if (kind === "commitment") return "commitment";
  return "shared_experience";
}

function modelEvidence(
  evidence: VerifiedContinuityEvidence,
): Omit<VerifiedContinuityEvidence, "text"> {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
