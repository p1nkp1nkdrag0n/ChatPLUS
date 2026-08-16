import { describe, expect, it } from "vitest";

import {
  AgentTurnDecisionSchema,
  ActivityEnrichmentBatchSchema,
  CharacterSpecDraftSchema,
  ImportedCharacterInputSchema,
  PluginManifestSchema,
  ScheduleEffectProposalSchema,
  ServerChatMessageInputSchema,
  UtcDateTimeSchema,
} from "./index.js";

const validDraft = {
  tier: "daily",
  sourceType: "original",
  identity: {
    name: "Lin",
    workOrRole: "student",
    worldSetting: "A contemporary city",
    selfDescription: "Quiet, curious, and conscientious.",
    timezone: "Asia/Shanghai",
  },
  persona: {
    traits: [
      {
        id: "trait.curious",
        name: "curious",
        description: "Investigates unfamiliar ideas.",
        strength: 0.8,
        triggers: ["new information"],
        exceptions: [],
        origin: "user_spec",
        sourceRefs: [],
      },
    ],
    values: [
      {
        id: "value.honesty",
        name: "honesty",
        priority: 0.9,
        description: "Avoids misleading people.",
        exceptions: [],
        origin: "user_spec",
        sourceRefs: [],
      },
    ],
    contradictions: [],
    goals: [
      {
        id: "goal.learn",
        title: "Learn",
        description: "Finish the current course.",
        priority: 0.8,
        progress: 0.2,
        origin: "user_spec",
        sourceRefs: [],
      },
    ],
    preferences: [],
    boundaries: [],
  },
  dialogue: {
    primaryLanguage: "zh-CN",
    formality: 0.4,
    directness: 0.7,
    warmth: 0.7,
    verbosity: 0.4,
    humor: 0.2,
    averageMessageLength: 80,
    averageChunksPerTurn: 1,
    frequentPhrases: [],
    avoidedPhrases: [],
    greetingPatterns: ["你好"],
    refusalPatterns: ["这次可能不行"],
    comfortingPatterns: ["我在听"],
  },
  userRelationship: {
    relationshipType: "friend",
    initialCloseness: 0.5,
    initialTrust: 0.6,
    addressTerms: ["你"],
    sharedContext: "",
  },
  routines: [],
  schedulePolicy: {
    enabled: true,
    horizonHours: 72,
    extendWhenRemainingHoursBelow: 24,
    sleepWindow: { startLocal: "23:00", endLocal: "07:30" },
    maxCommittedHoursPerDay: 10,
    routineAdherence: 0.8,
    spontaneity: 0.3,
    socialInvitationBias: 0.5,
  },
  proactivePolicy: {
    enabled: false,
    maxMessagesPerDay: 0,
    quietHours: { startLocal: "23:00", endLocal: "08:00" },
    minimumCloseness: 0.5,
    shareableCategories: ["travel"],
  },
  knowledge: { knownFacts: [], uncertainFacts: [], forbiddenMetaKnowledge: [] },
  sources: [],
  lockedPaths: [],
} as const;

describe("contract boundaries", () => {
  it("accepts a complete character draft and rejects unknown fields", () => {
    expect(CharacterSpecDraftSchema.parse(validDraft).identity.name).toBe(
      "Lin",
    );
    expect(
      CharacterSpecDraftSchema.safeParse({
        ...validDraft,
        databaseId: "forbidden",
      }).success,
    ).toBe(false);
  });

  it("enforces all unit interval fields", () => {
    const invalid = structuredClone(validDraft) as unknown as Record<
      string,
      unknown
    >;
    const dialogue = (invalid["dialogue"] ?? {}) as Record<string, unknown>;
    dialogue["warmth"] = 1.01;
    expect(CharacterSpecDraftSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires normalized UTC timestamps", () => {
    expect(
      UtcDateTimeSchema.safeParse("2026-08-16T12:00:00.000Z").success,
    ).toBe(true);
    expect(
      UtcDateTimeSchema.safeParse("2026-08-16T20:00:00+08:00").success,
    ).toBe(false);
  });

  it("limits imported material to 500 KiB", () => {
    const base = {
      characterName: "Lin",
      workTitle: "Example",
      storyStage: "Chapter 1",
      tier: "daily",
      timezone: "UTC",
    } as const;
    expect(
      ImportedCharacterInputSchema.safeParse({ ...base, sourceText: "a" })
        .success,
    ).toBe(true);
    expect(
      ImportedCharacterInputSchema.safeParse({
        ...base,
        sourceText: "a".repeat(512_001),
      }).success,
    ).toBe(false);
  });

  it("uses a strict discriminated schedule proposal union", () => {
    const valid = {
      operation: "reschedule",
      itemId: "schedule-1",
      newStartAtUtc: "2026-08-16T10:00:00.000Z",
      newEndAtUtc: "2026-08-16T11:00:00.000Z",
      reasonCode: "accepted_invitation",
      reasonSummary: "Moved study time for the accepted invitation.",
    } as const;
    expect(ScheduleEffectProposalSchema.safeParse(valid).success).toBe(true);
    expect(
      ScheduleEffectProposalSchema.safeParse({
        ...valid,
        item: {},
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("caps decision explanations at 240 characters", () => {
    const decision = {
      reply: { text: "好", chunks: ["好"], toneTags: ["warm"] },
      scheduleEffects: [],
      memoryCandidates: [],
      reasonCode: "ordinary_reply",
      reasonSummary: "x".repeat(241),
    } as const;
    expect(AgentTurnDecisionSchema.safeParse(decision).success).toBe(false);
  });

  it("rejects duplicate manifest declarations", () => {
    expect(
      PluginManifestSchema.safeParse({
        id: "example.plugin",
        displayName: "Example",
        version: "1.0.0",
        apiVersion: 1,
        requires: [],
        provides: ["example.service", "example.service"],
      }).success,
    ).toBe(false);
  });

  it("validates the strict server chat command envelope", () => {
    const input = {
      agentId: "agent-1",
      clientMessageId: "message-1",
      text: "你好",
    };
    expect(ServerChatMessageInputSchema.safeParse(input).success).toBe(true);
    expect(
      ServerChatMessageInputSchema.safeParse({
        ...input,
        content: "unexpected",
      }).success,
    ).toBe(false);
  });

  it("validates batch activity enrichment and unique event ids", () => {
    const event = {
      eventId: "event-1",
      summary: "完成了一次旅行。",
      outcomeFacts: ["到达目的地"],
      memoryCandidates: [
        {
          type: "activity_outcome",
          content: "完成了一次旅行。",
          tags: ["travel"],
          importance: 0.8,
          confidence: 1,
        },
      ],
      proactiveSummary: "旅行结束后有一些收获想分享。",
    } as const;
    expect(
      ActivityEnrichmentBatchSchema.safeParse({ events: [event] }).success,
    ).toBe(true);
    expect(
      ActivityEnrichmentBatchSchema.safeParse({ events: [event, event] })
        .success,
    ).toBe(false);
    expect(
      ActivityEnrichmentBatchSchema.safeParse({
        events: [{ ...event, hiddenReasoning: true }],
      }).success,
    ).toBe(false);
  });
});
