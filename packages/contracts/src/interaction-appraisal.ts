import { z } from "zod";

import {
  EntityIdSchema,
  RevisionSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import { RuntimeStateSchema } from "./state.js";

/** A brief authored character reaction, never reasoning or a user diagnosis. */
export const InteractionFeelingSchema = z.enum([
  "warmth",
  "curiosity",
  "appreciation",
  "concern",
  "relief",
  "uncertainty",
  "discomfort",
  "irritation",
  "disappointment",
  "fatigue",
]);
export const InteractionAttitudeSchema = z.enum([
  "receptive",
  "cautious",
  "ambivalent",
  "distant",
  "resistant",
]);

/** Bounded present subjective views cannot smuggle in fictional past actions,
 * user motives, consent claims, or a claim that a boundary was already voiced. */
export const INTERACTION_PRIVATE_VIEW_TEXT = {
  welcome_connection: "我愿意接近一些。",
  interested_in_understanding: "我对理解这件事有兴趣。",
  appreciate_trust: "我珍惜这份信任。",
  care_without_agreement: "我在意这份感受，但不代表我认同所有观点。",
  need_time_to_process: "我还需要一点时间消化。",
  need_more_space: "我现在需要多一点自己的空间。",
  not_ready_for_intimacy: "我还没有准备好这么亲密。",
  uncomfortable_with_topic: "这个话题让我有些不自在。",
  dislike_interaction_tone: "我不太喜欢这次交流的语气。",
  capacity_is_limited: "我在意，却暂时没有余力承接更多。",
  mixed_response: "我的感受有些复杂，还不能简单归为喜欢或反感。",
  prefer_a_slower_pace: "我希望交流的节奏慢一些。",
} as const;
export const InteractionPrivateViewSchema = z.enum(
  Object.keys(INTERACTION_PRIVATE_VIEW_TEXT) as [
    keyof typeof INTERACTION_PRIVATE_VIEW_TEXT,
    ...Array<keyof typeof INTERACTION_PRIVATE_VIEW_TEXT>,
  ],
);

export const InteractionAppraisalCandidateSchema = z
  .object({
    triggerQuote: z.string().trim().min(1).max(1_000),
    feelings: z.array(InteractionFeelingSchema).min(1).max(3),
    attitude: InteractionAttitudeSchema,
    publicExpression: z.string().trim().min(1).max(1_000),
    privateView: z.array(InteractionPrivateViewSchema).min(1).max(3),
  })
  .strict();
export type InteractionAppraisalCandidate = z.infer<
  typeof InteractionAppraisalCandidateSchema
>;

const InteractionAppraisalSourceSchema = z
  .object({
    id: EntityIdSchema,
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1),
    createdAtUtc: UtcDateTimeSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Server-owned receipt. This describes a character's reaction, not new facts
 * about either participant, and must stay outside factual memory projections. */
export const InteractionAppraisalSchema =
  InteractionAppraisalCandidateSchema.extend({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema,
    sourceMessageIds: z.tuple([EntityIdSchema, EntityIdSchema]),
    sources: z.tuple([
      InteractionAppraisalSourceSchema,
      InteractionAppraisalSourceSchema,
    ]),
    recordedAtUtc: UtcDateTimeSchema,
    characterVersion: RevisionSchema,
    characterSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
    effectivePersonaRevision: RevisionSchema.optional(),
    stateRevision: RevisionSchema,
    closeness: UnitIntervalSchema,
    runtimeState: RuntimeStateSchema,
    privateViewText: z.string().min(1).max(500),
    validationVersion: z.literal("interaction_appraisal_v1"),
    authority: z.literal("subjective_character_reaction"),
  }).strict();
export type InteractionAppraisal = z.infer<typeof InteractionAppraisalSchema>;
