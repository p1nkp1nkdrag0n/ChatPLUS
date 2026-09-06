import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { readConfig } from "../config.js";
import { runLlmHttpSmoke } from "./llm-smoke-flow.js";

const MOCK_REPLY = "好啊。海边主题听起来不错，我会带件薄外套。";

describe("LLM HTTP smoke flow", () => {
  let provider: FastifyInstance | undefined;

  afterEach(async () => {
    if (provider) await provider.close();
    provider = undefined;
  });

  it("uses the model-facing reply contract and persists a strict server-owned decision", async () => {
    const requests: unknown[] = [];
    provider = Fastify({ logger: false });
    provider.post("/chat/completions", (request) => {
      requests.push(request.body);
      return {
        model: "mock-deepseek",
        choices: [
          {
            message: {
              content: JSON.stringify({
                replyDecision: {
                  text: MOCK_REPLY,
                  toneTags: ["warm"],
                },
                worldEffects: {},
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 12,
          total_tokens: 32,
        },
      };
    });
    const baseUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const config = readConfig({
      nodeEnv: "test",
      profile: "test",
      databasePath: ":memory:",
      clockMode: "fake",
      seedDemo: false,
      developerRoutes: false,
      llm: {
        provider: "openai-compatible",
        profileName: "legacy",
        baseUrl,
        apiKey: "test-placeholder-token",
        model: "mock-deepseek",
        timeoutMs: 2_000,
        maxRetries: 0,
        maxOutputTokens: 2_048,
        capabilities: {
          structuredOutputMode: "json_object",
          supportsThinkingControl: true,
          supportsStreaming: false,
          reasoningEffort: "low",
          reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
          maxOutputTokens: 2_048,
        },
      },
    });

    const result = await runLlmHttpSmoke(config);

    expect(result).toMatchObject({
      provider: "openai-compatible",
      profile: "legacy",
      model: "mock-deepseek",
      reasoningEffort: "low",
      reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
      applicationLlmPurposes: ["chat_turn"],
      repairUsed: false,
    });
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.assistantText).toBe(result.chunks.join("\n"));
    expect(result.assistantText.replace(/\n/gu, "")).toBe(MOCK_REPLY);
    expect(requests).toHaveLength(1);

    const body = z.record(z.string(), z.unknown()).parse(requests[0]);
    expect(body["model"]).toBe("mock-deepseek");
    expect(body["thinking"]).toEqual({ type: "enabled" });
    expect(body["reasoning_effort"]).toBe("low");
    expect(body["response_format"]).toEqual({ type: "json_object" });

    const messages = z
      .array(z.object({ role: z.string(), content: z.string() }).passthrough())
      .parse(body["messages"]);
    const marker = "EXPECTED_JSON_SCHEMA\n";
    const schemaMessage = messages.find((message) =>
      message.content.startsWith(marker),
    );
    expect(schemaMessage).toBeDefined();
    expect(schemaMessage?.role).toBe("user");
    expect(messages.at(-1)?.content).not.toContain(marker);
    expect(messages.indexOf(schemaMessage!)).toBeLessThan(messages.length - 1);
    const schemaText =
      schemaMessage?.content.slice(
        (schemaMessage?.content.indexOf(marker) ?? -1) + marker.length,
      ) ?? "";
    const schema = z
      .object({
        required: z.array(z.string()),
        properties: z.record(z.string(), z.unknown()),
      })
      .passthrough()
      .parse(JSON.parse(schemaText) as unknown);
    expect(schema.required).toEqual(["replyDecision", "worldEffects"]);
    expect(Object.keys(schema.properties)).toEqual([
      "replyDecision",
      "worldEffects",
      "scheduleEffects",
    ]);
    expect(schema.properties).not.toHaveProperty("text");
    expect(schema.properties).not.toHaveProperty("reasonCode");
    expect(schema.properties).not.toHaveProperty("reasonSummary");
    const worldEffects = z
      .object({
        properties: z.record(z.string(), z.unknown()),
      })
      .passthrough()
      .parse(schema.properties["worldEffects"]);
    expect(Object.keys(worldEffects.properties)).toEqual([
      "stateDelta",
      "relationshipDelta",
      "memoryCandidates",
      "personalIntentCandidates",
      "continuityEffects",
    ]);
  });
});
