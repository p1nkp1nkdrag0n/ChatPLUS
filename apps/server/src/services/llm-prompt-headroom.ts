import type { LlmCapabilityProfile } from "@personasim/contracts";

const DEFAULT_CONTEXT_TOKENS = 32_000;
const DEFAULT_OUTPUT_TOKENS = 8_192;
const RESERVED_TOKENS = 2_000;
const MAXIMUM_PROMPT_TOKENS = 24_000;
const MINIMUM_PROMPT_TOKENS = 4_000;

export interface LlmPromptHeadroomDetails {
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly reservedTokens: number;
  readonly availablePromptTokens: number;
  readonly minimumPromptTokens: number;
}

export class LlmPromptHeadroomError extends Error {
  readonly code = "insufficient_llm_prompt_headroom";

  constructor(readonly details: LlmPromptHeadroomDetails) {
    super(
      `The configured LLM capability profile leaves ${details.availablePromptTokens} prompt tokens, but at least ${details.minimumPromptTokens} are required. Increase maxContextTokens or reduce maxOutputTokens.`,
    );
    this.name = "LlmPromptHeadroomError";
  }
}

/**
 * Returns only the prompt space the provider can actually accept. The output
 * allowance and a transport/formatting reserve are never borrowed by input.
 */
export function calculateLlmPromptTokenBudget(
  capabilities: LlmCapabilityProfile,
): number {
  const maxContextTokens =
    capabilities.maxContextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const maxOutputTokens = capabilities.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
  const availablePromptTokens =
    maxContextTokens - maxOutputTokens - RESERVED_TOKENS;

  if (availablePromptTokens < MINIMUM_PROMPT_TOKENS) {
    throw new LlmPromptHeadroomError({
      maxContextTokens,
      maxOutputTokens,
      reservedTokens: RESERVED_TOKENS,
      availablePromptTokens,
      minimumPromptTokens: MINIMUM_PROMPT_TOKENS,
    });
  }

  return Math.min(MAXIMUM_PROMPT_TOKENS, availablePromptTokens);
}
