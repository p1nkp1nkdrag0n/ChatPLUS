import { describe, expect, it } from "vitest";

import {
  canonicalMemoryConflictPair,
  planMemoryLifecycleTransition,
  reconcileMemoryClaims,
  type LifecycleMemoryLike,
} from "./memory-lifecycle.js";

const NOW = "2026-08-21T12:00:00.000Z";
const OLD = "2026-07-01T12:00:00.000Z";

function memory(
  overrides: Partial<LifecycleMemoryLike> = {},
): LifecycleMemoryLike {
  return {
    id: "memory-old",
    kind: "semantic",
    content: "The user is preparing for the postgraduate exam.",
    importance: 0.6,
    confidence: 1,
    status: "active",
    stability: "situational",
    certainty: "explicit",
    attribution: "user_explicit",
    claim: {
      subjectKey: "user_goal:postgraduate_exam",
      disposition: "affirmed",
      recordedAtUtc: OLD,
    },
    createdAtUtc: OLD,
    updatedAtUtc: OLD,
    ...overrides,
  };
}

describe("memory lifecycle aging", () => {
  it("ages ordinary memories but protects stable memories", () => {
    expect(
      planMemoryLifecycleTransition({
        memory: memory(),
        nowUtc: NOW,
      }),
    ).toMatchObject({
      fromStatus: "active",
      toStatus: "aging",
      reasonCode: "memory_aged",
    });
    expect(
      planMemoryLifecycleTransition({
        memory: memory({ stability: "stable" }),
        nowUtc: NOW,
      }),
    ).toBeUndefined();
  });

  it("archives expired memories regardless of stability", () => {
    expect(
      planMemoryLifecycleTransition({
        memory: memory({
          stability: "stable",
          expiresAtUtc: "2026-08-20T12:00:00.000Z",
        }),
        nowUtc: NOW,
      }),
    ).toMatchObject({
      toStatus: "archived",
      reasonCode: "memory_expired",
    });
  });
});

describe("memory claim reconciliation", () => {
  it("supersedes an older goal with a later explicit cancellation", () => {
    const result = reconcileMemoryClaims({
      existing: memory(),
      incoming: memory({
        id: "memory-new",
        content: "The user decided not to take the postgraduate exam.",
        claim: {
          subjectKey: "user_goal:postgraduate_exam",
          disposition: "cancelled",
          recordedAtUtc: "2026-08-21T10:00:00.000Z",
        },
        updatedAtUtc: "2026-08-21T10:00:00.000Z",
      }),
    });
    expect(result).toEqual({
      kind: "supersede",
      reasonCode: "later_explicit_claim",
      subjectKey: "user_goal:postgraduate_exam",
      existingStatus: "superseded",
      incomingStatus: "active",
      winnerMemoryId: "memory-new",
    });
  });

  it("opens review instead of guessing from uncertain evidence", () => {
    const result = reconcileMemoryClaims({
      existing: memory(),
      incoming: memory({
        id: "memory-new",
        certainty: "inferred",
        attribution: "model_inference",
        claim: {
          subjectKey: "user_goal:postgraduate_exam",
          disposition: "cancelled",
          recordedAtUtc: "2026-08-21T10:00:00.000Z",
        },
      }),
    });
    expect(result.kind).toBe("needs_review");
    expect(result.existingStatus).toBe("needs_review");
  });

  it("merges a grounded reinforcement and canonicalizes conflict pairs", () => {
    const result = reconcileMemoryClaims({
      existing: memory(),
      incoming: memory({
        id: "memory-new",
        content: "The user is preparing for the postgraduate exam.",
        claim: {
          subjectKey: "user_goal:postgraduate_exam",
          disposition: "affirmed",
          recordedAtUtc: "2026-08-20T10:00:00.000Z",
        },
      }),
    });
    expect(result).toMatchObject({
      kind: "merge",
      winnerMemoryId: "memory-old",
      incomingStatus: "merged",
    });
    expect(canonicalMemoryConflictPair("memory-z", "memory-a")).toEqual([
      "memory-a",
      "memory-z",
    ]);
  });
});
