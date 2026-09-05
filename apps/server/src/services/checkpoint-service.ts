import { createHash } from "node:crypto";

import {
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
  groupCheckpointTurns,
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
import { CheckpointAutobiographyError } from "./checkpoint-autobiography-model.js";
import {
  checkpointEntryCardTitle,
  checkpointLongMessageReceipts,
  MAXIMUM_CHECKPOINT_REPORT_ENTRIES,
} from "./checkpoint-report-excerpts.js";
import type { ContinuityIndexService } from "./continuity-index-service.js";
import type {
  ArchivedMessage,
  ContinuityRepository,
} from "./continuity-repository.js";

export { LlmCheckpointAutobiographyModel } from "./checkpoint-autobiography-model.js";

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
      reason: RetentionSelectionReason | "failure_cooldown";
      retryAtUtc?: string;
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
        error instanceof CheckpointAutobiographyError
          ? error.failureCode
          : "generation_failed",
        errorMessage(error),
        error instanceof CheckpointAutobiographyError
          ? {
              attemptCount: error.attemptCount,
              issues: error.issues,
            }
          : undefined,
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
        preparedAutobiography.issues
          .map((issue) => `${issue.code}: ${issue.message}`)
          .join("; "),
      );
    }
    const sourceIndexOnlyEvidenceIds = checkpointLongMessageReceipts(started)
      .filter((receipt) =>
        preparedAutobiography.bundle.entries.some(
          (entry) =>
            entry.content === receipt.content &&
            entry.evidence.length === 1 &&
            entry.evidence[0]?.id === receipt.evidenceId,
        ),
      )
      .map((receipt) => receipt.evidenceId);
    const reportCoverage = {
      sourceIndexOnlyEvidenceIds,
      hasUnrefinedContent: sourceIndexOnlyEvidenceIds.length > 0,
      note: "Source-index-only entries confirm a message exists; their life content has not been summarized or evaluated.",
    };
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
          reportCoverage,
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
          streamVersion: this.repository.nextCheckpointEventVersion(
            checkpoint.id,
          ),
          eventType: "conversation.checkpoint.committed",
          recordedAtUtc: nowUtc,
          payload: {
            reportCoverage,
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
    const selected: ArchivedMessage[] = [];
    let sourceTokenEstimate = 0;
    // Retention limits tokens, but a category may still receive more than 40
    // complete reports. Preserve turn boundaries and drain the oldest sources
    // over successive checkpoints without enlarging the stored schema.
    for (const turn of groupCheckpointTurns(selection.checkpointMessages)) {
      if (
        selected.length + turn.messages.length >
        MAXIMUM_CHECKPOINT_REPORT_ENTRIES
      )
        break;
      selected.push(...(turn.messages as ArchivedMessage[]));
      sourceTokenEstimate += turn.tokenEstimate;
    }
    const first = selected[0];
    const last = selected.at(-1);
    if (first === undefined || last === undefined) {
      return { status: "skipped", reason: "no_visible_messages" };
    }
    const nowUtc = this.clock.nowUtc();
    const recovery = this.repository.getCheckpointRecoveryState(sessionId);
    if (recovery !== undefined) {
      const delaysMinutes = [5, 15, 60] as const;
      const backoffMinutes =
        delaysMinutes[Math.min(recovery.consecutiveFailures, 3) - 1] ?? 60;
      const newSourceChanges =
        session.revision - recovery.checkpoint.sourceRevision;
      // Fresh evidence may earn an earlier attempt, but never less than five
      // minutes after failure. Message bursts cannot bypass the API backoff.
      const waitMinutes = newSourceChanges >= 4 ? 5 : backoffMinutes;
      const retryAt =
        Date.parse(recovery.checkpoint.updatedAtUtc) + waitMinutes * 60_000;
      if (Date.parse(nowUtc) < retryAt) {
        return {
          status: "skipped",
          reason: "failure_cooldown",
          retryAtUtc: new Date(retryAt).toISOString(),
        };
      }
    }
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
      sourceTokenEstimate,
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
    generation?: { attemptCount: number; issues: readonly string[] },
  ): Extract<CheckpointServiceResult, { status: "failed" }> {
    const nowUtc = this.clock.nowUtc();
    this.repository.transaction(() => {
      const failed = this.repository.failCheckpoint({
        checkpointId,
        failedAtUtc: nowUtc,
        failureCode: reason,
        failureSummary:
          errorSummary.slice(0, 1_000) || "Checkpoint generation failed.",
      });
      const checkpoint = this.repository.getCheckpoint(checkpointId);
      if (failed && checkpoint !== undefined) {
        const version =
          this.repository.nextCheckpointEventVersion(checkpointId);
        this.repository.store.insertDomainEvent({
          agentId: checkpoint.agentId,
          streamType: "conversation_checkpoint",
          streamId: checkpointId,
          streamVersion: version,
          eventType: "conversation.checkpoint.failed",
          recordedAtUtc: nowUtc,
          payload: {
            sessionId: checkpoint.sessionId,
            failureCode: reason,
            errorSummary: checkpoint.failureSummary,
            sourceRevision: checkpoint.sourceRevision,
            sourceHash: checkpoint.sourceHash,
            fromMessageId: checkpoint.fromMessageId,
            throughMessageId: checkpoint.throughMessageId,
            ...(generation === undefined
              ? {}
              : {
                  attemptCount: generation.attemptCount,
                  repairAttempted: generation.attemptCount > 1,
                  issues: generation.issues
                    .slice(0, 12)
                    .map((issue) => issue.slice(0, 400)),
                }),
          },
          idempotencyKey: `checkpoint:${checkpointId}:failed:${version}`,
        });
      }
    });
    const checkpoint = this.repository.getCheckpoint(checkpointId);
    if (checkpoint === undefined) {
      throw new Error("Failed checkpoint could not be reloaded.");
    }
    return { status: "failed", checkpoint, reason, errorSummary };
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
    title: checkpointEntryCardTitle(entry),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
