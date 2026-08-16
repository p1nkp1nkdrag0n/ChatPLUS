import {
  AgentTurnDecisionSchema,
  CharacterCompilationProposalSchema,
  type LLMRequest,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import { FakeClock, SystemClock, createClock } from "./clock.js";
import { createFixtureLlmProvider } from "./fixture-llm.js";

describe("clock providers", () => {
  it("advances a fake clock and never leaks its mutable Date", () => {
    const clock = new FakeClock("2026-06-01T00:00:00.000Z");
    const leaked = clock.now();
    leaked.setUTCFullYear(2030);
    expect(clock.nowUtc()).toBe("2026-06-01T00:00:00.000Z");
    clock.advance({ days: 1, hours: 2, minutes: 30 });
    expect(clock.nowUtc()).toBe("2026-06-02T02:30:00.000Z");
    expect(() => clock.setUtc("not-a-date")).toThrow(TypeError);
  });

  it("creates system and fake modes explicitly", () => {
    expect(createClock("system")).toBeInstanceOf(SystemClock);
    expect(
      createClock({ mode: "fake", initialUtc: "2026-01-01T00:00:00.000Z" }),
    ).toBeInstanceOf(FakeClock);
  });
});

describe("fixture LLM", () => {
  it("compiles a deterministic schema-valid character", async () => {
    const provider = createFixtureLlmProvider();
    const request: LLMRequest = {
      purpose: "compile_character",
      payload: {
        name: "林澈",
        worldSetting: "当代城市",
        workOrRole: "学生",
        coreTraits: ["克制", "好奇", "可靠"],
        coreContradiction: "独立但在意朋友",
        mainGoal: "完成研究",
        initialRelationship: "朋友",
        dialogueStyle: "简洁自然",
        tier: "high_fidelity",
        timezone: "Asia/Shanghai",
      },
    };
    const first = await provider.generate(request);
    const second = await provider.generate(request);
    const parsed = CharacterCompilationProposalSchema.parse(first.data);
    expect(parsed.draft.persona.boundaries).toHaveLength(3);
    expect(parsed.draft.routines.length).toBeGreaterThanOrEqual(5);
    expect(second.data).toEqual(first.data);
  });

  it("always accepts the fixture party invitation with a validated schedule proposal", async () => {
    const provider = createFixtureLlmProvider();
    const result = await provider.generate({
      purpose: "chat_turn",
      payload: {
        nowUtc: "2026-06-01T08:00:00.000Z",
        timezone: "Asia/Shanghai",
        userMessage: "今晚和我一起去参加晚会吧",
        schedule: [
          {
            id: "study-1",
            title: "自习",
            category: "study",
            startAtUtc: "2026-06-01T10:00:00.000Z",
            endAtUtc: "2026-06-01T13:00:00.000Z",
          },
        ],
      },
    });
    const parsed = AgentTurnDecisionSchema.parse(result.data);
    expect(parsed.reasonCode).toBe("accepted_social_invitation");
    expect(parsed.scheduleEffects.map((effect) => effect.operation)).toEqual([
      "cancel",
      "create",
    ]);
  });
});
