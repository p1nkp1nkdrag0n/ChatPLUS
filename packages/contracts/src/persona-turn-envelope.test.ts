import { describe, expect, it } from "vitest";
import { ContinuityTurnEffectsSchema } from "./follow-up.js";

import {
  PersonaTurnEnvelopeSchema,
  PersonaTurnProviderEnvelopeSchema,
} from "./persona-chat-decision.js";

describe("PersonaTurnEnvelope", () => {
  it("accepts the nested reply and keeps world effects independently untrusted", () => {
    const parsed = PersonaTurnEnvelopeSchema.parse({
      replyDecision: {
        text: "I could use a quiet evening.",
        deliveryMode: "single_block",
      },
      worldEffects: {
        stateDelta: { energy: -0.2 },
        relationshipDelta: { trust: 0.04 },
        memoryCandidates: [{ content: "untrusted" }],
        personalIntentCandidates: [{ activity: "take a walk" }],
      },
    });

    expect(parsed.replyDecision.text).toBe("I could use a quiet evening.");
    expect(parsed.worldEffects.stateDelta).toEqual({ energy: -0.2 });
    expect(parsed.worldEffects.relationshipDelta).toEqual({ trust: 0.04 });
  });

  it("normalizes a legacy flat response during rollout", () => {
    const parsed = PersonaTurnEnvelopeSchema.parse({
      text: "Let me think about that.",
      toneTags: ["thoughtful"],
      stateDelta: { stress: 0.1 },
    });

    expect(parsed.replyDecision).toMatchObject({
      text: "Let me think about that.",
      toneTags: ["thoughtful"],
      scheduleAction: { kind: "none" },
    });
    expect(parsed.worldEffects.stateDelta).toEqual({ stress: 0.1 });
  });

  it("strips server-owned schedule mutation fields", () => {
    const parsed = PersonaTurnEnvelopeSchema.parse({
      replyDecision: { text: "Maybe later." },
      worldEffects: {
        scheduleItem: { id: "schedule-1", source: "self_initiated" },
        scheduleMutationBundle: { owner: "self_planner" },
      },
    });

    expect(parsed.worldEffects).toEqual({});
    expect(parsed).not.toHaveProperty("scheduleItem");
    expect(parsed).not.toHaveProperty("scheduleMutationBundle");
  });

  it("keeps raw world effects when the provider reply is independently invalid", () => {
    const parsed = PersonaTurnProviderEnvelopeSchema.parse({
      replyDecision: { text: { invalid: true } },
      worldEffects: {
        stateDelta: { energy: -0.1 },
        memoryCandidates: [{ content: "untrusted" }],
        scheduleMutationBundle: { owner: "model" },
      },
      scheduleMutationBundle: { owner: "model" },
    });

    expect(parsed.replyDecision).toEqual({ text: { invalid: true } });
    expect(parsed.worldEffects).toEqual({
      stateDelta: { energy: -0.1 },
      memoryCandidates: [{ content: "untrusted" }],
    });
    expect(parsed).not.toHaveProperty("scheduleMutationBundle");
  });

  it("keeps transitional flat replies and legacy schedule proposals", () => {
    const parsed = PersonaTurnProviderEnvelopeSchema.parse({
      text: "Legacy reply.",
      stateDelta: { stress: 0.05 },
      scheduleEffects: [{ operation: "create" }],
    });

    expect(parsed.replyDecision).toMatchObject({ text: "Legacy reply." });
    expect(parsed.worldEffects.stateDelta).toEqual({ stress: 0.05 });
    expect(parsed.scheduleEffects).toEqual([{ operation: "create" }]);
  });
  it("preserves continuity effects as an isolated untrusted provider field", () => {
    const rawContinuityEffects = {
      followUpCandidates: [{ id: "database-id-must-stay-untrusted" }],
      followUpTransitions: "malformed",
      careCueCandidates: [],
    };
    const parsed = PersonaTurnProviderEnvelopeSchema.parse({
      replyDecision: { text: "The reply remains independently usable." },
      continuityEffects: rawContinuityEffects,
      scheduleMutationBundle: { owner: "model" },
    });

    expect(parsed.replyDecision).toEqual({
      text: "The reply remains independently usable.",
    });
    expect(parsed.worldEffects).toEqual({
      continuityEffects: rawContinuityEffects,
    });
    expect(parsed).not.toHaveProperty("continuityEffects");
    expect(parsed).not.toHaveProperty("scheduleMutationBundle");
    expect(
      ContinuityTurnEffectsSchema.safeParse(
        parsed.worldEffects.continuityEffects,
      ).success,
    ).toBe(false);
  });
});
