import { z } from "zod";

import { ScheduleCategorySchema } from "./schedule.js";

const ActivitySchema = z.string().trim().min(1).max(160);
const StartAtSchema = z.string().trim().min(1).max(120);
const DurationMinutesSchema = z.number().int().positive().max(1_440);
const EvidenceQuotesSchema = z
  .array(z.string().trim().min(1).max(500))
  .min(1)
  .max(8);

/**
 * A create-only schedule offer expressed in conversation terms. A complete
 * offer is still only pending until a later user turn explicitly confirms its
 * persisted version. The server resolves all authoritative command terms.
 */
export const ScheduleNegotiationOfferSchema = z
  .object({
    activity: ActivitySchema,
    category: ScheduleCategorySchema,
    startAt: StartAtSchema,
    durationMinutes: DurationMinutesSchema.optional(),
    evidenceQuotes: EvidenceQuotesSchema,
  })
  .strict();
export type ScheduleNegotiationOffer = z.infer<
  typeof ScheduleNegotiationOfferSchema
>;

/** Known offer details may be retained while the character asks for more. */
export const PartialScheduleNegotiationOfferSchema = z
  .object({
    activity: ActivitySchema.optional(),
    category: ScheduleCategorySchema.optional(),
    startAt: StartAtSchema.optional(),
    durationMinutes: DurationMinutesSchema.optional(),
    evidenceQuotes: EvidenceQuotesSchema.optional(),
  })
  .strict();
export type PartialScheduleNegotiationOffer = z.infer<
  typeof PartialScheduleNegotiationOfferSchema
>;

export const ScheduleNegotiationActionKindSchema = z.enum([
  "none",
  "request_details",
  "propose_offer",
  "accept_user_offer",
  "accept_pending_offer",
  "decline_offer",
  "withdraw_offer",
]);
export type ScheduleNegotiationActionKind = z.infer<
  typeof ScheduleNegotiationActionKindSchema
>;

const NoScheduleActionSchema = z.object({ kind: z.literal("none") }).strict();

const RequestScheduleDetailsActionSchema = z
  .object({
    kind: z.literal("request_details"),
    offer: PartialScheduleNegotiationOfferSchema.optional(),
  })
  .strict();

const ProposeScheduleOfferActionSchema = z
  .object({
    kind: z.literal("propose_offer"),
    offer: ScheduleNegotiationOfferSchema,
  })
  .strict();

const AcceptUserScheduleOfferActionSchema = z
  .object({
    kind: z.literal("accept_user_offer"),
    offer: ScheduleNegotiationOfferSchema,
  })
  .strict();

const AcceptPendingScheduleOfferActionSchema = z
  .object({
    kind: z.literal("accept_pending_offer"),
    evidenceQuotes: EvidenceQuotesSchema,
  })
  .strict();

const DeclineScheduleOfferActionSchema = z
  .object({ kind: z.literal("decline_offer") })
  .strict();

const WithdrawScheduleOfferActionSchema = z
  .object({ kind: z.literal("withdraw_offer") })
  .strict();

/**
 * Model-facing dialogue behavior for the create-only negotiation MVP.
 * accept_user_offer records willingness and presents a pending offer; it does
 * not commit in the same turn. Only accept_pending_offer can commit, and only
 * from a later user turn.
 * Accepting a pending offer intentionally carries no restated offer so the
 * server must use the persisted, versioned terms it originally presented.
 * Its evidence can only quote the current user's confirmation.
 */
export const ScheduleNegotiationActionSchema = z.discriminatedUnion("kind", [
  NoScheduleActionSchema,
  RequestScheduleDetailsActionSchema,
  ProposeScheduleOfferActionSchema,
  AcceptUserScheduleOfferActionSchema,
  AcceptPendingScheduleOfferActionSchema,
  DeclineScheduleOfferActionSchema,
  WithdrawScheduleOfferActionSchema,
]);
export type ScheduleNegotiationAction = z.infer<
  typeof ScheduleNegotiationActionSchema
>;
