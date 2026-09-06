import type { LLMChatMessage } from "@personasim/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createOpenAiCompatibleLlmProvider } from "./openai-compatible-llm.js";
import type { LlmCallMetric } from "./types.js";

interface RecordedBody {
  messages: LLMChatMessage[];
  response_format?: unknown;
}

function harness(
  mode: "json_object" | "prompt_json" | "native_schema",
  diagnostics = true,
  repair = false,
) {
  const requests: RecordedBody[] = [];
  const metrics: LlmCallMetric[] = [];
  const provider = createOpenAiCompatibleLlmProvider({
    apiKey: "offline-fixture",
    promptDiagnostics: diagnostics,
    capabilities: {
      structuredOutputMode: mode,
      supportsThinkingControl: false,
      supportsStreaming: false,
      maxOutputTokens: 256,
    },
    onMetric: (metric) => metrics.push(metric),
    retryDelay: () => Promise.resolve(),
    fetch: (_url, init) => {
      if (typeof init?.body !== "string")
        throw new TypeError("Expected a serialized JSON request body");
      requests.push(JSON.parse(init.body) as RecordedBody);
      return Promise.resolve(
        Response.json({
          choices: [
            {
              message: {
                content:
                  repair && requests.length === 1
                    ? '{"ok":"invalid"}'
                    : '{"ok":true}',
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    },
  });
  return { provider, requests, metrics };
}

describe("stable structured prompt layout", () => {
  it.each(["json_object", "prompt_json"] as const)(
    "places one schema before changing input without promoting its role (%s)",
    async (mode) => {
      const { provider, requests, metrics } = harness(mode);
      const input = {
        purpose: "chat_turn",
        system: "Fixed role",
        prompt: "Private current data 01",
        schema: z.object({ ok: z.boolean() }).strict(),
      };
      await provider.generateObject(input);
      await provider.generateObject({
        ...input,
        prompt: "Private current data 02",
      });
      const first = requests[0]!;
      expect(first.messages.map((message) => message.role)).toEqual([
        "system",
        "system",
        "user",
        "user",
      ]);
      expect(first.messages[2]?.content).toMatch(/^EXPECTED_JSON_SCHEMA\n/u);
      expect(first.messages[3]?.content).toBe(input.prompt);
      expect(requests[1]?.messages.slice(0, 3)).toEqual(
        first.messages.slice(0, 3),
      );
      expect(
        JSON.stringify(first).match(/EXPECTED_JSON_SCHEMA/gu),
      ).toHaveLength(1);
      expect(JSON.stringify(first)).not.toContain("cache_control");
      expect(metrics[1]?.promptDiagnostics?.firstChangedMessageIndex).toBe(3);
      expect(JSON.stringify(metrics)).not.toContain("Private current data");
    },
  );

  it("uses native schema once and keeps its dynamic user message separate", async () => {
    const { provider, requests } = harness("native_schema");
    await provider.generateObject({
      purpose: "chat_turn",
      system: "Fixed role",
      prompt: "current",
      schema: z.object({ ok: z.boolean() }).strict(),
    });
    expect(requests[0]?.response_format).toMatchObject({ type: "json_schema" });
    expect(requests[0]?.messages).toHaveLength(3);
    expect(JSON.stringify(requests[0]?.messages)).not.toContain(
      "EXPECTED_JSON_SCHEMA",
    );
  });

  it("appends repair after the original stable messages and observes both attempts", async () => {
    const { provider, requests, metrics } = harness("json_object", true, true);
    await provider.generateObject({
      purpose: "chat_turn",
      system: "Fixed role",
      prompt: "current",
      schema: z.object({ ok: z.boolean() }).strict(),
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.slice(0, -1)).toEqual(requests[0]?.messages);
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      "STRUCTURED_OUTPUT_REPAIR",
    );
    expect(metrics.map((metric) => metric.success)).toEqual([false, true]);
    expect(metrics[1]?.promptDiagnostics?.firstChangedMessageIndex).toBe(4);
    expect(metrics[0]?.logicalCallId).toBe(metrics[1]?.logicalCallId);
  });

  it("keeps runtime-only schemas valid and diagnostics optional", async () => {
    const { provider, requests, metrics } = harness("json_object", false);
    const value = await provider.generateObject({
      purpose: "chat_turn",
      system: "Fixed role",
      prompt: "current",
      schema: z.object({
        ok: z.boolean().transform((value) => (value ? "yes" : "no")),
      }),
    });
    expect(value.ok).toBe("yes");
    expect(requests[0]?.messages).toHaveLength(3);
    expect(metrics[0]).not.toHaveProperty("promptDiagnostics");
  });
});
