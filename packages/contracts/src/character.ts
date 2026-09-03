import { z } from "zod";

import {
  EntityIdSchema,
  IanaTimezoneSchema,
  LocalTimeSchema,
  SimulationTierSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import { CharacterSourceRefSchema, FieldOriginSchema } from "./provenance.js";

export const CharacterStatusSchema = z.enum(["draft", "published", "archived"]);
export type CharacterStatus = z.infer<typeof CharacterStatusSchema>;

export const CharacterSourceKindSchema = z.enum([
  "original",
  "imported_character",
]);
export type CharacterSourceKind = z.infer<typeof CharacterSourceKindSchema>;

export const ScheduleRigiditySchema = z.enum([
  "fixed",
  "committed",
  "flexible",
  "filler",
]);
export type ScheduleRigidity = z.infer<typeof ScheduleRigiditySchema>;

const SourceRefsSchema = z.array(EntityIdSchema).max(32);
const CharacterLocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a local calendar date")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Expected a valid local calendar date");

export const TraitRuleSchema = z
  .object({
    id: EntityIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    strength: UnitIntervalSchema,
    triggers: z.array(z.string().trim().min(1).max(240)).max(20),
    exceptions: z.array(z.string().trim().min(1).max(240)).max(20),
    origin: FieldOriginSchema,
    sourceRefs: SourceRefsSchema,
  })
  .strict();
export type TraitRule = z.infer<typeof TraitRuleSchema>;

export const ValueRuleSchema = z
  .object({
    id: EntityIdSchema,
    name: z.string().trim().min(1).max(120),
    priority: UnitIntervalSchema,
    description: z.string().trim().min(1).max(1_000),
    exceptions: z.array(z.string().trim().min(1).max(240)).max(20),
    origin: FieldOriginSchema,
    sourceRefs: SourceRefsSchema,
  })
  .strict();
export type ValueRule = z.infer<typeof ValueRuleSchema>;

export const ContradictionRuleSchema = z
  .object({
    id: EntityIdSchema,
    sideA: z.string().trim().min(1).max(500),
    sideB: z.string().trim().min(1).max(500),
    triggerConditions: z
      .array(z.string().trim().min(1).max(240))
      .min(1)
      .max(20),
    resolutionPattern: z.string().trim().min(1).max(1_000),
    origin: FieldOriginSchema,
  })
  .strict();
export type ContradictionRule = z.infer<typeof ContradictionRuleSchema>;

export const CharacterGoalMilestoneSchema = z
  .object({
    id: EntityIdSchema,
    /** Calendar days elapsed since the life thread was created. */
    afterDays: z.number().int().min(0).max(3_650),
    title: z.string().trim().min(1).max(160),
    focus: z.string().trim().min(1).max(1_000),
    nextStepHint: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type CharacterGoalMilestone = z.infer<
  typeof CharacterGoalMilestoneSchema
>;

export const CharacterGoalSchema = z
  .object({
    id: EntityIdSchema,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000),
    priority: UnitIntervalSchema,
    progress: UnitIntervalSchema,
    origin: FieldOriginSchema,
    sourceRefs: SourceRefsSchema,
    /**
     * A creation-time plan advanced by elapsed character-local calendar days.
     * It is optional so older persisted CharacterSpecs remain readable.
     */
    milestones: z.array(CharacterGoalMilestoneSchema).min(2).max(12).optional(),
  })
  .strict()
  .superRefine((goal, context) => {
    if (goal.milestones === undefined) return;
    if (goal.milestones[0]?.afterDays !== 0) {
      context.addIssue({
        code: "custom",
        message: "The first goal milestone must start at day 0",
        path: ["milestones", 0, "afterDays"],
      });
    }
    for (let index = 1; index < goal.milestones.length; index += 1) {
      if (
        goal.milestones[index]!.afterDays <=
        goal.milestones[index - 1]!.afterDays
      ) {
        context.addIssue({
          code: "custom",
          message: "Goal milestone day offsets must increase strictly",
          path: ["milestones", index, "afterDays"],
        });
      }
    }
  });
export type CharacterGoal = z.infer<typeof CharacterGoalSchema>;

export const PreferenceRuleSchema = z
  .object({
    id: EntityIdSchema,
    subject: z.string().trim().min(1).max(160),
    preference: z.string().trim().min(1).max(500),
    intensity: UnitIntervalSchema,
    conditions: z.array(z.string().trim().min(1).max(240)).max(20),
    origin: FieldOriginSchema,
    sourceRefs: SourceRefsSchema,
  })
  .strict();
export type PreferenceRule = z.infer<typeof PreferenceRuleSchema>;

export const BoundaryRuleSchema = z
  .object({
    id: EntityIdSchema,
    condition: z.string().trim().min(1).max(500),
    forbiddenBehavior: z.string().trim().min(1).max(500),
    responsePattern: z.string().trim().min(1).max(1_000),
    hard: z.boolean(),
  })
  .strict();
export type BoundaryRule = z.infer<typeof BoundaryRuleSchema>;

export const RoutineRuleSchema = z
  .object({
    id: EntityIdSchema,
    title: z.string().trim().min(1).max(160),
    category: z.string().trim().min(1).max(80),
    recurrence: z.string().trim().min(1).max(240),
    preferredStartLocal: LocalTimeSchema,
    preferredDurationMinutes: z.number().int().min(5).max(1_440),
    rigidity: ScheduleRigiditySchema,
    priority: UnitIntervalSchema,
  })
  .strict();
export type RoutineRule = z.infer<typeof RoutineRuleSchema>;

export const CharacterTemporalFrameSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("realtime"),
      eraLabel: z.string().trim().min(1).max(240).optional(),
      knowledgeCutoff: z.string().trim().min(1).max(240).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("anchored_story"),
      eraLabel: z.string().trim().min(1).max(240),
      storyAnchorLocalDate: CharacterLocalDateSchema,
      /** Precision supplied by the author; the full date may be operational. */
      anchorPrecision: z.enum(["year", "month", "day"]).optional(),
      /** Server-owned instant from which elapsed story time is projected. */
      systemAnchorUtc: UtcDateTimeSchema.optional(),
      knowledgeCutoff: z.string().trim().min(1).max(240).optional(),
    })
    .strict(),
]);
export type CharacterTemporalFrame = z.infer<
  typeof CharacterTemporalFrameSchema
>;

export const CharacterAppearanceSchema = z
  .object({
    summary: z.string().trim().min(1).max(2_000),
    distinctiveFeatures: z.array(z.string().trim().min(1).max(240)).max(20),
    presentationNotes: z.array(z.string().trim().min(1).max(240)).max(20),
  })
  .strict();
export type CharacterAppearance = z.infer<typeof CharacterAppearanceSchema>;

export const CharacterIdentitySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    workOrRole: z.string().trim().min(1).max(240),
    worldSetting: z.string().trim().min(1).max(4_000),
    selfDescription: z.string().trim().min(1).max(2_000),
    timezone: IanaTimezoneSchema,
    temporalFrame: CharacterTemporalFrameSchema.optional(),
    appearance: CharacterAppearanceSchema.optional(),
  })
  .strict();
export type CharacterIdentity = z.infer<typeof CharacterIdentitySchema>;

export const BiographyEntrySchema = z
  .object({
    id: EntityIdSchema,
    period: z.string().trim().min(1).max(240),
    event: z.string().trim().min(1).max(1_000),
    lastingImpact: z.string().trim().min(1).max(1_000).optional(),
    importance: UnitIntervalSchema,
    origin: FieldOriginSchema,
    sourceRefs: SourceRefsSchema,
  })
  .strict();
export type BiographyEntry = z.infer<typeof BiographyEntrySchema>;

export const CharacterPersonaSchema = z
  .object({
    traits: z.array(TraitRuleSchema).min(1).max(24),
    values: z.array(ValueRuleSchema).min(1).max(24),
    contradictions: z.array(ContradictionRuleSchema).max(16),
    goals: z.array(CharacterGoalSchema).min(1).max(20),
    preferences: z.array(PreferenceRuleSchema).max(40),
    boundaries: z.array(BoundaryRuleSchema).max(30),
    biography: z.array(BiographyEntrySchema).max(40).optional(),
  })
  .strict();
export type CharacterPersona = z.infer<typeof CharacterPersonaSchema>;

export const DialogueRuleSchema = z
  .object({
    id: EntityIdSchema,
    kind: z.enum(["language", "format", "register", "length", "avoidance"]),
    instruction: z.string().trim().min(1).max(1_000),
    enforcement: z.enum(["hard", "soft"]),
    conditions: z.array(z.string().trim().min(1).max(240)).max(20),
    origin: FieldOriginSchema,
    sourceRefs: SourceRefsSchema,
  })
  .strict();
export type DialogueRule = z.infer<typeof DialogueRuleSchema>;

export const DialogueStyleSchema = z
  .object({
    primaryLanguage: z.string().trim().min(1).max(64),
    formality: UnitIntervalSchema,
    directness: UnitIntervalSchema,
    warmth: UnitIntervalSchema,
    verbosity: UnitIntervalSchema,
    humor: UnitIntervalSchema,
    averageMessageLength: z.number().int().min(1).max(4_000),
    averageChunksPerTurn: z.number().int().min(1).max(12),
    frequentPhrases: z.array(z.string().trim().min(1).max(120)).max(40),
    avoidedPhrases: z.array(z.string().trim().min(1).max(120)).max(40),
    greetingPatterns: z.array(z.string().trim().min(1).max(500)).max(20),
    refusalPatterns: z.array(z.string().trim().min(1).max(500)).max(20),
    comfortingPatterns: z.array(z.string().trim().min(1).max(500)).max(20),
    /** Author wording is kept verbatim; numeric style fields are its projection. */
    authorGuidance: z.string().trim().min(1).max(2_000).optional(),
    understoodLanguages: z
      .array(z.string().trim().min(1).max(80))
      .max(20)
      .optional(),
    spokenLanguages: z
      .array(z.string().trim().min(1).max(80))
      .max(20)
      .optional(),
    rules: z.array(DialogueRuleSchema).max(30).optional(),
  })
  .strict();
export type DialogueStyle = z.infer<typeof DialogueStyleSchema>;

export const RelationshipBehaviorModeSchema = z
  .object({
    id: EntityIdSchema,
    conditions: z.array(z.string().trim().min(1).max(240)).min(1).max(20),
    behavior: z.string().trim().min(1).max(1_000),
    disclosurePattern: z.string().trim().min(1).max(1_000).optional(),
    origin: FieldOriginSchema,
    sourceRefs: SourceRefsSchema,
  })
  .strict();
export type RelationshipBehaviorMode = z.infer<
  typeof RelationshipBehaviorModeSchema
>;

export const InitialUserRelationshipSchema = z
  .object({
    relationshipType: z.string().trim().min(1).max(120),
    initialCloseness: UnitIntervalSchema,
    initialTrust: UnitIntervalSchema,
    addressTerms: z.array(z.string().trim().min(1).max(80)).max(20),
    sharedContext: z.string().trim().max(2_000),
    behaviorModes: z.array(RelationshipBehaviorModeSchema).max(20).optional(),
    tensions: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    affectionPatterns: z
      .array(z.string().trim().min(1).max(500))
      .max(20)
      .optional(),
  })
  .strict();
export type InitialUserRelationship = z.infer<
  typeof InitialUserRelationshipSchema
>;

export const SchedulePolicySchema = z
  .object({
    enabled: z.boolean(),
    horizonHours: z.literal(72),
    extendWhenRemainingHoursBelow: z.number().int().min(1).max(71),
    sleepWindow: z
      .object({
        startLocal: LocalTimeSchema,
        endLocal: LocalTimeSchema,
      })
      .strict(),
    maxCommittedHoursPerDay: z.number().min(1).max(24),
    routineAdherence: UnitIntervalSchema,
    spontaneity: UnitIntervalSchema,
    socialInvitationBias: UnitIntervalSchema,
  })
  .strict();
export type SchedulePolicy = z.infer<typeof SchedulePolicySchema>;

/**
 * Canonical name for the legacy 72-hour exact-schedule policy. The persisted
 * CharacterSpec key remains `schedulePolicy` so older character versions stay
 * readable; fuzzy-life authoring keeps its `enabled` value false.
 */
export const LegacyExactSchedulePolicySchema = SchedulePolicySchema;
export type LegacyExactSchedulePolicy = SchedulePolicy;

export const ProactivePolicySchema = z
  .object({
    enabled: z.boolean(),
    maxMessagesPerDay: z.number().int().min(0).max(2),
    quietHours: z
      .object({
        startLocal: LocalTimeSchema,
        endLocal: LocalTimeSchema,
      })
      .strict(),
    minimumCloseness: UnitIntervalSchema,
    shareableCategories: z.array(z.string().trim().min(1).max(80)).max(30),
  })
  .strict();
export type ProactivePolicy = z.infer<typeof ProactivePolicySchema>;

export const CharacterKnowledgeSchema = z
  .object({
    knownFacts: z.array(z.string().trim().min(1).max(1_000)).max(200),
    uncertainFacts: z.array(z.string().trim().min(1).max(1_000)).max(100),
    forbiddenMetaKnowledge: z
      .array(z.string().trim().min(1).max(1_000))
      .max(100),
  })
  .strict();
export type CharacterKnowledge = z.infer<typeof CharacterKnowledgeSchema>;

export const LockedCharacterPathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/);

const CharacterSpecContentShape = {
  tier: SimulationTierSchema,
  sourceType: CharacterSourceKindSchema,
  identity: CharacterIdentitySchema,
  persona: CharacterPersonaSchema,
  dialogue: DialogueStyleSchema,
  userRelationship: InitialUserRelationshipSchema,
  routines: z.array(RoutineRuleSchema).max(50),
  schedulePolicy: SchedulePolicySchema,
  proactivePolicy: ProactivePolicySchema,
  knowledge: CharacterKnowledgeSchema,
  sources: z.array(CharacterSourceRefSchema).max(200),
  lockedPaths: z.array(LockedCharacterPathSchema).max(200),
} as const;

export const CharacterSpecDraftSchema = z
  .object(CharacterSpecContentShape)
  .strict();
export type CharacterSpecDraft = z.infer<typeof CharacterSpecDraftSchema>;

export const CharacterSpecSchema = z
  .object({
    id: EntityIdSchema,
    version: z.number().int().positive(),
    status: CharacterStatusSchema,
    ...CharacterSpecContentShape,
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((spec, context) => {
    const sourceIds = new Set<string>();
    for (const [index, source] of spec.sources.entries()) {
      if (sourceIds.has(source.id)) {
        context.addIssue({
          code: "custom",
          message: "Source ids must be unique",
          path: ["sources", index, "id"],
        });
      }
      sourceIds.add(source.id);
    }

    const ruleIds = new Set<string>();
    const ruleGroups = [
      spec.persona.traits,
      spec.persona.values,
      spec.persona.contradictions,
      spec.persona.goals,
      spec.persona.preferences,
      spec.persona.boundaries,
      spec.persona.biography ?? [],
      spec.dialogue.rules ?? [],
      spec.userRelationship.behaviorModes ?? [],
      spec.routines,
    ];
    for (const group of ruleGroups) {
      for (const rule of group) {
        if (ruleIds.has(rule.id)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate rule id: ${rule.id}`,
          });
        }
        ruleIds.add(rule.id);
      }
    }
    for (const goal of spec.persona.goals) {
      for (const milestone of goal.milestones ?? []) {
        if (ruleIds.has(milestone.id)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate rule id: ${milestone.id}`,
          });
        }
        ruleIds.add(milestone.id);
      }
    }
  });
export type CharacterSpec = z.infer<typeof CharacterSpecSchema>;

export const OriginalCharacterInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    worldSetting: z.string().trim().min(1).max(4_000),
    workOrRole: z.string().trim().min(1).max(240),
    coreTraits: z.array(z.string().trim().min(1).max(120)).length(3),
    coreContradiction: z.string().trim().min(1).max(500),
    mainGoal: z.string().trim().min(1).max(160),
    initialRelationship: z.string().trim().min(1).max(120),
    dialogueStyle: z.string().trim().min(1).max(500),
    characterBrief: z.string().trim().min(1).max(20_000).optional(),
    storyEra: z.string().trim().min(1).max(240).optional(),
    storyAnchorYear: z.number().int().min(1000).max(9999).optional(),
    tier: SimulationTierSchema,
    timezone: IanaTimezoneSchema.default("UTC"),
  })
  .strict();
export type OriginalCharacterInput = z.infer<
  typeof OriginalCharacterInputSchema
>;
export type OriginalCharacterInputData = z.input<
  typeof OriginalCharacterInputSchema
>;

export const ImportedCharacterInputSchema = z
  .object({
    characterName: z.string().trim().min(1).max(120),
    workTitle: z.string().trim().min(1).max(200),
    storyStage: z.string().trim().min(1).max(240),
    tier: SimulationTierSchema,
    timezone: IanaTimezoneSchema.default("UTC"),
    sourceText: z
      .string()
      .trim()
      .min(1)
      .max(512_000)
      .refine(
        (text) => new TextEncoder().encode(text).byteLength <= 512_000,
        "Imported material may not exceed 500 KiB",
      ),
    sourceFormat: z
      .enum(["pasted_text", "txt", "md", "srt"])
      .default("pasted_text"),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/\.(?:txt|md|srt)$/i)
      .optional(),
  })
  .strict();
export type ImportedCharacterInput = z.infer<
  typeof ImportedCharacterInputSchema
>;
export type ImportedCharacterInputData = z.input<
  typeof ImportedCharacterInputSchema
>;
