import { CharacterSpecSchema } from "@personasim/contracts";
import {
  buildConversationContextPlan,
  assembleChatPrompt,
  deriveReplyStrategy,
  REPLY_TASK_GROUNDING_POLICY,
} from "@personasim/features";
import { estimatePromptTokens } from "@personasim/kernel";
import { describe, expect, it } from "vitest";

import { buildOriginalDraft } from "../domain/defaults.js";
import type { AgentTurnDecision } from "../domain/schemas.js";
import { CHARACTER_COMPILATION_POLICY_VERSION } from "./character-compiler.js";
import type { GenerateObjectInput, LlmService } from "./llm-service.js";
import { ReplyRepairService } from "./reply-repair-service.js";

const spec = CharacterSpecSchema.parse({
  ...buildOriginalDraft(
    {
      name: "陈雨",
      worldSetting: "当代城市",
      workOrRole: "花店店员",
      coreTraits: ["细心", "爱开玩笑"],
      initialRelationship: "初次相识",
      dialogueStyle: "随和，喜欢分享花店里具体的小趣事",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    },
    CHARACTER_COMPILATION_POLICY_VERSION,
  ),
  id: "agent-repair-expression",
  version: 1,
  status: "published",
  createdAtUtc: "2026-09-13T12:00:00.000Z",
  updatedAtUtc: "2026-09-13T12:00:00.000Z",
});

describe.each(["persona", "fixture"] as const)(
  "%s repair context headroom",
  (entrypoint) => {
    it.each([
      { contextTokens: 32_000, totalWindow: 32_000 },
      { contextTokens: 1_000_000, totalWindow: 258_000 },
    ])(
      "preserves grounding or skips before dispatch under a $totalWindow total window",
      async ({ contextTokens, totalWindow }) => {
        const calls: GenerateObjectInput<unknown>[] = [];
        const llm = {
          capabilities: {
            structuredOutputMode: "prompt_json",
            supportsThinkingControl: false,
            supportsStreaming: false,
            maxContextTokens: contextTokens,
            maxOutputTokens: 8_192,
          },
          generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
            calls.push(input);
            return Promise.resolve(
              input.schema.parse(input.fixture ?? { text: "修复后的回复。" }),
            );
          },
        } satisfies Pick<LlmService, "capabilities" | "generateObject">;
        // Use the execution override's window, not the constructor service's.
        const service = new ReplyRepairService({
          ...llm,
          capabilities: { ...llm.capabilities, maxContextTokens: 1_000_000 },
        } as LlmService);
        const fallback: AgentTurnDecision = {
          reply: { text: "原始保底。", chunks: ["原始保底。"], toneTags: [] },
          scheduleEffects: [],
          memoryCandidates: [],
          reasonCode: "test",
          reasonSummary: "Test repair fallback.",
        };
        const budget = { remaining: 2, attempts: 0 };
        const run = (replyGrounding: string) => {
          const common = {
            spec,
            llmExecution: llm as LlmService,
            userText: "今天想聊两句。",
            issues: ["Unsupported claim"],
            replyGrounding,
            repairBudget: budget,
          };
          return entrypoint === "fixture"
            ? service.repairFixtureDecision({
                ...common,
                invalidDecision: undefined,
                fallback,
              })
            : service.repairPersonaReply({
                ...common,
                invalidResponse: undefined,
                replyStrategy: deriveReplyStrategy(
                  common.userText,
                  spec.dialogue,
                ),
              });
        };
        const retained = "证".repeat((totalWindow - 18_000) / 2);
        expect(await run(retained)).toBeDefined();
        expect(calls).toHaveLength(1);
        const call = calls[0]!;
        expect(call.prompt).toContain(retained);
        expect(call.maxOutputTokens).toBe(8_192);
        expect(
          estimatePromptTokens(call.system + call.prompt) +
            call.maxOutputTokens! +
            2_000,
        ).toBeLessThanOrEqual(totalWindow);

        // The text alone fits, but borrowing its output reservation is forbidden.
        const result = await run("证".repeat((totalWindow - 8_000) / 2));
        expect(result).toBe(entrypoint === "fixture" ? fallback : undefined);
        expect(calls).toHaveLength(1);
        expect(budget).toEqual({ remaining: 1, attempts: 1 });
      },
    );
  },
);

const SOURCE_FACT = "陈雨喜欢留意花店里来往客人的小趣事。";
const RECENT_CONTEXT = "刚才说的花是向日葵。";
const GROUNDING = [
  "CHARACTER_SOURCE_JSON",
  JSON.stringify({
    id: "authored-source",
    text: SOURCE_FACT,
    allowedUses: ["explicit_mention"],
  }),
  "RECENT_VERBATIM_JSON",
  JSON.stringify([{ role: "user", content: RECENT_CONTEXT }]),
].join("\n");

async function captureRepair(userText: string) {
  const calls: GenerateObjectInput<unknown>[] = [];
  const llm = {
    capabilities: {
      structuredOutputMode: "prompt_json",
      supportsThinkingControl: false,
      supportsStreaming: false,
      maxOutputTokens: 8_192,
    },
    generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
      calls.push(input);
      return Promise.resolve(
        input.schema.parse({ text: "修复后的完整回复。" }),
      );
    },
  } satisfies Pick<LlmService, "capabilities" | "generateObject">;
  const plan = buildConversationContextPlan({
    originalQuery: userText,
    agentId: spec.id,
    sessionId: "session-repair-expression",
    recentMessages: [],
  });
  const replyStrategy = deriveReplyStrategy(userText, spec.dialogue, {
    conversationPlan: plan,
    relationship: { closeness: 0.1 },
  });
  const result = await new ReplyRepairService(
    llm as LlmService,
  ).repairPersonaReply({
    spec,
    userText,
    conversationPlan: plan,
    replyGrounding: GROUNDING,
    invalidResponse: { text: "需要修复的原回答。" },
    issues: [{ code: "UNSUPPORTED_CLAIM", text: "未获支持的经历" }],
    replyStrategy,
  });
  expect(result?.text).toBe("修复后的完整回复。");
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  const strategyLine = call.prompt
    .split("\n")
    .find((line) => line.startsWith("Soft reply strategy: "))!;
  const strategy = JSON.parse(
    strategyLine.slice("Soft reply strategy: ".length),
  ) as Record<string, unknown>;
  return { call, strategy };
}

describe("reply repair expression controls", () => {
  it.each([
    "今天路过花店，看见门口的花开得很好看。",
    "今天工作碰到了一点问题。",
    "猫今天趴在窗边，一点也不关心世界的问题。",
  ])("keeps ordinary repair free of quotas: %s", async (userText) => {
    const { call, strategy } = await captureRepair(userText);

    expect(call.purpose).toBe("repair_chat_turn");
    expect(call.maxRetries).toBe(0);
    expect(call.maxOutputTokens).toBe(8_192);
    expect(call.prompt).toContain(GROUNDING);
    expect(call.prompt.split(SOURCE_FACT)).toHaveLength(2);
    expect(call.prompt.split(RECENT_CONTEXT)).toHaveLength(2);
    expect(call.prompt).toContain(
      `"identity":${JSON.stringify(spec.identity)}`,
    );
    expect(call.prompt).toContain(
      `"traits":${JSON.stringify(spec.persona.traits)}`,
    );
    expect(call.prompt).toContain(
      `"dialogue":${JSON.stringify(spec.dialogue)}`,
    );
    expect(call.prompt).toContain(userText);
    expect(call.prompt).toContain("UNSUPPORTED_CLAIM");
    expect(call.prompt).toContain('"advicePolicy":"optional_light"');
    for (const field of [
      "targetMinChars",
      "targetMaxChars",
      "softTargetCharacters",
      "preferredChunkCount",
      "reviewUpperChars",
      "stateGuidance",
    ]) {
      expect(call.prompt).not.toContain(`"${field}":`);
    }
    expect(strategy.lengthOverride).toBe("none");
    expect(strategy.lengthGuidance).not.toMatch(/\d+\s*-\s*\d+\s*characters/u);
    expect(strategy.deliveryGuidance).not.toMatch(/around \d+ chunks/u);
    expect(strategy.affinityGuidance).not.toContain(
      "one short, complete thought",
    );
  });

  it.each([
    {
      name: "an explicit short reply",
      userText: "用一句话告诉我向日葵适合放在哪里。",
      lengthOverride: "explicit_brief",
    },
    {
      name: "explicit detailed help",
      userText: "请详细介绍照顾向日葵的步骤和注意事项。",
      lengthOverride: "requested_detail",
    },
  ])(
    "preserves soft guidance for $name",
    async ({ userText, lengthOverride }) => {
      const { call, strategy } = await captureRepair(userText);

      expect(strategy.lengthOverride).toBe(lengthOverride);
      const targets = strategy.softTargetCharacters as Record<string, unknown>;
      for (const field of ["minimum", "ideal", "maximum"])
        expect(typeof targets[field]).toBe("number");
      expect(strategy.lengthGuidance).toContain("guidance, not a quota");
      expect(strategy).not.toHaveProperty("preferredChunkCount");
      expect(strategy).not.toHaveProperty("reviewUpperChars");
      expect(call.prompt).toContain(userText);
      expect(call.prompt).toContain(GROUNDING);
    },
  );
});

describe.each(["persona", "fixture"] as const)(
  "%s repair runtime snapshot",
  (entrypoint) => {
    it.each(["fuzzy", "legacy_exact"] as const)(
      "uses only the original admitted %s state and canonical descriptions",
      async (lifePlanningMode) => {
        const state = {
          agentId: spec.id,
          asOfUtc: "2026-09-13T12:00:00.000Z",
          revision: 7,
          moodValence: -0.2,
          moodArousal: 0.7,
          energy: 0.2,
          stress: 0.3,
          socialBattery: 0.9,
          focus: 0.9,
          sleepDebtMinutes: 600,
        };
        const assembled = assembleChatPrompt({
          character: spec,
          state,
          lifePlanningMode,
          schedule: [],
          memories: [],
          recentMessages: [],
          nowUtc: state.asOfUtc,
          userMessage: "今天想聊两句。",
        });
        const lines = assembled.prompt.split("\n");
        const originalSnapshot =
          lines[lines.indexOf("RUNTIME_STATE_JSON") + 1]!;
        const calls: GenerateObjectInput<unknown>[] = [];
        const fallback: AgentTurnDecision = {
          reply: { text: "保底回复。", chunks: ["保底回复。"], toneTags: [] },
          scheduleEffects: [],
          memoryCandidates: [],
          reasonCode: "test",
          reasonSummary: "Test fallback.",
        };
        const llm = {
          capabilities: {
            structuredOutputMode: "prompt_json",
            supportsThinkingControl: false,
            supportsStreaming: false,
            maxOutputTokens: 8_192,
          },
          generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
            calls.push(input);
            return Promise.resolve(
              input.schema.parse(input.fixture ?? { text: "修复后的回复。" }),
            );
          },
        } satisfies Pick<LlmService, "capabilities" | "generateObject">;
        const service = new ReplyRepairService(llm as LlmService);
        // State advanced after dispatch. The repair must use the captured turn.
        state.energy = 0.95;
        state.focus = 0.1;
        state.revision = 8;
        const common = {
          spec,
          userText: "今天想聊两句。",
          issues: ["Contradictory current condition"],
          replyGrounding: assembled.replyGrounding,
        };
        if (entrypoint === "persona") {
          await service.repairPersonaReply({
            ...common,
            invalidResponse: { text: "我精力特别足。" },
            replyStrategy: assembled.replyStrategy,
          });
        } else {
          await service.repairFixtureDecision({
            ...common,
            invalidDecision: undefined,
            fallback,
          });
        }
        expect(calls).toHaveLength(1);
        const prompt = calls[0]!.prompt;
        // Both repair schemas share the generation policy without restoring
        // omitted data or duplicating the admitted grounding in that policy.
        expect(
          assembled.system.split(REPLY_TASK_GROUNDING_POLICY),
        ).toHaveLength(2);
        expect(
          calls[0]!.system.split(REPLY_TASK_GROUNDING_POLICY),
        ).toHaveLength(2);
        expect(prompt).not.toContain(REPLY_TASK_GROUNDING_POLICY);
        expect(prompt).toContain(`RUNTIME_STATE_JSON\n${originalSnapshot}`);
        expect(prompt.split(originalSnapshot)).toHaveLength(2);
        expect(prompt).toContain('"energy":0.2');
        expect(prompt).toContain('"focus":0.9');
        expect(prompt).not.toContain('"energy":0.95');
        expect(prompt).not.toContain('"stateGuidance":');
        expect(prompt).not.toContain('"summary":');
        expect(prompt).toContain(
          "same-turn snapshot admitted to the original reply",
        );
        expect(prompt).toContain(
          "not evidence of past events or permanent personality",
        );
        expect(prompt).toContain(`"dialogue":${JSON.stringify(spec.dialogue)}`);
        if (lifePlanningMode === "fuzzy") {
          expect(prompt).not.toContain('"sleepDebtMinutes":');
          expect(prompt).not.toContain('"sleepDebt":');
        } else {
          expect(prompt).toContain('"sleepDebtMinutes":600');
          expect(prompt).toContain("睡眠债很高");
        }
      },
    );
  },
);
