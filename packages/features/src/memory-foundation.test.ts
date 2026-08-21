import { describe, expect, it } from "vitest";

import {
  MemoryCandidateSchema,
  type MemoryCandidate,
  type MemoryEvidence,
} from "@personasim/contracts";

import { judgeMemoryCandidate } from "./memory-judge.js";
import { recallMemory, type RecallableMemory } from "./memory-recall.js";

const NOW = "2026-08-21T12:00:00.000Z";
const START = "2026-08-21T09:00:00.000Z";
const END = "2026-08-21T10:00:00.000Z";

function activityCandidate(
  evidenceSource: "activity_event" | "message",
): MemoryCandidate {
  return MemoryCandidateSchema.parse({
    kind: "episodic",
    content: "Finished the morning run and felt calmer.",
    importance: 0.8,
    confidence: 0.95,
    tags: ["activity_outcome", "exercise"],
    sourceMessageIds: evidenceSource === "message" ? ["message-1"] : [],
    sourceActivityEventIds:
      evidenceSource === "activity_event" ? ["activity-1"] : [],
    origin: "runtime_simulation",
    namespace: "runtime_simulation",
    certainty: "explicit",
    attribution: "simulation_event",
    stability: "one_off",
    temporalMetadata: {
      plannedStartAtUtc: START,
      plannedEndAtUtc: END,
      occurredStartAtUtc: START,
      occurredEndAtUtc: END,
      recordedAtUtc: NOW,
      temporalCertainty: "exact",
      temporalStatus: "occurred",
    },
    evidence: [
      evidenceSource === "activity_event"
        ? {
            sourceType: "activity_event",
            sourceId: "activity-1",
            contextSummary: "The run settled as completed.",
            recordedAtUtc: NOW,
          }
        : {
            sourceType: "message",
            sourceId: "message-1",
            quote: "I might run tomorrow.",
            recordedAtUtc: NOW,
          },
    ],
    shouldWrite: true,
    forbiddenOverclaims: [],
    reasonCode: "activity_outcome",
    reasonSummary: "Created from the settled activity.",
  });
}

describe("conservative memory judge", () => {
  it("requires ActivityEvent evidence for an activity outcome", () => {
    const rejected = judgeMemoryCandidate(activityCandidate("message"));
    expect(rejected.accepted).toBe(false);
    expect(rejected.issues.map((issue) => issue.code)).toContain(
      "ACTIVITY_OUTCOME_UNGROUNDED",
    );

    const accepted = judgeMemoryCandidate(activityCandidate("activity_event"));
    expect(accepted.accepted).toBe(true);
    expect(accepted.decision).toBe("write");
  });

  it("requires explicit or repeated evidence for a stable user model", () => {
    const explicit = MemoryCandidateSchema.parse({
      kind: "semantic",
      content: "The user is vegetarian.",
      importance: 0.9,
      confidence: 1,
      tags: ["diet", "preference"],
      sourceMessageIds: ["message-user-1"],
      sourceActivityEventIds: [],
      origin: "runtime_simulation",
      namespace: "user_model",
      certainty: "explicit",
      attribution: "user_explicit",
      stability: "stable",
      temporalMetadata: {
        mentionedAtUtc: NOW,
        recordedAtUtc: NOW,
        temporalCertainty: "exact",
        temporalStatus: "unknown",
      },
      evidence: [
        {
          sourceType: "message",
          sourceId: "message-user-1",
          quote: "I am vegetarian.",
          recordedAtUtc: NOW,
        },
      ],
      shouldWrite: true,
      forbiddenOverclaims: [],
      reasonCode: "stable_user_preference",
      reasonSummary: "The user stated this directly.",
    });
    expect(judgeMemoryCandidate(explicit).accepted).toBe(true);

    const inferredOnce = MemoryCandidateSchema.parse({
      ...explicit,
      certainty: "inferred",
      attribution: "model_inference",
      evidence: [
        {
          sourceType: "message",
          sourceId: "message-user-2",
          quote: "I ordered a vegetable dish.",
          recordedAtUtc: NOW,
        },
      ],
      reasonCode: "stable_user_inference",
      reasonSummary: "Only one behavior supports the inference.",
    });
    const rejected = judgeMemoryCandidate(inferredOnce);
    expect(rejected.accepted).toBe(false);
    expect(rejected.issues.map((issue) => issue.code)).toContain(
      "STABLE_USER_MODEL_UNGROUNDED",
    );
  });
});

describe("deterministic evidence recall", () => {
  it("explicitly abstains when recall is unrelated", () => {
    const memory: RecallableMemory = {
      id: "memory-tea",
      kind: "semantic",
      content: "The user prefers jasmine tea.",
      importance: 1,
      confidence: 1,
      tags: ["tea", "preference"],
      status: "active",
      namespace: "user_model",
      certainty: "explicit",
      attribution: "user_explicit",
      stability: "stable",
      temporalMetadata: {
        mentionedAtUtc: "2026-08-20T12:00:00.000Z",
        recordedAtUtc: "2026-08-20T12:00:00.000Z",
        temporalCertainty: "exact",
        temporalStatus: "unknown",
      },
      createdAtUtc: "2026-08-20T12:00:00.000Z",
      updatedAtUtc: "2026-08-20T12:00:00.000Z",
    };
    const evidence: MemoryEvidence = {
      id: "evidence-tea",
      memoryId: memory.id,
      sourceType: "message",
      sourceId: "message-tea",
      quote: "I prefer jasmine tea.",
      recordedAtUtc: "2026-08-20T12:00:00.000Z",
    };

    const result = recallMemory({
      query: "When is the project deadline?",
      memories: [memory],
      evidence: [evidence],
      nowUtc: NOW,
    });

    expect(result.mode).toBe("none");
    expect(result.abstained).toBe(true);
    expect(result.selectedMemoryIds).toEqual([]);
    if (result.abstained) {
      expect(result.abstentionReason).toBe("below_relevance_threshold");
    }
  });

  it("returns one bundle capped at three formal evidence items", () => {
    const memories: RecallableMemory[] = Array.from(
      { length: 4 },
      (_, index) => ({
        id: `memory-run-${index}`,
        kind: "episodic",
        content: `Morning run result ${index}`,
        importance: 0.9 - index * 0.01,
        confidence: 1,
        tags: ["running"],
        status: "active",
        namespace: "runtime_simulation",
        certainty: "explicit",
        attribution: "simulation_event",
        stability: "one_off",
        occurredAtUtc: START,
        sourceActivityEventIds: [`activity-run-${index}`],
        createdAtUtc: NOW,
        updatedAtUtc: NOW,
      }),
    );

    const result = recallMemory({
      query: "morning run",
      memories,
      nowUtc: NOW,
      maxEvidence: 99,
    });

    expect(result.abstained).toBe(false);
    if (!result.abstained) {
      expect(result.evidenceBundle.evidence).toHaveLength(3);
      expect(result.selectedEvidenceIds).toHaveLength(3);
      expect(result.mode).toBe("event_card");
    }
  });
  it("boosts an exact long Chinese anchor above a merely similar record", () => {
    const correct: RecallableMemory = {
      id: "memory-long-term-anchor",
      kind: "semantic",
      content: "用户在长期记忆测试中明确提供了姓名和食物偏好。",
      importance: 0.9,
      confidence: 1,
      tags: ["用户事实"],
      status: "active",
      namespace: "user_model",
      certainty: "explicit",
      attribution: "user_explicit",
      stability: "stable",
      createdAtUtc: NOW,
      updatedAtUtc: NOW,
    };
    const distractor: RecallableMemory = {
      ...correct,
      id: "memory-similar-question",
      content: "另一次对话只询问了名字和喜欢的食物，没有提供答案。",
      importance: 0.1,
      tags: ["近似问题"],
    };
    const result = recallMemory({
      query: "你还记得我之前说的长期记忆测试吗？我叫什么，爱吃什么？",
      memories: [distractor, correct],
      evidence: [
        {
          id: "evidence-long-term-anchor",
          memoryId: correct.id,
          sourceType: "message",
          sourceId: "message-long-term-anchor",
          quote: "为了做长期记忆测试，我叫林舟，最爱吃城南老店的蟹黄面。",
          recordedAtUtc: NOW,
        },
        {
          id: "evidence-similar-question",
          memoryId: distractor.id,
          sourceType: "message",
          sourceId: "message-similar-question",
          quote: "你叫什么，喜欢吃什么？",
          recordedAtUtc: NOW,
        },
      ],
      nowUtc: NOW,
    });

    expect(result.abstained).toBe(false);
    expect(result.selectedMemoryIds).toEqual([correct.id]);
    expect(result.score).toBeGreaterThanOrEqual(0.42);
    if (!result.abstained) {
      expect(result.evidenceBundle.evidence[0]?.scoreBreakdown.lexical).toBe(
        0.8,
      );
    }
  });
});
