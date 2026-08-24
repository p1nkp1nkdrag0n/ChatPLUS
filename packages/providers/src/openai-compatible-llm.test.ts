import {
  CharacterCompilationProposalSchema,
  StrictPersonaTurnProviderEnvelopeSchema,
  type JsonValue,
  type LLMRequest,
} from "@personasim/contracts";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { createFixtureLlmProvider } from "./fixture-llm.js";
import {
  createOpenAiCompatibleLlmProvider,
  LlmProviderError,
  redactSensitiveText,
} from "./openai-compatible-llm.js";
import { parseJsonText, StructuredOutputError } from "./safe-json.js";
import type { LlmCallMetric } from "./types.js";

function requestBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== "string")
    throw new TypeError("Expected a JSON request body");
  return body;
}

function occurrences(value: string, sentinel: string): number {
  return value.split(sentinel).length - 1;
}

type MutableCharacterProposal = {
  draft: {
    identity: { name: string };
    schedulePolicy: { horizonHours: number };
    sources: Array<Record<string, unknown>>;
  };
};

async function validCharacterProposal(): Promise<MutableCharacterProposal> {
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
  const response = await createFixtureLlmProvider().generate(request);
  if (response.data === undefined)
    throw new TypeError("Fixture did not return structured character data");
  return structuredClone(response.data) as unknown as MutableCharacterProposal;
}

function characterResponse(data: JsonValue): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(data) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("safe JSON parsing", () => {
  it("accepts a fenced JSON object without accepting surrounding prose", () => {
    expect(parseJsonText('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(parseJsonText('result: {"ok":true} trailing')).toEqual({ ok: true });
  });
});

describe("OpenAI-compatible provider", () => {
  it("normalizes the runtime-owned 72-hour horizon before strict character validation", async () => {
    const proposal = await validCharacterProposal();
    proposal.draft.schedulePolicy.horizonHours = 168;
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: () =>
        Promise.resolve(characterResponse(proposal as unknown as JsonValue)),
      maxRetries: 0,
      retryDelay: () => Promise.resolve(),
    });

    const value = await provider.generateObject({
      purpose: "compile_character",
      system: "Return JSON.",
      prompt: "Compile a character.",
      schema: CharacterCompilationProposalSchema,
    });

    expect(value.draft.schedulePolicy.horizonHours).toBe(72);
    expect(CharacterCompilationProposalSchema.safeParse(value).success).toBe(
      true,
    );
  });

  it("strips runtime-owned optional source metadata before strict character validation", async () => {
    const proposal = await validCharacterProposal();
    proposal.draft.sources[0] = {
      ...proposal.draft.sources[0]!,
      workTitle: "",
      locator: "",
      excerpt: "",
      checksum: "not-a-sha256",
      createdAtUtc: "not-a-utc-instant",
    };
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: () =>
        Promise.resolve(characterResponse(proposal as unknown as JsonValue)),
      maxRetries: 0,
      retryDelay: () => Promise.resolve(),
    });

    const value = await provider.generateObject({
      purpose: "compile_character",
      system: "Return JSON.",
      prompt: "Compile a character.",
      schema: CharacterCompilationProposalSchema,
    });

    expect(value.draft.sources[0]).not.toHaveProperty("workTitle");
    expect(value.draft.sources[0]).not.toHaveProperty("locator");
    expect(value.draft.sources[0]).not.toHaveProperty("excerpt");
    expect(value.draft.sources[0]).not.toHaveProperty("checksum");
    expect(value.draft.sources[0]).not.toHaveProperty("createdAtUtc");
    expect(CharacterCompilationProposalSchema.safeParse(value).success).toBe(
      true,
    );
  });

  it("still rejects unrelated invalid character fields after horizon normalization", async () => {
    const proposal = await validCharacterProposal();
    proposal.draft.schedulePolicy.horizonHours = 168;
    proposal.draft.identity.name = "";
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: () =>
        Promise.resolve(characterResponse(proposal as unknown as JsonValue)),
      maxRetries: 0,
      retryDelay: () => Promise.resolve(),
    });

    let thrown: unknown;
    try {
      await provider.generateObject({
        purpose: "compile_character",
        system: "Return JSON.",
        prompt: "Compile a character.",
        schema: CharacterCompilationProposalSchema,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StructuredOutputError);
    if (!(thrown instanceof StructuredOutputError))
      throw new TypeError("Expected strict structured-output validation");
    expect(
      thrown.issues.some((issue) => issue.includes("draft.identity.name")),
    ).toBe(true);
  });

  it("uses DeepSeek V4 Flash JSON mode with thinking disabled and ignores reasoning output", async () => {
    let requestInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = (_input, init) => {
      requestInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "deepseek-v4-flash",
            choices: [
              {
                message: {
                  content: '{"ok":true}',
                  reasoning_content: "must never be returned or persisted",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    };
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: fakeFetch,
      retryDelay: () => Promise.resolve(),
    });
    const value = await provider.generateObject({
      purpose: "chat_turn",
      system: "Return JSON.",
      prompt: "Test",
      schema: z.object({ ok: z.boolean() }).strict(),
    });
    expect(value).toEqual({ ok: true });
    const body = JSON.parse(requestBody(requestInit)) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body).toHaveProperty("max_tokens");
    expect(JSON.stringify(value)).not.toContain("reasoning");
  });

  it("rejects legacy flat chat output at the strict generateObject boundary", async () => {
    const legacyFlat = {
      text: "Legacy flat output must not reach the server.",
      stateDelta: { energy: -0.1 },
    } as JsonValue;
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: () => Promise.resolve(characterResponse(legacyFlat)),
      maxRetries: 0,
      retryDelay: () => Promise.resolve(),
    });

    let thrown: unknown;
    try {
      await provider.generateObject({
        purpose: "chat_turn",
        system: "Return the canonical chat envelope.",
        prompt: "Test",
        schema: StrictPersonaTurnProviderEnvelopeSchema,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StructuredOutputError);
    if (!(thrown instanceof StructuredOutputError)) {
      throw new TypeError("Expected strict structured-output validation");
    }
    expect(thrown.issues.some((issue) => issue.includes("replyDecision"))).toBe(
      true,
    );
  });

  it("omits unsupported controls in prompt JSON mode and clamps output tokens", async () => {
    let requestInit: RequestInit | undefined;
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      capabilities: {
        structuredOutputMode: "prompt_json",
        supportsThinkingControl: false,
        supportsStreaming: false,
        maxContextTokens: 4_096,
        maxOutputTokens: 256,
      },
      maxOutputTokens: 1_024,
      fetch: (_input, init) => {
        requestInit = init;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: '{"ok":true}' },
                  finish_reason: "stop",
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      },
      retryDelay: () => Promise.resolve(),
    });

    await provider.generateObject({
      purpose: "chat_turn",
      system: "Return JSON.",
      prompt: "Test",
      schema: z.object({ ok: z.boolean() }).strict(),
      maxOutputTokens: 2_048,
    });

    const body = JSON.parse(requestBody(requestInit)) as Record<
      string,
      unknown
    >;
    expect(provider.capabilities.structuredOutputMode).toBe("prompt_json");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("response_format");
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(256);
  });

  it("uses a native JSON schema response format when supported", async () => {
    let requestInit: RequestInit | undefined;
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      capabilities: {
        structuredOutputMode: "native_schema",
        supportsThinkingControl: false,
        supportsStreaming: false,
        maxOutputTokens: 8_192,
      },
      fetch: (_input, init) => {
        requestInit = init;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: '{"ok":true}' },
                  finish_reason: "stop",
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      },
      retryDelay: () => Promise.resolve(),
    });

    await provider.generateObject({
      purpose: "chat_turn",
      system: "Return JSON.",
      prompt: "Test",
      schema: z.object({ ok: z.boolean() }).strict(),
    });

    const body = JSON.parse(requestBody(requestInit)) as Record<
      string,
      unknown
    >;
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "personasim_chat_turn",
        strict: true,
      },
    });
    expect(JSON.stringify(body.response_format)).toContain('"ok"');
  });

  it("does not emit a physical attempt when native-schema preflight fails", async () => {
    let fetchCalls = 0;
    const metrics: LlmCallMetric[] = [];
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      capabilities: {
        structuredOutputMode: "native_schema",
        supportsThinkingControl: false,
        supportsStreaming: false,
        maxOutputTokens: 8_192,
      },
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(characterResponse({ ok: true }));
      },
      onMetric: (metric) => metrics.push(metric),
      retryDelay: () => Promise.resolve(),
    });

    await expect(
      provider.generateObject({
        purpose: "chat_turn",
        system: "Return JSON.",
        prompt: "Test",
        schema: z.object({
          ok: z.string().transform((value) => value.length > 0),
        }),
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_RESPONSE_SCHEMA" });

    expect(fetchCalls).toBe(0);
    expect(metrics).toEqual([]);
  });

  it("serializes generateObject prompts exactly once and keeps large request bodies bounded", async () => {
    let requestInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = (_input, init) => {
      requestInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: '{"ok":true}' },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    };
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: fakeFetch,
      retryDelay: () => Promise.resolve(),
    });
    const sentinel = "GENERATE_OBJECT_PROMPT_SENTINEL";
    const prompt = `${sentinel}:${"x".repeat(80_000)}`;

    await provider.generateObject({
      purpose: "chat_turn",
      system: "Return JSON.",
      prompt,
      schema: z.object({ ok: z.boolean() }).strict(),
    });

    const body = requestBody(requestInit);
    expect(occurrences(body, sentinel)).toBe(1);
    expect(body.length).toBeLessThan(prompt.length + 5_000);
    expect(body).not.toContain("INPUT_PAYLOAD_JSON");
  });

  it("serializes complete prompts exactly once and keeps large request bodies bounded", async () => {
    let requestInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = (_input, init) => {
      requestInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    content: "完成",
                    reasonCode: "activity_share",
                    reasonSummary: "分享已完成活动",
                  }),
                },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    };
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: fakeFetch,
      retryDelay: () => Promise.resolve(),
    });
    const sentinel = "COMPLETE_PROMPT_SENTINEL";
    const prompt = `${sentinel}:${"请".repeat(40_000)}`;

    await provider.complete({
      purpose: "compose_proactive_message",
      system: "Return JSON.",
      prompt,
    });

    const body = requestBody(requestInit);
    expect(occurrences(body, sentinel)).toBe(1);
    expect(body.length).toBeLessThan(prompt.length + 5_000);
    expect(body).not.toContain("INPUT_PAYLOAD_JSON");
  });

  it("still serializes structured payloads supplied to generate", async () => {
    let requestInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = (_input, init) => {
      requestInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    content: "完成",
                    reasonCode: "activity_share",
                    reasonSummary: "分享已完成活动",
                  }),
                },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    };
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: fakeFetch,
      retryDelay: () => Promise.resolve(),
    });

    await provider.generate({
      purpose: "compose_proactive_message",
      messages: [{ role: "user", content: "Use the structured context." }],
      payload: { eventId: "event-structured-sentinel", importance: 0.9 },
    });

    expect(requestBody(requestInit)).toContain(
      'INPUT_PAYLOAD_JSON\\n{\\"eventId\\":\\"event-structured-sentinel\\",\\"importance\\":0.9}\\n',
    );
  });

  it("retries schema-invalid structured output with the unchanged prompt", async () => {
    let calls = 0;
    const bodies: string[] = [];
    const fakeFetch: typeof fetch = (_input, init) => {
      calls += 1;
      bodies.push(requestBody(init));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    calls === 1
                      ? '{"ok":false,"private":"RAW_RESPONSE_SENTINEL"}'
                      : '{"ok":true}',
                },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    };
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: fakeFetch,
      maxRetries: 1,
      retryDelay: () => Promise.resolve(),
    });
    await expect(
      provider.generateObject({
        purpose: "chat_turn",
        system: "JSON",
        prompt: "Test",
        schema: z.object({ ok: z.literal(true) }).strict(),
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[1]).not.toContain("STRUCTURED_OUTPUT_REPAIR");
    expect(bodies[1]).not.toContain("RAW_RESPONSE_SENTINEL");
  });

  it("emits schema-invalid output as a failed physical attempt and preserves per-attempt usage", async () => {
    let calls = 0;
    const metrics: LlmCallMetric[] = [];
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      calls === 1
                        ? '{"ok":false,"private":"RAW_RESPONSE_SENTINEL"}'
                        : '{"ok":true}',
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: calls === 1 ? 11 : 13,
                completion_tokens: calls === 1 ? 2 : 3,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
      maxRetries: 1,
      onMetric: (metric) => metrics.push(metric),
      retryDelay: () => Promise.resolve(),
    });

    await expect(
      provider.generateObject({
        purpose: "chat_turn",
        system: "JSON",
        prompt: "Test",
        schema: z.object({ ok: z.literal(true) }).strict(),
      }),
    ).resolves.toEqual({ ok: true });

    expect(metrics).toEqual([
      expect.objectContaining({
        attempt: 1,
        success: false,
        status: 200,
        inputTokens: 11,
        outputTokens: 2,
        errorCode: "INVALID_STRUCTURED_OUTPUT",
      }),
      expect.objectContaining({
        attempt: 2,
        success: true,
        status: 200,
        inputTokens: 13,
        outputTokens: 3,
      }),
    ]);
    expect(metrics[0]).not.toHaveProperty("content");
    expect(JSON.stringify(metrics)).not.toContain("RAW_RESPONSE_SENTINEL");
  });

  it("retries output-truncated structured responses unchanged and preserves per-attempt usage", async () => {
    let calls = 0;
    const bodies: string[] = [];
    const metrics: LlmCallMetric[] = [];
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: (_input, init) => {
        calls += 1;
        bodies.push(requestBody(init));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      calls === 1
                        ? '{"ok":true,"private":"TRUNCATED_RESPONSE_SENTINEL"'
                        : '{"ok":true}',
                  },
                  finish_reason: calls === 1 ? "length" : "stop",
                },
              ],
              usage: {
                prompt_tokens: calls === 1 ? 19 : 23,
                completion_tokens: calls === 1 ? 2_000 : 4,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
      maxRetries: 1,
      onMetric: (metric) => metrics.push(metric),
      retryDelay: () => Promise.resolve(),
    });

    await expect(
      provider.generateObject({
        purpose: "chat_turn",
        system: "JSON",
        prompt: "OUTPUT_TRUNCATION_RETRY_PROMPT",
        schema: z.object({ ok: z.literal(true) }).strict(),
      }),
    ).resolves.toEqual({ ok: true });

    expect(calls).toBe(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[1]).not.toContain("STRUCTURED_OUTPUT_REPAIR");
    expect(bodies[1]).not.toContain("TRUNCATED_RESPONSE_SENTINEL");
    expect(metrics).toEqual([
      expect.objectContaining({
        attempt: 1,
        success: false,
        status: 200,
        inputTokens: 19,
        outputTokens: 2_000,
        errorCode: "OUTPUT_TRUNCATED",
      }),
      expect.objectContaining({
        attempt: 2,
        success: true,
        status: 200,
        inputTokens: 23,
        outputTokens: 4,
      }),
    ]);
    expect(metrics[1]).not.toHaveProperty("errorCode");
    expect(JSON.stringify(metrics)).not.toContain(
      "TRUNCATED_RESPONSE_SENTINEL",
    );
  });

  it("retains valid provider usage when the surrounding response envelope is invalid", async () => {
    const metrics: LlmCallMetric[] = [];
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              unexpected: true,
              usage: { prompt_tokens: 17, completion_tokens: 4 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      maxRetries: 0,
      onMetric: (metric) => metrics.push(metric),
      retryDelay: () => Promise.resolve(),
    });

    await expect(
      provider.generateObject({
        purpose: "chat_turn",
        system: "JSON",
        prompt: "Test",
        schema: z.object({ ok: z.literal(true) }).strict(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE_ENVELOPE" });
    expect(metrics).toEqual([
      expect.objectContaining({
        attempt: 1,
        success: false,
        inputTokens: 17,
        outputTokens: 4,
        errorCode: "INVALID_RESPONSE_ENVELOPE",
      }),
    ]);
  });

  it("fails after the structured-output retry budget is exhausted", async () => {
    let calls = 0;
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          characterResponse({ ok: false, private: "RAW_RESPONSE_SENTINEL" }),
        );
      },
      maxRetries: 1,
      retryDelay: () => Promise.resolve(),
    });

    await expect(
      provider.generateObject({
        purpose: "chat_turn",
        system: "JSON",
        prompt: "Test",
        schema: z.object({ ok: z.literal(true) }).strict(),
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
    expect(calls).toBe(2);
  });

  it.each([
    {
      label: "an invalid response envelope",
      response: () =>
        new Response(JSON.stringify({ unexpected: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      code: "INVALID_RESPONSE_ENVELOPE",
    },
    {
      label: "an empty response",
      response: () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      code: "EMPTY_RESPONSE",
    },
  ])("does not retry $label", async ({ response, code }) => {
    let calls = 0;
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: () => {
        calls += 1;
        return Promise.resolve(response());
      },
      maxRetries: 2,
      retryDelay: () => Promise.resolve(),
    });

    let thrown: unknown;
    try {
      await provider.generateObject({
        purpose: "chat_turn",
        system: "JSON",
        prompt: "Test",
        schema: z.object({ ok: z.literal(true) }).strict(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LlmProviderError);
    expect(thrown).toMatchObject({ code });
    expect(calls).toBe(1);
  });

  it.each([400, 409])("does not retry HTTP %s responses", async (status) => {
    let calls = 0;
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response("request rejected", { status }));
      },
      maxRetries: 2,
      retryDelay: () => Promise.resolve(),
    });

    await expect(
      provider.generateObject({
        purpose: "chat_turn",
        system: "JSON",
        prompt: "Test",
        schema: z.object({ ok: z.literal(true) }).strict(),
      }),
    ).rejects.toMatchObject({ code: "HTTP_ERROR", status });
    expect(calls).toBe(1);
  });

  it.each(["network", "timeout", "rate-limit", "server"] as const)(
    "retries %s failures with the unchanged original prompt",
    async (mode) => {
      let calls = 0;
      const bodies: string[] = [];
      const fakeFetch: typeof fetch = (_input, init) => {
        calls += 1;
        bodies.push(requestBody(init));
        if (calls === 1) {
          if (mode === "network") {
            return Promise.reject(new TypeError("simulated network failure"));
          }
          if (mode === "timeout") {
            return Promise.reject(new DOMException("timed out", "AbortError"));
          }
          return Promise.resolve(
            new Response("retry later", {
              status: mode === "rate-limit" ? 429 : 503,
            }),
          );
        }
        return Promise.resolve(characterResponse({ ok: true }));
      };
      const provider = createOpenAiCompatibleLlmProvider({
        apiKey: "test-placeholder-token",
        fetch: fakeFetch,
        maxRetries: 1,
        retryDelay: () => Promise.resolve(),
      });

      await expect(
        provider.generateObject({
          purpose: "chat_turn",
          system: "JSON",
          prompt: "NETWORK_RETRY_PROMPT",
          schema: z.object({ ok: z.literal(true) }).strict(),
        }),
      ).resolves.toEqual({ ok: true });

      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[1]).not.toContain("STRUCTURED_OUTPUT_REPAIR");
    },
  );

  it("redacts authorization headers and secret-looking tokens", () => {
    const secretLikeToken = ["s", "k-example12345678"].join("");
    const safe = redactSensitiveText(
      `Authorization: Bearer private-value and token ${secretLikeToken}`,
      ["private-value"],
    );
    expect(safe).not.toContain("private-value");
    expect(safe).not.toContain(secretLikeToken);
    expect(safe).toContain("[REDACTED]");
  });
});
