import { describe, expect, it } from "vitest";

import {
  CONVERSATION_CONTEXT_POLICY_VERSION,
  ConversationContextPlanSchema,
} from "./conversation-context-plan.js";

const historical = {
  policyVersion: CONVERSATION_CONTEXT_POLICY_VERSION,
  originalQuery: "今天看到一朵云。",
  expandedQueries: [],
  contextMessageIds: [],
  unresolvedReferences: [],
  intent: "sharing",
  adviceRequested: false,
  detailedAnalysisRequested: false,
  supportStyle: "respond_naturally",
  maxRecallEvidence: 3,
  maxExplicitMemories: 2,
  allowCharacterLifeMention: false,
};

describe("conversation advice-policy audit compatibility", () => {
  it("keeps historical retrieval snapshots readable without inventing advice permission", () => {
    const parsed = ConversationContextPlanSchema.parse(historical);
    expect(parsed.advicePolicy).toBeUndefined();
    expect(parsed.advicePolicyVersion).toBeUndefined();
  });

  it("accepts only the finite server-derived policy and its known version", () => {
    expect(
      ConversationContextPlanSchema.parse({
        ...historical,
        advicePolicy: "optional_light",
        advicePolicyVersion: "advice_load_v1",
      }).advicePolicy,
    ).toBe("optional_light");
    expect(
      ConversationContextPlanSchema.safeParse({
        ...historical,
        advicePolicy: "always_advise",
      }).success,
    ).toBe(false);
    expect(
      ConversationContextPlanSchema.safeParse({
        ...historical,
        advicePolicyVersion: "unreviewed",
      }).success,
    ).toBe(false);
  });
});
