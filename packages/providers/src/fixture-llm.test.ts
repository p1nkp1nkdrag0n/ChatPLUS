import {
  ActivityEnrichmentBatchSchema,
  AutobiographyRevisionProposalSchema,
  ContinuityTurnEffectsSchema,
  PersonaChatResponseSchema,
  PersonaTurnProviderEnvelopeSchema,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import { createFixtureLlmProvider } from "./fixture-llm.js";

describe("Fixture LLM activity enrichment", () => {
  it("returns one validated enrichment for every input event", async () => {
    const provider = createFixtureLlmProvider();
    const response = await provider.generate({
      purpose: "enrich_activity",
      payload: {
        events: [
          {
            eventId: "event-1",
            summary: "完成旅行",
            category: "travel",
            importance: 0.9,
          },
          {
            eventId: "event-2",
            summary: "完成学习任务",
            category: "study",
            importance: 0.7,
          },
        ],
      },
      seed: "batch-test",
    });

    const batch = ActivityEnrichmentBatchSchema.parse(response.data);
    expect(batch.events.map((event) => event.eventId)).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(batch.events[0]?.memoryCandidates[0]?.type).toBe("activity_outcome");
  });
});

describe("Fixture LLM checkpoint autobiography", () => {
  it("bounds evidence context while preserving the verified quote", async () => {
    const quote = "x".repeat(1_500);
    const response = await createFixtureLlmProvider().generate({
      purpose: "checkpoint_autobiography",
      payload: {
        prompt: JSON.stringify({
          evidence: [
            {
              id: "evidence-1",
              sourceType: "message_archive",
              sourceId: "message-1",
              quote,
              temporalStatus: "unknown",
              reliability: "reported",
              recordedAtUtc: "2026-08-21T04:00:00.000Z",
            },
          ],
          messages: [],
        }),
      },
    });

    const proposal = AutobiographyRevisionProposalSchema.parse(response.data);
    expect(proposal.entries[0]?.evidence[0]).toMatchObject({
      id: "evidence-1",
      sourceType: "message_archive",
      sourceId: "message-1",
      quote,
    });
    expect(proposal.entries[0]?.evidence[0]?.contextSummary).toHaveLength(
      1_000,
    );
  });
});

describe("Fixture LLM chat turn purpose contract", () => {
  it("returns the canonical provider envelope by default", async () => {
    const response = await createFixtureLlmProvider().generate({
      purpose: "chat_turn",
      payload: { userMessage: "今天晚饭吃什么？" },
    });

    const envelope = PersonaTurnProviderEnvelopeSchema.parse(response.data);
    const reply = PersonaChatResponseSchema.parse(envelope.replyDecision);
    expect(reply.text.length).toBeGreaterThan(0);
    expect(response.data).toHaveProperty("replyDecision");
    expect(response.data).not.toHaveProperty("reply");
  });

  it("accepts a canonical turn envelope override and normalizes it", async () => {
    const provider = createFixtureLlmProvider({
      fixtures: {
        chat_turn: {
          replyDecision: {
            text: " envelopes are the canonical provider shape.",
            toneTags: ["warm"],
            chunks: [" envelopes are the canonical provider shape."],
          },
          worldEffects: {
            stateDelta: { energy: -0.05 },
          },
        },
      },
    });

    const response = await provider.generate({
      purpose: "chat_turn",
      payload: { userMessage: "今天过得怎么样？" },
    });

    const envelope = PersonaTurnProviderEnvelopeSchema.parse(response.data);
    expect(envelope.replyDecision).toMatchObject({
      text: " envelopes are the canonical provider shape.",
    });
    expect(envelope.worldEffects).toMatchObject({
      stateDelta: { energy: -0.05 },
    });
  });
  it("rejects a legacy flat AgentTurnDecision override", () => {
    const provider = createFixtureLlmProvider({
      fixtures: {
        chat_turn: {
          reply: {
            text: "Legacy flat output must not pass the provider gate.",
            chunks: ["Legacy flat output must not pass the provider gate."],
            toneTags: ["neutral"],
          },
          scheduleEffects: [],
          memoryCandidates: [],
          reasonCode: "legacy_flat_decision",
          reasonSummary: "This is a valid old decision but not an envelope.",
        },
      },
    });

    expect(() =>
      provider.generate({
        purpose: "chat_turn",
        payload: { userMessage: "test" },
      }),
    ).toThrow();
  });

  it("keeps repair_chat_turn mapped to the reply-only response schema", async () => {
    const response = await createFixtureLlmProvider().generate({
      purpose: "repair_chat_turn",
      payload: { userMessage: "repair this reply" },
    });

    const reply = PersonaChatResponseSchema.parse(response.data);
    expect(reply.text.length).toBeGreaterThan(0);
    expect(response.data).not.toHaveProperty("reply");
    expect(response.data).not.toHaveProperty("scheduleEffects");
    expect(response.data).not.toHaveProperty("stateDelta");
  });
});

describe("Fixture LLM continuity effects", () => {
  it.each([
    {
      label: "defense",
      userMessage: "我明天答辩，有点紧张。",
      evidenceQuote: "明天答辩",
    },
    {
      label: "interview",
      userMessage: "我明天面试，希望别太紧张。",
      evidenceQuote: "明天面试",
    },
    {
      label: "portfolio",
      userMessage: "作品集要交了，我还在收尾。",
      evidenceQuote: "作品集要交",
    },
  ])(
    "grounds follow-up and care-cue proposals for $label",
    async ({ userMessage, evidenceQuote }) => {
      const response = await createFixtureLlmProvider().generate({
        purpose: "chat_turn",
        payload: { userMessage },
      });
      const envelope = PersonaTurnProviderEnvelopeSchema.parse(response.data);
      const continuity = ContinuityTurnEffectsSchema.parse(
        envelope.worldEffects.continuityEffects,
      );

      expect(continuity.followUpCandidates).toHaveLength(1);
      expect(continuity.careCueCandidates).toHaveLength(1);
      expect(continuity.followUpTransitions).toEqual([]);
      expect(continuity.followUpCandidates[0]?.evidenceQuotes).toEqual([
        evidenceQuote,
      ]);
      expect(continuity.careCueCandidates[0]?.evidenceQuotes).toEqual([
        evidenceQuote,
      ]);
      for (const candidate of [
        continuity.followUpCandidates[0],
        continuity.careCueCandidates[0],
      ]) {
        expect(candidate).not.toHaveProperty("id");
        expect(candidate).not.toHaveProperty("earliestAtUtc");
        expect(candidate).not.toHaveProperty("expiresAtUtc");
      }
    },
  );

  it("keeps continuity collections empty for an ordinary message", async () => {
    const response = await createFixtureLlmProvider().generate({
      purpose: "chat_turn",
      payload: { userMessage: "今天午饭还不错。" },
    });
    const envelope = PersonaTurnProviderEnvelopeSchema.parse(response.data);
    const continuity = ContinuityTurnEffectsSchema.parse(
      envelope.worldEffects.continuityEffects,
    );

    expect(continuity).toEqual({
      followUpCandidates: [],
      followUpTransitions: [],
      careCueCandidates: [],
    });
  });
});
