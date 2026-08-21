import { describe, expect, it } from "vitest";

import {
  AgentAutobiographySnapshotSchema,
  AutobiographyEntryDraftSchema,
} from "./autobiography.js";

const NOW = "2026-08-21T12:00:00.000Z";

describe("autobiography contracts", () => {
  it("does not accept context-only evidence for an occurred entry", () => {
    expect(
      AutobiographyEntryDraftSchema.safeParse({
        entryKind: "important_experience",
        content: "I finished the run.",
        temporalStatus: "occurred",
        fromUtc: "2026-08-21T09:00:00.000Z",
        evidence: [
          {
            id: "evidence-1",
            sourceType: "domain_event",
            sourceId: "event-1",
            contextSummary: "A future run was planned.",
            temporalStatus: "planned",
            reliability: "context",
            recordedAtUtc: NOW,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires a non-empty, unique snapshot evidence chain", () => {
    const snapshot = {
      id: "autobiography-1",
      agentId: "agent-1",
      sourceCheckpointId: "checkpoint-1",
      revision: 1,
      summaryFirstPerson: "I remember finishing the morning run.",
      importantExperiences: ["I finished the morning run."],
      relationshipChanges: [],
      activeGoals: [],
      unresolvedThreads: [],
      commitments: [],
      sourceEvidenceIds: ["evidence-1"],
      fromUtc: "2026-08-21T09:00:00.000Z",
      throughUtc: NOW,
      createdAtUtc: NOW,
    };
    expect(
      AgentAutobiographySnapshotSchema.parse(snapshot).sourceEvidenceIds,
    ).toEqual(["evidence-1"]);
    expect(
      AgentAutobiographySnapshotSchema.safeParse({
        ...snapshot,
        sourceEvidenceIds: [],
      }).success,
    ).toBe(false);
  });
});
