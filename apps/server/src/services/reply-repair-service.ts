import {
  type EvidenceBundle,
  PersonaChatResponseSchema,
  type PersonaChatResponse,
} from "@personasim/contracts";
import type {
  ExplicitReplyConstraints,
  PromptMessageLike,
  ReplyStrategy,
} from "@personasim/features";

import {
  agentTurnDecisionSchema,
  type AgentTurnDecision,
  type CharacterSpec,
} from "../domain/schemas.js";
import type { LlmService } from "./llm-service.js";
import type { TurnReplyDirectives } from "./turn-execution-service.js";

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
    /** Pre-filtered persona context for enforced ContextPlan mode. */
    personaContext?: unknown;
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
          input.personaContext ?? {
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
    replyDirectives?: TurnReplyDirectives;
    evidenceContext?: EvidenceBundle;
    /** Server-selected same-session assertions; never assistant text. */
    recentUserFactEvidence?: readonly PromptMessageLike[];
    explicitReplyConstraints?: ExplicitReplyConstraints;
    /** Already-valid grounded anchors that a repair must retain verbatim. */
    preserveAnchors?: string[];
    /** Pre-filtered persona context for enforced ContextPlan mode. */
    personaContext?: unknown;
  }): Promise<PersonaChatResponse | undefined> {
    try {
      const personaContext =
        input.personaContext ??
        (input.evidenceContext === undefined &&
        (input.recentUserFactEvidence?.length ?? 0) === 0
          ? {
              identity: input.spec.identity,
              persona: input.spec.persona,
              dialogue: input.spec.dialogue,
              forbiddenMetaKnowledge:
                input.spec.knowledge.forbiddenMetaKnowledge,
            }
          : {
              identity: {
                name: input.spec.identity.name,
                timezone: input.spec.identity.timezone,
              },
              dialogue: input.spec.dialogue,
              boundaries: input.spec.persona.boundaries,
              forbiddenMetaKnowledge:
                input.spec.knowledge.forbiddenMetaKnowledge,
            });
      const repaired = await this.llm.generateObject({
        purpose: "repair_chat_turn",
        agentId: input.spec.id,
        maxRetries: 0,
        maxOutputTokens: input.replyStrategy.maxOutputTokens,
        system:
          "Repair only the in-character conversational reply. Return one JSON object containing the complete required text plus optional toneTags and deliveryMode. chunks is optional and intended only for sequential delivery; omit chunks for single_block so the complete reply is not duplicated. Treat supplied reply directives as authoritative facts and claim restrictions; never change their outcome. Preserve every supplied grounded anchor while changing only the invalid portion. When durable or recent-user evidence context is supplied, it is the sole source for user facts; never infer missing facts from persona, assistant text, or the invalid reply. Explicit point, sentence, brevity, topic-switch, and no-follow-up-question constraints are hard requirements. If forbidFollowUpQuestions is true, acknowledge the boundary and end without any question, invitation to continue, new-topic solicitation, or check-in. Do not propose actions, schedules, memories, state changes, relationship changes, or hidden reasoning. Other length guidance is soft: preserve useful substance and never pad merely to hit a number.",
        prompt:
          `Character role and persona: ${JSON.stringify(personaContext)}\n` +
          `User message: ${JSON.stringify(input.userText)}\n` +
          `Invalid reply: ${JSON.stringify(input.invalidResponse ?? null)}\n` +
          `Persona guard issues to fix: ${JSON.stringify(input.issues)}\n` +
          `Authoritative reply directives: ${JSON.stringify(input.replyDirectives ?? null)}\n` +
          `Allowed evidence context: ${JSON.stringify(input.evidenceContext ?? null)}\n` +
          `Allowed recent user fact evidence: ${JSON.stringify(input.recentUserFactEvidence ?? null)}\n` +
          `Grounded anchors that must be preserved: ${JSON.stringify(input.preserveAnchors ?? [])}\n` +
          `Explicit user reply constraints: ${JSON.stringify(input.explicitReplyConstraints ?? null)}\n` +
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
