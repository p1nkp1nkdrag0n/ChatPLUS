import { z } from "zod";
import { LlmPurposeSchema } from "./llm.js";
import { LlmSelectionSchema } from "./llm-settings.js";

export const UserModelSettingsSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  onboardingCompleted: z.boolean(),
  bindings: z.partialRecord(LlmPurposeSchema, LlmSelectionSchema),
  imageSelection: LlmSelectionSchema.nullable(),
});
export type UserModelSettings = z.infer<typeof UserModelSettingsSchema>;

export const UserModelSetupInputSchema = z.strictObject({
  mode: z.enum(["platform", "user"]),
  selection: LlmSelectionSchema,
  expectedRevision: z.number().int().nonnegative(),
});
export type UserModelSetupInput = z.infer<typeof UserModelSetupInputSchema>;

export const UserModelSettingsUpdateInputSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  bindings: z.partialRecord(LlmPurposeSchema, LlmSelectionSchema.nullable()),
  imageSelection: LlmSelectionSchema.nullable().optional(),
});
export type UserModelSettingsUpdateInput = z.infer<
  typeof UserModelSettingsUpdateInputSchema
>;
