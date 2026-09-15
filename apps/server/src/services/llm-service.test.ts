import {
  LetterReplyProposalSchema,
  DiaryDraftSchema,
  DiaryReviewSchema,
  PersonaTurnProviderEnvelopeSchema,
  LlmModelSettingsSchema,
  type PersonaTurnProviderEnvelope,
} from "@personasim/contracts";
import { createManagedLlmProvider } from "@personasim/providers";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import { LlmService, type LlmLogicalCallEvent } from "./llm-service.js";
import { LlmSettingsService } from "./llm-settings-service.js";

const NOW_UTC = "2026-08-22T04:00:00.000Z";

describe("LlmService model output allowance", () => {
  const model = (id: string, maxOutputTokens: number) =>
    LlmModelSettingsSchema.parse({
      id,
      capabilities: {
        structuredOutputMode: "prompt_json",
        supportsThinkingControl: false,
        supportsStreaming: false,
        maxOutputTokens,
        maxContextTokens: 262_144,
      },
    });
  const command = {
    purpose: "compile_character" as const,
    system: "Return JSON.",
    prompt: "Compile a character.",
    schema: z.object({ ok: z.boolean() }),
    maxOutputTokens: 32_000,
    useModelMaxOutputTokens: true,
  };
  const response = () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  const request = (init: RequestInit | undefined) => {
    if (typeof init?.body !== "string")
      throw new TypeError("Expected JSON request");
    return JSON.parse(init.body) as { model: string; max_tokens: number };
  };

  it("uses the model resolved by default settings and preserves a captured selection", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const observations: LlmLogicalCallEvent[] = [];
    const harness = createHarness({
      fetch: fetcher,
      onLogicalCall: (event) => observations.push(event),
    });
    try {
      // Isolate the selection contract from environment profiles and credentials.
      const settings = Object.create(
        LlmSettingsService.prototype,
      ) as LlmSettingsService;
      const configuration = (id: string, maxOutputTokens: number) => ({
        selection: { providerId: id, modelId: id, revision: 1 },
        protocol: "openai-compatible" as const,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "",
        timeoutMs: 1000,
        model: model(id, maxOutputTokens),
        profileName: id,
      });
      const resolve = vi
        .spyOn(settings, "resolve")
        .mockReturnValue(configuration("large-model", 131_072));
      harness.llm.settings = settings;
      const captured = harness.llm.captureDefault();
      resolve.mockReturnValue(configuration("small-model", 4_096));

      await harness.llm.generateObject(command);
      await captured.generateObject(command);

      expect(fetcher.mock.calls.map((call) => request(call[1]))).toMatchObject([
        { model: "small-model", max_tokens: 4_096 },
        { model: "large-model", max_tokens: 131_072 },
      ]);
      expect(observations.filter((event) => event.stage === "started")).toEqual(
        [
          expect.objectContaining({ useModelMaxOutputTokens: true }),
          expect.objectContaining({ useModelMaxOutputTokens: true }),
        ],
      );
    } finally {
      harness.database.close();
    }
  });

  it("resolves the allowance from each hosted purpose provider", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const harness = createHarness({
      executionResolver: (purpose) => {
        const selected = model(
          purpose,
          purpose === "compile_character" ? 131_072 : 4_096,
        );
        return {
          provider: createManagedLlmProvider({
            protocol: "openai-compatible",
            baseUrl: "https://hosted-provider.invalid/v1",
            timeoutMs: 1000,
            model: selected,
            fetch: fetcher,
          }),
          protocol: "openai-compatible",
          selection: {
            providerId: "hosted",
            modelId: selected.id,
            revision: 2,
          },
          displayName: selected.id,
        };
      },
    });
    try {
      await harness.llm.generateObject(command);
      await harness.llm.generateObject({
        ...command,
        purpose: "import_character",
      });
      expect(fetcher.mock.calls.map((call) => request(call[1]))).toMatchObject([
        { model: "compile_character", max_tokens: 131_072 },
        { model: "import_character", max_tokens: 4_096 },
      ]);
    } finally {
      harness.database.close();
    }
  });
});

describe("LlmService fixture chat contract", () => {
  it("keeps diary source text and private views out of logical-call telemetry", async () => {
    const observations: LlmLogicalCallEvent[] = [];
    const harness = createHarness({
      onLogicalCall: (event) => observations.push(event),
    });
    try {
      await harness.llm.generateObject({
        purpose: "diary_generation",
        system: "PRIVATE-DIARY-SYSTEM",
        prompt: "PRIVATE-DIARY-SOURCE",
        schema: DiaryDraftSchema,
        fixture: {
          title: "PRIVATE-DIARY-TITLE",
          paragraphs: [
            { text: "PRIVATE-DIARY-VIEW", sourceMessageIds: ["source-1"] },
          ],
        },
      });
      await harness.llm.generateObject({
        purpose: "diary_review",
        system: "PRIVATE-DIARY-REVIEW-SYSTEM",
        prompt: "PRIVATE-DIARY-REVIEW-SOURCE",
        schema: DiaryReviewSchema,
        fixture: { valid: false, issues: ["PRIVATE-DIARY-REVIEW-ISSUE"] },
      });
      expect(observations[0]).toMatchObject({
        stage: "started",
        system: "[redacted:diary_generation]",
        prompt: "[redacted:diary_generation]",
      });
      expect(observations[1]).toMatchObject({
        stage: "completed",
        success: true,
      });
      expect(observations[1]).not.toHaveProperty("parsedOutput");
      expect(observations[2]).toMatchObject({
        stage: "started",
        system: "[redacted:diary_review]",
        prompt: "[redacted:diary_review]",
      });
      expect(observations[3]).toMatchObject({
        stage: "completed",
        success: true,
      });
      expect(observations[3]).not.toHaveProperty("parsedOutput");
      expect(
        JSON.stringify({ observations, calls: harness.store.listLlmCalls(10) }),
      ).not.toContain("PRIVATE-DIARY");
    } finally {
      harness.database.close();
    }
  });
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

  it("redacts sealed correspondence from logical-call observations and metrics", async () => {
    const observations: LlmLogicalCallEvent[] = [];
    const harness = createHarness({
      onLogicalCall: (event) => observations.push(event),
    });
    try {
      const fixture = LetterReplyProposalSchema.parse({
        subject: "REPLY-SECRET-SUBJECT",
        salutation: "你好：",
        paragraphs: ["REPLY-SECRET-BODY"],
        closing: "祝好",
        signature: "角色",
        referencedEvidenceIds: [],
      });
      await harness.llm.generateObject({
        purpose: "letter_reply",
        system: "SYSTEM-INCOMING-SECRET",
        prompt: "PROMPT-INCOMING-SECRET",
        schema: LetterReplyProposalSchema,
        fixture,
      });

      expect(observations).toHaveLength(2);
      expect(observations[0]).toMatchObject({
        stage: "started",
        system: "[redacted:letter_reply]",
        prompt: "[redacted:letter_reply]",
      });
      expect(observations[1]).toMatchObject({
        stage: "completed",
        success: true,
      });
      expect(observations[1]).not.toHaveProperty("parsedOutput");
      const serialized = JSON.stringify({
        observations,
        calls: harness.store.listLlmCalls(10),
      });
      expect(serialized).not.toContain("INCOMING-SECRET");
      expect(serialized).not.toContain("REPLY-SECRET");
    } finally {
      harness.database.close();
    }
  });
});

function createHarness(
  observation: ConstructorParameters<typeof LlmService>[3] = {},
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
        provider: "fixture",
        baseUrl: "https://example.invalid",
        model: "personasim-fixture-v1",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
      store,
      clock,
      observation,
    ),
  };
}
