import { describe, expect, it } from "vitest";
import { InteractionAppraisalCandidateSchema } from "./interaction-appraisal.js";
import {
  PersonaChatDecisionSchema,
  PersonaTurnEnvelopeSchema,
  PersonaTurnProviderEnvelopeSchema,
  StrictPersonaTurnProviderEnvelopeSchema,
} from "./persona-chat-decision.js";

const appraisal = {
  triggerQuote: "我想聊一件私人的事情。",
  feelings: ["concern", "discomfort"],
  attitude: "ambivalent",
  publicExpression: "我在听。",
  privateView: ["care_without_agreement", "need_more_space"],
};

describe("optional same-turn interaction appraisal contract", () => {
  it("preserves independent appraisal through strict, normalized and legacy envelopes", () => {
    const canonical = {
      replyDecision: { text: "我在听。" },
      worldEffects: {},
      interactionAppraisal: appraisal,
    };
    for (const schema of [
      PersonaTurnEnvelopeSchema,
      PersonaTurnProviderEnvelopeSchema,
      StrictPersonaTurnProviderEnvelopeSchema,
    ]) {
      expect(schema.parse(canonical).interactionAppraisal).toEqual(appraisal);
      expect(
        schema.parse({ replyDecision: { text: "我在听。" }, worldEffects: {} })
          .interactionAppraisal,
      ).toBeUndefined();
    }
    expect(
      PersonaChatDecisionSchema.parse({
        text: "我在听。",
        interactionAppraisal: appraisal,
      }).interactionAppraisal,
    ).toEqual(appraisal);
    expect(
      PersonaTurnProviderEnvelopeSchema.parse({
        text: "我在听。",
        interactionAppraisal: appraisal,
      }).interactionAppraisal,
    ).toEqual(appraisal);
  });

  it("does not invalidate a reply for a malformed optional reaction", () => {
    const parsed = StrictPersonaTurnProviderEnvelopeSchema.parse({
      replyDecision: { text: "我在听。" },
      interactionAppraisal: "invalid",
    });
    expect(parsed.replyDecision).toEqual({ text: "我在听。" });
    expect(
      InteractionAppraisalCandidateSchema.safeParse(parsed.interactionAppraisal)
        .success,
    ).toBe(false);
  });

  it("allows mixed feelings but forbids invented actions, motives and server-owned fields", () => {
    expect(
      InteractionAppraisalCandidateSchema.safeParse(appraisal).success,
    ).toBe(true);
    for (const forged of [
      { ...appraisal, privateView: ["我昨晚一直没有睡，他是在故意操控我。"] },
      { ...appraisal, sourceMessageIds: ["other-message"] },
      { ...appraisal, closeness: -0.3 },
      { ...appraisal, occurredAtUtc: "2000-01-01T00:00:00.000Z" },
      { ...appraisal, feelings: ["the_user_is_manipulative"] },
    ])
      expect(
        InteractionAppraisalCandidateSchema.safeParse(forged).success,
      ).toBe(false);
  });
});
