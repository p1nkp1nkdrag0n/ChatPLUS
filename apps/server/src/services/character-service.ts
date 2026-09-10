import { createHash } from "node:crypto";

import type { DatabaseStore } from "../db/store.js";
import {
  buildImportedDraft,
  buildOriginalDraft,
  importedSourceLabel,
  initialRuntimeState,
} from "../domain/defaults.js";
import type { LifePlanningMode } from "../domain/capabilities.js";
import { ApiError, notFound } from "../domain/errors.js";
import { createEntityId } from "../domain/id.js";
import {
  applyStrangerRelationship,
  hasStrangerRelationship,
  STRANGER_RELATIONSHIP_TYPE,
} from "../domain/stranger-relationship.js";
import {
  characterDraftSchema,
  characterCompilationProposalSchema,
  characterSpecSchema,
  importedCharacterInputSchema,
  originalCharacterInputSchema,
  type CharacterDraft,
  type CharacterSpec,
  type OriginalCharacterInput,
} from "../domain/schemas.js";
import type { Clock } from "../runtime/clock.js";
import {
  assertCharacterClockIsEditable,
  assertTimezone,
  applyLifePlanningAuthority,
  ensureTimeBasedGoalMilestones,
  normalizeTemporalAnchor,
} from "./character-clock.js";
import {
  assertCharacterSourceRefs,
  authoritativeImportedDraft,
  authoritativeOriginalDraft,
  buildCompilePrompt,
  buildImportPrompt,
  CHARACTER_COMPILATION_MAX_OUTPUT_TOKENS,
  CHARACTER_COMPILATION_MAX_RETRIES,
  CHARACTER_COMPILATION_POLICY_VERSION,
  CHARACTER_COMPILER_SYSTEM,
  CHARACTER_IMPORT_SYSTEM,
  normalizeCharacterRuleIds,
} from "./character-compiler.js";
import {
  applyCharacterMutation,
  getExpectedCharacterVersion,
  protectLockedCharacterFields,
  stripCharacterMetadata,
  type CharacterMutation,
} from "./character-draft-editor.js";
import type { LlmService } from "./llm-service.js";
import {
  assertCharacterAuthority,
  authorizeEditedCharacter,
  authorizeGeneratedCharacter,
  characterAuthorityReview,
} from "./character-authority.js";

type PendingCharacterSource = {
  id: string;
  sourceType: string;
  title: string;
  contentExcerpt: string;
  sourceHash: string;
};

/**
 * Orchestrates character compilation and lifecycle persistence. Pure draft
 * authority, editing, validation, and story-clock rules live in collaborators.
 */
export class CharacterService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly llm: LlmService,
    private readonly lifePlanningMode: LifePlanningMode = "fuzzy",
  ) {}

  list(includeArchived = false) {
    return this.store.listCharacters(includeArchived);
  }

  getCreationOrigin(agentId: string): "user" | "demo" {
    const row = this.store.database
      .prepare("SELECT creation_origin AS origin FROM characters WHERE id = ?")
      .get(agentId) as { origin: "user" | "demo" } | undefined;
    if (!row) throw notFound("Character");
    return row.origin;
  }

  get(agentId: string): {
    summary: ReturnType<DatabaseStore["getCharacterSummary"]>;
    spec: CharacterSpec;
    sources: Array<Record<string, unknown>>;
    authorityReview: ReturnType<typeof characterAuthorityReview>;
  } {
    const summary = this.store.getCharacterSummary(agentId);
    const spec = this.store.getCharacterSpec(agentId);
    if (!summary || !spec) throw notFound("Character");
    return {
      summary,
      spec,
      sources: this.store.listCharacterSources(agentId),
      authorityReview: characterAuthorityReview(spec),
    };
  }

  async generate(rawInput: unknown): Promise<CharacterSpec> {
    const input = originalCharacterInputSchema.parse(rawInput);
    assertTimezone(input.timezone);
    const fallback = buildOriginalDraft(
      input,
      CHARACTER_COMPILATION_POLICY_VERSION,
    );
    const proposal = await this.llm.generateObject({
      purpose: "compile_character",
      system: CHARACTER_COMPILER_SYSTEM,
      prompt: buildCompilePrompt(input),
      schema: characterCompilationProposalSchema,
      maxOutputTokens: CHARACTER_COMPILATION_MAX_OUTPUT_TOKENS,
      maxRetries: CHARACTER_COMPILATION_MAX_RETRIES,
      fixture: {
        draft: fallback,
        reasonCode: "fixture_character_compilation",
        reasonSummary: "根据原创角色表单生成结构化角色草稿。",
      },
    });
    const draft = authorizeGeneratedCharacter(
      authoritativeOriginalDraft(proposal.draft, input, fallback),
      input,
      fallback,
      proposal.draft,
    );
    if (input.characterBrief === undefined) return this.createFromDraft(draft);
    const sourceHash = createHash("sha256")
      .update(input.characterBrief)
      .digest("hex");
    draft.sources[0] = { ...draft.sources[0]!, checksum: sourceHash };
    return this.createFromDraft(draft, {
      id: createEntityId("source"),
      sourceType: "original_character_brief",
      title: `${input.name}的详细角色素材`,
      contentExcerpt: input.characterBrief,
      sourceHash,
    });
  }

  async import(rawInput: unknown): Promise<CharacterSpec> {
    const input = importedCharacterInputSchema.parse(rawInput);
    assertTimezone(input.timezone);
    const fallback = buildImportedDraft(
      input,
      CHARACTER_COMPILATION_POLICY_VERSION,
    );
    const proposal = await this.llm.generateObject({
      purpose: "import_character",
      system: CHARACTER_IMPORT_SYSTEM,
      prompt: buildImportPrompt(input),
      schema: characterCompilationProposalSchema,
      maxOutputTokens: CHARACTER_COMPILATION_MAX_OUTPUT_TOKENS,
      maxRetries: CHARACTER_COMPILATION_MAX_RETRIES,
      fixture: {
        draft: fallback,
        reasonCode: "fixture_character_import",
        reasonSummary: "根据导入材料生成带来源边界的角色草稿。",
      },
    });
    const excerpt = input.sourceText.replace(/\s+/g, " ").slice(0, 4_000);
    const sourceHash = createHash("sha256")
      .update(input.sourceText)
      .digest("hex");
    const draft = authorizeGeneratedCharacter(
      authoritativeImportedDraft(proposal.draft, input, fallback, sourceHash),
      input,
      fallback,
      proposal.draft,
    );
    return this.createFromDraft(draft, {
      id: createEntityId("source"),
      sourceType: "imported_text",
      title: importedSourceLabel(input),
      contentExcerpt: excerpt,
      sourceHash,
    });
  }

  updateDraft(agentId: string, mutation: CharacterMutation): CharacterSpec {
    const current = this.store.getCharacterSpec(agentId);
    if (!current) throw notFound("Character");
    const expectedVersion = getExpectedCharacterVersion(mutation);
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new ApiError(
        409,
        "version_conflict",
        "The character draft has changed.",
        {
          expectedVersion,
          currentVersion: current.version,
        },
      );
    }

    const currentDraft = characterDraftSchema.parse(
      stripCharacterMetadata(current),
    );
    const nowUtc = this.clock.nowUtc();
    if (
      "authorityDecisions" in mutation &&
      Object.keys(mutation).some(
        (key) => !["authorityDecisions", "expectedVersion"].includes(key),
      )
    ) {
      throw new ApiError(
        422,
        "authority_confirmation_mixed_edit",
        "Confirm a reviewed candidate separately from editing new content.",
      );
    }
    let candidate = applyLifePlanningAuthority(
      ensureTimeBasedGoalMilestones(
        normalizeTemporalAnchor(
          {
            ...("authorityDecisions" in mutation
              ? currentDraft
              : applyCharacterMutation(currentDraft, mutation)),
            // Compilation is server-owned metadata. Older clients omitting
            // it must not reactivate legacy calendar backfill on a v2 draft.
            compilationPolicyVersion: currentDraft.compilationPolicyVersion,
          },
          nowUtc,
          currentDraft,
        ),
      ),
      this.lifePlanningMode,
    );
    candidate = applyStrangerRelationship(candidate);
    assertCharacterClockIsEditable(
      this.store,
      agentId,
      currentDraft,
      candidate,
    );
    assertTimezone(candidate.identity.timezone);
    protectLockedCharacterFields(currentDraft, candidate);
    // A quarantined proposal is still an edit with auditable source references;
    // invalid identifiers must not disappear before the existing validation.
    assertCharacterSourceRefs(candidate);
    candidate = authorizeEditedCharacter(
      candidate,
      currentDraft,
      "authorityDecisions" in mutation
        ? mutation.authorityDecisions
        : undefined,
      expectedVersion,
    );
    // Authority review does not recompile lifecycle semantics. Keep the current
    // policy so an ordinary edit cannot stop an existing calendar-based plan.
    assertCharacterSourceRefs(candidate);

    const next = characterSpecSchema.parse({
      ...candidate,
      id: current.id,
      version: current.version + 1,
      status: "draft",
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    });
    this.store.transaction(() => {
      this.store.insertCharacterVersion(next);
      this.store.updateCharacterHead(next);
      this.store.insertDomainEvent({
        agentId,
        streamType: "character",
        streamId: agentId,
        streamVersion: next.version,
        eventType: "character.draft_updated",
        recordedAtUtc: nowUtc,
        payload: { version: next.version },
        idempotencyKey: `character:${agentId}:version:${next.version}:created`,
      });
    });
    return next;
  }

  listVersions(agentId: string) {
    if (!this.store.getCharacterSummary(agentId)) throw notFound("Character");
    return this.store.listCharacterVersions(agentId);
  }

  restore(agentId: string, version: number): CharacterSpec {
    const source = this.store.getCharacterSpec(agentId, version);
    const head = this.store.getCharacterSpec(agentId);
    if (!source || !head) throw notFound("Character version");
    const nowUtc = this.clock.nowUtc();
    const sourceDraft = authorizeEditedCharacter(
      applyLifePlanningAuthority(
        ensureTimeBasedGoalMilestones(
          characterDraftSchema.parse(stripCharacterMetadata(source)),
        ),
        this.lifePlanningMode,
      ),
      characterDraftSchema.parse(stripCharacterMetadata(source)),
      undefined,
      undefined,
    );
    // Restore the selected version's lifecycle policy while applying today's
    // authority review; the head's newer compiler policy is unrelated.
    assertCharacterClockIsEditable(
      this.store,
      agentId,
      characterDraftSchema.parse(stripCharacterMetadata(head)),
      sourceDraft,
    );
    const restored = characterSpecSchema.parse({
      ...sourceDraft,
      id: agentId,
      version: head.version + 1,
      status: "draft",
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    });
    this.store.transaction(() => {
      this.store.insertCharacterVersion(restored);
      this.store.updateCharacterHead(restored);
      this.store.insertDomainEvent({
        agentId,
        streamType: "character",
        streamId: agentId,
        streamVersion: restored.version,
        eventType: "character.version_restored",
        recordedAtUtc: nowUtc,
        payload: { restoredFromVersion: version, version: restored.version },
        idempotencyKey: `character:${agentId}:version:${restored.version}:restore`,
      });
    });
    return restored;
  }

  publish(agentId: string, expectedVersion?: number): CharacterSpec {
    let head = this.store.getCharacterSpec(agentId);
    if (!head) throw notFound("Character");
    if (expectedVersion !== undefined && expectedVersion !== head.version) {
      throw new ApiError(
        409,
        "version_conflict",
        "The character draft has changed.",
        {
          expectedVersion,
          currentVersion: head.version,
        },
      );
    }
    if (head.status === "archived") {
      throw new ApiError(
        409,
        "character_archived",
        "An archived character cannot be published.",
      );
    }
    // Keep old versions intact while preventing restore/publish from reviving
    // author-defined relationship baselines under the current app policy.
    if (!hasStrangerRelationship(head)) {
      head = this.updateDraft(agentId, {
        spec: stripCharacterMetadata(head),
        expectedVersion: head.version,
      });
    }
    // Already-published historical versions retain their exact saved content.
    if (head.status === "published") return head;
    assertCharacterAuthority(head);
    const nowUtc = this.clock.nowUtc();
    const published = characterSpecSchema.parse({
      ...applyLifePlanningAuthority(
        ensureTimeBasedGoalMilestones(
          characterDraftSchema.parse(stripCharacterMetadata(head)),
        ),
        this.lifePlanningMode,
      ),
      id: head.id,
      version: head.version,
      createdAtUtc: head.createdAtUtc,
      status: "published",
      updatedAtUtc: nowUtc,
    });
    this.store.transaction(() => {
      this.store.markOtherVersionsNotPublished(agentId, head.version);
      this.store.replaceVersion(published);
      this.store.updateCharacterHead(published);
      this.store.insertDomainEvent({
        agentId,
        streamType: "character",
        streamId: agentId,
        streamVersion: published.version,
        eventType: "character.published",
        recordedAtUtc: nowUtc,
        payload: { version: published.version, tier: published.tier },
        idempotencyKey: `character:${agentId}:version:${published.version}:published`,
      });
    });
    return published;
  }

  archive(agentId: string): CharacterSpec {
    const head = this.store.getCharacterSpec(agentId);
    if (!head) throw notFound("Character");
    if (head.status === "archived") return head;
    const nowUtc = this.clock.nowUtc();
    const archived = characterSpecSchema.parse({
      ...head,
      status: "archived",
      updatedAtUtc: nowUtc,
    });
    this.store.transaction(() => {
      this.store.replaceVersion(archived);
      this.store.updateCharacterHead(archived);
      this.store.insertDomainEvent({
        agentId,
        streamType: "character",
        streamId: agentId,
        streamVersion: archived.version,
        eventType: "character.archived",
        recordedAtUtc: nowUtc,
        payload: {},
        idempotencyKey: `character:${agentId}:archived:${archived.version}`,
      });
    });
    return archived;
  }

  createDemoCharacter(): CharacterSpec {
    const input: OriginalCharacterInput = {
      name: "林夏",
      worldSetting: "当代城市生活；日程和关系会随着真实时间推进。",
      workOrRole: "研究生与独立插画师",
      coreTraits: ["认真", "有主见", "对熟人温暖"],
      coreContradiction: "既重视自己的学习计划，也珍惜与重要之人的共同经历",
      mainGoal: "完成毕业作品，同时保留有意义的生活体验",
      initialRelationship: STRANGER_RELATIONSHIP_TYPE,
      dialogueStyle: "自然、简洁、偶尔有一点冷幽默",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    };
    const fallback = buildOriginalDraft(
      input,
      CHARACTER_COMPILATION_POLICY_VERSION,
    );
    return this.createFromDraft(
      authorizeGeneratedCharacter(fallback, input, fallback),
      undefined,
      "demo",
    );
  }

  private createFromDraft(
    rawDraft: CharacterDraft,
    source?: PendingCharacterSource,
    creationOrigin: "user" | "demo" = "user",
  ): CharacterSpec {
    const nowUtc = this.clock.nowUtc();
    const draft = applyLifePlanningAuthority(
      characterDraftSchema.parse(
        normalizeTemporalAnchor(
          ensureTimeBasedGoalMilestones(characterDraftSchema.parse(rawDraft)),
          nowUtc,
        ),
      ),
      this.lifePlanningMode,
    );
    assertCharacterSourceRefs(draft);
    assertTimezone(draft.identity.timezone);
    const id = createEntityId("character");
    const spec = characterSpecSchema.parse({
      ...(draft.authorityAudit === undefined
        ? normalizeCharacterRuleIds(draft)
        : draft),
      id,
      version: 1,
      status: "draft",
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    });
    const state = initialRuntimeState(id, nowUtc, spec);
    this.store.transaction(() => {
      this.store.insertCharacter(spec);
      this.store.database
        .prepare("UPDATE characters SET creation_origin = ? WHERE id = ?")
        .run(creationOrigin, id);
      this.store.insertInitialState(state, nowUtc);
      if (source) {
        this.store.insertCharacterSource({
          ...source,
          characterId: id,
          createdAtUtc: nowUtc,
        });
      }
      this.store.insertDomainEvent({
        agentId: id,
        streamType: "character",
        streamId: id,
        streamVersion: 1,
        eventType: "character.created",
        recordedAtUtc: nowUtc,
        payload: {
          creationOrigin,
          sourceType: spec.sourceType,
          tier: spec.tier,
          compilationPolicyVersion:
            spec.compilationPolicyVersion ?? "legacy_template_v1",
        },
        idempotencyKey: `character:${id}:created`,
      });
    });
    return spec;
  }
}
