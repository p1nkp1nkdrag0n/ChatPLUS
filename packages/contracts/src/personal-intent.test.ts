import { describe, expect, it } from "vitest";

import {
  PersonalIntentCandidateSchema,
  PersonalIntentSchema,
} from "./personal-intent.js";

const candidate = {
  activity: "Riverside night photography",
  durationHint: "half an hour",
  timingHint: "tomorrow evening",
  basisKind: "chat" as const,
  evidenceQuotes: ["the riverside looks beautiful at night"],
  reasonCode: "chat_inspiration",
  reasonSummary: "The user's observation inspired a possible activity.",
};

describe("PersonalIntent contracts", () => {
  it("keeps persisted ownership and exact time fields out of the model candidate", () => {
    expect(PersonalIntentCandidateSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      PersonalIntentCandidateSchema.safeParse({
        ...candidate,
        id: "model-owned-id",
        earliestAtUtc: "2026-08-22T10:00:00.000Z",
        source: "model",
      }).success,
    ).toBe(false);
  });

  it("requires a chronological persisted planning window", () => {
    const intent = {
      id: "intent-1",
      agentId: "agent-1",
      activity: "Riverside night photography",
      category: "leisure" as const,
      desiredDurationMinutes: 30,
      earliestAtUtc: "2026-08-22T15:00:00.000Z",
      latestAtUtc: "2026-08-22T10:00:00.000Z",
      basisKind: "chat" as const,
      basisRefIds: [],
      evidenceMessageIds: ["message-1"],
      priority: 0.6,
      freshness: 1,
      status: "pending" as const,
      dedupeKey: "pi:v1:example",
      specVersion: 1,
      schemaVersion: 1,
      attemptCount: 0,
      createdAtUtc: "2026-08-21T04:00:00.000Z",
      updatedAtUtc: "2026-08-21T04:00:00.000Z",
    };

    expect(PersonalIntentSchema.safeParse(intent).success).toBe(false);
  });
});
