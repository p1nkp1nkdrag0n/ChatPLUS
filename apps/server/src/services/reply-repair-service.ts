import {
  PersonaChatResponseSchema,
  type PersonaChatResponse,
} from "@personasim/contracts";
import type { ReplyStrategy } from "@personasim/features";

import {
  agentTurnDecisionSchema,
  type AgentTurnDecision,
  type CharacterSpec,
} from "../domain/schemas.js";
import {
  REPAIR_CHAT_TURN_OUTPUT_TOKEN_TARGET,
  resolveChatOutputTokenBudget,
} from "./chat-output-budget.js";
import type { LlmService } from "./llm-service.js";

/**
 * Owns the one-shot repair boundary for invalid provider output. Repairs are
 * intentionally model-only: they never validate or commit world effects.
 */
export class ReplyRepairService {
  constructor(private readonly llm: LlmService) {}

  async repairFixtureDecision(input: {
    spec: CharacterSpec;
    userText: string;
    invalidDecision: AgentTurnDecision | undefined;
    issues: unknown;
    fallback: AgentTurnDecision;
  }): Promise<AgentTurnDecision> {
    try {
      return await this.llm.generateObject({
        purpose: "repair_chat_turn",
        agentId: input.spec.id,
        maxRetries: 0,
        system:
          "Repair a fictional character turn. Preserve a truthful reply, remove or correct invalid schedule effects, and return only the requested JSON object.",
        prompt: `User message: ${input.userText}\nInvalid decision: ${JSON.stringify(
          input.invalidDecision ?? null,
        )}\nValidation issues: ${JSON.stringify(input.issues)}\nCharacter: ${JSON.stringify(
          {
            identity: input.spec.identity,
            persona: input.spec.persona,
          },
        )}`,
        schema: agentTurnDecisionSchema,
        fixture: input.fallback,
      });
    } catch {
      return input.fallback;
    }
  }

  async repairPersonaReply(input: {
    spec: CharacterSpec;
    userText: string;
    invalidResponse: PersonaChatResponse | undefined;
    issues: unknown;
    replyStrategy: ReplyStrategy;
  }): Promise<PersonaChatResponse | undefined> {
    try {
      const repaired = await this.llm.generateObject({
        purpose: "repair_chat_turn",
        agentId: input.spec.id,
        maxRetries: 0,
        maxOutputTokens: resolveChatOutputTokenBudget(
          this.llm.capabilities,
          REPAIR_CHAT_TURN_OUTPUT_TOKEN_TARGET,
          input.replyStrategy.maxOutputTokens,
        ),
        system:
          "Repair only the in-character conversational reply. Return one JSON object containing the complete required text plus optional toneTags and deliveryMode. chunks is optional and intended only for sequential delivery; omit chunks for single_block so the complete reply is not duplicated. Do not propose actions, schedules, memories, state changes, relationship changes, or hidden reasoning. Length guidance is soft: preserve useful substance and never pad merely to hit a number.",
        prompt:
          `Character role and persona: ${JSON.stringify({
            identity: input.spec.identity,
            persona: input.spec.persona,
            dialogue: input.spec.dialogue,
            forbiddenMetaKnowledge: input.spec.knowledge.forbiddenMetaKnowledge,
          })}\n` +
          `User message: ${JSON.stringify(input.userText)}\n` +
          `Invalid reply: ${JSON.stringify(input.invalidResponse ?? null)}\n` +
          `Persona guard issues to fix: ${JSON.stringify(input.issues)}\n` +
          `Soft reply strategy: ${JSON.stringify({
            complexity: input.replyStrategy.complexity,
            targetMinChars: input.replyStrategy.targetMinChars,
            targetMaxChars: input.replyStrategy.targetMaxChars,
            deliveryPreference: input.replyStrategy.deliveryPreference,
            preferredChunkCount: input.replyStrategy.preferredChunkCount,
          })}\n` +
          'Return at minimum {"text":"the complete repaired in-character reply"}. You may add toneTags and deliveryMode. Add chunks only when deliveryMode is sequential; omit chunks for single_block.',
        schema: PersonaChatResponseSchema,
      });
      return PersonaChatResponseSchema.parse(repaired);
    } catch {
      return undefined;
    }
  }
}
