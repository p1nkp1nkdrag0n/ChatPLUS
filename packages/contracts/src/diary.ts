import { z } from "zod";
import {
  EntityIdSchema,
  IanaTimezoneSchema,
  UtcDateTimeSchema,
} from "./primitives.js";

export const DiaryDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Expected a real calendar date");
export const DiaryMonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);

export const GenerateDiaryInputSchema = z.strictObject({
  entryDate: DiaryDateSchema,
  timezone: IanaTimezoneSchema,
  clientRequestId: EntityIdSchema,
  expectedRevision: z.number().int().nonnegative().optional(),
});
export type GenerateDiaryInput = z.infer<typeof GenerateDiaryInputSchema>;

/** Model-authored narrative. Only the server chooses ownership, dates and revisions. */
export const DiaryDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  paragraphs: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(2_000),
        sourceMessageIds: z.array(EntityIdSchema).min(1).max(40),
      }),
    )
    .min(1)
    .max(16),
});
export type DiaryDraft = z.infer<typeof DiaryDraftSchema>;

export const DiaryEntrySchema = z.strictObject({
  id: EntityIdSchema,
  agentId: EntityIdSchema,
  entryDate: DiaryDateSchema,
  timezone: IanaTimezoneSchema,
  title: z.string(),
  body: z.string(),
  revision: z.number().int().positive(),
  createdAtUtc: UtcDateTimeSchema,
  updatedAtUtc: UtcDateTimeSchema,
  sourceMessageIds: z.array(EntityIdSchema),
  validity: z.enum(["current", "source_changed"]),
  hasNewMaterial: z.boolean(),
});
export type DiaryEntry = z.infer<typeof DiaryEntrySchema>;

export const DiaryVolumeSchema = z.strictObject({
  agentId: EntityIdSchema,
  characterName: z.string(),
  month: DiaryMonthSchema,
  entryCount: z.number().int().positive(),
  latestEntryDate: DiaryDateSchema,
  updatedAtUtc: UtcDateTimeSchema,
});
export type DiaryVolume = z.infer<typeof DiaryVolumeSchema>;
export const DiaryVolumesQuerySchema = z.strictObject({
  agentId: EntityIdSchema.optional(),
  year: z.coerce.number().int().min(1).max(9999).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});
export type DiaryVolumesQuery = z.infer<typeof DiaryVolumesQuerySchema>;

export const DiarySourceMessageSchema = z.strictObject({
  id: EntityIdSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAtUtc: UtcDateTimeSchema,
  includedAsDaySource: z.boolean(),
});
export type DiarySourceMessage = z.infer<typeof DiarySourceMessageSchema>;
