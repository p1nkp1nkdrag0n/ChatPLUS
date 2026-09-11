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

const badgeVisualFields = {
  subject: z.string().min(1).max(500),
  setting: z.string().max(500),
  motifs: z.array(z.string().max(200)).max(6),
  palette: z
    .array(z.string().regex(/^#[a-fA-F0-9]{6}$/u))
    .min(2)
    .max(5),
  theme: z.string().max(200),
};
export const AchievementBadgeVisualSpecV1Schema = z.strictObject({
  version: z.literal("achievement_badge_v1"),
  ...badgeVisualFields,
});
export const AchievementBadgeVisualSpecV2Schema = z.strictObject({
  version: z.literal("achievement_badge_v2"),
  ...badgeVisualFields,
  finish: z.enum(["gold", "mother-of-pearl-aurora"]),
});
export const AchievementBadgeVisualSpecSchema = z.discriminatedUnion(
  "version",
  [AchievementBadgeVisualSpecV1Schema, AchievementBadgeVisualSpecV2Schema],
);
export type AchievementBadgeVisualSpec = z.infer<
  typeof AchievementBadgeVisualSpecSchema
>;

/** Cosmetic metadata only: never include achievement rules or thresholds. */
export const ACHIEVEMENT_WAX_TIERS = {
  1: { color: "#8B3542", name: "酒红" },
  2: { color: "#3D654F", name: "松绿" },
  3: { color: "#355678", name: "深蓝" },
  4: { color: "#74518A", name: "紫色" },
  5: { color: "#C69A4F", name: "金色" },
  6: { color: "#D1B7D9", name: "珠母极光" },
} as const;
export type AchievementWaxTier = keyof typeof ACHIEVEMENT_WAX_TIERS;
export const ACHIEVEMENT_WAX_BADGES = {
  door: 1,
  quill: 1,
  message: 1,
  envelope: 1,
  mailbox: 1,
  letter: 1,
  sprout: 2,
  leaf: 2,
  sun: 3,
  echo: 3,
  calendar: 4,
  flower: 4,
  tree: 5,
  star: 5,
  orbit: 6,
  constellation: 6,
} as const satisfies Record<string, AchievementWaxTier>;
export function getAchievementWaxBadge(key: string) {
  const safeKey = Object.hasOwn(ACHIEVEMENT_WAX_BADGES, key)
    ? (key as keyof typeof ACHIEVEMENT_WAX_BADGES)
    : "door";
  const tier = ACHIEVEMENT_WAX_BADGES[safeKey];
  const root = `/dearvale/achievements/wax-v2/${safeKey}`;
  return {
    tier,
    color: ACHIEVEMENT_WAX_TIERS[tier].color,
    imageUrl: `${root}.webp`,
    thumbnailUrl: `${root}.thumb.webp`,
  };
}
