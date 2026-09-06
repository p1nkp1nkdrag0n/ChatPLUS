import type { RetrievedMemoryEvidence } from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import { buildConversationContextPlan } from "./conversation-context-plan.js";
import { selectMemoryUseForTurn } from "./memory-use.js";

function evidence(id: string, content: string): RetrievedMemoryEvidence {
  return {
    memoryId: id,
    memoryContent: content,
    memoryKind: "semantic",
    namespace: "user_model",
    attribution: "user_explicit",
    certainty: "explicit",
    stability: "stable",
    score: 0.8,
    scoreBreakdown: {
      lexical: 0.8,
      tag: 0,
      importance: 0.8,
      recency: 1,
      temporal: 0.5,
      namespace: 1,
    },
    evidence: {
      id: `evidence_${id}`,
      memoryId: id,
      sourceType: "message",
      sourceId: `message_${id}`,
      quote: content,
      recordedAtUtc: "2026-09-06T00:00:00.000Z",
    },
  };
}
function plan(originalQuery: string) {
  return buildConversationContextPlan({
    originalQuery,
    agentId: "agent",
    sessionId: "session",
    recentMessages: [],
  });
}

describe("memory use permissions", () => {
  it("applies global and matching topical preferences without mechanically repeating them", () => {
    const result = selectMemoryUseForTurn({
      plan: plan("今天工作有点累。"),
      evidence: [
        evidence("global", "我不喜欢被追问。"),
        evidence("work", "我谈工作烦恼时，希望先听我说，别急着建议。"),
        evidence("family", "我谈家庭争吵时，别急着建议。"),
      ],
    });
    expect(result.backgroundEvidenceIds).toEqual([
      "evidence_global",
      "evidence_work",
    ]);
    expect(result.behavioralPreferenceEvidenceIds).toEqual([
      "evidence_global",
      "evidence_work",
    ]);
    expect(result.explicitMentionEvidenceIds).toEqual([]);
  });

  it("excludes withdrawn evidence from all use and suppresses recently repeated mentions only", () => {
    const result = selectMemoryUseForTurn({
      plan: plan("今天工作有点忙。"),
      evidence: [
        evidence("old", "工作地点是上海。"),
        evidence("recent", "工作地点是北京。"),
      ],
      suppressedMemoryIds: ["old"],
      recentlyMentionedMemoryIds: ["recent"],
    });
    expect(result.backgroundEvidenceIds).toEqual(["evidence_recent"]);
    expect(result.explicitMentionEvidenceIds).toEqual([]);
    expect(result.omissions).toEqual([
      { evidenceId: "evidence_old", reason: "suppressed" },
      { evidenceId: "evidence_recent", reason: "recently_mentioned" },
    ]);
  });

  it("limits casual explicit mentions while retaining useful background", () => {
    const result = selectMemoryUseForTurn({
      plan: plan("今天工作有点忙。"),
      evidence: [1, 2, 3].map((id) =>
        evidence(String(id), `工作项目第${id}次进展。`),
      ),
    });
    expect(result.backgroundEvidenceIds).toHaveLength(3);
    expect(result.explicitMentionEvidenceIds).toHaveLength(2);
    expect(result.omissions.at(-1)?.reason).toBe("mention_budget");
  });
});
