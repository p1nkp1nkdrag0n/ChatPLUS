import { z } from "zod";

import { ContinuityTurnEffectsSchema } from "./follow-up.js";
import { MemoryCandidateSchema } from "./memory.js";
import { PersonalIntentCandidateSchema } from "./personal-intent.js";
import { AgentReplySchema } from "./messages.js";
import { ReasonCodeSchema, ShortTextSchema } from "./primitives.js";
import { RelationshipDeltaSchema } from "./relationship.js";
import { ScheduleEffectProposalSchema } from "./schedule.js";
import { RuntimeStateDeltaSchema } from "./state.js";

export const AgentTurnDecisionSchema = z
  .object({
    reply: AgentReplySchema,
    scheduleEffects: z.array(ScheduleEffectProposalSchema).max(10),
    stateDelta: RuntimeStateDeltaSchema.optional(),
    relationshipDelta: RelationshipDeltaSchema.optional(),
    memoryCandidates: z.array(MemoryCandidateSchema).max(8),
    personalIntentCandidates: z
      .array(PersonalIntentCandidateSchema)
      .max(8)
      .optional(),
    continuityEffects: ContinuityTurnEffectsSchema.optional(),
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict();
export type AgentTurnDecision = z.infer<typeof AgentTurnDecisionSchema>;

/** Compatibility name used by conversation feature modules. */
export const ChatTurnProposalSchema = AgentTurnDecisionSchema;
export type ChatTurnProposal = AgentTurnDecision;
