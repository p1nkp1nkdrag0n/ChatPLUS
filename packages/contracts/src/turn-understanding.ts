import { z } from "zod";

import { ModelTurnEffectsProposalSchema } from "./persona-chat-decision.js";

/** The semantic lane selected for a user turn before any reply is generated. */
export const TurnRouteSchema = z.enum([
  "conversation",
  "schedule_query",
  "schedule_mutation",
  "explicit_memory",
  "continuity",
  "mixed",
  "ambiguous",
]);
export type TurnRoute = z.infer<typeof TurnRouteSchema>;

export const TurnDialogueActSchema = z.enum([
  "inform",
  "ask",
  "invite",
  "confirm",
  "decline",
  "request_memory",
  "request_follow_up",
  "quote",
  "hypothesize",
]);
export type TurnDialogueAct = z.infer<typeof TurnDialogueActSchema>;

/** A verbatim quote proposed by the model. Grounding happens on the server. */
export const EvidenceQuoteSchema = z
  .object({
    text: z.string().trim().min(1).max(500),
  })
  .strict();
export type EvidenceQuote = z.infer<typeof EvidenceQuoteSchema>;

export const ScheduleIntentProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("query_schedule"),
      evidenceQuotes: z.array(EvidenceQuoteSchema).min(1).max(4),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_shared_activity"),
      activityQuote: EvidenceQuoteSchema,
      timeQuote: EvidenceQuoteSchema.optional(),
      participantQuote: EvidenceQuoteSchema.optional(),
      durationMinutes: z
        .number()
        .int()
        .positive()
        .max(24 * 60)
        .optional(),
      missingFields: z
        .array(z.enum(["activity", "time", "participant"]))
        .max(3),
    })
    .strict(),
  z
    .object({
      kind: z.literal("confirm_pending_offer"),
      evidenceQuotes: z.array(EvidenceQuoteSchema).min(1).max(4),
    })
    .strict(),
  z
    .object({
      kind: z.literal("decline_pending_offer"),
      evidenceQuotes: z.array(EvidenceQuoteSchema).min(1).max(4),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unsupported_mutation"),
      operation: z.enum(["cancel", "delete", "reschedule", "move", "other"]),
      evidenceQuotes: z.array(EvidenceQuoteSchema).min(1).max(4),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ambiguous"),
      evidenceQuotes: z.array(EvidenceQuoteSchema).max(4),
      missingFields: z.array(z.string().trim().min(1).max(64)).max(8),
    })
    .strict(),
]);
export type ScheduleIntentProposal = z.infer<
  typeof ScheduleIntentProposalSchema
>;

export const TurnTopicProposalSchema = z
  .object({
    key: z.string().trim().min(1).max(120),
    domain: z.string().trim().min(1).max(80),
    confidence: z.number().min(0).max(1),
    evidenceQuotes: z.array(EvidenceQuoteSchema).max(4),
  })
  .strict();
export type TurnTopicProposal = z.infer<typeof TurnTopicProposalSchema>;

/**
 * Untrusted, reply-free semantic observation. Schedule terms remain quotes,
 * and every world-effect sibling remains independently validatable later.
 */
export const TurnObservationProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    route: TurnRouteSchema,
    dialogueActs: z.array(TurnDialogueActSchema).max(8),
    topics: z.array(TurnTopicProposalSchema).max(8),
    scheduleIntent: ScheduleIntentProposalSchema,
    worldEffects: ModelTurnEffectsProposalSchema,
    salientUserQuotes: z.array(EvidenceQuoteSchema).max(6),
    uncertainty: z.array(z.string().trim().min(1).max(240)).max(8),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type TurnObservationProposal = z.infer<
  typeof TurnObservationProposalSchema
>;
