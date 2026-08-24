import { describe, expect, it } from "vitest";

import { TurnObservationProposalSchema } from "./turn-understanding.js";

function baseObservation(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    route: "schedule_mutation",
    dialogueActs: ["invite"],
    topics: [
      {
        key: "一起散步",
        domain: "social",
        confidence: 0.9,
        evidenceQuotes: [{ text: "一起去散步" }],
      },
    ],
    scheduleIntent: {
      kind: "create_shared_activity",
      activityQuote: { text: "一起去散步" },
      timeQuote: { text: "明天" },
      participantQuote: { text: "一起" },
      missingFields: [],
    },
    worldEffects: {
      stateDelta: "independently validated later",
      memoryCandidates: [{ malformedSibling: true }],
    },
    salientUserQuotes: [{ text: "明天一起去散步" }],
    uncertainty: [],
    confidence: 0.88,
  };
}

describe("TurnObservationProposalSchema", () => {
  it("accepts loose world-effect siblings without mixing in a reply", () => {
    const parsed = TurnObservationProposalSchema.parse(baseObservation());
    expect(parsed.worldEffects).toMatchObject({
      stateDelta: "independently validated later",
      memoryCandidates: [{ malformedSibling: true }],
    });
    expect(parsed).not.toHaveProperty("text");
  });

  it("rejects reply fields at the observation boundary", () => {
    expect(
      TurnObservationProposalSchema.safeParse({
        ...baseObservation(),
        text: "好，我们明天见。",
      }).success,
    ).toBe(false);
  });

  it("rejects model-owned ids and canonical time fields in schedule intent", () => {
    const withDatabaseId = baseObservation();
    withDatabaseId.scheduleIntent = {
      kind: "create_shared_activity",
      activityQuote: { text: "一起去散步" },
      startAtUtc: "2026-08-24T08:00:00.000Z",
      itemId: "schedule-1",
      missingFields: ["time"],
    };
    expect(
      TurnObservationProposalSchema.safeParse(withDatabaseId).success,
    ).toBe(false);
  });
});
