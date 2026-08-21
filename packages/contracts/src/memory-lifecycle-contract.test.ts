import { describe, expect, it } from "vitest";

import { MemorySchema } from "./memory.js";

const NOW = "2026-08-21T12:00:00.000Z";

function memory(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "memory-lifecycle-contract",
    agentId: "agent-lifecycle-contract",
    kind: "commitment",
    content: "The user plans to submit the portfolio.",
    importance: 0.9,
    confidence: 1,
    tags: ["portfolio"],
    sourceMessageIds: ["message-lifecycle-contract"],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    status: "active",
    dedupeKey: "memory-key-lifecycle-contract",
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
    ...overrides,
  };
}

describe("memory lifecycle contract", () => {
  it("keeps claim semantics nested while lifecycle links stay top-level", () => {
    const parsed = MemorySchema.parse(
      memory({
        claim: {
          subjectKey: "user_goal:portfolio_submission",
          disposition: "affirmed",
          recordedAtUtc: NOW,
        },
        lastReinforcedAtUtc: NOW,
        lifecycleUpdatedAtUtc: NOW,
      }),
    );

    expect(parsed.claim).toEqual({
      subjectKey: "user_goal:portfolio_submission",
      disposition: "affirmed",
      recordedAtUtc: NOW,
    });
  });

  it("requires a target for superseded and merged memories", () => {
    expect(
      MemorySchema.safeParse(memory({ status: "superseded" })).success,
    ).toBe(false);
    expect(MemorySchema.safeParse(memory({ status: "merged" })).success).toBe(
      false,
    );
    expect(
      MemorySchema.safeParse(
        memory({ status: "merged", mergedIntoId: "memory-merge-target" }),
      ).success,
    ).toBe(true);
  });

  it("retains legacy forgotten only as a migration-compatible status", () => {
    expect(MemorySchema.parse(memory({ status: "forgotten" })).status).toBe(
      "forgotten",
    );
  });
});
