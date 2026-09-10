import { z } from "zod";
import { EntityIdSchema, UtcDateTimeSchema } from "./primitives.js";

// Public collection contracts intentionally contain no rule keys, thresholds,
// state values, progress, or unreached definitions.
export const AchievementSchema = z.strictObject({
  id: EntityIdSchema,
  title: z.string(),
  description: z.string(),
  category: z.enum(["global", "character"]),
  agentId: EntityIdSchema.optional(),
  agentName: z.string().optional(),
  unlockedAtUtc: UtcDateTimeSchema,
  badge: z.strictObject({
    key: z.string(),
    status: z.enum(["fixed", "pending", "generating", "ready", "failed"]),
    imageUrl: z.string().optional(),
    thumbnailUrl: z.string().optional(),
  }),
  notificationRead: z.boolean(),
});
export type Achievement = z.infer<typeof AchievementSchema>;

export const AchievementPageSchema = z.strictObject({
  items: z.array(AchievementSchema),
  nextCursor: z.string().optional(),
  notifications: z.array(AchievementSchema),
  agents: z.array(z.strictObject({ id: EntityIdSchema, name: z.string() })),
  serverTimeUtc: UtcDateTimeSchema,
});
export type AchievementPage = z.infer<typeof AchievementPageSchema>;

export const AchievementQuerySchema = z.strictObject({
  category: z.enum(["all", "global", "character"]).default("all"),
  agentId: EntityIdSchema.optional(),
  cursor: z.string().regex(/^\d+$/u).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

export const AchievementImageSettingsSchema = z.strictObject({
  protocol: z.enum(["openai-compatible", "gemini", "fixture"]),
  baseUrl: z.string(),
  model: z.string(),
  apiKeyConfigured: z.boolean(),
  enabled: z.boolean(),
});
export type AchievementImageSettings = z.infer<
  typeof AchievementImageSettingsSchema
>;
export const AchievementImageSettingsInputSchema = z.strictObject({
  protocol: z.enum(["openai-compatible", "gemini", "fixture"]),
  baseUrl: z.string().trim().max(2048),
  model: z.string().trim().max(200),
  enabled: z.boolean(),
  apiKey: z.string().trim().min(1).max(16000).optional(),
  clearApiKey: z.boolean().optional(),
});
export type AchievementImageSettingsInput = z.infer<
  typeof AchievementImageSettingsInputSchema
>;

export const AchievementBadgeVisualSpecSchema = z.strictObject({
  version: z.literal("achievement_badge_v1"),
  subject: z.string().min(1).max(500),
  setting: z.string().max(500),
  motifs: z.array(z.string().max(200)).max(6),
  palette: z
    .array(z.string().regex(/^#[a-fA-F0-9]{6}$/u))
    .min(2)
    .max(5),
  theme: z.string().max(200),
});
export type AchievementBadgeVisualSpec = z.infer<
  typeof AchievementBadgeVisualSpecSchema
>;
