import type { LlmCapabilityProfile } from "@personasim/contracts";

/**
 * Chat envelopes can spend output tokens on hidden reasoning as well as the
 * visible JSON response. Keep a deliberately generous target for the primary
 * decision so high/max reasoning profiles do not exhaust a small reply-sized
 * allowance before emitting the required envelope.
 */
export const CHAT_TURN_OUTPUT_TOKEN_TARGET = 24_576;

/**
 * The repair prompt is smaller and asks for reply-only JSON, but reasoning
 * models still need substantially more room than the visible reply length.
 */
export const REPAIR_CHAT_TURN_OUTPUT_TOKEN_TARGET = 16_384;

/**
 * Resolves an application target against the configured model capability.
 * The OpenAI-compatible provider applies the same cap at transport time; doing
 * it here keeps logical-call evidence honest and makes the constraint testable.
 */
export function resolveChatOutputTokenBudget(
  capabilities: LlmCapabilityProfile,
  target: number,
  strategyMinimum = 0,
): number {
  if (!Number.isInteger(target) || target < 1) {
    throw new TypeError("Chat output token target must be a positive integer.");
  }
  if (!Number.isInteger(strategyMinimum) || strategyMinimum < 0) {
    throw new TypeError(
      "Chat output token strategy minimum must be a non-negative integer.",
    );
  }
  const requested = Math.max(target, strategyMinimum);
  return capabilities.maxOutputTokens === undefined
    ? requested
    : Math.min(requested, capabilities.maxOutputTokens);
}
