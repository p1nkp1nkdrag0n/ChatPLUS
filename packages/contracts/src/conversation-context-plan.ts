import { z } from "zod";

import { EntityIdSchema } from "./primitives.js";

export const CONVERSATION_CONTEXT_POLICY_VERSION = "continuity_context_v2";

/** Retrieval and expression hints only; never a source of facts or authority. */
export const ConversationContextPlanSchema = z
  .object({
    policyVersion: z.literal(CONVERSATION_CONTEXT_POLICY_VERSION),
    originalQuery: z.string().min(1).max(20_000),
    expandedQueries: z.array(z.string().min(1).max(1_200)).max(3),
    contextMessageIds: z.array(EntityIdSchema).max(3),
    unresolvedReferences: z.array(z.string().min(1).max(80)).max(8),
    intent: z.enum([
      "sharing",
      "venting",
      "help",
      "recollection",
      "relationship_repair",
      "casual",
      "uncertain",
    ]),
    adviceRequested: z.boolean(),
    detailedAnalysisRequested: z.boolean(),
    supportStyle: z.enum([
      "listen",
      "respond_naturally",
      "offer_requested_help",
      "listen_then_help",
    ]),
    /** Optional for historical retrieval snapshots written before clause planning. */
    helpTiming: z
      .enum(["now", "after_user_finishes", "unspecified"])
      .optional(),
    requestPolicyVersion: z.literal("clause_requests_v1").optional(),
    maxRecallEvidence: z.number().int().min(1).max(8),
    maxExplicitMemories: z.number().int().min(0).max(8),
    allowCharacterLifeMention: z.boolean(),
  })
  .strict();
export type ConversationContextPlan = z.infer<
  typeof ConversationContextPlanSchema
>;
