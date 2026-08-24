import {
  PersonaTurnProviderEnvelopeSchema,
  ProactiveMessageProposalSchema,
  type PersonaTurnProviderEnvelope,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import { LlmService } from "./llm-service.js";

const NOW_UTC = "2026-08-22T04:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LlmService fixture chat contract", () => {
  it("passes a canonical chat envelope through the fixture override", async () => {
    const harness = createHarness();
    try {
      const fixture = PersonaTurnProviderEnvelopeSchema.parse({
        replyDecision: {
          text: "Canonical fixture reply.",
          chunks: ["Canonical fixture reply."],
          toneTags: ["neutral"],
        },
        worldEffects: {
          stateDelta: { energy: -0.05 },
        },
        scheduleEffects: [],
      });

      const result = await harness.llm.generateObject({
        purpose: "chat_turn",
        system: "system",
        prompt: "prompt",
        schema: PersonaTurnProviderEnvelopeSchema,
        fixture,
      });

      expect(result).toEqual(fixture);
      expect(harness.store.listLlmCalls(1)[0]).toMatchObject({
        provider: "fixture",
        inputTokens: 3,
        outputTokens: Math.ceil(JSON.stringify(fixture).length / 4),
        providerInputTokens: null,
        providerOutputTokens: null,
        usageSource: "estimated",
        attemptCount: 1,
        failedAttemptCount: 0,
        providerInputUsageAttemptCount: 0,
        providerOutputUsageAttemptCount: 0,
        attemptTelemetrySource: "exact",
        success: true,
      });
    } finally {
      harness.database.close();
    }
  });

  it("rejects a legacy flat decision before constructing the fixture provider", async () => {
    const harness = createHarness();
    try {
      const legacyFixture = {
        reply: {
          text: "Legacy flat fixture.",
          chunks: ["Legacy flat fixture."],
          toneTags: ["neutral"],
        },
        scheduleEffects: [],
        memoryCandidates: [],
        reasonCode: "legacy_flat_fixture",
        reasonSummary: "The server must migrate this before provider use.",
      } as unknown as PersonaTurnProviderEnvelope;

      await expect(
        harness.llm.generateObject({
          purpose: "chat_turn",
          system: "system",
          prompt: "prompt",
          schema: PersonaTurnProviderEnvelopeSchema,
          fixture: legacyFixture,
        }),
      ).rejects.toMatchObject({
        name: "LlmServiceError",
        code: "invalid_fixture_contract",
      });
    } finally {
      harness.database.close();
    }
  });
});

describe("LlmService usage audit", () => {
  it("keeps local estimates and records sanitized provider-reported usage", async () => {
    const apiKey = "provider-usage-secret";
    const responseValue = {
      content: "收到，我会基于已确认的信息回应。",
      reasonCode: "grounded_reply",
      reasonSummary: "The response uses validated context.",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: JSON.stringify(responseValue) },
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
        ),
      ),
    );
    const harness = createHarness("openai-compatible", apiKey);
    try {
      const system = "Return JSON.";
      const prompt = "Compose safely.";
      const result = await harness.llm.generateObject({
        purpose: "compose_proactive_message",
        system,
        prompt,
        schema: ProactiveMessageProposalSchema,
      });

      expect(result).toEqual(responseValue);
      const call = harness.store.listLlmCalls(1)[0];
      expect(call).toMatchObject({
        provider: "openai-compatible",
        inputTokens: Math.ceil((system + prompt).length / 4),
        outputTokens: Math.ceil(JSON.stringify(responseValue).length / 4),
        providerInputTokens: 31,
        providerOutputTokens: 7,
        usageSource: "provider",
        attemptCount: 1,
        failedAttemptCount: 0,
        providerInputUsageAttemptCount: 1,
        providerOutputUsageAttemptCount: 1,
        attemptTelemetrySource: "exact",
        success: true,
      });
      expect(JSON.stringify(call)).not.toContain(apiKey);
      expect(JSON.stringify(call)).not.toContain(JSON.stringify(responseValue));
    } finally {
      harness.database.close();
    }
  });

  it("persists one recovered logical success with all physical attempts and provider usage", async () => {
    const apiKey = "retry-usage-secret";
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        attempts += 1;
        const value =
          attempts === 1
            ? { private: "RAW_RETRY_OUTPUT_SENTINEL" }
            : {
                content: "Recovered reply.",
                reasonCode: "retry_recovered",
                reasonSummary: "The second provider attempt was valid.",
              };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: JSON.stringify(value) },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: attempts === 1 ? 11 : 13,
                completion_tokens: attempts === 1 ? 2 : 3,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }),
    );
    const harness = createHarness("openai-compatible", apiKey, 1);
    try {
      await expect(
        harness.llm.generateObject({
          purpose: "compose_proactive_message",
          system: "Return JSON.",
          prompt: "Compose safely.",
          schema: ProactiveMessageProposalSchema,
        }),
      ).resolves.toMatchObject({ reasonCode: "retry_recovered" });

      const calls = harness.store.listLlmCalls(10);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        success: true,
        attemptCount: 2,
        failedAttemptCount: 1,
        providerInputUsageAttemptCount: 2,
        providerOutputUsageAttemptCount: 2,
        attemptTelemetrySource: "exact",
        providerInputTokens: 24,
        providerOutputTokens: 5,
        usageSource: "provider",
      });
      expect(JSON.stringify(calls)).not.toContain(apiKey);
      expect(JSON.stringify(calls)).not.toContain("RAW_RETRY_OUTPUT_SENTINEL");
    } finally {
      harness.database.close();
    }
  });

  it("marks provider usage as partial when any physical attempt omits it", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        attempts += 1;
        const value =
          attempts === 1
            ? { private: "INVALID_FIRST_ATTEMPT" }
            : {
                content: "Recovered reply.",
                reasonCode: "retry_recovered",
                reasonSummary: "The second provider attempt was valid.",
              };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: JSON.stringify(value) },
                  finish_reason: "stop",
                },
              ],
              ...(attempts === 1
                ? { usage: { prompt_tokens: 11, completion_tokens: 2 } }
                : {}),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }),
    );
    const harness = createHarness("openai-compatible", "partial-secret", 1);
    try {
      await expect(
        harness.llm.generateObject({
          purpose: "compose_proactive_message",
          system: "Return JSON.",
          prompt: "Compose safely.",
          schema: ProactiveMessageProposalSchema,
        }),
      ).resolves.toMatchObject({ reasonCode: "retry_recovered" });

      expect(harness.store.listLlmCalls(1)[0]).toMatchObject({
        success: true,
        attemptCount: 2,
        failedAttemptCount: 1,
        providerInputTokens: 11,
        providerOutputTokens: 2,
        providerInputUsageAttemptCount: 1,
        providerOutputUsageAttemptCount: 1,
        attemptTelemetrySource: "exact",
        usageSource: "provider",
      });
    } finally {
      harness.database.close();
    }
  });

  it("persists retry exhaustion as one logical failure with every failed attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      private: "RAW_EXHAUSTED_OUTPUT_SENTINEL",
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );
    const harness = createHarness("openai-compatible", "retry-secret", 1);
    try {
      await expect(
        harness.llm.generateObject({
          purpose: "compose_proactive_message",
          system: "Return JSON.",
          prompt: "Compose safely.",
          schema: ProactiveMessageProposalSchema,
        }),
      ).rejects.toMatchObject({ code: "INVALID_STRUCTURED_OUTPUT" });

      const calls = harness.store.listLlmCalls(10);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        success: false,
        errorCode: "INVALID_STRUCTURED_OUTPUT",
        attemptCount: 2,
        failedAttemptCount: 2,
        providerInputUsageAttemptCount: 2,
        providerOutputUsageAttemptCount: 2,
        attemptTelemetrySource: "exact",
        providerInputTokens: 10,
        providerOutputTokens: 2,
        usageSource: "provider",
      });
      expect(JSON.stringify(calls)).not.toContain(
        "RAW_EXHAUSTED_OUTPUT_SENTINEL",
      );
    } finally {
      harness.database.close();
    }
  });
});

function createHarness(
  provider: "fixture" | "openai-compatible" = "fixture",
  apiKey?: string,
  maxRetries = 0,
): { database: Database; store: DatabaseStore; llm: LlmService } {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const store = new DatabaseStore(database);
  const clock = new FakeClock(NOW_UTC);
  return {
    database,
    store,
    llm: new LlmService(
      {
        provider,
        baseUrl: "https://example.invalid",
        ...(apiKey === undefined ? {} : { apiKey }),
        model:
          provider === "fixture"
            ? "personasim-fixture-v1"
            : "deepseek-usage-test",
        timeoutMs: 1_000,
        maxRetries,
      },
      store,
      clock,
    ),
  };
}
