import { z } from "zod";

import { EntityIdSchema } from "./primitives.js";

/** A transient, server-built view of source messages; never model-authored state. */
export const INTERACTION_EVIDENCE_POLICY_VERSION = "directed_interaction_v1";

export const InteractionSourceMessageSchema = z
  .object({
    id: EntityIdSchema,
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1),
  })
  .strict();
export type InteractionSourceMessage = z.infer<
  typeof InteractionSourceMessageSchema
>;

export const InteractionEvidenceAnchorSchema = z
  .object({
    id: EntityIdSchema,
    kind: z.enum(["communication_preference", "behavior_report"]),
    requestedBy: z.string().min(1).optional(),
    expectedActor: z.string().min(1),
    recipient: z.string().min(1),
    behavior: z.enum(["listen_first", "fewer_questions"]),
    scope: z.object({ topic: z.string().min(1).optional() }).strict(),
    modality: z.enum([
      "requested",
      "willing",
      "promised",
      "observed_once",
      "observed_repeated",
    ]),
    sourceMessageIds: z.array(EntityIdSchema).min(1),
    sourceQuotes: z
      .array(
        z
          .object({
            messageId: EntityIdSchema,
            role: z.literal("user"),
            text: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    /** Empty means no support in this snapshot, not proof it never happened. */
    observedAdherenceEvidenceIds: z.array(EntityIdSchema),
  })
  .strict();
export type InteractionEvidenceAnchor = z.infer<
  typeof InteractionEvidenceAnchorSchema
>;

export const InteractionEvidenceSnapshotSchema = z
  .object({
    policyVersion: z.literal(INTERACTION_EVIDENCE_POLICY_VERSION),
    userId: EntityIdSchema,
    characterId: EntityIdSchema,
    sourceMessages: z.array(InteractionSourceMessageSchema),
    historicalAnchors: z.array(InteractionEvidenceAnchorSchema),
    /** Applicability is separate from whether a request existed in history. */
    activePracticeAnchorIds: z.array(EntityIdSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const messages = new Map(
      snapshot.sourceMessages.map((message) => [message.id, message]),
    );
    const actors = new Set([
      `user:${snapshot.userId}`,
      `character:${snapshot.characterId}`,
    ]);
    for (const anchor of snapshot.historicalAnchors) {
      if (
        !actors.has(anchor.expectedActor) ||
        !actors.has(anchor.recipient) ||
        anchor.expectedActor === anchor.recipient ||
        (anchor.requestedBy !== undefined && !actors.has(anchor.requestedBy))
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Interaction participants must belong to this user and character",
          path: ["historicalAnchors"],
        });
      }
      if (
        anchor.sourceMessageIds.some(
          (id) => messages.get(id)?.role !== "user",
        ) ||
        anchor.sourceQuotes.some((quote) => {
          const source = messages.get(quote.messageId);
          return (
            !anchor.sourceMessageIds.includes(quote.messageId) ||
            source?.role !== "user" ||
            !source.text.includes(quote.text)
          );
        }) ||
        anchor.observedAdherenceEvidenceIds.some(
          (id) => messages.get(id)?.role !== "user",
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Interaction anchors require exact original user evidence",
          path: ["historicalAnchors"],
        });
      }
    }
    if (
      snapshot.activePracticeAnchorIds.some(
        (id) => !snapshot.historicalAnchors.some((anchor) => anchor.id === id),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Active practices must reference historical anchors",
        path: ["activePracticeAnchorIds"],
      });
    }
  });
export type InteractionEvidenceSnapshot = z.infer<
  typeof InteractionEvidenceSnapshotSchema
>;
