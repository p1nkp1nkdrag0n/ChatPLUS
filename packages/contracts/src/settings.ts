import { z } from "zod";

import {
  IanaTimezoneSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";

export const LLMProviderKindSchema = z.enum(["fixture", "openai_compatible"]);
export type LLMProviderKind = z.infer<typeof LLMProviderKindSchema>;

export const LLMSettingsSchema = z
  .object({
    provider: LLMProviderKindSchema,
    model: z.string().trim().min(1).max(160),
    baseUrl: z.url().optional(),
    apiKeyConfigured: z.boolean(),
    temperature: z.number().finite().min(0).max(2),
    maxOutputTokens: z.number().int().min(1).max(64_000),
    requestTimeoutMs: z.number().int().min(1_000).max(300_000),
    maxRepairAttempts: z.literal(1),
  })
  .strict()
  .superRefine((settings, context) => {
    if (
      settings.provider === "openai_compatible" &&
      settings.baseUrl === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "baseUrl is required for an OpenAI-compatible provider",
        path: ["baseUrl"],
      });
    }
  });
export type LLMSettings = z.infer<typeof LLMSettingsSchema>;

export const SimulationSettingsSchema = z
  .object({
    defaultTimezone: IanaTimezoneSchema,
    scheduleHorizonHours: z.literal(72),
    proactiveDailyLimit: z.number().int().min(0).max(2),
    settlementBatchLimit: z.number().int().min(1).max(1_000),
    personaConsistencyThreshold: UnitIntervalSchema,
  })
  .strict();
export type SimulationSettings = z.infer<typeof SimulationSettingsSchema>;

export const AppSettingsSchema = z
  .object({
    llm: LLMSettingsSchema,
    simulation: SimulationSettingsSchema,
    developerMode: z.boolean(),
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict();
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const SettingsUpdateRequestSchema = z
  .object({
    provider: LLMProviderKindSchema.optional(),
    model: z.string().trim().min(1).max(160).optional(),
    baseUrl: z.union([z.url(), z.null()]).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(1).max(64_000).optional(),
    requestTimeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    defaultTimezone: IanaTimezoneSchema.optional(),
    developerMode: z.boolean().optional(),
  })
  .strict()
  .refine(
    (settings) => Object.values(settings).some((value) => value !== undefined),
    {
      message: "At least one setting is required",
    },
  );
export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequestSchema>;
