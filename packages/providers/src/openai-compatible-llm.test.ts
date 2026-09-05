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
  it("accepts a fifteen-minute timeout for high-effort structured compilation", () => {
    expect(() =>
      createOpenAiCompatibleLlmProvider({
        apiKey: "test-placeholder-token",
        timeoutMs: 900_000,
      }),
    ).not.toThrow();
    expect(() =>
      createOpenAiCompatibleLlmProvider({
        apiKey: "test-placeholder-token",
        timeoutMs: 900_001,
      }),
    ).toThrow(/between 100 and 900000/u);
  });

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

  it("uses the DashScope Qwen Flash endpoint and returns only the final Chinese JSON", async () => {
    let requestUrl: Parameters<typeof fetch>[0] | undefined;
    let requestInit: RequestInit | undefined;
    const metrics: LlmCallMetric[] = [];
    const hiddenReasoning = "QWEN_REASONING_SENTINEL：这不是角色的最终回复。";
    const reply = { text: "今天过得怎么样？我想听听你的故事。" };
    const provider = createOpenAiCompatibleLlmProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/",
      apiKey: "test-qwen-profile-key",
      model: "qwen3.8-flash",
      timeoutMs: 300_000,
      maxRetries: 1,
      maxOutputTokens: 32_768,
      capabilities: {
        structuredOutputMode: "json_object",
        supportsThinkingControl: false,
        supportsStreaming: false,
        reasoningEffort: "medium",
        reasoningRequestFormat: "openai_reasoning_effort",
        maxContextTokens: 1_000_000,
        maxOutputTokens: 32_768,
      },
      fetch: (input, init) => {
        requestUrl = input;
        requestInit = init;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model: "qwen3.8-flash",
              choices: [
                {
                  message: {
                    content: JSON.stringify(reply),
                    reasoning_content: hiddenReasoning,
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 40,
                completion_tokens: 30,
                total_tokens: 70,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
      onMetric: (metric) => metrics.push(metric),
      retryDelay: () => Promise.resolve(),
    });

    const value = await provider.generateObject({
      purpose: "chat_turn",
      system: "请扮演一位关心朋友的角色，以 JSON 返回回复。",
      prompt: "今天有点累，想和你聊聊天。",
      schema: z.object({ text: z.string() }).strict(),
    });

    expect(requestUrl).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("Authorization")).toBe(
      "Bearer test-qwen-profile-key",
    );
    const body = JSON.parse(requestBody(requestInit)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      model: "qwen3.8-flash",
      reasoning_effort: "medium",
      response_format: { type: "json_object" },
      stream: false,
      max_tokens: 32_768,
    });
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
    expect(value).toEqual(reply);
    expect(JSON.stringify(value)).not.toContain(hiddenReasoning);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      responseModel: "qwen3.8-flash",
      success: true,
      inputTokens: 40,
      outputTokens: 30,
    });
    expect(JSON.stringify(metrics)).not.toContain(hiddenReasoning);
    expect(JSON.stringify(metrics)).not.toContain("test-qwen-profile-key");
  });

  it("retries a reasoning-only stop without promoting hidden reasoning to the reply", async () => {
    const metrics: LlmCallMetric[] = [];
    let attempts = 0;
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      maxRetries: 1,
      retryDelay: () => Promise.resolve(),
      onMetric: (metric) => metrics.push(metric),
      fetch: () => {
        attempts += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model: "deepseek-test",
              choices: [
                {
                  message:
                    attempts === 1
                      ? {
                          content: "",
                          reasoning_content:
                            "internal reasoning that must not become a reply",
                        }
                      : { content: '{"ok":true}' },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: attempts === 1 ? 300 : 4,
                total_tokens: attempts === 1 ? 310 : 14,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    });

    await expect(
      provider.generateObject({
        purpose: "chat_turn",
        system: "Return JSON.",
        prompt: "Test",
        schema: z.object({ ok: z.boolean() }).strict(),
      }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(metrics[0]).toMatchObject({
      success: false,
      errorCode: "EMPTY_FINAL_AFTER_REASONING",
      finishReason: "stop",
    });
  });

  it("reports provider response identity, finish reason, and reported usage for a successful physical attempt", async () => {
    const metrics: LlmCallMetric[] = [];
    const apiKey = "private-provider-api-key";
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey,
      model: "configured-model-alias",
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              model: "provider-routed-model",
              choices: [
                {
                  message: { content: '{"ok":true}' },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 17,
                completion_tokens: 5,
                total_tokens: 22,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      maxRetries: 0,
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(
      provider.generateObject({
        purpose: "chat_turn",
        system: "Return JSON.",
        prompt: "Test",
        schema: z.object({ ok: z.literal(true) }).strict(),
      }),
    ).resolves.toEqual({ ok: true });

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      provider: "openai-compatible",
      model: "configured-model-alias",
      responseModel: "provider-routed-model",
      purpose: "chat_turn",
      attempt: 1,
      success: true,
      status: 200,
      finishReason: "stop",
      usageSource: "provider",
      inputTokens: 17,
      outputTokens: 5,
    });
    expect(metrics[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(metrics)).not.toContain(apiKey);
  });

  it.each([
    {
      name: "OpenAI reasoning effort",
      effort: "medium" as const,
      format: "openai_reasoning_effort" as const,
      expected: { reasoning_effort: "medium" },
      absent: ["thinking", "output_config"],
    },
    {
      name: "Anthropic adaptive thinking",
      effort: "medium" as const,
      format: "anthropic_output_config" as const,
      expected: {
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
      },
      absent: ["reasoning_effort"],
    },
    {
      name: "OpenAI effort with explicitly enabled thinking",
      effort: "low" as const,
      format: "openai_reasoning_effort_with_thinking" as const,
      expected: {
        thinking: { type: "enabled" },
        reasoning_effort: "low",
      },
      absent: ["output_config"],
    },
  ])(
    "serializes $name controls",
    async ({ effort, format, expected, absent }) => {
      let requestInit: RequestInit | undefined;
      const provider = createOpenAiCompatibleLlmProvider({
        apiKey: "test-placeholder-token",
        capabilities: {
          structuredOutputMode: "json_object",
          supportsThinkingControl: true,
          supportsStreaming: false,
          reasoningEffort: effort,
          reasoningRequestFormat: format,
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
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        },
        maxRetries: 0,
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
      expect(body).toMatchObject(expected);
      for (const field of absent) expect(body).not.toHaveProperty(field);
    },
  );

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

  it("retries once when JSON is schema-invalid, then returns the validated object", async () => {
    let calls = 0;
    const bodies: string[] = [];
    const metrics: LlmCallMetric[] = [];
    const fakeFetch: typeof fetch = (_input, init) => {
      calls += 1;
      bodies.push(requestBody(init));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: `provider-repair-attempt-${calls}`,
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
              prompt_tokens: 20 + calls,
              completion_tokens: 4 + calls,
              total_tokens: 24 + calls * 2,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    };
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: fakeFetch,
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
    expect(calls).toBe(2);
    expect(bodies[0]).not.toContain("STRUCTURED_OUTPUT_REPAIR");
    expect(bodies[1]).toContain("STRUCTURED_OUTPUT_REPAIR");
    expect(bodies[1]).toContain("ok:");
    expect(bodies[1]).not.toContain("RAW_RESPONSE_SENTINEL");
    expect(occurrences(bodies[1] ?? "", "STRUCTURED_OUTPUT_REPAIR")).toBe(1);
    expect(metrics).toHaveLength(2);
    expect(metrics[0]).toMatchObject({
      purpose: "chat_turn",
      attempt: 1,
      success: false,
      status: 200,
      responseModel: "provider-repair-attempt-1",
      finishReason: "stop",
      usageSource: "provider",
      inputTokens: 21,
      outputTokens: 5,
      errorCode: "INVALID_STRUCTURED_OUTPUT",
    });
    expect(metrics[1]).toMatchObject({
      purpose: "chat_turn",
      attempt: 2,
      success: true,
      status: 200,
      responseModel: "provider-repair-attempt-2",
      finishReason: "stop",
      usageSource: "provider",
      inputTokens: 22,
      outputTokens: 6,
    });
    expect(metrics[1]).not.toHaveProperty("errorCode");
    expect(JSON.stringify(metrics)).not.toContain("RAW_RESPONSE_SENTINEL");
    expect(JSON.stringify(metrics)).not.toContain("test-placeholder-token");
  });

  it("rebuilds each repair request from only the latest validation issues", async () => {
    const bodies: string[] = [];
    const responses = [
      '{"ok":false,"first_only":true}',
      '{"ok":false,"second_only":true}',
      '{"ok":true}',
    ];
    const fakeFetch: typeof fetch = (_input, init) => {
      bodies.push(requestBody(init));
      return Promise.resolve(
        characterResponse(
          JSON.parse(
            responses[bodies.length - 1] ?? '{"ok":true}',
          ) as JsonValue,
        ),
      );
    };
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-placeholder-token",
      fetch: fakeFetch,
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
    ).resolves.toEqual({ ok: true });

    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toContain("first_only");
    expect(bodies[2]).toContain("second_only");
    expect(bodies[2]).not.toContain("first_only");
    expect(occurrences(bodies[2] ?? "", "STRUCTURED_OUTPUT_REPAIR")).toBe(1);
  });

  it.each(["network", "rate-limit"] as const)(
    "retries %s failures with the unchanged original prompt",
    async (mode) => {
      let calls = 0;
      const bodies: string[] = [];
      const metrics: LlmCallMetric[] = [];
      const fakeFetch: typeof fetch = (_input, init) => {
        calls += 1;
        bodies.push(requestBody(init));
        if (calls === 1) {
          return mode === "network"
            ? Promise.reject(new TypeError("simulated network failure"))
            : Promise.resolve(
                new Response("retry later HTTP_BODY_SENTINEL", {
                  status: 429,
                }),
              );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model: "provider-retry-model",
              choices: [
                {
                  message: { content: '{"ok":true}' },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 31,
                completion_tokens: 7,
                total_tokens: 38,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      };
      const provider = createOpenAiCompatibleLlmProvider({
        apiKey: "test-placeholder-token",
        fetch: fakeFetch,
        maxRetries: 1,
        onMetric: (metric) => metrics.push(metric),
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
      expect(metrics).toHaveLength(2);
      expect(metrics[0]).toMatchObject({
        purpose: "chat_turn",
        attempt: 1,
        success: false,
        usageSource: "unavailable",
        errorCode: mode === "network" ? "NETWORK_ERROR" : "HTTP_ERROR",
      });
      if (mode === "network") {
        expect(metrics[0]).not.toHaveProperty("status");
      } else {
        expect(metrics[0]).toHaveProperty("status", 429);
      }
      expect(metrics[0]).not.toHaveProperty("responseModel");
      expect(metrics[0]).not.toHaveProperty("finishReason");
      expect(metrics[0]?.latencyMs).toBeGreaterThanOrEqual(0);
      expect(metrics[1]).toMatchObject({
        purpose: "chat_turn",
        attempt: 2,
        success: true,
        status: 200,
        responseModel: "provider-retry-model",
        finishReason: "stop",
        usageSource: "provider",
        inputTokens: 31,
        outputTokens: 7,
      });
      expect(metrics[1]?.latencyMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(metrics)).not.toContain("HTTP_BODY_SENTINEL");
      expect(JSON.stringify(metrics)).not.toContain("test-placeholder-token");
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
