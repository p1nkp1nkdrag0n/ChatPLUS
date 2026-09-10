import { CharacterSpecSchema } from "@personasim/contracts";
import type { ReplySteeringMode } from "@personasim/features";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { REPLY_REPAIR_SERVICE_TOKEN } from "../composition/service-tokens.js";
import { readConfig } from "../config.js";
import { buildOriginalDraft, initialRuntimeState } from "../domain/defaults.js";
import { FakeClock } from "../runtime/clock.js";
import { CHARACTER_COMPILATION_POLICY_VERSION } from "./character-compiler.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { LlmLogicalCallEvent } from "./llm-service.js";

const NOW = "2026-09-08T12:00:00.000Z";
const SESSION_ID = "session-reply-steering";
const USER_TEXT = "请以你自己的身份介绍一下自己。";
const REPAIRED_TEXT = "我是林夏，在书店工作。很高兴认识你。";
const DRAFT = buildOriginalDraft(
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
);
const SPEC = CharacterSpecSchema.parse({
  ...DRAFT,
  schedulePolicy: { ...DRAFT.schedulePolicy, enabled: false },
  id: "agent-reply-steering",
  version: 1,
  status: "published",
  createdAtUtc: NOW,
  updatedAtUtc: NOW,
});

type LogicalRequest = Extract<LlmLogicalCallEvent, { stage: "started" }>;
type WireRequest = Record<string, unknown> & {
  messages: { role: string; content: string }[];
};

function withoutLengthSteering(
  prompt: string,
  fields: readonly string[],
): string {
  const lines = prompt.split("\n");
  const index = lines.indexOf("REPLY_STRATEGY_JSON");
  if (index < 0) return prompt;
  const strategy = JSON.parse(lines[index + 1]!) as Record<string, unknown>;
  for (const key of fields) {
    expect(strategy).toHaveProperty(key);
    delete strategy[key];
  }
  lines[index + 1] = JSON.stringify(strategy);
  return lines.join("\n");
}

async function runIsolatedTurn(replySteeringMode?: ReplySteeringMode) {
  const logical: LogicalRequest[] = [];
  const completed: LlmLogicalCallEvent[] = [];
  const wire: WireRequest[] = [];
  const app = await buildApp({
    ...(replySteeringMode === undefined ? {} : { replySteeringMode }),
    config: readConfig({
      nodeEnv: "test",
      databasePath: ":memory:",
      clockMode: "fake",
      seedDemo: false,
      developerRoutes: false,
      lifePlanningMode: "legacy_exact",
      selfInitiatedPlanningMode: "off",
      liveWorldEffectsMode: "off",
      chatEffectsMode: "off",
      scheduleNegotiationMode: "legacy",
      companionContextMode: "enforced",
      personaRuntimeMode: "off",
      memoryRecallMode: "legacy",
      autobiographyMode: "off",
      llm: {
        provider: "openai-compatible",
        baseUrl: "https://reply-steering.invalid/v1",
        apiKey: "test-only-never-dispatched",
        model: "reply-steering-test-model",
        timeoutMs: 1_000,
        maxRetries: 0,
        maxOutputTokens: 32_768,
        capabilities: {
          structuredOutputMode: "json_object",
          supportsThinkingControl: false,
          supportsStreaming: false,
          maxContextTokens: 131_072,
          maxOutputTokens: 32_768,
        },
      },
    }),
    clock: new FakeClock(NOW),
    seedDemo: false,
    startScheduler: false,
    logger: false,
    llmObservation: {
      onLogicalCall: (event) => {
        if (event.stage === "started") logical.push(event);
        else completed.push(event);
      },
      // Exercise provider serialization, response parsing and metrics without
      // replacing LlmService or dispatching a paid network request.
      fetch: async (url, init) => {
        const request = new Request(url, init);
        expect(request.url).toBe(
          "https://reply-steering.invalid/v1/chat/completions",
        );
        wire.push(JSON.parse(await request.text()) as WireRequest);
        expect(wire.length).toBeLessThanOrEqual(2);
        const output =
          wire.length === 1
            ? {
                replyDecision: {
                  text: "作为一个AI语言模型，我没有自己的生活。",
                },
                worldEffects: {},
              }
            : { text: REPAIRED_TEXT, deliveryMode: "single_block" };
        return Response.json({
          id: `completion-${wire.length}`,
          object: "chat.completion",
          model: "reply-steering-test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(output) },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 30,
            total_tokens: 130,
          },
        });
      },
    },
  });
  const repairs = vi.spyOn(
    app.personasim.kernel.registry.resolve(REPLY_REPAIR_SERVICE_TOKEN),
    "repairPersonaReply",
  );
  try {
    const store = app.personasim.store;
    store.insertCharacter(SPEC);
    store.insertInitialState(initialRuntimeState(SPEC.id, NOW, SPEC), NOW);
    store.database
      .prepare(
        `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(SESSION_ID, SPEC.id, "Reply steering comparison", NOW, NOW);
    const initial = {
      spec: store.getCharacterSpec(SPEC.id),
      state: store.getRuntimeState(SPEC.id),
      session: store.getSession(SESSION_ID),
    };
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/messages`,
      payload: {
        agentId: SPEC.id,
        text: USER_TEXT,
        clientMessageId: "reply-steering-turn",
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const result = response.json<ChatTurnResult>();
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: "repair_chat_turn", success: true }),
      ]),
    );
    expect(result.assistantMessage.content.replaceAll("\n", "")).toBe(
      REPAIRED_TEXT,
    );
    expect(result.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(result.assistantMessage.content).toBe(
      result.decision.chunks.join("\n"),
    );
    expect(logical.map((call) => call.purpose)).toEqual([
      "chat_turn",
      "repair_chat_turn",
    ]);
    expect(completed).toHaveLength(2);
    expect(
      completed.every((event) => event.stage === "completed" && event.success),
    ).toBe(true);
    expect(wire).toHaveLength(2);
    expect(repairs).toHaveBeenCalledTimes(1);
    const repair = repairs.mock.calls[0]![0];
    expect(repair.replyGrounding).not.toContain("REPLY_STRATEGY_JSON");
    expect(repair.replyGrounding).not.toContain("softTargetCharacters");
    expect(repair.replyGrounding).toContain("RECENT_VERBATIM_JSON");
    expect(logical[1]!.prompt).toContain("AI_META_DISCLOSURE");
    expect(logical[1]!.prompt).toContain("Soft reply strategy:");
    expect(logical.map((call) => call.maxOutputTokens)).toEqual([
      24_576, 16_384,
    ]);
    return { initial, logical, wire, repair, result };
  } finally {
    repairs.mockRestore();
    await app.close();
  }
}

describe("reply steering through HTTP, provider transport and persona repair", () => {
  it.each([
    [
      "no_length_steering",
      [
        "softTargetCharacters",
        "preferredChunkCount",
        "deliveryPreference",
        "lengthGuidance",
        "deliveryGuidance",
      ],
    ],
    ["no_length_only_steering", ["softTargetCharacters", "lengthGuidance"]],
    ["no_chunk_count_steering", ["preferredChunkCount"]],
    ["no_delivery_steering", ["deliveryPreference", "deliveryGuidance"]],
  ] as const)(
    "%s changes only its main-prompt fields while holding repair fixed",
    async (mode, fields) => {
      const defaults = await runIsolatedTurn();
      const current = await runIsolatedTurn("current");
      const experimental = await runIsolatedTurn(mode);
      expect(current.initial).toEqual(defaults.initial);
      expect(experimental.initial).toEqual(current.initial);
      expect(current.logical).toEqual(defaults.logical);
      expect(current.wire).toEqual(defaults.wire);

      expect(experimental.logical).toEqual([
        {
          ...current.logical[0],
          prompt: withoutLengthSteering(current.logical[0]!.prompt, fields),
        },
        current.logical[1],
      ]);
      expect(experimental.wire).toEqual([
        {
          ...current.wire[0],
          messages: current.wire[0]!.messages.map((message) => ({
            ...message,
            content: withoutLengthSteering(message.content, fields),
          })),
        },
        current.wire[1],
      ]);
      expect(experimental.repair.replyStrategy).toEqual(
        current.repair.replyStrategy,
      );
      expect(experimental.repair.replyGrounding).toBe(
        current.repair.replyGrounding,
      );
      expect(experimental.repair.issues).toEqual(current.repair.issues);
      expect(experimental.result.decision).toEqual(current.result.decision);
      expect(experimental.result.assistantMessage.content).toBe(
        current.result.assistantMessage.content,
      );
    },
  );
});
