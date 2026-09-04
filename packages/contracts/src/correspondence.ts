import { z } from "zod";

import { LocalDateSchema } from "./life.js";
import { KeepsakeKindSchema } from "./keepsake.js";
import {
  EntityIdSchema,
  IanaTimezoneSchema,
  JsonValueSchema,
  ReasonCodeSchema,
  RevisionSchema,
  ShortTextSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";

const CORRESPONDENCE_SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const CorrespondenceSha256Schema = z
  .string()
  .regex(CORRESPONDENCE_SHA_256_PATTERN, "Expected a lowercase SHA-256 digest");

export const CorrespondenceThreadStatusSchema = z.enum(["open", "closed"]);
export type CorrespondenceThreadStatus = z.infer<
  typeof CorrespondenceThreadStatusSchema
>;

export const LetterDirectionSchema = z.enum(["user_to_agent", "agent_to_user"]);
export type LetterDirection = z.infer<typeof LetterDirectionSchema>;

export const LetterStatusSchema = z.enum([
  "draft",
  "sealed",
  "in_transit",
  "delivered_unread",
  "read",
  "cancelled",
]);
export type LetterStatus = z.infer<typeof LetterStatusSchema>;

export const LetterGenerationRunStatusSchema = z.enum([
  "pending",
  "generating",
  "retryable",
  "committed",
  "failed",
  "discarded",
]);
export type LetterGenerationRunStatus = z.infer<
  typeof LetterGenerationRunStatusSchema
>;

export const TemporalTaskStatusSchema = z.enum([
  "pending",
  "claimed",
  "completed",
  "retryable",
  "dead_letter",
]);
export type TemporalTaskStatus = z.infer<typeof TemporalTaskStatusSchema>;

export const TemporalTaskKindSchema = z.enum([
  "letter.outbound_arrival",
  "letter.reply_generation",
  "letter.return_arrival",
  "letter.generation_retry",
  "keepsake.generate",
]);
export type TemporalTaskKind = z.infer<typeof TemporalTaskKindSchema>;

export const LetterTransitPolicyVersionSchema = z.literal("fixed_5d_v1");
export type LetterTransitPolicyVersion = z.infer<
  typeof LetterTransitPolicyVersionSchema
>;

export const FixedTransitPolicyV1Schema = z
  .object({
    version: LetterTransitPolicyVersionSchema,
    outboundDays: z.literal(5),
    returnDays: z.literal(5),
    progressBasis: z.literal("wall_clock"),
    displayPrecision: z.literal("day"),
  })
  .strict();
export type FixedTransitPolicyV1Contract = z.infer<
  typeof FixedTransitPolicyV1Schema
>;

export const CorrespondenceThreadSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    status: CorrespondenceThreadStatusSchema,
    rootLetterId: EntityIdSchema.optional(),
    latestLetterId: EntityIdSchema.optional(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
    closedAtUtc: UtcDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((thread, context) => {
    if (thread.status === "closed" && thread.closedAtUtc === undefined) {
      context.addIssue({
        code: "custom",
        message: "A closed correspondence thread requires closedAtUtc",
        path: ["closedAtUtc"],
      });
    }
    if (thread.status === "open" && thread.closedAtUtc !== undefined) {
      context.addIssue({
        code: "custom",
        message: "An open correspondence thread cannot have closedAtUtc",
        path: ["closedAtUtc"],
      });
    }
    if (
      thread.rootLetterId === undefined &&
      thread.latestLetterId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "latestLetterId requires rootLetterId",
        path: ["latestLetterId"],
      });
    }
    if (Date.parse(thread.updatedAtUtc) < Date.parse(thread.createdAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "updatedAtUtc cannot precede createdAtUtc",
        path: ["updatedAtUtc"],
      });
    }
    if (
      thread.closedAtUtc !== undefined &&
      Date.parse(thread.closedAtUtc) < Date.parse(thread.createdAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "closedAtUtc cannot precede createdAtUtc",
        path: ["closedAtUtc"],
      });
    }
    if (
      thread.closedAtUtc !== undefined &&
      Date.parse(thread.closedAtUtc) < Date.parse(thread.updatedAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "closedAtUtc cannot precede updatedAtUtc",
        path: ["closedAtUtc"],
      });
    }
  });
export type CorrespondenceThread = z.infer<typeof CorrespondenceThreadSchema>;

const LetterSubjectSchema = z.string().trim().min(1).max(240);
const LetterPlaintextBodySchema = z.string().max(50_000);

export const LetterSchema = z
  .object({
    id: EntityIdSchema,
    threadId: EntityIdSchema,
    agentId: EntityIdSchema,
    replyToLetterId: EntityIdSchema.optional(),
    direction: LetterDirectionSchema,
    status: LetterStatusSchema,
    subject: LetterSubjectSchema.optional(),
    body: LetterPlaintextBodySchema.optional(),
    contentHash: CorrespondenceSha256Schema.optional(),
    transitPolicyVersion: LetterTransitPolicyVersionSchema.optional(),
    transitTimezone: IanaTimezoneSchema.optional(),
    dispatchedAtUtc: UtcDateTimeSchema.optional(),
    arrivalDueAtUtc: UtcDateTimeSchema.optional(),
    effectiveAuthorTimeUtc: UtcDateTimeSchema.optional(),
    deliveredEffectiveAtUtc: UtcDateTimeSchema.optional(),
    processedAtUtc: UtcDateTimeSchema.optional(),
    readAtUtc: UtcDateTimeSchema.optional(),
    openedAtUtc: UtcDateTimeSchema.optional(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((letter, context) => {
    const transportFields = [
      ["contentHash", letter.contentHash],
      ["transitPolicyVersion", letter.transitPolicyVersion],
      ["transitTimezone", letter.transitTimezone],
      ["dispatchedAtUtc", letter.dispatchedAtUtc],
      ["arrivalDueAtUtc", letter.arrivalDueAtUtc],
      ["effectiveAuthorTimeUtc", letter.effectiveAuthorTimeUtc],
    ] as const;

    if (letter.status === "draft" || letter.status === "cancelled") {
      for (const [field, value] of transportFields) {
        if (value !== undefined) {
          context.addIssue({
            code: "custom",
            message: `${letter.status} letters cannot have ${field}`,
            path: [field],
          });
        }
      }
      if (
        letter.deliveredEffectiveAtUtc !== undefined ||
        letter.processedAtUtc !== undefined ||
        letter.readAtUtc !== undefined ||
        letter.openedAtUtc !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: `${letter.status} letters cannot have delivery timestamps`,
          path: ["status"],
        });
      }
    } else {
      for (const [field, value] of transportFields) {
        if (value === undefined) {
          context.addIssue({
            code: "custom",
            message: `${letter.status} letters require ${field}`,
            path: [field],
          });
        }
      }
    }

    if (
      (letter.status === "delivered_unread" || letter.status === "read") &&
      (letter.deliveredEffectiveAtUtc === undefined ||
        letter.processedAtUtc === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Delivered letters require effective and processed delivery timestamps",
        path: ["deliveredEffectiveAtUtc"],
      });
    }
    if (
      (letter.status === "sealed" || letter.status === "in_transit") &&
      (letter.deliveredEffectiveAtUtc !== undefined ||
        letter.processedAtUtc !== undefined ||
        letter.readAtUtc !== undefined ||
        letter.openedAtUtc !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: `${letter.status} letters cannot have delivery timestamps`,
        path: ["status"],
      });
    }
    if (
      letter.status === "read" &&
      letter.direction === "user_to_agent" &&
      (letter.readAtUtc === undefined || letter.openedAtUtc !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A read user letter requires readAtUtc and cannot have openedAtUtc",
        path: ["readAtUtc"],
      });
    }
    if (
      letter.status === "read" &&
      letter.direction === "user_to_agent" &&
      letter.readAtUtc !== undefined &&
      letter.deliveredEffectiveAtUtc !== undefined &&
      letter.readAtUtc !== letter.deliveredEffectiveAtUtc
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A user letter must be read at its effective delivery timestamp",
        path: ["readAtUtc"],
      });
    }
    if (
      letter.status === "read" &&
      letter.direction === "agent_to_user" &&
      (letter.openedAtUtc === undefined || letter.readAtUtc !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A read agent reply requires openedAtUtc and cannot have readAtUtc",
        path: ["openedAtUtc"],
      });
    }
    if (
      letter.status !== "read" &&
      (letter.readAtUtc !== undefined || letter.openedAtUtc !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only read letters can have readAtUtc or openedAtUtc",
        path: [letter.readAtUtc === undefined ? "openedAtUtc" : "readAtUtc"],
      });
    }

    if (letter.direction === "agent_to_user") {
      if (letter.subject !== undefined || letter.body !== undefined) {
        context.addIssue({
          code: "custom",
          message:
            "Agent reply plaintext must remain outside the letter record and encrypted at rest",
          path: [letter.body === undefined ? "subject" : "body"],
        });
      }
      if (letter.status !== "draft" && letter.replyToLetterId === undefined) {
        context.addIssue({
          code: "custom",
          message: "A sealed agent reply requires replyToLetterId",
          path: ["replyToLetterId"],
        });
      }
    }
    if (letter.direction === "user_to_agent" && letter.body === undefined) {
      context.addIssue({
        code: "custom",
        message: "A user letter requires a body field",
        path: ["body"],
      });
    } else if (
      letter.direction === "user_to_agent" &&
      letter.status !== "draft" &&
      letter.status !== "cancelled" &&
      letter.body?.trim().length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "A sealed user letter requires a non-empty body",
        path: ["body"],
      });
    }

    if (
      letter.dispatchedAtUtc !== undefined &&
      letter.arrivalDueAtUtc !== undefined &&
      Date.parse(letter.arrivalDueAtUtc) <= Date.parse(letter.dispatchedAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "arrivalDueAtUtc must be later than dispatchedAtUtc",
        path: ["arrivalDueAtUtc"],
      });
    }
    if (
      letter.effectiveAuthorTimeUtc !== undefined &&
      letter.dispatchedAtUtc !== undefined &&
      Date.parse(letter.effectiveAuthorTimeUtc) >
        Date.parse(letter.dispatchedAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "effectiveAuthorTimeUtc cannot be later than dispatchedAtUtc",
        path: ["effectiveAuthorTimeUtc"],
      });
    }
    if (
      letter.deliveredEffectiveAtUtc !== undefined &&
      letter.dispatchedAtUtc !== undefined &&
      Date.parse(letter.deliveredEffectiveAtUtc) <
        Date.parse(letter.dispatchedAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "deliveredEffectiveAtUtc cannot precede dispatchedAtUtc",
        path: ["deliveredEffectiveAtUtc"],
      });
    }
    if (
      letter.deliveredEffectiveAtUtc !== undefined &&
      letter.processedAtUtc !== undefined &&
      Date.parse(letter.processedAtUtc) <
        Date.parse(letter.deliveredEffectiveAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "processedAtUtc cannot precede deliveredEffectiveAtUtc",
        path: ["processedAtUtc"],
      });
    }
    if (
      letter.deliveredEffectiveAtUtc !== undefined &&
      letter.readAtUtc !== undefined &&
      Date.parse(letter.readAtUtc) < Date.parse(letter.deliveredEffectiveAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "readAtUtc cannot precede deliveredEffectiveAtUtc",
        path: ["readAtUtc"],
      });
    }
    if (
      letter.deliveredEffectiveAtUtc !== undefined &&
      letter.openedAtUtc !== undefined &&
      Date.parse(letter.openedAtUtc) <
        Date.parse(letter.deliveredEffectiveAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "openedAtUtc cannot precede deliveredEffectiveAtUtc",
        path: ["openedAtUtc"],
      });
    }
    if (Date.parse(letter.updatedAtUtc) < Date.parse(letter.createdAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "updatedAtUtc cannot precede createdAtUtc",
        path: ["updatedAtUtc"],
      });
    }
  });
export type Letter = z.infer<typeof LetterSchema>;

const Base64ValueSchema = z
  .string()
  .min(1)
  .max(100_000)
  .regex(BASE64_PATTERN, "Expected a base64-encoded value");

export const EncryptedLetterBodySchema = z
  .object({
    letterId: EntityIdSchema,
    ciphertext: Base64ValueSchema,
    iv: Base64ValueSchema,
    authTag: Base64ValueSchema,
    keyVersion: z.number().int().positive(),
    aadHash: CorrespondenceSha256Schema,
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict();
export type EncryptedLetterBody = z.infer<typeof EncryptedLetterBodySchema>;

export const CorrespondenceJsonObjectSchema = z.record(
  z.string(),
  JsonValueSchema,
);

const LetterGenerationSourceWindowSchema = z
  .object({
    fromUtc: UtcDateTimeSchema,
    throughUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((window, context) => {
    if (Date.parse(window.throughUtc) < Date.parse(window.fromUtc)) {
      context.addIssue({
        code: "custom",
        message: "sourceWindow.throughUtc cannot precede fromUtc",
        path: ["throughUtc"],
      });
    }
  });

const LetterGenerationCharacterContextSchema = z
  .object({
    version: z.number().int().positive(),
    identity: CorrespondenceJsonObjectSchema,
    persona: CorrespondenceJsonObjectSchema,
    dialogue: CorrespondenceJsonObjectSchema,
    userRelationship: CorrespondenceJsonObjectSchema,
    knowledge: CorrespondenceJsonObjectSchema,
  })
  .strict();

const LetterGenerationFuzzyLifeContextSchema = z
  .object({
    dailyContext: JsonValueSchema,
    intents: z.array(CorrespondenceJsonObjectSchema).max(1_000),
    threads: z.array(CorrespondenceJsonObjectSchema).max(1_000),
    verifiedOutcomes: z.array(CorrespondenceJsonObjectSchema).max(2_000),
    causalRecords: z.array(CorrespondenceJsonObjectSchema).max(2_000),
  })
  .strict();

const LetterGenerationIntervalDigestSchema = z
  .object({
    activityEvents: z.array(CorrespondenceJsonObjectSchema).max(2_000),
    lifeOutcomes: z.array(CorrespondenceJsonObjectSchema).max(2_000),
  })
  .strict();

export const LetterGenerationKeepsakeEvidenceSchema = z
  .object({
    id: EntityIdSchema,
    recordType: z.literal("keepsake"),
    title: z.string().trim().min(1).max(160),
    kind: KeepsakeKindSchema,
    description: z.string().trim().min(1).max(2_000),
    sourceEventIds: z.array(EntityIdSchema).max(24),
    sourceMemoryIds: z.array(EntityIdSchema).max(24),
    sourceLetterIds: z.array(EntityIdSchema).max(24),
    createdEffectiveAtUtc: UtcDateTimeSchema,
    readyAtUtc: UtcDateTimeSchema,
  })
  .strict();
export type LetterGenerationKeepsakeEvidence = z.infer<
  typeof LetterGenerationKeepsakeEvidenceSchema
>;

const LetterGenerationContextV1RawSchema = z
  .object({
    schemaVersion: z.literal(1),
    effectiveAtUtc: UtcDateTimeSchema,
    sourceWindow: LetterGenerationSourceWindowSchema,
    character: LetterGenerationCharacterContextSchema,
    runtimeState: CorrespondenceJsonObjectSchema,
    relationship: CorrespondenceJsonObjectSchema,
    fuzzyLife: LetterGenerationFuzzyLifeContextSchema,
    intervalDigest: LetterGenerationIntervalDigestSchema,
    memoryEvidence: z.array(CorrespondenceJsonObjectSchema).max(2_000),
    conversationTail: z.array(CorrespondenceJsonObjectSchema).max(500),
    priorCorrespondence: z.array(CorrespondenceJsonObjectSchema).max(500),
    // Optional for backward compatibility with already-frozen v1 snapshots.
    // Newly frozen snapshots always persist a bounded array.
    readyKeepsakes: z
      .array(LetterGenerationKeepsakeEvidenceSchema)
      .max(100)
      .optional(),
    budgets: CorrespondenceJsonObjectSchema,
  })
  .strict()
  .superRefine((generationContext, context) => {
    if (
      generationContext.sourceWindow.throughUtc !==
      generationContext.effectiveAtUtc
    ) {
      context.addIssue({
        code: "custom",
        message:
          "sourceWindow.throughUtc must equal the generation effective time",
        path: ["sourceWindow", "throughUtc"],
      });
    }
  });
type LetterGenerationContextV1Raw = z.infer<
  typeof LetterGenerationContextV1RawSchema
>;
type LetterGenerationContextV1Base = Omit<
  LetterGenerationContextV1Raw,
  "readyKeepsakes"
>;
export type LetterGenerationContextV1 =
  | LetterGenerationContextV1Base
  | (LetterGenerationContextV1Base & {
      readyKeepsakes: LetterGenerationKeepsakeEvidence[];
    });

// The union keeps old v1 objects (no property) and new v1 objects (a concrete
// JSON array) assignable to JsonValue. An optional `T | undefined` property
// would not be part of the JSON domain under exactOptionalPropertyTypes.
export const LetterGenerationContextV1Schema =
  LetterGenerationContextV1RawSchema as z.ZodType<LetterGenerationContextV1>;

export const LetterGenerationSnapshotSchema = z
  .object({
    id: EntityIdSchema,
    incomingLetterId: EntityIdSchema,
    agentId: EntityIdSchema,
    effectiveAtUtc: UtcDateTimeSchema,
    characterVersion: z.number().int().positive(),
    stateRevision: RevisionSchema,
    contextJson: LetterGenerationContextV1Schema,
    evidenceIds: z.array(EntityIdSchema).max(2_000),
    contextHash: CorrespondenceSha256Schema,
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (new Set(snapshot.evidenceIds).size !== snapshot.evidenceIds.length) {
      context.addIssue({
        code: "custom",
        message: "evidenceIds must be unique",
        path: ["evidenceIds"],
      });
    }
    if (snapshot.contextJson.effectiveAtUtc !== snapshot.effectiveAtUtc) {
      context.addIssue({
        code: "custom",
        message: "Snapshot context effective time must match effectiveAtUtc",
        path: ["contextJson", "effectiveAtUtc"],
      });
    }
    if (snapshot.contextJson.character.version !== snapshot.characterVersion) {
      context.addIssue({
        code: "custom",
        message: "Snapshot character version must match context character",
        path: ["contextJson", "character", "version"],
      });
    }
    if (
      Date.parse(snapshot.createdAtUtc) < Date.parse(snapshot.effectiveAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "createdAtUtc cannot precede effectiveAtUtc",
        path: ["createdAtUtc"],
      });
    }
  });
export type LetterGenerationSnapshot = z.infer<
  typeof LetterGenerationSnapshotSchema
>;

export const LetterGenerationRunSchema = z
  .object({
    id: EntityIdSchema,
    incomingLetterId: EntityIdSchema,
    snapshotId: EntityIdSchema,
    agentId: EntityIdSchema,
    replyLetterId: EntityIdSchema.optional(),
    claimToken: EntityIdSchema.optional(),
    generationEpoch: RevisionSchema,
    status: LetterGenerationRunStatusSchema,
    attempt: z.number().int().nonnegative(),
    claimedAtUtc: UtcDateTimeSchema.optional(),
    leaseExpiresAtUtc: UtcDateTimeSchema.optional(),
    provider: ShortTextSchema.optional(),
    model: ShortTextSchema.optional(),
    errorCode: ReasonCodeSchema.optional(),
    resultHash: CorrespondenceSha256Schema.optional(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
    committedAtUtc: UtcDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    if (
      run.status === "generating" &&
      (run.claimToken === undefined ||
        run.claimedAtUtc === undefined ||
        run.leaseExpiresAtUtc === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A generating run requires a claim token and lease",
        path: ["claimToken"],
      });
    }
    if (
      run.status !== "generating" &&
      (run.claimToken !== undefined ||
        run.claimedAtUtc !== undefined ||
        run.leaseExpiresAtUtc !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only a generating run can retain an active claim or lease",
        path: ["claimToken"],
      });
    }
    if (
      run.status === "committed" &&
      (run.committedAtUtc === undefined ||
        run.replyLetterId === undefined ||
        run.provider === undefined ||
        run.model === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A committed run requires provider, model, and committedAtUtc",
        path: ["committedAtUtc"],
      });
    }
    if (run.status !== "committed" && run.committedAtUtc !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only a committed run can have committedAtUtc",
        path: ["committedAtUtc"],
      });
    }
    if (run.status !== "committed" && run.replyLetterId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only a committed run can have replyLetterId",
        path: ["replyLetterId"],
      });
    }
    if (
      run.claimedAtUtc !== undefined &&
      run.leaseExpiresAtUtc !== undefined &&
      Date.parse(run.leaseExpiresAtUtc) <= Date.parse(run.claimedAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "leaseExpiresAtUtc must be later than claimedAtUtc",
        path: ["leaseExpiresAtUtc"],
      });
    }
    if (Date.parse(run.updatedAtUtc) < Date.parse(run.createdAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "updatedAtUtc cannot precede createdAtUtc",
        path: ["updatedAtUtc"],
      });
    }
  });
export type LetterGenerationRun = z.infer<typeof LetterGenerationRunSchema>;

export const TemporalTaskSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    kind: TemporalTaskKindSchema,
    entityId: EntityIdSchema,
    dueAtUtc: UtcDateTimeSchema,
    priority: z.number().int().nonnegative().max(10_000),
    status: TemporalTaskStatusSchema,
    claimToken: EntityIdSchema.optional(),
    claimedAtUtc: UtcDateTimeSchema.optional(),
    leaseExpiresAtUtc: UtcDateTimeSchema.optional(),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(1).max(512),
    payload: CorrespondenceJsonObjectSchema,
    lastErrorCode: ReasonCodeSchema.optional(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
    completedAtUtc: UtcDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.attempt > task.maxAttempts) {
      context.addIssue({
        code: "custom",
        message: "attempt cannot exceed maxAttempts",
        path: ["attempt"],
      });
    }
    if (
      task.status === "claimed" &&
      (task.claimToken === undefined ||
        task.claimedAtUtc === undefined ||
        task.leaseExpiresAtUtc === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A claimed task requires a claim token and lease",
        path: ["claimToken"],
      });
    }
    if (
      task.status !== "claimed" &&
      (task.claimToken !== undefined ||
        task.claimedAtUtc !== undefined ||
        task.leaseExpiresAtUtc !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only a claimed task can retain an active claim or lease",
        path: ["claimToken"],
      });
    }
    if (task.status === "completed" && task.completedAtUtc === undefined) {
      context.addIssue({
        code: "custom",
        message: "A completed task requires completedAtUtc",
        path: ["completedAtUtc"],
      });
    }
    if (task.status !== "completed" && task.completedAtUtc !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only a completed task can have completedAtUtc",
        path: ["completedAtUtc"],
      });
    }
    if (
      task.claimedAtUtc !== undefined &&
      task.leaseExpiresAtUtc !== undefined &&
      Date.parse(task.leaseExpiresAtUtc) <= Date.parse(task.claimedAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "leaseExpiresAtUtc must be later than claimedAtUtc",
        path: ["leaseExpiresAtUtc"],
      });
    }
    if (Date.parse(task.updatedAtUtc) < Date.parse(task.createdAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "updatedAtUtc cannot precede createdAtUtc",
        path: ["updatedAtUtc"],
      });
    }
  });
export type TemporalTask = z.infer<typeof TemporalTaskSchema>;

export const LetterReplyGenerationTaskPayloadSchema = z
  .object({
    incomingLetterId: EntityIdSchema,
    snapshotId: EntityIdSchema,
    generationEpoch: z.number().int().nonnegative(),
  })
  .strict();
export type LetterReplyGenerationTaskPayload = z.infer<
  typeof LetterReplyGenerationTaskPayloadSchema
>;

export const LetterReplyProposalSchema = z
  .object({
    subject: LetterSubjectSchema,
    salutation: ShortTextSchema,
    paragraphs: z.array(z.string().trim().min(1).max(4_000)).min(1).max(24),
    closing: ShortTextSchema,
    signature: ShortTextSchema,
    postscript: z.string().trim().min(1).max(2_000).optional(),
    referencedEvidenceIds: z.array(EntityIdSchema).max(2_000),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (
      new Set(proposal.referencedEvidenceIds).size !==
      proposal.referencedEvidenceIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "referencedEvidenceIds must be unique",
        path: ["referencedEvidenceIds"],
      });
    }
    const totalLength =
      proposal.subject.length +
      proposal.salutation.length +
      proposal.paragraphs.reduce(
        (sum, paragraph) => sum + paragraph.length,
        0,
      ) +
      proposal.closing.length +
      proposal.signature.length +
      (proposal.postscript?.length ?? 0);
    if (totalLength > 50_000) {
      context.addIssue({
        code: "custom",
        message: "Letter reply content exceeds the maximum total length",
        path: ["paragraphs"],
      });
    }
  });
export type LetterReplyProposal = z.infer<typeof LetterReplyProposalSchema>;

/**
 * Safe mailbox projection. It intentionally has no plaintext reply body and no
 * encryption fields. `previewText` is populated only for user-authored or
 * already-opened letters by the server projector.
 */
export const LetterSummaryResponseSchema = z
  .object({
    id: EntityIdSchema,
    threadId: EntityIdSchema,
    direction: LetterDirectionSchema,
    status: LetterStatusSchema,
    authoredDisplayDate: LocalDateSchema,
    dispatchedAtUtc: UtcDateTimeSchema.optional(),
    arrivalDueAtUtc: UtcDateTimeSchema.optional(),
    progress: UnitIntervalSchema,
    postmark: ShortTextSchema,
    canOpen: z.boolean(),
    canEdit: z.boolean(),
    previewText: z.string().max(240).optional(),
  })
  .strict()
  .superRefine((letter, context) => {
    const shouldBeOpenable =
      letter.direction === "agent_to_user" &&
      (letter.status === "delivered_unread" || letter.status === "read");
    if (letter.canOpen !== shouldBeOpenable) {
      context.addIssue({
        code: "custom",
        message: "canOpen must identify exactly the delivered agent replies",
        path: ["canOpen"],
      });
    }
    const shouldBeEditable =
      letter.direction === "user_to_agent" && letter.status === "draft";
    if (letter.canEdit !== shouldBeEditable) {
      context.addIssue({
        code: "custom",
        message: "canEdit must identify exactly the user drafts",
        path: ["canEdit"],
      });
    }
    if (
      letter.previewText !== undefined &&
      letter.direction === "agent_to_user" &&
      letter.status !== "read"
    ) {
      context.addIssue({
        code: "custom",
        message: "Unopened agent replies cannot expose previewText",
        path: ["previewText"],
      });
    }
    if (
      (letter.status === "draft" || letter.status === "cancelled") &&
      letter.progress !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: `${letter.status} letters must have zero transit progress`,
        path: ["progress"],
      });
    }
    if (
      (letter.status === "delivered_unread" || letter.status === "read") &&
      letter.progress !== 1
    ) {
      context.addIssue({
        code: "custom",
        message: "Delivered letters must have complete transit progress",
        path: ["progress"],
      });
    }
    if (
      (letter.dispatchedAtUtc === undefined) !==
      (letter.arrivalDueAtUtc === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Dispatch and arrival timestamps must be exposed together",
        path: ["arrivalDueAtUtc"],
      });
    }
  });
export type LetterSummaryResponse = z.infer<typeof LetterSummaryResponseSchema>;

/**
 * Safe product projection for the one active correspondence turn. It exposes
 * only whether a reply is still being prepared, has been explicitly
 * rescheduled, or needs intervention. Task/run identifiers and provider error
 * details remain confined to the developer inspector.
 */
export const CorrespondenceReplyStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("waiting"),
      incomingLetterId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("retry_scheduled"),
      incomingLetterId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      incomingLetterId: EntityIdSchema,
      canRetry: z.boolean(),
    })
    .strict(),
]);
export type CorrespondenceReplyState = z.infer<
  typeof CorrespondenceReplyStateSchema
>;

export const CorrespondenceThreadSummaryResponseSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    status: CorrespondenceThreadStatusSchema,
    rootLetterId: EntityIdSchema.optional(),
    latestLetterId: EntityIdSchema.optional(),
    replyState: CorrespondenceReplyStateSchema.optional(),
  })
  .strict()
  .superRefine((thread, context) => {
    if (thread.replyState === undefined) return;
    if (thread.status !== "open") {
      context.addIssue({
        code: "custom",
        message: "Only an open correspondence thread can expose replyState",
        path: ["replyState"],
      });
    }
    if (thread.latestLetterId !== thread.replyState.incomingLetterId) {
      context.addIssue({
        code: "custom",
        message: "replyState must describe the latest incoming letter",
        path: ["replyState", "incomingLetterId"],
      });
    }
  });
export type CorrespondenceThreadSummaryResponse = z.infer<
  typeof CorrespondenceThreadSummaryResponseSchema
>;

export const OpenLetterResponseSchema = z
  .object({
    letter: LetterSummaryResponseSchema,
    body: z.string().trim().min(1).max(50_000),
    subject: LetterSubjectSchema,
    salutation: ShortTextSchema,
    closing: ShortTextSchema,
    signature: ShortTextSchema,
    postscript: z.string().trim().min(1).max(2_000).optional(),
    relatedKeepsakeIds: z.array(EntityIdSchema).max(100),
  })
  .strict()
  .superRefine((response, context) => {
    if (
      response.letter.direction !== "agent_to_user" ||
      response.letter.status !== "read"
    ) {
      context.addIssue({
        code: "custom",
        message: "Open letter responses require a read agent reply",
        path: ["letter", "status"],
      });
    }
    if (
      new Set(response.relatedKeepsakeIds).size !==
      response.relatedKeepsakeIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "relatedKeepsakeIds must be unique",
        path: ["relatedKeepsakeIds"],
      });
    }
  });
export type OpenLetterResponse = z.infer<typeof OpenLetterResponseSchema>;

const CorrespondenceClientRequestIdSchema = EntityIdSchema;
const LetterRequestBodySchema = z
  .string()
  .max(50_000)
  .refine((value) => value.trim().length > 0, "Letter body cannot be blank");

export const CreateLetterDraftRequestSchema = z
  .object({
    clientRequestId: CorrespondenceClientRequestIdSchema,
    subject: LetterSubjectSchema.optional(),
    body: LetterRequestBodySchema,
  })
  .strict();
export type CreateLetterDraftRequest = z.infer<
  typeof CreateLetterDraftRequestSchema
>;

export const UpdateLetterDraftRequestSchema = z
  .object({
    subject: LetterSubjectSchema.nullable().optional(),
    body: LetterRequestBodySchema.optional(),
  })
  .strict()
  .refine(
    (request) => request.subject !== undefined || request.body !== undefined,
    "At least one draft field must be supplied",
  );
export type UpdateLetterDraftRequest = z.infer<
  typeof UpdateLetterDraftRequestSchema
>;

export const SealLetterRequestSchema = z
  .object({
    clientRequestId: CorrespondenceClientRequestIdSchema,
  })
  .strict();
export type SealLetterRequest = z.infer<typeof SealLetterRequestSchema>;

export const OpenLetterRequestSchema = z.object({}).strict();
export type OpenLetterRequest = z.infer<typeof OpenLetterRequestSchema>;

/**
 * Safe ordinary detail projection. User-authored text remains readable in
 * every lifecycle state. Agent-authored text is present only after the reply
 * has been opened successfully; authenticated envelope fields never cross the
 * HTTP contract boundary.
 */
export const LetterDetailResponseSchema = z
  .object({
    letter: LetterSummaryResponseSchema,
    subject: LetterSubjectSchema.optional(),
    body: z.string().max(50_000).optional(),
    salutation: ShortTextSchema.optional(),
    closing: ShortTextSchema.optional(),
    signature: ShortTextSchema.optional(),
    postscript: z.string().trim().min(1).max(2_000).optional(),
    relatedKeepsakeIds: z.array(EntityIdSchema).max(100).optional(),
  })
  .strict()
  .superRefine((response, context) => {
    const replyOnlyFields = [
      ["salutation", response.salutation],
      ["closing", response.closing],
      ["signature", response.signature],
      ["postscript", response.postscript],
      ["relatedKeepsakeIds", response.relatedKeepsakeIds],
    ] as const;

    if (response.letter.direction === "user_to_agent") {
      if (response.body === undefined) {
        context.addIssue({
          code: "custom",
          message: "User-authored letter details require body",
          path: ["body"],
        });
      }
      for (const [field, value] of replyOnlyFields) {
        if (value !== undefined) {
          context.addIssue({
            code: "custom",
            message: `User-authored letter details cannot contain ${field}`,
            path: [field],
          });
        }
      }
      return;
    }

    const hasPlaintext =
      response.subject !== undefined ||
      response.body !== undefined ||
      replyOnlyFields.some(([, value]) => value !== undefined);
    if (response.letter.status !== "read") {
      if (hasPlaintext) {
        context.addIssue({
          code: "custom",
          message: "An unopened agent reply cannot expose plaintext",
          path: ["letter", "status"],
        });
      }
      return;
    }

    if (
      response.subject === undefined ||
      response.body === undefined ||
      response.salutation === undefined ||
      response.closing === undefined ||
      response.signature === undefined ||
      response.relatedKeepsakeIds === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "An opened agent reply detail requires complete plaintext",
        path: ["body"],
      });
    }
  });
export type LetterDetailResponse = z.infer<typeof LetterDetailResponseSchema>;

export const CorrespondenceMailboxQuerySchema = z
  .object({
    // Keep the original unparameterized mailbox call compatible: it used to
    // return at most 500 records. The web UI deliberately requests smaller
    // pages so people can choose when to load older correspondence.
    limit: z.coerce.number().int().min(1).max(500).default(500),
    cursor: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
export type CorrespondenceMailboxQuery = z.infer<
  typeof CorrespondenceMailboxQuerySchema
>;

export const CorrespondenceMailboxResponseSchema = z
  .object({
    // A page can reference 500 distinct historical threads and additionally
    // carry the current empty open thread needed for compose availability.
    threads: z.array(CorrespondenceThreadSummaryResponseSchema).max(501),
    letters: z.array(LetterSummaryResponseSchema).max(500),
    serverTimeUtc: UtcDateTimeSchema,
    nextCursor: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
export type CorrespondenceMailboxResponse = z.infer<
  typeof CorrespondenceMailboxResponseSchema
>;

/**
 * Credential- and payload-free temporal task projection for the developer
 * inspector. A claimed task intentionally keeps its lease timestamps while
 * omitting the claim token needed to mutate it.
 */
export const DeveloperTemporalTaskResponseSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    kind: TemporalTaskKindSchema,
    entityId: EntityIdSchema,
    dueAtUtc: UtcDateTimeSchema,
    priority: z.number().int().nonnegative().max(10_000),
    status: TemporalTaskStatusSchema,
    claimedAtUtc: UtcDateTimeSchema.optional(),
    leaseExpiresAtUtc: UtcDateTimeSchema.optional(),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    lastErrorCode: ReasonCodeSchema.optional(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
    completedAtUtc: UtcDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.attempt > task.maxAttempts) {
      context.addIssue({
        code: "custom",
        message: "attempt cannot exceed maxAttempts",
        path: ["attempt"],
      });
    }
    if (
      task.status === "claimed" &&
      (task.claimedAtUtc === undefined || task.leaseExpiresAtUtc === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A claimed developer task requires lease timestamps",
        path: ["claimedAtUtc"],
      });
    }
    if (
      task.status !== "claimed" &&
      (task.claimedAtUtc !== undefined || task.leaseExpiresAtUtc !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only a claimed developer task can expose lease timestamps",
        path: ["claimedAtUtc"],
      });
    }
    if (task.status === "completed" && task.completedAtUtc === undefined) {
      context.addIssue({
        code: "custom",
        message: "A completed developer task requires completedAtUtc",
        path: ["completedAtUtc"],
      });
    }
    if (task.status !== "completed" && task.completedAtUtc !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only a completed developer task can have completedAtUtc",
        path: ["completedAtUtc"],
      });
    }
    if (
      task.claimedAtUtc !== undefined &&
      task.leaseExpiresAtUtc !== undefined &&
      Date.parse(task.leaseExpiresAtUtc) <= Date.parse(task.claimedAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "leaseExpiresAtUtc must be later than claimedAtUtc",
        path: ["leaseExpiresAtUtc"],
      });
    }
    if (Date.parse(task.updatedAtUtc) < Date.parse(task.createdAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "updatedAtUtc cannot precede createdAtUtc",
        path: ["updatedAtUtc"],
      });
    }
  });
export type DeveloperTemporalTaskResponse = z.infer<
  typeof DeveloperTemporalTaskResponseSchema
>;

export const DeveloperTemporalTasksResponseSchema = z
  .object({
    tasks: z.array(DeveloperTemporalTaskResponseSchema).max(500),
  })
  .strict();
export type DeveloperTemporalTasksResponse = z.infer<
  typeof DeveloperTemporalTasksResponseSchema
>;
