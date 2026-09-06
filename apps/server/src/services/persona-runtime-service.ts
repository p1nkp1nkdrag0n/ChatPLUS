import {
  LOCAL_USER_ID,
  MemoryCandidateSchema,
  PERSONA_RUNTIME_POLICY_VERSION,
  type CharacterSpec,
  type EffectivePersonaSnapshot,
  type PersonaAdaptation,
  type PersonaEvidenceSource,
  type PersonaRuntimeMode,
} from "@personasim/contracts";
import {
  buildEffectivePersona,
  deriveExplicitPersonaPractices,
  deriveExplicitPersonaPracticeRetractions,
  personaPracticeBaseSignature,
  stableId,
  matchesConversationTopic,
} from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";
import {
  PersonaRuntimeRepository,
  personaScopeKey,
  type PersonaRuntimeHead,
} from "../repositories/persona-runtime-repository.js";
import { validateMergeAndPersistMemories } from "./memory-service.js";

export interface PersonaSourceValidity {
  currentRevision(agentId: string): number;
  readSource(
    agentId: string,
    sourceType: PersonaEvidenceSource["sourceType"],
    sourceId: string,
    nowUtc?: string,
  ): PersonaEvidenceSource | undefined;
  isSourceCurrent(
    agentId: string,
    source: PersonaEvidenceSource,
    nowUtc?: string,
  ): boolean;
  isDerivedCurrent(
    agentId: string,
    derivedType: string,
    derivedId: string,
    nowUtc?: string,
  ): boolean;
  registerDependencies(input: {
    agentId: string;
    derivedType: string;
    derivedId: string;
    sources: readonly PersonaEvidenceSource[];
    nowUtc: string;
  }): boolean;
}

export interface PersonaSnapshotInput {
  baseSpec: CharacterSpec;
  nowUtc: string;
  userId?: string;
  topicText?: string;
}

export interface PersonaPracticeCaptureInput {
  baseSpec: CharacterSpec;
  sourceMessageId: string;
  nowUtc: string;
  userId?: string;
  mode: PersonaRuntimeMode;
  expectedRevision?: number;
  expectedMemoryRevision?: number;
}

export interface PersonaPracticeCaptureResult {
  revision: number;
  capturedObservationIds: string[];
  acceptedAdaptationIds: string[];
}

/** No model calls or background worker; mutation methods belong inside the caller's short commit. */
export class PersonaRuntimeService {
  private readonly repository: PersonaRuntimeRepository;

  constructor(
    private readonly store: DatabaseStore,
    private readonly validity: PersonaSourceValidity,
    repository?: PersonaRuntimeRepository,
  ) {
    this.repository = repository ?? new PersonaRuntimeRepository(store);
  }

  /** Pure read, including when no runtime head has ever been created. */
  snapshot(input: PersonaSnapshotInput): EffectivePersonaSnapshot {
    const adaptations = this.repository.listAdaptations(input.baseSpec.id);
    return buildEffectivePersona({
      ...input,
      userId: input.userId ?? LOCAL_USER_ID,
      revision: this.repository.head(input.baseSpec.id)?.revision ?? 0,
      memoryRevision: this.validity.currentRevision(input.baseSpec.id),
      adaptations,
      validAdaptationIds: adaptations
        .filter((item) => this.isCurrent(item, input.nowUtc))
        .map((item) => item.id),
    });
  }

  /** The recorded historical projection; later retractions cannot rewrite a past letter snapshot. */
  snapshotAsOf(input: PersonaSnapshotInput): EffectivePersonaSnapshot {
    if (input.baseSpec.createdAtUtc > input.nowUtc)
      throw new Error("persona_base_as_of_conflict");
    const historical = this.repository.historyAt(
      input.baseSpec.id,
      input.nowUtc,
    );
    const adaptations = historical?.state.adaptations ?? [];
    const invalidations = this.repository.invalidationsAt(
      input.baseSpec.id,
      input.nowUtc,
    );
    const invalidatedIds = new Set(invalidations.adaptationIds);
    return buildEffectivePersona({
      ...input,
      userId: input.userId ?? LOCAL_USER_ID,
      revision: historical?.revision ?? 0,
      memoryRevision: Math.max(
        historical?.state.memoryRevision ?? 0,
        invalidations.memoryRevision,
      ),
      adaptations,
      validAdaptationIds: adaptations
        .filter(
          (item) => item.status === "accepted" && !invalidatedIds.has(item.id),
        )
        .map((item) => item.id),
    });
  }

  reconcileBase(input: { baseSpec: CharacterSpec; nowUtc: string }): void {
    this.store.transaction(() => {
      const agentId = input.baseSpec.id;
      const head = this.repository.ensureHead({
        agentId,
        baseCharacterVersion: input.baseSpec.version,
        memoryRevision: this.validity.currentRevision(agentId),
        updatedAtUtc: input.nowUtc,
      });
      if (head.baseCharacterVersion === input.baseSpec.version) return;
      const current = this.store.getCharacterSpec(agentId);
      if (current?.version !== input.baseSpec.version)
        throw new Error("persona_base_version_conflict");
      const previous = this.store.getCharacterSpec(
        agentId,
        head.baseCharacterVersion,
      );
      const preserve =
        previous !== undefined &&
        personaPracticeBaseSignature(previous) ===
          personaPracticeBaseSignature(input.baseSpec);
      const adaptations = this.repository.listAdaptations(agentId);
      const accepted = adaptations.filter((item) => item.status === "accepted");
      if (accepted.length === 0) {
        this.repository.updateHead(
          {
            ...head,
            baseCharacterVersion: input.baseSpec.version,
            updatedAtUtc: input.nowUtc,
          },
          head.revision,
        );
        return;
      }
      for (const item of accepted)
        this.repository.saveAdaptation(
          {
            ...item,
            baseCharacterVersion: input.baseSpec.version,
            revision: head.revision + 1,
            status: preserve ? "accepted" : "needs_review",
            ...(preserve ? {} : { effectiveToUtc: input.nowUtc }),
          },
          input.nowUtc,
        );
      this.commitRevision(
        { ...head, baseCharacterVersion: input.baseSpec.version },
        input.nowUtc,
        preserve
          ? "base_rebased_compatible"
          : "author_changed_practice_context",
        `base:${input.baseSpec.version}`,
      );
    });
  }

  reconcileSources(input: { agentId: string; nowUtc: string }): void {
    this.store.transaction(() => {
      const head = this.repository.head(input.agentId);
      if (head === undefined) return;
      const invalid = this.repository
        .listAdaptations(input.agentId)
        .filter(
          (item) =>
            item.status === "accepted" && !this.isCurrent(item, input.nowUtc),
        );
      if (invalid.length === 0) return;
      for (const item of invalid)
        this.repository.saveAdaptation(
          { ...item, status: "retracted", effectiveToUtc: input.nowUtc },
          input.nowUtc,
        );
      this.commitRevision(
        head,
        input.nowUtc,
        "evidence_invalidated",
        `invalid:${head.revision}:${this.validity.currentRevision(input.agentId)}`,
      );
    });
  }

  captureExplicitPractice(
    input: PersonaPracticeCaptureInput,
  ): PersonaPracticeCaptureResult {
    return this.store.transaction(() => {
      const agentId = input.baseSpec.id;
      const result: PersonaPracticeCaptureResult = {
        revision: this.repository.head(agentId)?.revision ?? 0,
        capturedObservationIds: [],
        acceptedAdaptationIds: [],
      };
      if (input.mode === "off") return result;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== result.revision
      )
        throw new Error("persona_revision_conflict");
      if (
        input.expectedMemoryRevision !== undefined &&
        input.expectedMemoryRevision !== this.validity.currentRevision(agentId)
      )
        throw new Error("persona_memory_revision_conflict");
      if (
        this.store.getCharacterSpec(agentId)?.version !== input.baseSpec.version
      ) {
        if (input.mode === "shadow") return result;
        throw new Error("persona_base_version_conflict");
      }
      if (input.mode === "enforced") {
        this.reconcileBase({ baseSpec: input.baseSpec, nowUtc: input.nowUtc });
        this.reconcileSources({ agentId, nowUtc: input.nowUtc });
      }
      result.revision = this.repository.head(agentId)?.revision ?? 0;
      const source = this.store.database
        .prepare(
          "SELECT role, content, created_at_utc AS createdAtUtc FROM messages WHERE id = ? AND agent_id = ?",
        )
        .get(input.sourceMessageId, agentId) as
        { role: string; content: string; createdAtUtc: string } | undefined;
      if (source?.role !== "user" || source.createdAtUtc > input.nowUtc)
        return result;
      const messageSource = this.validity.readSource(
        agentId,
        "message",
        input.sourceMessageId,
        input.nowUtc,
      );
      if (messageSource === undefined) return result;
      if (input.mode === "enforced") {
        const retractions = deriveExplicitPersonaPracticeRetractions({
          text: source.content,
          userId: input.userId ?? LOCAL_USER_ID,
        });
        const withdrawn = this.repository
          .listAdaptations(agentId)
          .filter(
            (item) =>
              item.status === "accepted" &&
              retractions.some(
                (request) =>
                  request.facet === item.proposal.facet &&
                  request.scope.userId === item.proposal.scope.userId &&
                  (request.scope.topic === undefined ||
                    (item.proposal.scope.topic !== undefined &&
                      matchesConversationTopic(
                        item.proposal.scope.topic,
                        request.scope.topic,
                      ) &&
                      matchesConversationTopic(
                        request.scope.topic,
                        item.proposal.scope.topic,
                      ))),
              ),
          );
        if (withdrawn.length > 0) {
          const head = this.repository.head(agentId)!;
          for (const adaptation of withdrawn)
            this.repository.saveAdaptation(
              {
                ...adaptation,
                status: "retracted",
                effectiveToUtc: input.nowUtc,
              },
              input.nowUtc,
            );
          this.commitRevision(
            head,
            input.nowUtc,
            "explicit_practice_withdrawal",
            `withdraw:${input.sourceMessageId}`,
            [messageSource],
          );
          result.revision = head.revision + 1;
        }
      }
      const proposals = deriveExplicitPersonaPractices({
        text: source.content,
        userId: input.userId ?? LOCAL_USER_ID,
      });
      if (proposals.length === 0) return result;
      const pending = proposals.flatMap((proposal) => {
        const key = `${input.sourceMessageId}:${personaScopeKey(proposal)}`;
        const id = stableId("persona_observation", `${agentId}:${key}`);
        if (
          this.repository.observe({
            id,
            agentId,
            sourceMessageId: input.sourceMessageId,
            sourceHash: messageSource.sourceHash,
            proposal,
            dedupeKey: key,
            nowUtc: input.nowUtc,
          }) === "new"
        )
          result.capturedObservationIds.push(id);
        const observation = this.repository.observation(id)!;
        return observation.status === "captured" &&
          observation.sourceHash === messageSource.sourceHash
          ? [{ id, proposal, key }]
          : [];
      });
      if (input.mode === "shadow" || pending.length === 0) return result;
      const existing = this.repository.listAdaptations(agentId);
      const changed = pending.filter((item) => {
        const unchanged = existing.some(
          (adaptation) =>
            adaptation.status === "accepted" &&
            this.isCurrent(adaptation, input.nowUtc) &&
            personaScopeKey(adaptation.proposal) ===
              personaScopeKey(item.proposal) &&
            adaptation.proposal.practice === item.proposal.practice,
        );
        if (unchanged)
          this.repository.markObservation(
            item.id,
            "rejected",
            "practice_already_effective",
          );
        return !unchanged;
      });
      if (
        changed.length === 0 ||
        existing.length + changed.length > 1_000 ||
        existing.filter((item) => item.status === "accepted").length +
          changed.length >
          100
      )
        return result;
      const memories = validateMergeAndPersistMemories({
        store: this.store,
        agentId,
        nowUtc: input.nowUtc,
        authoritativeMessageId: input.sourceMessageId,
        maxCandidates: 1,
        candidates: [
          MemoryCandidateSchema.parse({
            kind: "relationship",
            content: source.content,
            importance: 0.8,
            confidence: 1,
            tags: ["explicit_relationship_practice"],
            sourceMessageIds: [],
            sourceActivityEventIds: [],
            origin: "runtime_simulation",
            namespace: "user_model",
            certainty: "explicit",
            attribution: "user_explicit",
            stability: "stable",
            reasonCode: "explicit_relationship_practice",
            reasonSummary:
              "The user explicitly requested an enduring, scoped conversation practice.",
          }),
        ],
      });
      const memory = memories.find(
        (item) =>
          item.status === "active" &&
          item.sourceMessageIds.includes(input.sourceMessageId),
      );
      const memorySource =
        memory === undefined
          ? undefined
          : this.validity.readSource(
              agentId,
              "memory",
              memory.id,
              input.nowUtc,
            );
      if (
        memorySource === undefined ||
        !this.validity.isSourceCurrent(agentId, messageSource, input.nowUtc)
      )
        throw new Error("persona_evidence_changed");
      const head = this.repository.head(agentId)!;
      for (const item of changed) {
        const id = stableId("persona_adaptation", `${agentId}:${item.key}`);
        const adaptation: PersonaAdaptation = {
          id,
          agentId,
          proposal: item.proposal,
          baseCharacterVersion: input.baseSpec.version,
          revision: head.revision + 1,
          sourceMessageId: input.sourceMessageId,
          sources: [memorySource, messageSource],
          status: "accepted",
          effectiveFromUtc: input.nowUtc,
          policyVersion: PERSONA_RUNTIME_POLICY_VERSION,
        };
        for (const previous of existing.filter(
          (prior) =>
            prior.status === "accepted" &&
            personaScopeKey(prior.proposal) === personaScopeKey(item.proposal),
        )) {
          this.repository.saveAdaptation(
            { ...previous, status: "superseded", effectiveToUtc: input.nowUtc },
            input.nowUtc,
          );
        }
        this.repository.saveAdaptation(adaptation, input.nowUtc);
        if (
          !this.validity.registerDependencies({
            agentId,
            derivedType: "persona_adaptation",
            derivedId: id,
            sources: adaptation.sources,
            nowUtc: input.nowUtc,
          })
        )
          throw new Error("persona_evidence_changed");
        this.repository.markObservation(
          item.id,
          "accepted",
          "explicit_scoped_practice",
        );
        result.acceptedAdaptationIds.push(id);
      }
      this.commitRevision(
        head,
        input.nowUtc,
        "explicit_scoped_practice",
        `capture:${input.sourceMessageId}`,
      );
      result.revision = head.revision + 1;
      return result;
    });
  }

  retract(input: {
    agentId: string;
    adaptationId: string;
    nowUtc: string;
    reason: string;
    expectedRevision: number;
  }): void {
    this.store.transaction(() => {
      const head = this.repository.head(input.agentId);
      if (head?.revision !== input.expectedRevision)
        throw new Error("persona_revision_conflict");
      const adaptation = this.repository
        .listAdaptations(input.agentId)
        .find((item) => item.id === input.adaptationId);
      if (adaptation === undefined || adaptation.status !== "accepted") return;
      this.repository.saveAdaptation(
        { ...adaptation, status: "retracted", effectiveToUtc: input.nowUtc },
        input.nowUtc,
      );
      this.commitRevision(
        head,
        input.nowUtc,
        input.reason,
        `retract:${adaptation.id}:${head.revision}`,
      );
    });
  }

  private isCurrent(item: PersonaAdaptation, nowUtc: string): boolean {
    return (
      item.sources.every((source) =>
        this.validity.isSourceCurrent(item.agentId, source, nowUtc),
      ) &&
      this.validity.isDerivedCurrent(
        item.agentId,
        "persona_adaptation",
        item.id,
        nowUtc,
      )
    );
  }

  private commitRevision(
    head: PersonaRuntimeHead,
    nowUtc: string,
    reason: string,
    idempotencyKey: string,
    changeSources?: PersonaEvidenceSource[],
  ): void {
    if (nowUtc < head.updatedAtUtc) throw new Error("persona_time_conflict");
    const memoryRevision = this.validity.currentRevision(head.agentId);
    this.repository.appendRevision({
      id: stableId("persona_revision", `${head.agentId}:${head.revision + 1}`),
      agentId: head.agentId,
      fromRevision: head.revision,
      reason,
      idempotencyKey,
      nowUtc,
      state: {
        baseCharacterVersion: head.baseCharacterVersion,
        memoryRevision,
        adaptations: this.repository.listAdaptations(head.agentId),
        ...(changeSources === undefined ? {} : { changeSources }),
      },
    });
    this.repository.updateHead(
      {
        ...head,
        revision: head.revision + 1,
        memoryRevision,
        updatedAtUtc: nowUtc,
      },
      head.revision,
    );
  }
}
