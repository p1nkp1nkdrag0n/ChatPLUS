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
    expect(parsed.requestPolicyVersion).toBeUndefined();
    expect(parsed.structuredTaskRequested).toBeUndefined();
  });

  it.each(["clause_requests_v1", "clause_requests_v2", "clause_requests_v3"])(
    "retains the recorded request parser version %s",
    (requestPolicyVersion) => {
      expect(
        ConversationContextPlanSchema.parse({
          ...historical,
          requestPolicyVersion,
        }).requestPolicyVersion,
      ).toBe(requestPolicyVersion);
    },
  );

  it("rejects unknown request parser versions", () => {
    expect(
      ConversationContextPlanSchema.safeParse({
        ...historical,
        requestPolicyVersion: "unreviewed",
      }).success,
    ).toBe(false);
  });

  it("retains the v3 procedural hint without inventing it for old plans", () => {
    expect(
      ConversationContextPlanSchema.parse({
        ...historical,
        requestPolicyVersion: "clause_requests_v3",
        structuredTaskRequested: true,
      }).structuredTaskRequested,
    ).toBe(true);
    expect(
      ConversationContextPlanSchema.safeParse({
        ...historical,
        structuredTaskRequested: "yes",
      }).success,
    ).toBe(false);
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
