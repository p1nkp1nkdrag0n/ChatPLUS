import { z } from "zod";

import { EntityIdSchema, UtcDateTimeSchema } from "./primitives.js";

export const CalendarScopeSchema = z.enum([
  "public_system",
  "user_private",
  "character_world",
]);
export type CalendarScope = z.infer<typeof CalendarScopeSchema>;

export const CalendarRecurrenceSchema = z.enum(["none", "yearly"]);
export type CalendarRecurrence = z.infer<typeof CalendarRecurrenceSchema>;

export const CalendarSourceSchema = z.enum([
  "manual",
  "system_dataset",
  "character_spec",
  "plugin",
]);
export type CalendarSource = z.infer<typeof CalendarSourceSchema>;

export const CalendarStatusSchema = z.enum(["active", "archived"]);
export type CalendarStatus = z.infer<typeof CalendarStatusSchema>;

const LocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const parsed = new Date(value + "T00:00:00.000Z");
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Expected a valid local calendar date");
const LocalTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const TimezoneSchema = z.string().trim().min(1).max(120);

const CalendarDraftShape = {
  scope: CalendarScopeSchema,
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(2_000).optional(),
  localDate: LocalDateSchema,
  timezone: TimezoneSchema,
  allDay: z.boolean().default(true),
  startLocalTime: LocalTimeSchema.optional(),
  endLocalTime: LocalTimeSchema.optional(),
  recurrence: CalendarRecurrenceSchema.default("none"),
} as const;

export const CalendarEntryDraftSchema = z
  .object(CalendarDraftShape)
  .strict()
  .superRefine(validateTimes);
export type CalendarEntryDraft = z.infer<typeof CalendarEntryDraftSchema>;

export const CalendarEntrySchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema.optional(),
    ...CalendarDraftShape,
    source: CalendarSourceSchema,
    status: CalendarStatusSchema,
    dedupeKey: z.string().trim().min(1).max(512),
    revision: z.number().int().nonnegative(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    validateTimes(entry, context);
    if (entry.scope !== "public_system" && entry.agentId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Non-public calendar entries require an agentId",
        path: ["agentId"],
      });
    }
  });
export type CalendarEntry = z.infer<typeof CalendarEntrySchema>;

export const CalendarPromptItemSchema = z
  .object({
    ref: z.string().regex(/^calendar_[1-9]\d*$/u),
    scope: CalendarScopeSchema,
    label: z.string().trim().min(1).max(500),
    localDate: LocalDateSchema,
    allDay: z.boolean(),
  })
  .strict();
export type CalendarPromptItem = z.infer<typeof CalendarPromptItemSchema>;

function validateTimes(
  value: {
    allDay: boolean;
    startLocalTime?: string | undefined;
    endLocalTime?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (!value.allDay && value.startLocalTime === undefined) {
    context.addIssue({
      code: "custom",
      message: "Timed entries require startLocalTime",
      path: ["startLocalTime"],
    });
  }
  if (value.endLocalTime !== undefined && value.startLocalTime === undefined) {
    context.addIssue({
      code: "custom",
      message: "endLocalTime requires startLocalTime",
      path: ["endLocalTime"],
    });
  }
  if (
    value.startLocalTime !== undefined &&
    value.endLocalTime !== undefined &&
    value.endLocalTime <= value.startLocalTime
  ) {
    context.addIssue({
      code: "custom",
      message: "endLocalTime must be later than startLocalTime",
      path: ["endLocalTime"],
    });
  }
}
