import { describe, expect, it } from "vitest";

import {
  CharacterVisualProfileSchema,
  KeepsakeAssetSchema,
  KeepsakeListQuerySchema,
  KeepsakePageResponseSchema,
  KeepsakeSchema,
  KeepsakeSpecSchema,
  VisualPromptSpecSchema,
} from "./keepsake.js";

const HASH = "a".repeat(64);
const NOW = "2026-09-08T20:00:00.000Z";

describe("keepsake contracts", () => {
  it("requires every keepsake proposal to cite a durable source", () => {
    const base = {
      kind: "ticket_stub",
      title: "雨夜电影票",
      description: "来自一次已经确认发生的共同观影。",
      theme: "雨后的旧电影院",
      caption: "九月八日，散场时雨刚停。",
      sourceEventIds: [],
      sourceMemoryIds: [],
      sourceLetterIds: [],
    } as const;

    expect(KeepsakeSpecSchema.safeParse(base).success).toBe(false);
    expect(
      KeepsakeSpecSchema.safeParse({
        ...base,
        sourceEventIds: ["outcome-1"],
      }).success,
    ).toBe(true);
  });

  it("requires a ready keepsake to point to an asset", () => {
    const keepsake = {
      id: "keepsake-1",
      agentId: "agent-1",
      title: "雨夜电影票",
      kind: "ticket_stub",
      description: "来自一次已经确认发生的共同观影。",
      createdBy: "agent",
      ownedBy: "user",
      givenTo: "user",
      sourceEventIds: ["outcome-1"],
      sourceMemoryIds: [],
      sourceLetterIds: [],
      canonicality: "canonical",
      status: "ready",
      visualSpecJson: {
        version: "keepsake_visual_v1",
        templateVersion: "ticket-stub-v1",
        theme: "雨后的旧电影院",
        caption: "九月八日，散场时雨刚停。",
        palette: ["#C56F46", "#22354B"],
        materials: ["旧纸", "蓝色油墨"],
      },
      visualSpecHash: HASH,
      createdEffectiveAtUtc: NOW,
      giftedAtUtc: NOW,
      idempotencyKey: "keepsake:life_outcome:outcome-1:ticket_stub:v1",
      createdAtUtc: NOW,
      updatedAtUtc: NOW,
    } as const;

    expect(KeepsakeSchema.safeParse(keepsake).success).toBe(false);
    expect(
      KeepsakeSchema.safeParse({
        ...keepsake,
        primaryAssetId: "asset-1",
      }).success,
    ).toBe(true);
  });

  it("keeps the provider prompt bounded to a visual projection", () => {
    const prompt = {
      version: "keepsake_visual_v1",
      kind: "postcard",
      subject: "海边灯塔与晚霞",
      setting: "九十年代末的北方海港",
      mood: "克制而温暖",
      composition: "横向风景，远景灯塔，前景留出邮戳空间",
      materials: ["哑光纸", "颗粒水彩"],
      palette: ["#D9A66F", "#264653"],
      stableCharacterTraits: ["不出现正脸"],
      forbiddenElements: ["现代智能手机", "水印", "可读品牌标志"],
      visualProfileHash: HASH,
      semanticSourceHash: HASH,
    } as const;

    expect(VisualPromptSpecSchema.safeParse(prompt).success).toBe(true);
    expect(
      VisualPromptSpecSchema.safeParse({
        ...prompt,
        rawCharacterSource: "full private source",
      }).success,
    ).toBe(false);
  });

  it("requires deterministic profile and asset integrity hashes", () => {
    expect(
      CharacterVisualProfileSchema.safeParse({
        version: 1,
        agentId: "agent-1",
        characterVersion: 2,
        stableAppearanceTraits: ["深色短发"],
        periodAndSetting: "九十年代末的北方城市",
        materialLanguage: ["旧纸", "铅笔"],
        imageLanguage: ["低饱和", "自然光"],
        forbiddenElements: ["现代智能手机"],
        profileHash: HASH,
        createdAtUtc: NOW,
      }).success,
    ).toBe(true);

    expect(
      KeepsakeAssetSchema.safeParse({
        id: "asset-1",
        keepsakeId: "keepsake-1",
        storageKey: "agent-1/aa.webp",
        thumbnailStorageKey: "agent-1/aa.thumb.webp",
        mimeType: "image/webp",
        width: 1200,
        height: 800,
        sha256: HASH,
        thumbnailSha256: "not-a-hash",
        provider: "fixture-template",
        model: "postcard-v1",
        promptSpecHash: HASH,
        createdAtUtc: NOW,
      }).success,
    ).toBe(false);
  });

  it("validates server-side cabinet filters and complete filter metadata", () => {
    expect(
      KeepsakeListQuerySchema.parse({
        kind: "postcard",
        sourceType: "reflection",
        period: "2026-09",
      }),
    ).toEqual({
      kind: "postcard",
      sourceType: "reflection",
      period: "2026-09",
      limit: 50,
    });
    expect(
      KeepsakeListQuerySchema.safeParse({ period: "2026-13" }).success,
    ).toBe(false);
    expect(
      KeepsakeListQuerySchema.safeParse({ sourceType: "planned_event" })
        .success,
    ).toBe(false);
    expect(
      KeepsakePageResponseSchema.safeParse({
        items: [],
        filterOptions: {
          kinds: ["postcard", "sketch"],
          sourceTypes: ["relationship_milestone", "reflection"],
          periods: ["2026-10", "2026-09"],
        },
      }).success,
    ).toBe(true);
  });
});
