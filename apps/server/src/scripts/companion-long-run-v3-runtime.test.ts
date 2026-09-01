import { describe, expect, it } from "vitest";

import { hashLongRunV3SnapshotProjections } from "./companion-long-run-v3-runtime.js";

describe("companion long-run v3 snapshot hashes", () => {
  const baseProjection = {
    runtimeState: { mood: 0.5 },
    messages: [{ id: "message-1" }],
    rejectedProposals: [{ id: "rejection-1" }],
    retrievalRuns: [{ id: "retrieval-1" }],
    retrievalRunsFullSha256: "retrieval-digest-1",
    llmCalls: [{ id: "call-1" }],
    tableCounts: { messages: 1, llm_calls: 1 },
  };

  it.each([
    ["rejectedProposals", [{ id: "rejection-2" }]],
    ["retrievalRuns", [{ id: "retrieval-2" }]],
    ["retrievalRunsFullSha256", "retrieval-digest-2"],
    ["llmCalls", [{ id: "call-2" }]],
    ["tableCounts", { messages: 999, llm_calls: 2 }],
  ] as const)(
    "keeps %s out of the business hash and inside the audit hash",
    (field, value) => {
      const before = hashLongRunV3SnapshotProjections(baseProjection);
      const after = hashLongRunV3SnapshotProjections({
        ...baseProjection,
        [field]: value,
      });
      expect(after.durableSha256).toBe(before.durableSha256);
      expect(after.auditSha256).not.toBe(before.auditSha256);
    },
  );

  it("keeps business payload rows out of the audit hash material", () => {
    const before = hashLongRunV3SnapshotProjections(baseProjection);
    const after = hashLongRunV3SnapshotProjections({
      ...baseProjection,
      messages: [{ id: "message-1" }, { id: "message-2" }],
    });
    expect(after.durableSha256).not.toBe(before.durableSha256);
    expect(after.auditSha256).toBe(before.auditSha256);
  });
});
