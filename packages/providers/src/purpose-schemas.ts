import {
  ActivityEnrichmentBatchSchema,
  AutobiographyRevisionProposalSchema,
  CharacterCompilationProposalSchema,
  LetterReplyProposalSchema,
  normalizeCharacterCompilationModelOutput,
  PersonaChatResponseSchema,
  StrictPersonaTurnProviderEnvelopeSchema,
  ProactiveMessageProposalSchema,
  SchedulePlanProposalSchema,
  type LlmPurpose,
} from "@personasim/contracts";
import type { ZodType } from "zod";
export const PURPOSE_OUTPUT_SCHEMAS: Record<LlmPurpose, ZodType> = {
  compile_character: CharacterCompilationProposalSchema,
  import_character: CharacterCompilationProposalSchema,
  plan_schedule: SchedulePlanProposalSchema,
  chat_turn: StrictPersonaTurnProviderEnvelopeSchema,
  repair_chat_turn: PersonaChatResponseSchema,
  enrich_activity: ActivityEnrichmentBatchSchema,
  compose_proactive_message: ProactiveMessageProposalSchema,
  checkpoint_autobiography: AutobiographyRevisionProposalSchema,
  letter_reply: LetterReplyProposalSchema,
};

export function normalizePurposeOutput(
  purpose: LlmPurpose,
  value: unknown,
): unknown {
  return purpose === "compile_character" || purpose === "import_character"
    ? normalizeCharacterCompilationModelOutput(value)
    : value;
}
