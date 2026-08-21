import { z } from "zod";

import { UtcDateTimeSchema, isChronologicalRange } from "./primitives.js";

export const TemporalCertaintySchema = z.enum([
  "exact",
  "date_only",
  "approximate",
  "unknown",
]);
export type TemporalCertainty = z.infer<typeof TemporalCertaintySchema>;

export const TemporalStatusSchema = z.enum([
  "planned",
  "in_progress",
  "occurred",
  "cancelled",
  "unknown",
]);
export type TemporalStatus = z.infer<typeof TemporalStatusSchema>;

export const TemporalMetadataSchema = z
  .object({
    mentionedAtUtc: UtcDateTimeSchema.optional(),
    plannedStartAtUtc: UtcDateTimeSchema.optional(),
    plannedEndAtUtc: UtcDateTimeSchema.optional(),
    occurredStartAtUtc: UtcDateTimeSchema.optional(),
    occurredEndAtUtc: UtcDateTimeSchema.optional(),
    recordedAtUtc: UtcDateTimeSchema,
    temporalCertainty: TemporalCertaintySchema,
    temporalStatus: TemporalStatusSchema,
  })
  .strict()
  .superRefine((temporal, context) => {
    const checkRange = (
      start: string | undefined,
      end: string | undefined,
      startName: "plannedStartAtUtc" | "occurredStartAtUtc",
      endName: "plannedEndAtUtc" | "occurredEndAtUtc",
    ): void => {
      if (end !== undefined && start === undefined) {
        context.addIssue({
          code: "custom",
          message: `${endName} requires ${startName}`,
          path: [endName],
        });
      } else if (
        start !== undefined &&
        end !== undefined &&
        !isChronologicalRange(start, end)
      ) {
        context.addIssue({
          code: "custom",
          message: `${endName} must be later than ${startName}`,
          path: [endName],
        });
      }
    };
    checkRange(
      temporal.plannedStartAtUtc,
      temporal.plannedEndAtUtc,
      "plannedStartAtUtc",
      "plannedEndAtUtc",
    );
    checkRange(
      temporal.occurredStartAtUtc,
      temporal.occurredEndAtUtc,
      "occurredStartAtUtc",
      "occurredEndAtUtc",
    );

    if (
      temporal.temporalStatus === "planned" &&
      (temporal.occurredStartAtUtc !== undefined ||
        temporal.occurredEndAtUtc !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A planned event is not evidence that the event occurred",
        path: ["temporalStatus"],
      });
    }
    if (
      temporal.temporalStatus === "in_progress" &&
      temporal.occurredStartAtUtc === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "An in-progress event requires an actual start",
        path: ["occurredStartAtUtc"],
      });
    }
    if (
      temporal.temporalStatus === "in_progress" &&
      temporal.occurredEndAtUtc !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "An in-progress event cannot already have an actual end",
        path: ["occurredEndAtUtc"],
      });
    }
    if (
      temporal.temporalStatus === "occurred" &&
      temporal.occurredStartAtUtc === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "An occurred event requires occurredStartAtUtc",
        path: ["occurredStartAtUtc"],
      });
    }
  });
export type TemporalMetadata = z.infer<typeof TemporalMetadataSchema>;

export function temporalStatusRepresentsOccurrence(
  status: TemporalStatus,
): boolean {
  return status === "in_progress" || status === "occurred";
}
