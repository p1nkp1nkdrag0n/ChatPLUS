import { describe, expect, it } from "vitest";

import { EventCardDraftSchema, EventCardSchema } from "./event-card.js";

const NOW = "2026-08-21T12:00:00.000Z";

function occurredDraft() {
  return {
    cardKind: "activity" as const,
    sourceKind: "activity_event" as const,
    sourceId: "activity-1",
    dedupeKey: "activity:activity-1",
    title: "Morning run",
    summary: "Finished the morning run.",
    tags: ["running"],
    namespace: "runtime_simulation" as const,
    certainty: "explicit" as const,
    attribution: "simulation_event" as const,
    temporalMetadata: {
      occurredStartAtUtc: "2026-08-21T09:00:00.000Z",
      occurredEndAtUtc: "2026-08-21T10:00:00.000Z",
      recordedAtUtc: NOW,
      temporalCertainty: "exact" as const,
      temporalStatus: "occurred" as const,
    },
    importance: 0.8,
    evidence: [
      {
        id: "evidence-activity-1",
        sourceType: "activity_event" as const,
        sourceId: "activity-1",
        contextSummary: "The run settled as completed.",
        temporalStatus: "occurred" as const,
        reliability: "fact" as const,
        recordedAtUtc: NOW,
      },
    ],
  };
}

describe("event card contracts", () => {
  it("requires an evidence chain for an occurred card", () => {
    const draft = occurredDraft();
    expect(EventCardDraftSchema.parse(draft).cardKind).toBe("activity");
    expect(
      EventCardDraftSchema.safeParse({
        ...draft,
        evidence: [
          {
            ...draft.evidence[0],
            reliability: "context",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps the projected evidence id list exact", () => {
    const draft = occurredDraft();
    expect(
      EventCardSchema.safeParse({
        id: "card-1",
        agentId: "agent-1",
        ...draft,
        sourceEvidenceIds: ["wrong-evidence"],
        status: "active",
        indexVersion: 1,
        createdAtUtc: NOW,
        updatedAtUtc: NOW,
      }).success,
    ).toBe(false);
    expect(
      EventCardSchema.parse({
        id: "card-1",
        agentId: "agent-1",
        ...draft,
        sourceEvidenceIds: ["evidence-activity-1"],
        status: "active",
        indexVersion: 1,
        createdAtUtc: NOW,
        updatedAtUtc: NOW,
      }).sourceEvidenceIds,
    ).toEqual(["evidence-activity-1"]);
  });
});
