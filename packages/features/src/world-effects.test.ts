import { describe, expect, it } from "vitest";

import { PersonaTurnEnvelopeSchema } from "@personasim/contracts";

import { validateWorldEffects } from "./world-effects.js";

describe("validateWorldEffects", () => {
  it("clamps live state and relationship deltas independently", () => {
    const envelope = PersonaTurnEnvelopeSchema.parse({
      replyDecision: { text: "I am listening." },
      worldEffects: {
        stateDelta: { energy: -1, stress: 0.7 },
        relationshipDelta: { trust: 0.8, familiarity: -0.5 },
      },
    });

    const result = validateWorldEffects(envelope.worldEffects);

    expect(result.effects.stateDelta).toEqual({ energy: -0.2, stress: 0.2 });
    expect(result.effects.relationshipDelta).toEqual({
      trust: 0.08,
      familiarity: 0,
    });
    expect(result.limitsApplied).toEqual(["state_delta", "relationship_delta"]);
    expect(result.rejections).toEqual([]);
  });

  it("rejects one invalid effect without discarding valid siblings", () => {
    const envelope = PersonaTurnEnvelopeSchema.parse({
      replyDecision: { text: "The reply remains valid." },
      worldEffects: {
        stateDelta: { currentActivityId: "model-owned-id" },
        relationshipDelta: { closeness: 0.03 },
        memoryCandidates: [{ content: "missing required fields" }],
        personalIntentCandidates: [
          {
            activity: "take a short walk",
            basisKind: "chat",
            evidenceQuotes: ["take a short walk"],
            reasonCode: "chat_intent",
            reasonSummary: "The user expressed a grounded preference.",
          },
          {
            activity: "own an exact timestamp",
            basisKind: "chat",
            evidenceQuotes: ["exact timestamp"],
            earliestAtUtc: "2026-08-21T08:00:00.000Z",
            reasonCode: "chat_intent",
            reasonSummary: "This field is server-owned.",
          },
        ],
      },
    });

    const result = validateWorldEffects(envelope.worldEffects);

    expect(envelope.replyDecision.text).toBe("The reply remains valid.");
    expect(result.effects.stateDelta).toBeUndefined();
    expect(result.effects.relationshipDelta).toEqual({ closeness: 0.03 });
    expect(result.effects.memoryCandidates).toEqual([]);
    expect(result.effects.personalIntentCandidates).toHaveLength(1);
    expect(result.rejections.map((item) => item.reasonCode)).toEqual([
      "server_owned_state_field",
      "invalid_effect_candidate",
      "invalid_effect_candidate",
    ]);
  });
  it("materializes minimal DeepSeek memory proposals with server-owned persistence fields", () => {
    const envelope = PersonaTurnEnvelopeSchema.parse({
      replyDecision: { text: "我记住了。" },
      worldEffects: {
        memoryCandidates: [
          {
            type: "user_fact",
            content: "用户在测试中的代号是林舟",
            sourceMessageIds: [],
            sourceActivityEventIds: [],
            namespace: "character_self",
            certainty: "uncertain",
            shouldWrite: false,
          },
          {
            type: "user_preference",
            content: "用户偏爱的食物是蟹黄面",
            sourceMessageIds: [],
            sourceActivityEventIds: [],
          },
        ],
      },
    });

    const result = validateWorldEffects(envelope.worldEffects);

    expect(result.rejections).toEqual([]);
    expect(result.effects.memoryCandidates).toHaveLength(2);
    expect(result.effects.memoryCandidates[0]).toMatchObject({
      kind: "semantic",
      content: "用户在测试中的代号是林舟",
      namespace: "user_model",
      certainty: "explicit",
      attribution: "user_explicit",
      stability: "stable",
      shouldWrite: true,
      sourceMessageIds: [],
      sourceActivityEventIds: [],
      reasonCode: "model_memory_candidate",
    });
    expect(result.effects.memoryCandidates[1]).toMatchObject({
      kind: "semantic",
      content: "用户偏爱的食物是蟹黄面",
      namespace: "user_model",
      certainty: "explicit",
      attribution: "user_explicit",
      stability: "stable",
    });
  });
});
