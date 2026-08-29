import { z } from "zod";

export const StructuredOutputModeSchema = z.enum([
  "native_schema",
  "json_object",
  "prompt_json",
]);
export type StructuredOutputMode = z.infer<typeof StructuredOutputModeSchema>;

export const ReasoningEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ReasoningRequestFormatSchema = z.enum([
  "openai_reasoning_effort",
  "anthropic_output_config",
  "openai_reasoning_effort_with_thinking",
]);
export type ReasoningRequestFormat = z.infer<
  typeof ReasoningRequestFormatSchema
>;

export const LlmCapabilityProfileSchema = z
  .object({
    structuredOutputMode: StructuredOutputModeSchema,
    supportsThinkingControl: z.boolean(),
    supportsStreaming: z.boolean(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    reasoningRequestFormat: ReasoningRequestFormatSchema.optional(),
    maxContextTokens: z.number().int().positive().max(10_000_000).optional(),
    maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      (profile.reasoningEffort === undefined) !==
      (profile.reasoningRequestFormat === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "reasoningEffort and reasoningRequestFormat must be configured together",
        path:
          profile.reasoningEffort === undefined
            ? ["reasoningEffort"]
            : ["reasoningRequestFormat"],
      });
    }
  })
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
