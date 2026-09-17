import { describe, expect, it } from "vitest";
import {
  createCompletedActivityCandidate,
  selectProactiveCandidate,
  type CreateCompletedActivityCandidateInput,
  type ProactiveCandidateLike,
} from "./proactive-dialogue.js";

const NOW = "2026-09-02T04:00:00.000Z";
function input(
  overrides: Partial<CreateCompletedActivityCandidateInput> = {},
): CreateCompletedActivityCandidateInput {
  return {
    tier: "high_fidelity",
    agentId: "agent-1",
    policy: {
      enabled: true,
      maxMessagesPerDay: 2,
      minimumCloseness: 0.4,
      quietHours: { startLocal: "23:00", endLocal: "08:00" },
      shareableCategories: ["leisure"],
    },
    relationshipCloseness: 0.8,
    nowUtc: NOW,
    ttlHours: 48,
    source: {
      id: "event-1",
      agentId: "agent-1",
      completed: true,
      title: "散步",
      category: "leisure",
      summary: "沿河走了一会儿。",
      shareable: true,
      narrativeImportance: 0.2,
      recordedAtUtc: NOW,
    },
    ...overrides,
  };
}

describe("completed activity candidates", () => {
  it("allows explicitly shareable everyday material without narrative importance", () => {
    expect(createCompletedActivityCandidate(input())?.summary).toBe(
      "沿河走了一会儿。",
    );
    const value = input();
    value.source.shareable = false;
    value.source.narrativeImportance = 1;
    expect(createCompletedActivityCandidate(value)).toBeUndefined();
    expect(
      createCompletedActivityCandidate({ ...value, userRelevance: 0.8 }),
    ).toBeDefined();
    expect(
      createCompletedActivityCandidate({ ...value, shareableValue: 0.7 }),
    ).toBeDefined();
  });

  it.each(["pending", "sent", "expired", "suppressed", "merged"] as const)(
    "never recreates one source even after its candidate is %s",
    (status) => {
      const first = createCompletedActivityCandidate(input())!;
      expect(
        createCompletedActivityCandidate(
          input({
            nowUtc: "2026-09-03T04:00:00.000Z",
            existingCandidates: [{ ...first, status }],
          }),
        ),
      ).toBeUndefined();
    },
  );

  it("separates recurring topics from immutable event identity with finite cooldown", () => {
    const first = createCompletedActivityCandidate(input())!;
    const next = input({
      nowUtc: "2026-09-02T06:00:00.000Z",
      existingCandidates: [{ ...first, status: "sent" }],
    });
    next.source.id = "event-2";
    next.source.recordedAtUtc = next.nowUtc;
    const second = createCompletedActivityCandidate(next)!;
    expect(second.id).not.toBe(first.id);
    expect(second.dedupeKey).toBe(first.dedupeKey);
    expect(Date.parse(second.earliestSendAtUtc)).toBe(
      Date.parse("2026-09-03T04:00:00.000Z"),
    );
    expect(second.summary).toBe(next.source.summary);
    const later = input({
      nowUtc: "2026-09-04T04:00:00.000Z",
      existingCandidates: [{ ...first, status: "sent" }],
    });
    later.source.id = "event-3";
    later.source.recordedAtUtc = later.nowUtc;
    expect(
      Date.parse(createCompletedActivityCandidate(later)!.earliestSendAtUtc),
    ).toBe(Date.parse(later.nowUtc));
  });

  it("rejects plans, foreign events and stale completed facts", () => {
    for (const change of [
      { completed: false },
      { agentId: "other" },
      { recordedAtUtc: "2026-08-25T04:00:00.000Z" },
    ]) {
      const value = input();
      Object.assign(value.source, change);
      expect(createCompletedActivityCandidate(value)).toBeUndefined();
    }
  });

  it("stable candidate identity survives title changes", () => {
    const value = input();
    const first = createCompletedActivityCandidate(value)!;
    value.source.title = "另一种描述";
    expect(createCompletedActivityCandidate(value)?.id).toBe(first.id);
  });

  it("honors the caller's daily limit without a second hidden limit", () => {
    const value = input();
    const candidate = createCompletedActivityCandidate(value)!;
    const selection = {
      tier: value.tier,
      candidates: [candidate] as ProactiveCandidateLike[],
      nowUtc: NOW,
      timezone: "Asia/Shanghai",
      policy: { ...value.policy, maxMessagesPerDay: 3 },
      relationshipCloseness: 0.8,
    };
    expect(selectProactiveCandidate({ ...selection, sentToday: 2 })).toBe(
      candidate,
    );
    expect(
      selectProactiveCandidate({ ...selection, sentToday: 3 }),
    ).toBeUndefined();
  });
});
