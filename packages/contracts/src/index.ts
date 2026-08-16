export * from "./api.js";
export * from "./character.js";
export * from "./events.js";
export * from "./llm.js";
export * from "./memory.js";
export * from "./messages.js";
export * from "./plugin.js";
export * from "./primitives.js";
export * from "./provenance.js";
export * from "./relationship.js";
export * from "./schedule.js";
export * from "./settings.js";
export * from "./simulation.js";
export * from "./state.js";
export * from "./turn.js";

// Conventional camel-case aliases used at runtime by Fastify feature modules.
export {
  CharacterSpecDraftSchema as characterDraftSchema,
  CharacterSpecSchema as characterSpecSchema,
  ImportedCharacterInputSchema as importedCharacterInputSchema,
  OriginalCharacterInputSchema as originalCharacterInputSchema,
} from "./character.js";
export { AgentTurnDecisionSchema as agentTurnDecisionSchema } from "./turn.js";
export {
  ScheduleEffectProposalSchema as scheduleEffectProposalSchema,
  ScheduleItemDraftSchema as scheduleItemDraftSchema,
  ScheduleItemSchema as scheduleItemSchema,
  SchedulePlanProposalSchema as schedulePlanSchema,
} from "./schedule.js";
export { RuntimeStateSchema as runtimeStateSchema } from "./state.js";
export {
  ActivityEnrichmentBatchSchema as activityEnrichmentBatchSchema,
  ActivityEnrichmentProposalSchema as activityEnrichmentSchema,
} from "./llm.js";
export { ServerChatMessageInputSchema as chatMessageInputSchema } from "./messages.js";
