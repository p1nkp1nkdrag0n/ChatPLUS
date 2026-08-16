import {
  AgentTurnDecisionSchema,
  CharacterSpecDraftSchema,
  CharacterSpecSchema,
  CharacterCompilationProposalSchema,
  ActivityEnrichmentBatchSchema,
  ImportedCharacterInputSchema,
  OriginalCharacterInputSchema,
  RuntimeStateSchema,
  ScheduleEffectProposalSchema,
  ScheduleItemDraftSchema,
  ScheduleItemSchema,
  SchedulePlanProposalSchema,
  ScheduleStateEffectsSchema,
  SimulationTierSchema,
  ServerChatMessageInputSchema,
  type ActivityEnrichmentBatch,
  type AgentTurnDecision,
  type CharacterSpec,
  type CharacterSpecDraft,
  type CharacterCompilationProposal,
  type ImportedCharacterInput,
  type OriginalCharacterInput,
  type RuntimeState,
  type ScheduleEffectProposal,
  type ScheduleItem,
  type ScheduleItemDraft,
  type SchedulePlanProposal,
  type ScheduleStateEffects,
  type SimulationTier,
} from "@personasim/contracts";
import { z } from "zod";

// Domain objects are owned by @personasim/contracts. This module only supplies
// server naming aliases and backwards-compatible HTTP input normalization.
export const simulationTierSchema = SimulationTierSchema;
export const characterDraftSchema = CharacterSpecDraftSchema;
export const characterSpecSchema = CharacterSpecSchema;
export const characterCompilationProposalSchema =
  CharacterCompilationProposalSchema;
export const runtimeStateSchema = RuntimeStateSchema;
export const scheduleItemDraftSchema = ScheduleItemDraftSchema;
export const scheduleItemSchema = ScheduleItemSchema;
export const schedulePlanSchema = SchedulePlanProposalSchema;
export const scheduleEffectProposalSchema = ScheduleEffectProposalSchema;
export const stateDeltaSchema = ScheduleStateEffectsSchema;
export const agentTurnDecisionSchema = AgentTurnDecisionSchema;
export const chatMessageInputSchema = ServerChatMessageInputSchema;
export const activityEnrichmentSchema = ActivityEnrichmentBatchSchema;

export type {
  AgentTurnDecision,
  ActivityEnrichmentBatch,
  CharacterSpec,
  CharacterCompilationProposal,
  ImportedCharacterInput,
  OriginalCharacterInput,
  RuntimeState,
  ScheduleEffectProposal,
  ScheduleItem,
  ScheduleItemDraft,
  SchedulePlanProposal,
  SimulationTier,
};
export type CharacterDraft = CharacterSpecDraft;
export type StateDelta = ScheduleStateEffects;

// Accepted form values must fit their authoritative CharacterSpec destinations;
// the shared request contracts own these limits so every consumer agrees.
const serverOriginalCharacterInputSchema = OriginalCharacterInputSchema;
const serverImportedCharacterInputSchema = ImportedCharacterInputSchema;

export const originalCharacterInputSchema = z.preprocess((raw) => {
  if (!isRecord(raw)) return raw;
  const input = { ...raw };
  input.coreContradiction ??= input.centralContradiction;
  input.mainGoal ??= input.primaryGoal;
  input.initialRelationship ??= input.relationshipToUser;
  delete input.centralContradiction;
  delete input.primaryGoal;
  delete input.relationshipToUser;
  return input;
}, serverOriginalCharacterInputSchema);

export const importedCharacterInputSchema = z.preprocess((raw) => {
  if (!isRecord(raw)) return raw;
  const input = { ...raw };
  input.characterName ??= input.name;
  input.sourceFormat ??= inferSourceFormat(input.fileName ?? input.sourceTitle);
  if (
    !input.fileName &&
    typeof input.sourceTitle === "string" &&
    /\.(?:txt|md|srt)$/i.test(input.sourceTitle)
  ) {
    input.fileName = input.sourceTitle;
  }
  delete input.name;
  delete input.sourceTitle;
  return input;
}, serverImportedCharacterInputSchema);

export const clockAdvanceSchema = z
  .object({
    days: z.number().int().min(-365).max(365).optional(),
    hours: z.number().int().min(-8_760).max(8_760).optional(),
    minutes: z.number().int().min(-525_600).max(525_600).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.values(value).some((part) => part !== undefined && part !== 0),
    {
      message: "At least one non-zero duration is required",
    },
  );

export type ActivityEnrichment = ActivityEnrichmentBatch;

function inferSourceFormat(
  value: unknown,
): "pasted_text" | "txt" | "md" | "srt" {
  if (typeof value !== "string") return "pasted_text";
  const extension = value.toLowerCase().split(".").at(-1);
  return extension === "txt" || extension === "md" || extension === "srt"
    ? extension
    : "pasted_text";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
