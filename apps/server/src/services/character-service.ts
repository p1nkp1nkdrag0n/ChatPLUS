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

  get(agentId: string): {
    summary: ReturnType<DatabaseStore["getCharacterSummary"]>;
    spec: CharacterSpec;
    sources: Array<Record<string, unknown>>;
  } {
    const summary = this.store.getCharacterSummary(agentId);
    const spec = this.store.getCharacterSpec(agentId);
    if (!summary || !spec) throw notFound("Character");
    return { summary, spec, sources: this.store.listCharacterSources(agentId) };
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
    const draft = authoritativeOriginalDraft(proposal.draft, input, fallback);
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
    const draft = authoritativeImportedDraft(
      proposal.draft,
      input,
      fallback,
      sourceHash,
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
    const candidate = applyLifePlanningAuthority(
      ensureTimeBasedGoalMilestones(
        normalizeTemporalAnchor(
          {
            ...applyCharacterMutation(currentDraft, mutation),
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
    assertCharacterClockIsEditable(
      this.store,
      agentId,
      currentDraft,
      candidate,
    );
    assertTimezone(candidate.identity.timezone);
    protectLockedCharacterFields(currentDraft, candidate);
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
    const sourceDraft = applyLifePlanningAuthority(
      ensureTimeBasedGoalMilestones(
        characterDraftSchema.parse(stripCharacterMetadata(source)),
      ),
      this.lifePlanningMode,
    );
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
    const head = this.store.getCharacterSpec(agentId);
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
      initialRelationship: "认识了一段时间的朋友",
      dialogueStyle: "自然、简洁、偶尔有一点冷幽默",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    };
    return this.createFromDraft(buildOriginalDraft(input));
  }

  private createFromDraft(
    rawDraft: CharacterDraft,
    source?: PendingCharacterSource,
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
      ...normalizeCharacterRuleIds(draft),
      id,
      version: 1,
      status: "draft",
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    });
    const state = initialRuntimeState(id, nowUtc, spec);
    this.store.transaction(() => {
      this.store.insertCharacter(spec);
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
