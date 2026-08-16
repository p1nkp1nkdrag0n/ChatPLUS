import { createHash } from "node:crypto";

import { DateTime } from "luxon";

import type { DatabaseStore } from "../db/store.js";
import {
  buildImportedDraft,
  buildOriginalDraft,
  importedSourceLabel,
  initialRuntimeState,
  originalDialogueStyleFact,
} from "../domain/defaults.js";
import { ApiError, notFound } from "../domain/errors.js";
import { capabilitiesForTier } from "../domain/capabilities.js";
import { createEntityId } from "../domain/id.js";
import {
  characterDraftSchema,
  characterCompilationProposalSchema,
  characterSpecSchema,
  importedCharacterInputSchema,
  originalCharacterInputSchema,
  type CharacterDraft,
  type CharacterSpec,
  type ImportedCharacterInput,
  type OriginalCharacterInput,
} from "../domain/schemas.js";
import type { Clock } from "../runtime/clock.js";
import type { LlmService } from "./llm-service.js";

type CharacterMutation =
  | { spec: unknown; expectedVersion?: number }
  | { patch: Record<string, unknown>; expectedVersion?: number }
  | {
      path: string;
      value?: unknown;
      remove?: boolean;
      expectedVersion?: number;
    }
  | Record<string, unknown>;

type PendingCharacterSource = {
  id: string;
  sourceType: string;
  title: string;
  contentExcerpt: string;
  sourceHash: string;
};

// CharacterSpec is the largest structured response in the MVP. The provider
// default is intentionally smaller for ordinary turns, so compilation gets a
// bounded per-call budget that still leaves ample room for a complete draft.
const CHARACTER_COMPILATION_MAX_OUTPUT_TOKENS = 32_000;

export class CharacterService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly llm: LlmService,
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
    const fallback = buildOriginalDraft(input);
    const proposal = await this.llm.generateObject({
      purpose: "compile_character",
      system:
        "You compile an editable fictional character specification. Preserve user facts, add observable triggers and exceptions, and never invent sensitive real-person identifiers.",
      prompt: buildCompilePrompt(input),
      schema: characterCompilationProposalSchema,
      maxOutputTokens: CHARACTER_COMPILATION_MAX_OUTPUT_TOKENS,
      fixture: {
        draft: fallback,
        reasonCode: "fixture_character_compilation",
        reasonSummary: "根据原创角色表单生成结构化角色草稿。",
      },
    });
    return this.createFromDraft(
      authoritativeOriginalDraft(proposal.draft, input, fallback),
    );
  }

  async import(rawInput: unknown): Promise<CharacterSpec> {
    const input = importedCharacterInputSchema.parse(rawInput);
    assertTimezone(input.timezone);
    const fallback = buildImportedDraft(input);
    const proposal = await this.llm.generateObject({
      purpose: "import_character",
      system:
        "Extract a character from supplied canon text. Keep direct evidence separate from inference and do not treat unshown details as canon.",
      prompt: buildImportPrompt(input),
      schema: characterCompilationProposalSchema,
      maxOutputTokens: CHARACTER_COMPILATION_MAX_OUTPUT_TOKENS,
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
    const expectedVersion = getExpectedVersion(mutation);
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

    const currentDraft = characterDraftSchema.parse(stripMetadata(current));
    const candidate = applyMutation(currentDraft, mutation);
    assertTimezone(candidate.identity.timezone);
    protectLockedFields(currentDraft, candidate);
    assertSourceRefs(candidate);

    const nowUtc = this.clock.nowUtc();
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
    const restored = characterSpecSchema.parse({
      ...stripMetadata(source),
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
      ...head,
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
    const draft = characterDraftSchema.parse(rawDraft);
    assertSourceRefs(draft);
    assertTimezone(draft.identity.timezone);
    const id = createEntityId("character");
    const nowUtc = this.clock.nowUtc();
    const spec = characterSpecSchema.parse({
      ...normalizeRuleIds(draft),
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
        payload: { sourceType: spec.sourceType, tier: spec.tier },
        idempotencyKey: `character:${id}:created`,
      });
    });
    return spec;
  }
}

function normalizeRuleIds(draft: CharacterDraft): CharacterDraft {
  const clone = structuredClone(draft);
  const usedRuleIds = new Set<string>();
  const groups = [
    clone.persona.traits,
    clone.persona.values,
    clone.persona.contradictions,
    clone.persona.goals,
    clone.persona.preferences,
    clone.persona.boundaries,
    clone.routines,
  ];
  for (const group of groups) {
    for (const item of group) {
      if (!item.id || usedRuleIds.has(item.id))
        item.id = createEntityId("rule");
      usedRuleIds.add(item.id);
    }
  }
  for (const source of clone.sources) {
    if (!source.id) source.id = createEntityId("source");
  }
  return clone;
}

function authoritativeOriginalDraft(
  candidate: CharacterDraft,
  input: OriginalCharacterInput,
  fallback: CharacterDraft,
): CharacterDraft {
  const untrustedCandidate = downgradeUntrustedOriginalProvenance(candidate);
  return withValidatedFallback(
    applyTierAuthority(
      rebaseOriginalSourceRefs(
        applyOriginalFormAuthority(untrustedCandidate, input, fallback),
      ),
      input.tier,
    ),
    applyTierAuthority(structuredClone(fallback), input.tier),
  );
}

function downgradeUntrustedOriginalProvenance(
  candidate: CharacterDraft,
): CharacterDraft {
  const draft = structuredClone(candidate);
  const rules = [
    ...draft.persona.traits,
    ...draft.persona.values,
    ...draft.persona.contradictions,
    ...draft.persona.goals,
    ...draft.persona.preferences,
  ];
  for (const rule of rules) {
    if (rule.origin === "user_spec" || rule.origin === "canon_extract") {
      rule.origin = "model_inference";
    }
  }
  return draft;
}

function applyOriginalFormAuthority(
  draft: CharacterDraft,
  input: OriginalCharacterInput,
  fallback: CharacterDraft,
): CharacterDraft {
  const sourceId = fallback.sources[0]!.id;
  const authorTraits = input.coreTraits.map((name, index) => {
    const generated = draft.persona.traits[index];
    const base = fallback.persona.traits[index]!;
    return {
      ...(generated ?? base),
      id: base.id,
      name,
      origin: "user_spec" as const,
      sourceRefs: [sourceId],
    };
  });
  const authorTraitIds = new Set(authorTraits.map((trait) => trait.id));
  const generatedContradiction = draft.persona.contradictions[0];
  const baseContradiction = fallback.persona.contradictions[0]!;
  const authorContradiction = {
    ...(generatedContradiction ?? baseContradiction),
    id: baseContradiction.id,
    sideA: input.coreContradiction,
    origin: "user_spec" as const,
  };
  const generatedGoal = draft.persona.goals[0];
  const baseGoal = fallback.persona.goals[0]!;
  const authorGoal = {
    ...(generatedGoal ?? baseGoal),
    id: baseGoal.id,
    title: input.mainGoal,
    description: `持续推进：${input.mainGoal}`,
    origin: "user_spec" as const,
    sourceRefs: [sourceId],
  };
  const generatedValue = draft.persona.values[0];
  const baseValue = fallback.persona.values[0]!;
  const authorValue = {
    ...(generatedValue ?? baseValue),
    id: baseValue.id,
    name: baseValue.name,
    description: input.mainGoal,
    origin: "user_spec" as const,
    sourceRefs: [sourceId],
  };
  const dialogueStyleFact = originalDialogueStyleFact(input.dialogueStyle);

  return {
    ...draft,
    sourceType: "original",
    identity: {
      ...draft.identity,
      name: input.name,
      workOrRole: input.workOrRole,
      worldSetting: input.worldSetting,
      selfDescription: fallback.identity.selfDescription,
      timezone: input.timezone,
    },
    persona: {
      ...draft.persona,
      traits: [
        ...authorTraits,
        ...draft.persona.traits
          .slice(input.coreTraits.length)
          .filter((trait) => !authorTraitIds.has(trait.id)),
      ],
      values: [
        authorValue,
        ...draft.persona.values
          .slice(1)
          .filter((value) => value.id !== authorValue.id),
      ],
      contradictions: [
        authorContradiction,
        ...draft.persona.contradictions
          .slice(1)
          .filter((item) => item.id !== authorContradiction.id),
      ],
      goals: [
        authorGoal,
        ...draft.persona.goals
          .slice(1)
          .filter((goal) => goal.id !== authorGoal.id),
      ],
    },
    userRelationship: {
      ...draft.userRelationship,
      relationshipType: input.initialRelationship,
    },
    knowledge: {
      ...draft.knowledge,
      knownFacts: [
        ...draft.knowledge.knownFacts
          .filter((fact) => fact !== dialogueStyleFact)
          .slice(0, 199),
        dialogueStyleFact,
      ],
    },
    sources: structuredClone(fallback.sources),
  };
}

function authoritativeImportedDraft(
  candidate: CharacterDraft,
  input: ImportedCharacterInput,
  fallback: CharacterDraft,
  sourceHash: string,
): CharacterDraft {
  const authoritativeSource = {
    ...fallback.sources[0]!,
    workTitle: input.workTitle,
    locator: input.storyStage,
    checksum: sourceHash,
  };
  return withValidatedFallback(
    applyTierAuthority(
      rebaseImportedSourceRefs({
        ...structuredClone(candidate),
        sourceType: "imported_character",
        identity: {
          ...candidate.identity,
          name: input.characterName,
          workOrRole: `《${input.workTitle}》中的角色`,
          worldSetting: `${input.workTitle}；剧情阶段：${input.storyStage}`,
          selfDescription: `${input.characterName}来自《${input.workTitle}》，当前处于${input.storyStage}。`,
          timezone: input.timezone,
        },
        knowledge: {
          ...candidate.knowledge,
          knownFacts: [
            ...candidate.knowledge.knownFacts.filter(
              (fact) => fact !== input.workTitle && fact !== input.storyStage,
            ),
            `作品：${input.workTitle}`,
            `剧情阶段：${input.storyStage}`,
          ],
        },
        sources: [authoritativeSource],
      }),
      input.tier,
    ),
    applyTierAuthority(
      rebaseImportedSourceRefs({
        ...structuredClone(fallback),
        sources: [authoritativeSource],
      }),
      input.tier,
    ),
  );
}

function rebaseOriginalSourceRefs(draft: CharacterDraft): CharacterDraft {
  const sourceId = draft.sources[0]!.id;
  const rules = characterEvidenceRules(draft);
  for (const rule of rules) {
    if (rule.origin === "canon_extract") rule.origin = "model_inference";
    rule.sourceRefs =
      rule.origin === "user_spec" || rule.origin === "model_inference"
        ? [sourceId]
        : [];
  }
  return draft;
}

function rebaseImportedSourceRefs(draft: CharacterDraft): CharacterDraft {
  const sourceId = draft.sources[0]!.id;
  const rules = characterEvidenceRules(draft);
  for (const rule of rules) {
    if (rule.origin === "user_spec") rule.origin = "model_inference";
    rule.sourceRefs =
      rule.origin === "canon_extract" || rule.origin === "model_inference"
        ? [sourceId]
        : [];
  }
  return draft;
}

function characterEvidenceRules(draft: CharacterDraft) {
  return [
    ...draft.persona.traits,
    ...draft.persona.values,
    ...draft.persona.goals,
    ...draft.persona.preferences,
  ];
}

function applyTierAuthority(
  draft: CharacterDraft,
  tier: CharacterDraft["tier"],
): CharacterDraft {
  const capabilities = capabilitiesForTier(tier);
  return {
    ...draft,
    tier,
    schedulePolicy: { ...draft.schedulePolicy, enabled: capabilities.schedule },
    proactivePolicy: {
      ...draft.proactivePolicy,
      enabled: capabilities.proactiveDialogue,
    },
  };
}

function withValidatedFallback(
  candidate: CharacterDraft,
  fallback: CharacterDraft,
): CharacterDraft {
  try {
    const parsed = characterDraftSchema.parse(candidate);
    assertSourceRefs(parsed);
    return parsed;
  } catch {
    const parsed = characterDraftSchema.parse(fallback);
    assertSourceRefs(parsed);
    return parsed;
  }
}

function assertSourceRefs(draft: CharacterDraft): void {
  const sourceIds = new Set(draft.sources.map((source) => source.id));
  const rules = [
    ...draft.persona.traits,
    ...draft.persona.values,
    ...draft.persona.goals,
    ...draft.persona.preferences,
  ];
  for (const rule of rules) {
    if (
      (rule.origin === "user_spec" ||
        rule.origin === "canon_extract" ||
        rule.origin === "model_inference") &&
      rule.sourceRefs.length === 0
    ) {
      throw new ApiError(
        422,
        "missing_source_ref",
        "Evidence-backed character fields require a source.",
        {
          ruleId: rule.id,
        },
      );
    }
    const invalid = rule.sourceRefs.filter(
      (sourceId) => !sourceIds.has(sourceId),
    );
    if (invalid.length > 0) {
      throw new ApiError(
        422,
        "invalid_source_ref",
        "Character field references an unknown source.",
        {
          ruleId: rule.id,
          sourceRefs: invalid,
        },
      );
    }
  }
}

function stripMetadata(spec: CharacterSpec): CharacterDraft {
  const draft = structuredClone(spec) as unknown as Record<string, unknown>;
  for (const field of [
    "id",
    "version",
    "status",
    "createdAtUtc",
    "updatedAtUtc",
  ])
    delete draft[field];
  return characterDraftSchema.parse(draft);
}

function applyMutation(
  current: CharacterDraft,
  mutation: CharacterMutation,
): CharacterDraft {
  if ("spec" in mutation) {
    const fullSpec = characterSpecSchema.safeParse(mutation.spec);
    return fullSpec.success
      ? stripMetadata(fullSpec.data)
      : characterDraftSchema.parse(mutation.spec);
  }
  if ("path" in mutation && typeof mutation.path === "string") {
    const clone = structuredClone(current) as unknown as Record<
      string,
      unknown
    >;
    setAtPath(clone, mutation.path, mutation.value, mutation.remove === true);
    return characterDraftSchema.parse(clone);
  }
  if ("patch" in mutation && isRecord(mutation.patch)) {
    return characterDraftSchema.parse(
      deepMerge(structuredClone(current), mutation.patch),
    );
  }
  const possibleSpec = { ...mutation };
  delete possibleSpec.expectedVersion;
  return characterDraftSchema.parse(possibleSpec);
}

function getExpectedVersion(mutation: CharacterMutation): number | undefined {
  const value = mutation.expectedVersion;
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function protectLockedFields(
  before: CharacterDraft,
  after: CharacterDraft,
): void {
  for (const path of before.lockedPaths) {
    if (!after.lockedPaths.includes(path)) continue;
    if (
      JSON.stringify(getAtPath(before, path)) !==
      JSON.stringify(getAtPath(after, path))
    ) {
      throw new ApiError(
        409,
        "field_locked",
        `The character field is locked: ${path}`,
        { path },
      );
    }
  }
}

function setAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
  remove: boolean,
): void {
  if (!/^([A-Za-z][A-Za-z0-9_]*)(\.([A-Za-z][A-Za-z0-9_]*|\d+))*$/.test(path)) {
    throw new ApiError(
      400,
      "invalid_path",
      "The requested JSON path is invalid.",
      { path },
    );
  }
  const parts = path.split(".");
  let cursor: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const nextValue: unknown = Array.isArray(cursor)
      ? cursor[Number(part)]
      : cursor[part];
    if (!isRecord(nextValue) && !Array.isArray(nextValue)) {
      throw new ApiError(
        400,
        "invalid_path",
        "The requested JSON path does not exist.",
        { path },
      );
    }
    cursor = nextValue;
  }
  const key = parts.at(-1)!;
  if (Array.isArray(cursor)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
      throw new ApiError(
        400,
        "invalid_path",
        "The requested array index is invalid.",
        { path },
      );
    }
    if (remove) cursor.splice(index, 1);
    else cursor[index] = value;
  } else if (remove) delete cursor[key];
  else cursor[key] = value;
}

function getAtPath(target: unknown, path: string): unknown {
  let value = target;
  for (const part of path.split(".")) {
    if (Array.isArray(value)) value = value[Number(part)];
    else if (isRecord(value)) value = value[part];
    else return undefined;
  }
  return value;
}

function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(target[key]))
      target[key] = deepMerge(target[key], value);
    else target[key] = value;
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertTimezone(timezone: string): void {
  if (!DateTime.utc().setZone(timezone).isValid) {
    throw new ApiError(
      400,
      "invalid_timezone",
      `Unsupported IANA timezone: ${timezone}`,
    );
  }
}

function buildCompilePrompt(input: OriginalCharacterInput): string {
  return (
    `Create a CharacterSpecDraft from this JSON:\n${JSON.stringify(input)}\n\n` +
    "Include observable triggers and exceptions for each trait, at least two contradiction rules, at least five routines, at least three hard boundaries, dialogue statistics, schedule policy, and proactive policy."
  );
}

function buildImportPrompt(input: ImportedCharacterInput): string {
  const excerpts = boundedCharacterExcerpts(
    input.sourceText,
    input.characterName,
  );
  return (
    `Extract ${input.characterName} from ${input.workTitle} at story stage ${input.storyStage}. ` +
    "Use canon_extract only for direct evidence; model_inference for supported inference; synthetic_extension only for non-canon gaps. " +
    "The source may be represented by bounded excerpts from the beginning, end, distributed positions, and locations near the character name; do not invent facts between excerpts. " +
    `Source excerpts:\n${excerpts}`
  );
}

function boundedCharacterExcerpts(
  sourceText: string,
  characterName: string,
): string {
  const maxCharacters = 60_000;
  if (sourceText.length <= maxCharacters) return sourceText;

  const ranges = new Map<string, { start: number; end: number }>();
  const addRange = (center: number, length: number) => {
    const start = Math.max(
      0,
      Math.min(sourceText.length - length, center - Math.floor(length / 2)),
    );
    const end = Math.min(sourceText.length, start + length);
    ranges.set(`${start}:${end}`, { start, end });
  };
  addRange(6_000, 12_000);
  addRange(sourceText.length - 6_000, 12_000);
  for (const ratio of [0.25, 0.5, 0.75]) {
    const anchor = Math.floor(sourceText.length * ratio);
    addRange(anchor, 6_000);
    const occurrence = sourceText.indexOf(characterName, anchor);
    if (occurrence >= 0) addRange(occurrence, 6_000);
  }

  let remaining = maxCharacters;
  const excerpts: string[] = [];
  for (const range of [...ranges.values()].toSorted(
    (a, b) => a.start - b.start,
  )) {
    if (remaining <= 0) break;
    const end = Math.min(range.end, range.start + remaining);
    excerpts.push(
      `[excerpt ${range.start}-${end}]\n${sourceText.slice(range.start, end)}`,
    );
    remaining -= end - range.start;
  }
  return excerpts.join("\n\n");
}
