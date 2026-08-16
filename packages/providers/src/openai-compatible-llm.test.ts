import {
  CharacterCompilationProposalSchema,
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
    expect(bodies[0]).not.toContain("STRUCTURED_OUTPUT_REPAIR");
    expect(bodies[1]).toContain("STRUCTURED_OUTPUT_REPAIR");
    expect(bodies[1]).toContain("ok:");
    expect(bodies[1]).not.toContain("RAW_RESPONSE_SENTINEL");
    expect(occurrences(bodies[1] ?? "", "STRUCTURED_OUTPUT_REPAIR")).toBe(1);
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
      const fakeFetch: typeof fetch = (_input, init) => {
        calls += 1;
        bodies.push(requestBody(init));
        if (calls === 1) {
          return mode === "network"
            ? Promise.reject(new TypeError("simulated network failure"))
            : Promise.resolve(new Response("retry later", { status: 429 }));
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
