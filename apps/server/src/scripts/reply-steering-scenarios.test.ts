import { describe, expect, it } from "vitest";
import { CharacterSpecSchema } from "@personasim/contracts";
import {
  assembleChatPrompt,
  buildConversationContextPlan,
} from "@personasim/features";
import {
  buildGuLanV3InitialState,
  LONG_RUN_V3_START_UTC,
} from "./companion-long-run-v3-baseline.js";

import {
  REPLY_STEERING_CATEGORIES,
  REPLY_STEERING_COMMON_SCENARIO_IDS,
  REPLY_STEERING_PERSONA_CONTEXT,
  REPLY_STEERING_PERSONAS,
  REPLY_STEERING_SCENARIOS,
  REPLY_STEERING_SCENARIO_VERSION,
  buildReplySteeringCharacter,
  replySteeringPersonaContext,
} from "./reply-steering-scenarios.js";

describe("reply-steering comparison fixtures", () => {
  it.each([
    "help-presentation-tonight",
    "detail-compare-work-options",
    "listen-switch-to-help",
  ])(
    "delivers requested-help policy through the actual prompt for %s",
    (scenarioId) => {
      const scene = REPLY_STEERING_SCENARIOS.find(
        (candidate) => candidate.id === scenarioId,
      )!;
      const plan = buildConversationContextPlan({
        originalQuery: scene.userText,
        agentId: "agent-test",
        sessionId: "session-test",
        recentMessages: [],
      });
      expect(plan).toMatchObject({
        intent: "help",
        adviceRequested: true,
        advicePolicy: "requested",
        supportStyle: "offer_requested_help",
        helpTiming: "now",
        requestPolicyVersion: "clause_requests_v3",
      });
      if (scenarioId === "detail-compare-work-options")
        expect(plan.detailedAnalysisRequested).toBe(true);
      const character = buildReplySteeringCharacter();
      const state = buildGuLanV3InitialState(character);
      const assembled = assembleChatPrompt({
        character,
        state: {
          agentId: state.agentId,
          asOfUtc: state.asOfUtc,
          revision: state.revision,
          moodValence: state.moodValence,
          moodArousal: state.moodArousal,
          energy: state.energy,
          stress: state.stress,
          socialBattery: state.socialBattery,
          focus: state.focus,
          sleepDebtMinutes: state.sleepDebtMinutes,
        },
        schedule: [],
        memories: [],
        recentMessages: scene.history,
        nowUtc: LONG_RUN_V3_START_UTC,
        userMessage: scene.userText,
        conversationPlan: plan,
        lifePlanningMode: "fuzzy",
        decisionMode: "reply_only",
      });
      const lines = assembled.prompt.split("\n");
      const delivered = JSON.parse(
        lines[lines.indexOf("REPLY_STRATEGY_JSON") + 1]!,
      ) as Record<string, unknown>;
      expect(delivered).toMatchObject({
        conversationIntent: "help",
        adviceRequested: true,
        advicePolicy: "requested",
        supportStyle: "offer_requested_help",
        helpTiming: "now",
      });
      if (scenarioId === "help-presentation-tonight") {
        expect(plan.structuredTaskRequested).toBe(true);
        expect(delivered).toMatchObject({ complexity: "complex" });
        expect(delivered.lengthGuidance).not.toContain(
          "ordinary conversational turn",
        );
      }
      if (scenarioId === "listen-switch-to-help") {
        expect(plan.structuredTaskRequested).toBe(false);
        expect(delivered).toMatchObject({ complexity: "standard" });
      }
    },
  );
  it("keeps a balanced twelve-case corpus for every compared model", () => {
    expect(REPLY_STEERING_SCENARIO_VERSION).toBe("reply-steering-scenarios-v1");
    expect(REPLY_STEERING_SCENARIOS).toHaveLength(12);
    expect(new Set(REPLY_STEERING_SCENARIOS.map((item) => item.id)).size).toBe(
      12,
    );
    for (const category of REPLY_STEERING_CATEGORIES) {
      expect(
        REPLY_STEERING_SCENARIOS.filter((item) => item.category === category),
      ).toHaveLength(2);
    }
  });

  it("can freeze the exact persona, histories, inputs and rubrics in a run manifest", () => {
    expect(JSON.parse(JSON.stringify(REPLY_STEERING_SCENARIOS))).toEqual(
      REPLY_STEERING_SCENARIOS,
    );
    for (const scenario of REPLY_STEERING_SCENARIOS) {
      expect(scenario.characterContext).toBe(REPLY_STEERING_PERSONA_CONTEXT);
      expect(scenario.userText.trim().length).toBeGreaterThan(0);
      expect(scenario.history.length).toBeGreaterThan(0);
      scenario.history.forEach((message, index) => {
        expect(message.role).toBe(index % 2 === 0 ? "user" : "assistant");
        expect(message.content.trim().length).toBeGreaterThan(0);
      });
      expect(scenario.history.at(-1)?.role).toBe("assistant");
      expect(scenario.rubric.successCriteria.length).toBeGreaterThan(0);
      expect(scenario.rubric.failureModes.length).toBeGreaterThan(0);
      expect(scenario.rubric.lengthGuidance.trim().length).toBeGreaterThan(0);
    }
  });

  it("includes a stage transition that must override an earlier listen-only request", () => {
    const scenario = REPLY_STEERING_SCENARIOS.find(
      (item) => item.id === "listen-switch-to-help",
    )!;
    expect(scenario.history[0]?.content).toContain("暂时不要给建议");
    expect(scenario.userText).toContain("现在可以一起想办法了");
    expect(scenario.userText).toContain("帮我拟一版");
    expect(scenario.rubric.successCriteria.join("\n")).toContain(
      "从倾听切换到帮助",
    );
  });

  it("treats completeness as required when the user explicitly asks for depth", () => {
    const detailedCases = REPLY_STEERING_SCENARIOS.filter(
      (item) => item.category === "detailed-response",
    );
    for (const scenario of detailedCases) {
      expect(scenario.rubric.successCriteria.length).toBeGreaterThanOrEqual(3);
      expect(scenario.rubric.failureModes.join("\n")).toMatch(/遗漏|不回答/u);
      expect(scenario.rubric.lengthGuidance).toMatch(/不奖励|不按/u);
    }
  });

  it("does not smuggle target response policy into the shared persona context", () => {
    expect(REPLY_STEERING_PERSONA_CONTEXT).not.toMatch(
      /简洁|短回复|一到三段|不要建议|先确认.*倾听|先辨认.*倾听/u,
    );
    expect(REPLY_STEERING_PERSONA_CONTEXT).toContain("被摄者的同意与尊严");
    expect(REPLY_STEERING_PERSONA_CONTEXT).toContain("尚未完成终剪或公开放映");
  });

  it("uses a preregistered common subset spanning every category", () => {
    const cases = REPLY_STEERING_COMMON_SCENARIO_IDS.map((id) =>
      REPLY_STEERING_SCENARIOS.find((item) => item.id === id),
    );
    expect(cases).toHaveLength(6);
    expect(new Set(cases.map((item) => item?.category))).toEqual(
      new Set(REPLY_STEERING_CATEGORIES),
    );
  });

  it("freezes three valid, independently built personalities with identical facts and budgets", () => {
    const specs = REPLY_STEERING_PERSONAS.map((persona) =>
      buildReplySteeringCharacter(persona.id),
    );
    expect(new Set(specs.map((spec) => spec.identity.name)).size).toBe(3);
    for (const [index, spec] of specs.entries()) {
      const persona = REPLY_STEERING_PERSONAS[index]!;
      expect(CharacterSpecSchema.safeParse(spec).success).toBe(true);
      expect(spec).toEqual(buildReplySteeringCharacter(persona.id));
      expect(spec.persona.values).toEqual(specs[0]!.persona.values);
      expect(spec.persona.goals).toEqual(specs[0]!.persona.goals);
      expect(spec.persona.biography).toEqual(specs[0]!.persona.biography);
      expect(spec.userRelationship).toEqual(specs[0]!.userRelationship);
      expect(spec.dialogue.averageMessageLength).toBe(
        specs[0]!.dialogue.averageMessageLength,
      );
      expect(spec.dialogue.averageChunksPerTurn).toBe(
        specs[0]!.dialogue.averageChunksPerTurn,
      );
      expect(spec.dialogue.verbosity).toBe(specs[0]!.dialogue.verbosity);
      expect(spec.dialogue.authorGuidance).not.toMatch(
        /简短|简洁|少说|多说|字数|段落|分段/u,
      );
      expect(spec.knowledge.knownFacts.join("\n")).toContain("曾因拒绝");
      expect(spec.knowledge.knownFacts.join("\n")).toContain(persona.name);
      expect(replySteeringPersonaContext(persona.id)).toContain(
        persona.description,
      );
      if (persona.name !== "顾澜") {
        expect(JSON.stringify(spec)).not.toContain("顾澜");
      }
    }
    expect(specs[0]!.persona.traits).not.toEqual(specs[1]!.persona.traits);
    expect(specs[1]!.dialogue.warmth).toBeLessThan(specs[0]!.dialogue.warmth);
    expect(specs[2]!.dialogue.humor).toBeGreaterThan(specs[0]!.dialogue.humor);
    specs[0]!.persona.values[0]!.description = "mutation in one run";
    expect(
      buildReplySteeringCharacter().persona.values[0]!.description,
    ).not.toContain("mutation");
  });
});
