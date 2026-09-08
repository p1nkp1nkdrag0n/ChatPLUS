import { CharacterSpecSchema } from "@personasim/contracts";
import {
  buildConversationContextPlan,
  deriveReplyStrategy,
  turnExpressionPromptView,
} from "@personasim/features";
import { describe, expect, it } from "vitest";

import { buildOriginalDraft } from "../domain/defaults.js";
import type { AgentTurnDecision } from "../domain/schemas.js";
import { CHARACTER_COMPILATION_POLICY_VERSION } from "./character-compiler.js";
import type { GenerateObjectInput, LlmService } from "./llm-service.js";
import { ReplyRepairService } from "./reply-repair-service.js";

const NOW = "2026-09-08T12:00:00.000Z";
const CURRENT_USER = "好呀很高兴与你聊天";
const RETAINED_HISTORY = "开学这两天我一直担心研究室的人际相处。";
const OMITTED_HISTORY = "之前为了准备研究生开学，我买了一本蓝色笔记本。";
const REPAIRED_REPLY = "我也很开心呀。";
const spec = CharacterSpecSchema.parse({
  ...buildOriginalDraft(
    {
      name: "林夏",
      worldSetting: "当代城市",
      workOrRole: "书店店员",
      coreTraits: ["愿意倾听"],
      initialRelationship: "邻居",
      dialogueStyle: "自然简洁",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    },
    CHARACTER_COMPILATION_POLICY_VERSION,
  ),
  id: "agent-repair-grounding",
  version: 1,
  status: "published",
  createdAtUtc: NOW,
  updatedAtUtc: NOW,
});

const fallback: AgentTurnDecision = {
  reply: { text: REPAIRED_REPLY, chunks: [REPAIRED_REPLY], toneTags: [] },
  scheduleEffects: [],
  memoryCandidates: [],
  reasonCode: "test",
  reasonSummary: "Repair grounding regression.",
};

const groundingCases = [
  {
    name: "uses retained canonical history once without restoring omitted dialogue",
    grounding: `RECENT_VERBATIM_JSON\n${JSON.stringify([
      { role: "user", content: RETAINED_HISTORY },
    ])}`,
    retainedCount: 1,
    omittedCount: 0,
  },
  {
    name: "respects explicitly empty grounding without resurrecting raw history",
    grounding: "",
    retainedCount: 0,
    omittedCount: 0,
  },
  {
    name: "keeps inline history for callers without a canonical grounding input",
    grounding: undefined,
    retainedCount: 1,
    omittedCount: 1,
  },
];

describe.each(["fixture decision", "persona reply"] as const)(
  "%s repair grounding",
  (entrypoint) => {
    it.each(groundingCases)("$name", async (testCase) => {
      const plan = buildConversationContextPlan({
        originalQuery: CURRENT_USER,
        agentId: spec.id,
        sessionId: "session-repair-grounding",
        recentMessages: [OMITTED_HISTORY, RETAINED_HISTORY].map(
          (text, index) => ({
            id: `history-${index}`,
            agentId: spec.id,
            sessionId: "session-repair-grounding",
            role: "user" as const,
            text,
          }),
        ),
      });
      const originalPlan = structuredClone(plan);
      const calls: GenerateObjectInput<unknown>[] = [];
      const llm = {
        capabilities: {
          structuredOutputMode: "prompt_json",
          supportsThinkingControl: false,
          supportsStreaming: false,
        },
        generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
          calls.push(input);
          return Promise.resolve(
            input.schema.parse(input.fixture ?? { text: REPAIRED_REPLY }),
          );
        },
      } satisfies Pick<LlmService, "capabilities" | "generateObject">;
      const service = new ReplyRepairService(llm as LlmService);
      const common = {
        spec,
        userText: CURRENT_USER,
        conversationPlan: plan,
        ...(testCase.grounding === undefined
          ? {}
          : { replyGrounding: testCase.grounding }),
        issues: ["Invalid reply envelope"],
      };

      if (entrypoint === "fixture decision") {
        const result = await service.repairFixtureDecision({
          ...common,
          invalidDecision: undefined,
          fallback,
        });
        expect(result.reply.text).toBe(REPAIRED_REPLY);
      } else {
        const result = await service.repairPersonaReply({
          ...common,
          invalidResponse: undefined,
          replyStrategy: deriveReplyStrategy(CURRENT_USER, spec.dialogue),
        });
        expect(result?.text).toBe(REPAIRED_REPLY);
      }

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.purpose).toBe("repair_chat_turn");
      expect(call.prompt.split(RETAINED_HISTORY).length - 1).toBe(
        testCase.retainedCount,
      );
      expect(call.prompt.split(OMITTED_HISTORY).length - 1).toBe(
        testCase.omittedCount,
      );
      expect(call.prompt).toContain(CURRENT_USER);
      expect(call.prompt).toContain(
        `"topicGuidance":${JSON.stringify(turnExpressionPromptView(plan).topicGuidance)}`,
      );
      expect(plan).toEqual(originalPlan);
    });
  },
);
