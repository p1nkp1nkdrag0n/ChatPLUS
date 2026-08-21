import { z } from "zod";

export const StructuredOutputModeSchema = z.enum([
  "native_schema",
  "json_object",
  "prompt_json",
]);
export type StructuredOutputMode = z.infer<typeof StructuredOutputModeSchema>;

export const LlmCapabilityProfileSchema = z
  .object({
    structuredOutputMode: StructuredOutputModeSchema,
    supportsThinkingControl: z.boolean(),
    supportsStreaming: z.boolean(),
    maxContextTokens: z.number().int().positive().max(10_000_000).optional(),
    maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict()
  .refine(
    (profile) =>
      profile.maxContextTokens === undefined ||
      profile.maxOutputTokens === undefined ||
      profile.maxOutputTokens < profile.maxContextTokens,
    {
      message: "maxOutputTokens must be smaller than maxContextTokens",
      path: ["maxOutputTokens"],
    },
  );

export type LlmCapabilityProfile = z.infer<typeof LlmCapabilityProfileSchema>;
