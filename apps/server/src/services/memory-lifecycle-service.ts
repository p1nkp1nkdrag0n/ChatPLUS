import type { Memory } from "@personasim/contracts";
import {
  canonicalMemoryConflictPair,
  planMemoryLifecycleTransition,
  reconcileMemoryClaims,
  stableId,
  type MemoryClaimReconciliation,
  type LifecycleMemoryLike,
  type MemoryLifecyclePolicyLike,
  type MemoryLifecycleTransition,
} from "@personasim/features";

import type { Clock } from "../runtime/clock.js";
import type {
  ContinuityMemoryRepository,
  LifecycleMemoryRecord,
} from "./continuity-memory-repository.js";

export interface MemoryLifecycleMaintenanceResult {
  agentId: string;
  transitions: MemoryLifecycleTransition[];
  skippedMemoryIds: string[];
}

export interface MemoryReconciliationResult {
  reconciliation: MemoryClaimReconciliation;
  replayed: boolean;
  changedMemoryIds: string[];
  conflictId?: string;
}

type ActionableMemoryReconciliation = Omit<
  MemoryClaimReconciliation,
  "kind" | "subjectKey"
> & {
  kind: "merge" | "supersede" | "needs_review";
  subjectKey: string;
};

export class MemoryLifecycleService {
  constructor(
    private readonly repository: ContinuityMemoryRepository,
    private readonly clock: Clock,
    private readonly policy?: MemoryLifecyclePolicyLike,
  ) {}

  maintainAgent(agentId: string): MemoryLifecycleMaintenanceResult {
    const nowUtc = this.clock.nowUtc();
    const candidates = this.repository
      .listLifecycleMemories(agentId)
      .map((record) =>
        planMemoryLifecycleTransition({
          memory: toLifecycleMemory(record.memory),
          nowUtc,
          ...(this.policy === undefined ? {} : { policy: this.policy }),
        }),
      )
      .filter(
        (transition): transition is MemoryLifecycleTransition =>
          transition !== undefined,
      );
    return this.repository.transaction(() => {
      const transitions: MemoryLifecycleTransition[] = [];
      const skippedMemoryIds: string[] = [];
      for (const candidate of candidates) {
        const current = this.repository.getLifecycleMemory(candidate.memoryId);
        if (current === undefined) {
          skippedMemoryIds.push(candidate.memoryId);
          continue;
        }
        const currentPlan = planMemoryLifecycleTransition({
          memory: toLifecycleMemory(current.memory),
          nowUtc,
          ...(this.policy === undefined ? {} : { policy: this.policy }),
        });
        if (
          currentPlan === undefined ||
          currentPlan.fromStatus !== candidate.fromStatus ||
          currentPlan.toStatus !== candidate.toStatus
        ) {
          skippedMemoryIds.push(candidate.memoryId);
          continue;
        }
        const changed = this.repository.patchLifecycleMemory({
          memoryId: candidate.memoryId,
          expectedStatuses: [current.memory.status],
          patch: {
            status: candidate.toStatus,
            updatedAtUtc: nowUtc,
            lifecycleUpdatedAtUtc: nowUtc,
          },
        });
        if (!changed) {
          skippedMemoryIds.push(candidate.memoryId);
          continue;
        }
        this.repository.insertDomainEvent({
          agentId,
          streamType: "memory",
          streamId: candidate.memoryId,
          streamVersion: nextStreamVersion(this.repository, candidate.memoryId),
          eventType: "memory.lifecycle.transitioned",
          recordedAtUtc: nowUtc,
          payload: candidate,
          idempotencyKey: `memory-lifecycle:${candidate.memoryId}:${candidate.fromStatus}:${candidate.toStatus}`,
        });
        transitions.push(candidate);
      }
      return { agentId, transitions, skippedMemoryIds };
    });
  }

  reconcileNewMemories(
    agentId: string,
    incomingMemoryIds: readonly string[],
  ): MemoryReconciliationResult[] {
    const results: MemoryReconciliationResult[] = [];
    for (const incomingMemoryId of new Set(incomingMemoryIds)) {
      const incoming =
        this.repository.getLifecycleMemory(incomingMemoryId)?.memory;
      const subjectKey = incoming?.claim?.subjectKey;
      if (
        incoming === undefined ||
        incoming.agentId !== agentId ||
        subjectKey === undefined
      ) {
        continue;
      }
      if (incoming.claim?.revisionIntent === "explicit_correction") {
        results.push(
          ...this.reconcileExplicitCorrectionBatch(agentId, incomingMemoryId),
        );
        continue;
      }
      const existing = this.repository
        .listLifecycleMemories(agentId)
        .filter(
          (record) =>
            record.memory.id !== incomingMemoryId &&
            (record.memory.status === "active" ||
              record.memory.status === "aging" ||
              record.memory.status === "needs_review") &&
            record.memory.claim?.subjectKey === subjectKey,
        );
      if (existing.length === 0) continue;
      results.push(
        this.reconcile({
          existingMemoryId: existing.at(-1)!.memory.id,
          incomingMemoryId,
        }),
      );
    }
    return results;
  }

  private reconcileExplicitCorrectionBatch(
    agentId: string,
    incomingMemoryId: string,
  ): MemoryReconciliationResult[] {
    const nowUtc = this.clock.nowUtc();
    return this.repository.transaction(() => {
      let incoming = requiredMemory(
        this.repository.getLifecycleMemory(incomingMemoryId),
      );
      const subjectKey = incoming.memory.claim?.subjectKey;
      if (
        incoming.memory.agentId !== agentId ||
        subjectKey === undefined ||
        incoming.memory.claim?.revisionIntent !== "explicit_correction"
      ) {
        return [];
      }

      const existing = this.repository
        .listLifecycleMemories(agentId)
        .filter(
          (record) =>
            record.memory.id !== incomingMemoryId &&
            record.memory.claim?.subjectKey === subjectKey &&
            !memoryWasRecordedAfter(record.memory, incoming.memory) &&
            (record.memory.status === "active" ||
              record.memory.status === "aging" ||
              record.memory.status === "needs_review" ||
              record.memory.supersededById === incomingMemoryId ||
              record.memory.mergedIntoId === incomingMemoryId),
        );
      if (existing.length === 0) return [];

      const plans = existing.map((target) => {
        const equivalent = correctionTargetIsEquivalent(
          target.memory,
          incoming.memory,
        );
        const reconciliation: ActionableMemoryReconciliation = equivalent
          ? {
              kind: "merge",
              reasonCode: "claim_reinforced",
              subjectKey,
              existingStatus: "merged",
              incomingStatus: "active",
              winnerMemoryId: incomingMemoryId,
            }
          : {
              kind: "supersede",
              reasonCode: "explicit_user_correction",
              subjectKey,
              existingStatus: "superseded",
              incomingStatus: "active",
              winnerMemoryId: incomingMemoryId,
            };
        const [leftMemoryId, rightMemoryId] = canonicalMemoryConflictPair(
          target.memory.id,
          incomingMemoryId,
        );
        const idempotencyKey = reconciliationIdempotencyKey({
          agentId,
          subjectKey,
          leftMemoryId,
          rightMemoryId,
        });
        const prior = this.repository.store.database
          .prepare("SELECT id FROM memory_conflicts WHERE idempotency_key = ?")
          .get(idempotencyKey) as { id: string } | undefined;
        return {
          target,
          equivalent,
          reconciliation,
          leftMemoryId,
          rightMemoryId,
          idempotencyKey,
          prior,
        };
      });
      if (plans.every((plan) => plan.prior !== undefined)) {
        return plans.map((plan) => ({
          reconciliation: plan.reconciliation,
          replayed: true,
          changedMemoryIds: [],
          conflictId: plan.prior!.id,
        }));
      }

      const canonicalChanged =
        incoming.memory.status !== "active" ||
        incoming.memory.supersededById !== undefined ||
        incoming.memory.mergedIntoId !== undefined;
      if (canonicalChanged) {
        requirePatch(
          this.repository.patchLifecycleMemory({
            memoryId: incomingMemoryId,
            expectedStatuses: [incoming.memory.status],
            patch: {
              status: "active",
              supersededById: null,
              mergedIntoId: null,
              updatedAtUtc: nowUtc,
              lifecycleUpdatedAtUtc: nowUtc,
            },
          }),
        );
        incoming = requiredMemory(
          this.repository.getLifecycleMemory(incomingMemoryId),
        );
      }

      const results: MemoryReconciliationResult[] = [];
      let canonicalChangeReported = false;
      for (const plan of plans) {
        const {
          target,
          equivalent,
          reconciliation,
          leftMemoryId,
          rightMemoryId,
          idempotencyKey,
          prior,
        } = plan;
        if (prior !== undefined) {
          results.push({
            reconciliation,
            replayed: true,
            changedMemoryIds: [],
            conflictId: prior.id,
          });
          continue;
        }

        const conflictId = stableId("memory_conflict", idempotencyKey);
        const changedMemoryIds =
          canonicalChanged && !canonicalChangeReported
            ? [incomingMemoryId]
            : [];
        canonicalChangeReported = canonicalChangeReported || canonicalChanged;
        if (equivalent) {
          requirePatch(
            this.repository.patchLifecycleMemory({
              memoryId: target.memory.id,
              expectedStatuses: [target.memory.status],
              patch: {
                status: "merged",
                supersededById: null,
                mergedIntoId: incomingMemoryId,
                updatedAtUtc: nowUtc,
                lifecycleUpdatedAtUtc: nowUtc,
              },
            }),
          );
          const targetAfter = requiredMemory(
            this.repository.getLifecycleMemory(incomingMemoryId),
          );
          requireInsert(
            this.repository.insertMemoryMergeHistory({
              id: stableId("memory_merge", idempotencyKey),
              agentId,
              targetMemoryId: incomingMemoryId,
              sourceMemoryId: target.memory.id,
              subjectKey,
              reasonCode: reconciliation.reasonCode,
              reasonSummary:
                "Equivalent earlier claims were merged into the explicit correction.",
              sourceSnapshot: target.memory,
              targetBefore: incoming.memory,
              targetAfter: targetAfter.memory,
              evidence: evidenceSnapshot(target.memory, incoming.memory),
              idempotencyKey: `merge:${idempotencyKey}`,
              mergedAtUtc: nowUtc,
            }),
            "Memory merge history already exists without its conflict.",
          );
        } else {
          requirePatch(
            this.repository.patchLifecycleMemory({
              memoryId: target.memory.id,
              expectedStatuses: [target.memory.status],
              patch: {
                status: "superseded",
                supersededById: incomingMemoryId,
                mergedIntoId: null,
                updatedAtUtc: nowUtc,
                lifecycleUpdatedAtUtc: nowUtc,
              },
            }),
          );
        }
        changedMemoryIds.push(target.memory.id);

        requireInsert(
          this.repository.insertMemoryConflict({
            id: conflictId,
            agentId,
            subjectKey,
            leftMemoryId,
            rightMemoryId,
            status: "resolved",
            resolution: equivalent ? "merged" : "superseded",
            winnerMemoryId: incomingMemoryId,
            reasonCode: reconciliation.reasonCode,
            reasonSummary: reasonSummary(reconciliation.kind),
            evidence: evidenceSnapshot(target.memory, incoming.memory),
            idempotencyKey,
            createdAtUtc: nowUtc,
            resolvedAtUtc: nowUtc,
          }),
          "Memory conflict already exists for an incomplete reconciliation.",
        );
        requireInsert(
          this.repository.insertDomainEvent({
            agentId,
            streamType: "memory_conflict",
            streamId: conflictId,
            streamVersion: 1,
            eventType: `memory.claim.${reconciliation.kind}`,
            recordedAtUtc: nowUtc,
            payload: {
              existingMemoryId: target.memory.id,
              incomingMemoryId,
              subjectKey,
              reasonCode: reconciliation.reasonCode,
              changedMemoryIds,
            },
            idempotencyKey: `domain:${idempotencyKey}`,
          }),
          "Memory reconciliation event already exists without its conflict.",
        );
        results.push({
          reconciliation,
          replayed: false,
          changedMemoryIds,
          conflictId,
        });
      }
      return results;
    });
  }

  reconcile(input: {
    existingMemoryId: string;
    incomingMemoryId: string;
  }): MemoryReconciliationResult {
    const nowUtc = this.clock.nowUtc();
    return this.repository.transaction(() => {
      const existing = requiredMemory(
        this.repository.getLifecycleMemory(input.existingMemoryId),
      );
      const incoming = requiredMemory(
        this.repository.getLifecycleMemory(input.incomingMemoryId),
      );
      if (existing.memory.agentId !== incoming.memory.agentId) {
        throw new Error("Memory reconciliation requires one agent.");
      }
      const reconciliation = reconcileMemoryClaims({
        existing: toLifecycleMemory(existing.memory),
        incoming: toLifecycleMemory(incoming.memory),
      });
      if (
        reconciliation.kind === "unrelated" ||
        reconciliation.subjectKey === undefined
      ) {
        return {
          reconciliation,
          replayed: false,
          changedMemoryIds: [],
        };
      }
      const actionable = {
        ...reconciliation,
        subjectKey: reconciliation.subjectKey,
      } as ActionableMemoryReconciliation;
      const [leftMemoryId, rightMemoryId] = canonicalMemoryConflictPair(
        existing.memory.id,
        incoming.memory.id,
      );
      const idempotencyKey = reconciliationIdempotencyKey({
        agentId: existing.memory.agentId,
        subjectKey: actionable.subjectKey,
        leftMemoryId,
        rightMemoryId,
      });
      const prior = this.repository.store.database
        .prepare("SELECT id FROM memory_conflicts WHERE idempotency_key = ?")
        .get(idempotencyKey) as { id: string } | undefined;
      if (prior !== undefined) {
        return {
          reconciliation,
          replayed: true,
          changedMemoryIds: [],
          conflictId: prior.id,
        };
      }
      const conflictId = stableId("memory_conflict", idempotencyKey);
      const changedMemoryIds = this.applyReconciliation({
        existing,
        incoming,
        reconciliation: actionable,
        nowUtc,
        conflictId,
        idempotencyKey,
        leftMemoryId,
        rightMemoryId,
      });
      this.repository.insertDomainEvent({
        agentId: existing.memory.agentId,
        streamType: "memory_conflict",
        streamId: conflictId,
        streamVersion: 1,
        eventType: `memory.claim.${reconciliation.kind}`,
        recordedAtUtc: nowUtc,
        payload: {
          existingMemoryId: existing.memory.id,
          incomingMemoryId: incoming.memory.id,
          subjectKey: actionable.subjectKey,
          reasonCode: reconciliation.reasonCode,
          changedMemoryIds,
        },
        idempotencyKey: `domain:${idempotencyKey}`,
      });
      return {
        reconciliation,
        replayed: false,
        changedMemoryIds,
        conflictId,
      };
    });
  }

  private applyReconciliation(input: {
    existing: LifecycleMemoryRecord;
    incoming: LifecycleMemoryRecord;
    reconciliation: ActionableMemoryReconciliation;
    nowUtc: string;
    conflictId: string;
    idempotencyKey: string;
    leftMemoryId: string;
    rightMemoryId: string;
  }): string[] {
    const {
      existing,
      incoming,
      reconciliation,
      nowUtc,
      conflictId,
      idempotencyKey,
      leftMemoryId,
      rightMemoryId,
    } = input;
    const changedMemoryIds: string[] = [];
    if (reconciliation.kind === "supersede") {
      requirePatch(
        this.repository.patchLifecycleMemory({
          memoryId: existing.memory.id,
          expectedStatuses: [existing.memory.status],
          patch: {
            status: "superseded",
            supersededById: incoming.memory.id,
            updatedAtUtc: nowUtc,
            lifecycleUpdatedAtUtc: nowUtc,
          },
        }),
      );
      changedMemoryIds.push(existing.memory.id);
    } else if (reconciliation.kind === "merge") {
      requirePatch(
        this.repository.patchLifecycleMemory({
          memoryId: existing.memory.id,
          expectedStatuses: [existing.memory.status],
          patch: {
            status: "active",
            updatedAtUtc: nowUtc,
            lifecycleUpdatedAtUtc: nowUtc,
            lastReinforcedAtUtc: nowUtc,
          },
        }),
      );
      requirePatch(
        this.repository.patchLifecycleMemory({
          memoryId: incoming.memory.id,
          expectedStatuses: [incoming.memory.status],
          patch: {
            status: "merged",
            mergedIntoId: existing.memory.id,
            updatedAtUtc: nowUtc,
            lifecycleUpdatedAtUtc: nowUtc,
          },
        }),
      );
      const targetAfter = requiredMemory(
        this.repository.getLifecycleMemory(existing.memory.id),
      );
      this.repository.insertMemoryMergeHistory({
        id: stableId("memory_merge", idempotencyKey),
        agentId: existing.memory.agentId,
        targetMemoryId: existing.memory.id,
        sourceMemoryId: incoming.memory.id,
        subjectKey: reconciliation.subjectKey,
        reasonCode: reconciliation.reasonCode,
        reasonSummary: "Equivalent claims were merged as reinforcement.",
        sourceSnapshot: incoming.memory,
        targetBefore: existing.memory,
        targetAfter: targetAfter.memory,
        evidence: evidenceSnapshot(existing.memory, incoming.memory),
        idempotencyKey: `merge:${idempotencyKey}`,
        mergedAtUtc: nowUtc,
      });
      changedMemoryIds.push(existing.memory.id, incoming.memory.id);
    } else {
      for (const record of [existing, incoming]) {
        requirePatch(
          this.repository.patchLifecycleMemory({
            memoryId: record.memory.id,
            expectedStatuses: [record.memory.status],
            patch: {
              status: "needs_review",
              updatedAtUtc: nowUtc,
              lifecycleUpdatedAtUtc: nowUtc,
            },
          }),
        );
        changedMemoryIds.push(record.memory.id);
      }
    }
    this.repository.insertMemoryConflict({
      id: conflictId,
      agentId: existing.memory.agentId,
      subjectKey: reconciliation.subjectKey,
      leftMemoryId,
      rightMemoryId,
      status: reconciliation.kind === "needs_review" ? "open" : "resolved",
      resolution:
        reconciliation.kind === "supersede"
          ? "superseded"
          : reconciliation.kind === "merge"
            ? "merged"
            : "needs_review",
      ...(reconciliation.winnerMemoryId === undefined
        ? {}
        : { winnerMemoryId: reconciliation.winnerMemoryId }),
      reasonCode: reconciliation.reasonCode,
      reasonSummary: reasonSummary(reconciliation.kind),
      evidence: evidenceSnapshot(existing.memory, incoming.memory),
      idempotencyKey,
      createdAtUtc: nowUtc,
      ...(reconciliation.kind === "needs_review"
        ? {}
        : { resolvedAtUtc: nowUtc }),
    });
    return changedMemoryIds;
  }
}

function requiredMemory(
  record: LifecycleMemoryRecord | undefined,
): LifecycleMemoryRecord {
  if (record === undefined) throw new Error("Memory not found.");
  return record;
}

function requirePatch(changed: boolean): void {
  if (!changed)
    throw new Error("Memory changed during lifecycle reconciliation.");
}

function requireInsert(inserted: boolean, message: string): void {
  if (!inserted) throw new Error(message);
}

function reconciliationIdempotencyKey(input: {
  agentId: string;
  subjectKey: string;
  leftMemoryId: string;
  rightMemoryId: string;
}): string {
  return `memory-reconcile:${stableId(
    "pair",
    `${input.agentId}:${input.subjectKey}:${input.leftMemoryId}:${input.rightMemoryId}`,
  )}`;
}

function correctionTargetIsEquivalent(
  existing: Memory,
  incoming: Memory,
): boolean {
  const incomingClaim = incoming.claim;
  if (incomingClaim === undefined) return false;
  const comparison = reconcileMemoryClaims({
    existing: toLifecycleMemory(existing),
    incoming: {
      ...toLifecycleMemory(incoming),
      claim: {
        subjectKey: incomingClaim.subjectKey,
        disposition: incomingClaim.disposition,
        recordedAtUtc: incomingClaim.recordedAtUtc,
      },
    },
  });
  return comparison.kind === "merge";
}

function memoryWasRecordedAfter(candidate: Memory, incoming: Memory): boolean {
  const candidateTime = Date.parse(
    candidate.claim?.recordedAtUtc ?? candidate.createdAtUtc,
  );
  const incomingTime = Date.parse(
    incoming.claim?.recordedAtUtc ?? incoming.createdAtUtc,
  );
  return (
    Number.isFinite(candidateTime) &&
    Number.isFinite(incomingTime) &&
    candidateTime > incomingTime
  );
}

function nextStreamVersion(
  repository: ContinuityMemoryRepository,
  streamId: string,
): number {
  const row = repository.store.database
    .prepare(
      `SELECT COALESCE(MAX(stream_version), 0) + 1 AS next_version
       FROM domain_events WHERE stream_type = 'memory' AND stream_id = ?`,
    )
    .get(streamId) as { next_version: number };
  return Number(row.next_version);
}

function evidenceSnapshot(
  existing: Memory,
  incoming: Memory,
): Record<string, unknown> {
  return {
    existing: {
      id: existing.id,
      claim: existing.claim ?? null,
      certainty: existing.certainty ?? null,
      attribution: existing.attribution ?? null,
      confidence: existing.confidence,
    },
    incoming: {
      id: incoming.id,
      claim: incoming.claim ?? null,
      certainty: incoming.certainty ?? null,
      attribution: incoming.attribution ?? null,
      confidence: incoming.confidence,
    },
  };
}

function reasonSummary(kind: MemoryClaimReconciliation["kind"]): string {
  if (kind === "supersede") {
    return "A later reliable explicit claim or correction superseded the earlier claim.";
  }
  if (kind === "merge") {
    return "Equivalent claims were merged as reinforcement.";
  }
  return "The claims require review because no reliable winner was proven.";
}

function toLifecycleMemory(memory: Memory): LifecycleMemoryLike {
  return {
    id: memory.id,
    kind: memory.kind,
    content: memory.content,
    importance: memory.importance,
    confidence: memory.confidence,
    status: memory.status,
    ...(memory.stability === undefined ? {} : { stability: memory.stability }),
    ...(memory.certainty === undefined ? {} : { certainty: memory.certainty }),
    ...(memory.attribution === undefined
      ? {}
      : { attribution: memory.attribution }),
    ...(memory.claim === undefined ? {} : { claim: memory.claim }),
    ...(memory.expiresAtUtc === undefined
      ? {}
      : { expiresAtUtc: memory.expiresAtUtc }),
    createdAtUtc: memory.createdAtUtc,
    updatedAtUtc: memory.updatedAtUtc,
    ...(memory.lifecycleUpdatedAtUtc === undefined
      ? {}
      : { lifecycleUpdatedAtUtc: memory.lifecycleUpdatedAtUtc }),
    ...(memory.lastReinforcedAtUtc === undefined
      ? {}
      : { lastReinforcedAtUtc: memory.lastReinforcedAtUtc }),
  };
}
