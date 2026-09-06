import {
  LetterReplyProposalSchema,
  PersonaTurnProviderEnvelopeSchema,
  type PersonaTurnProviderEnvelope,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import { LlmService, type LlmLogicalCallEvent } from "./llm-service.js";

const NOW_UTC = "2026-08-22T04:00:00.000Z";

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
