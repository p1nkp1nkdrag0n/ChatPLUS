import {
  ActivityEnrichmentBatchSchema,
  AgentTurnDecisionSchema,
  CharacterCompilationProposalSchema,
  normalizeCharacterCompilationModelOutput,
  ProactiveMessageProposalSchema,
  SchedulePlanProposalSchema,
  type LlmPurpose,
} from "@personasim/contracts";
import type { ZodType } from "zod";

export const PURPOSE_OUTPUT_SCHEMAS: Record<LlmPurpose, ZodType> = {
  compile_character: CharacterCompilationProposalSchema,
  import_character: CharacterCompilationProposalSchema,
  plan_schedule: SchedulePlanProposalSchema,
  chat_turn: AgentTurnDecisionSchema,
  repair_chat_turn: AgentTurnDecisionSchema,
  enrich_activity: ActivityEnrichmentBatchSchema,
  compose_proactive_message: ProactiveMessageProposalSchema,
};

export function normalizePurposeOutput(
  purpose: LlmPurpose,
  value: unknown,
): unknown {
  return purpose === "compile_character" || purpose === "import_character"
    ? normalizeCharacterCompilationModelOutput(value)
    : value;
}
