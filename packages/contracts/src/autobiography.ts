import { z } from "zod";

import {
  ContinuityEvidenceRefSchema,
  type ContinuityEvidenceRef,
} from "./event-card.js";
import {
  EntityIdSchema,
  RevisionSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import { TemporalStatusSchema } from "./temporal.js";

export const AutobiographyEntryKindSchema = z.enum([
  "important_experience",
  "relationship_change",
  "active_goal",
  "unresolved_thread",
  "commitment",
]);
export type AutobiographyEntryKind = z.infer<
  typeof AutobiographyEntryKindSchema
>;

const AutobiographyEntryContentShape = {
  entryKind: AutobiographyEntryKindSchema,
  content: z.string().trim().min(1).max(2_000),
  temporalStatus: TemporalStatusSchema,
  fromUtc: UtcDateTimeSchema.optional(),
  throughUtc: UtcDateTimeSchema.optional(),
  evidence: z
    .array(ContinuityEvidenceRefSchema)
    .min(1)
    .max(20)
    .refine(
      (values) => new Set(values.map((item) => item.id)).size === values.length,
      { message: "Autobiography evidence ids must be unique" },
    ),
} as const;

function addEntryIssues(
  entry: {
    temporalStatus: z.infer<typeof TemporalStatusSchema>;
    fromUtc?: string | undefined;
    throughUtc?: string | undefined;
    evidence: ContinuityEvidenceRef[];
  },
  context: z.core.$RefinementCtx<unknown>,
): void {
  if (entry.throughUtc !== undefined && entry.fromUtc === undefined) {
    context.addIssue({
      code: "custom",
      message: "throughUtc requires fromUtc",
      path: ["throughUtc"],
    });
  } else if (
    entry.fromUtc !== undefined &&
    entry.throughUtc !== undefined &&
    Date.parse(entry.fromUtc) >= Date.parse(entry.throughUtc)
  ) {
    context.addIssue({
      code: "custom",
      message: "throughUtc must be later than fromUtc",
      path: ["throughUtc"],
    });
  }
  if (
    entry.temporalStatus === "occurred" &&
    !entry.evidence.some(
      (item) => item.reliability === "fact" || item.reliability === "reported",
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "An occurred autobiography entry requires occurrence evidence",
      path: ["evidence"],
    });
  }
}

export const AutobiographyEntryDraftSchema = z
  .object(AutobiographyEntryContentShape)
  .strict()
  .superRefine(addEntryIssues);
export type AutobiographyEntryDraft = z.infer<
  typeof AutobiographyEntryDraftSchema
>;

export const AutobiographyRevisionProposalSchema = z
  .object({
    summaryFirstPerson: z.string().trim().min(1).max(10_000),
    entries: z.array(AutobiographyEntryDraftSchema).min(1).max(50),
  })
  .strict();
export type AutobiographyRevisionProposal = z.infer<
  typeof AutobiographyRevisionProposalSchema
>;

export const AutobiographyEntrySchema = z
  .object({
    id: EntityIdSchema,
    snapshotId: EntityIdSchema,
    agentId: EntityIdSchema,
    ordinal: z.number().int().nonnegative(),
    ...AutobiographyEntryContentShape,
    sourceEvidenceIds: z
      .array(EntityIdSchema)
      .min(1)
      .max(20)
      .refine((values) => new Set(values).size === values.length, {
        message: "sourceEvidenceIds must be unique",
      }),
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    addEntryIssues(entry, context);
    const evidenceIds = entry.evidence.map((item) => item.id);
    if (evidenceIds.join("\u0000") !== entry.sourceEvidenceIds.join("\u0000")) {
      context.addIssue({
        code: "custom",
        message: "sourceEvidenceIds must match evidence in order",
        path: ["sourceEvidenceIds"],
      });
    }
  });
export type AutobiographyEntry = z.infer<typeof AutobiographyEntrySchema>;

const UniqueTextListSchema = z
  .array(z.string().trim().min(1).max(2_000))
  .max(40)
  .refine((values) => new Set(values).size === values.length, {
    message: "Autobiography lists must not contain duplicates",
  });

export const AgentAutobiographySnapshotSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sourceCheckpointId: EntityIdSchema,
    previousSnapshotId: EntityIdSchema.optional(),
    revision: RevisionSchema.refine((value) => value > 0, {
      message: "Autobiography revision must be positive",
    }),
    summaryFirstPerson: z.string().trim().min(1).max(10_000),
    importantExperiences: UniqueTextListSchema,
    relationshipChanges: UniqueTextListSchema,
    activeGoals: UniqueTextListSchema,
    unresolvedThreads: UniqueTextListSchema,
    commitments: UniqueTextListSchema,
    sourceEvidenceIds: z
      .array(EntityIdSchema)
      .min(1)
      .max(500)
      .refine((values) => new Set(values).size === values.length, {
        message: "sourceEvidenceIds must be unique",
      }),
    fromUtc: UtcDateTimeSchema,
    throughUtc: UtcDateTimeSchema,
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .refine(
    (snapshot) =>
      Date.parse(snapshot.fromUtc) <= Date.parse(snapshot.throughUtc),
    {
      message: "throughUtc cannot be earlier than fromUtc",
      path: ["throughUtc"],
    },
  );
export type AgentAutobiographySnapshot = z.infer<
  typeof AgentAutobiographySnapshotSchema
>;
