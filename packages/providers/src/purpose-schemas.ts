import {
  ActivityEnrichmentBatchSchema,
  AgentTurnDecisionSchema,
  AutobiographyRevisionProposalSchema,
  CharacterCompilationProposalSchema,
  normalizeCharacterCompilationModelOutput,
  PersonaChatResponseSchema,
  PersonaTurnProviderEnvelopeSchema,
  ProactiveMessageProposalSchema,
  SchedulePlanProposalSchema,
  type LlmPurpose,
} from "@personasim/contracts";
import type { ZodType } from "zod";
import { z } from "zod";

/**
 * chat_turn accepts both the canonical turn envelope and the legacy flat
 * decision during rollout. The strict decision is tried first so fixture and
 * legacy consumers keep their exact shape; envelope-shaped model output then
 * validates through the provider boundary, which strips server-owned schedule
 * mutation fields.
 */
const ChatTurnPurposeSchema = z.union([
  AgentTurnDecisionSchema,
  PersonaTurnProviderEnvelopeSchema,
]);

export const PURPOSE_OUTPUT_SCHEMAS: Record<LlmPurpose, ZodType> = {
  compile_character: CharacterCompilationProposalSchema,
  import_character: CharacterCompilationProposalSchema,
  plan_schedule: SchedulePlanProposalSchema,
  chat_turn: ChatTurnPurposeSchema,
  repair_chat_turn: PersonaChatResponseSchema,
  enrich_activity: ActivityEnrichmentBatchSchema,
  compose_proactive_message: ProactiveMessageProposalSchema,
  checkpoint_autobiography: AutobiographyRevisionProposalSchema,
};

export function normalizePurposeOutput(
  purpose: LlmPurpose,
  value: unknown,
): unknown {
  return purpose === "compile_character" || purpose === "import_character"
    ? normalizeCharacterCompilationModelOutput(value)
    : value;
}
