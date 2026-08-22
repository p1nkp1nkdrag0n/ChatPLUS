import { describe, expect, it } from "vitest";

import { guardPersonaReply } from "./persona-guard.js";
import {
  createProactiveCandidate,
  isWithinQuietHours,
  selectProactiveCandidate,
} from "./proactive-dialogue.js";
import { assembleChatPrompt } from "./prompt-assembler.js";
import type { ScheduleItemLike } from "./schedule-validator.js";

const NOW = "2026-06-01T12:00:00.000Z";

function shareableItem(): ScheduleItemLike {
  return {
    id: "trip-1",
    agentId: "agent-1",
    title: "短途旅行",
    description: "test",
    category: "travel",
    startAtUtc: "2026-06-01T08:00:00.000Z",
    endAtUtc: "2026-06-01T11:00:00.000Z",
    timezone: "Asia/Shanghai",
    status: "completed",
    rigidity: "flexible",
    priority: 0.8,
    source: "initial_plan",
    adherenceProbability: 0.8,
    narrativeImportance: 0.85,
    shareable: true,
    stateEffects: { moodValence: 0.1 },
    revision: 1,
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  };
}

const policy = {
  enabled: true,
  maxMessagesPerDay: 2,
  quietHours: { startLocal: "23:00", endLocal: "08:00" },
  minimumCloseness: 0.4,
  shareableCategories: ["travel"],
};

describe("proactive rules", () => {
  it("handles a quiet period that crosses midnight", () => {
    expect(
      isWithinQuietHours("2026-06-01T15:30:00.000Z", "Asia/Shanghai"),
    ).toBe(true);
    expect(
      isWithinQuietHours("2026-06-01T23:30:00.000Z", "Asia/Shanghai"),
    ).toBe(true);
    expect(
      isWithinQuietHours("2026-06-01T12:00:00.000Z", "Asia/Shanghai"),
    ).toBe(false);
  });

  it("requires high fidelity, importance, closeness and daily capacity", () => {
    const item = shareableItem();
    const event = {
      id: "event-1",
      agentId: "agent-1",
      scheduleItemId: item.id,
      kind: "completed" as const,
      category: "travel",
      scheduleStatus: "completed" as const,
      startedAtUtc: item.startAtUtc,
      endedAtUtc: item.endAtUtc,
      occurredAtUtc: item.endAtUtc,
      summary: "旅行结束，看到了新的风景。",
      completionRatio: 1,
      importance: 0.85,
      shareable: true,
      idempotencyKey: "event-key",
      createdAtUtc: item.endAtUtc,
    };
    expect(
      createProactiveCandidate({
        tier: "daily",
        agentId: "agent-1",
        event,
        item,
        policy,
        relationshipCloseness: 0.8,
        nowUtc: NOW,
      }),
    ).toBeUndefined();

    const candidate = createProactiveCandidate({
      tier: "high_fidelity",
      agentId: "agent-1",
      event,
      item,
      policy,
      relationshipCloseness: 0.8,
      nowUtc: NOW,
    });
    expect(candidate).toBeDefined();
    expect(
      selectProactiveCandidate({
        tier: "high_fidelity",
        candidates: candidate === undefined ? [] : [candidate],
        nowUtc: NOW,
        timezone: "Asia/Shanghai",
        policy,
        relationshipCloseness: 0.8,
        sentToday: 2,
      }),
    ).toBeUndefined();
  });
});

describe("prompt and persona guard", () => {
  it("selects structured character data and requests only an in-character reply", () => {
    const secretRawSource = "FULL_IMPORT_SHOULD_NEVER_APPEAR";
    const scheduleId = "SCHEDULE_ID_MUST_NOT_APPEAR";
    const memoryId = "MEMORY_ID_MUST_NOT_APPEAR";
    const userId = "USER_ID_MUST_NOT_APPEAR";
    const assembled = assembleChatPrompt({
      character: {
        id: "agent-1",
        tier: "high_fidelity",
        sourceType: "imported_character",
        identity: {
          name: "林澈",
          workOrRole: "学生",
          worldSetting: "当代城市",
          selfDescription: "克制而可靠",
          timezone: "Asia/Shanghai",
        },
        persona: {
          traits: [],
          values: [],
          contradictions: [],
          goals: [],
          preferences: [],
          boundaries: [],
        },
        dialogue: {
          register: "克制、简短",
          vocabulary: "日常用词",
          avoidedPhrases: ["作为一个 AI"],
        },
        userRelationship: { relationshipType: "朋友" },
        routines: [],
        schedulePolicy: {},
        proactivePolicy: {},
        knowledge: {
          knownFacts: [],
          uncertainFacts: [],
          forbiddenMetaKnowledge: [],
        },
        sources: [{ excerpt: "允许的短片段", sourceText: secretRawSource }],
      },
      state: {
        agentId: "agent-1",
        asOfUtc: NOW,
        moodValence: 0,
        moodArousal: 0.5,
        energy: 0.5,
        stress: 0.2,
        socialBattery: 0.5,
        focus: 0.5,
        relationship: {
          userId,
          closeness: 0.6,
          trust: 0.7,
          familiarity: 0.5,
          recentInteractionValence: 0.2,
        },
        revision: 0,
      },
      schedule: [
        {
          id: scheduleId,
          agentId: "agent-1",
          title: "晚间自习",
          description: "准备考试",
          category: "study",
          startAtUtc: "2026-06-01T13:00:00.000Z",
          endAtUtc: "2026-06-01T15:00:00.000Z",
          timezone: "Asia/Shanghai",
          status: "planned",
          rigidity: "flexible",
          priority: 0.7,
          source: "initial_plan",
          adherenceProbability: 0.8,
          narrativeImportance: 0.4,
          shareable: false,
          stateEffects: {},
          revision: 1,
          createdAtUtc: NOW,
          updatedAtUtc: NOW,
        },
      ],
      memories: [
        {
          id: memoryId,
          agentId: "agent-1",
          kind: "relationship",
          content: "用户喜欢在周末散步。",
          importance: 0.6,
          confidence: 0.9,
          tags: ["偏好"],
          sourceMessageIds: [],
          sourceActivityEventIds: [],
          origin: "runtime_simulation",
          status: "active",
          dedupeKey: "walk-preference",
          createdAtUtc: NOW,
          updatedAtUtc: NOW,
        },
      ],
      recentMessages: [],
      nowUtc: NOW,
      userMessage: "今天怎么样？",
    });
    const fullInstructions = `${assembled.system}\n${assembled.prompt}`;
    expect(assembled.prompt).toContain("允许的短片段");
    expect(assembled.prompt).not.toContain(secretRawSource);
    expect(assembled.prompt).toContain('"register":"克制、简短"');
    expect(assembled.prompt).toContain('{"text":"the complete reply"}');
    expect(assembled.prompt).not.toContain(
      '{"text":"the complete reply","toneTags":[],"deliveryMode":"single_block"}',
    );
    expect(assembled.prompt).toContain(
      "chunks is optional and intended only for sequential delivery",
    );
    expect(assembled.prompt).toContain("For single_block, omit chunks");
    expect(assembled.prompt).toContain("REPLY_STRATEGY_JSON");
    expect(assembled.prompt).toContain("softTargetCharacters");
    expect(assembled.prompt).toContain("not a quota");
    expect(assembled.prompt).not.toContain(scheduleId);
    expect(assembled.prompt).not.toContain(memoryId);
    expect(assembled.prompt).not.toContain(userId);
    expect(assembled.prompt).not.toContain("agent-1");
    expect(assembled.system).toContain("replyDecision and worldEffects");
    expect(assembled.system).toContain(
      "For complex questions, explain naturally and completely",
    );
    expect(assembled.system).toContain(
      "Choose deliveryMode as the character would",
    );
    expect(assembled.system).toContain(
      "persona and dialogue or language style strictly",
    );
    expect(assembled.system).toContain(
      "external action or schedule change has been completed, submitted, committed",
    );
    expect(assembled.system).toContain(
      "Do not return schedules, memory records, mutations, identifiers",
    );
    expect(fullInstructions).not.toContain("AgentTurnDecision");
    expect(fullInstructions).not.toContain("matching schedule effect");
    expect(fullInstructions).not.toContain("valid schedule effect");
    expect(fullInstructions).not.toContain("reasonCode");
    expect(fullInstructions).not.toContain("reasonSummary");
    expect(assembled.system).toContain("chain-of-thought");
  });

  it("blocks a schedule mutation claim with no accepted proposal", () => {
    const result = guardPersonaReply({
      text: "我已经修改了今晚的日程。",
      acceptedScheduleEffects: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((entry) => entry.code)).toContain(
      "UNCOMMITTED_SCHEDULE_CLAIM",
    );
  });
});
