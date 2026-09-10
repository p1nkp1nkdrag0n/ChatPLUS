import type {
  MemoryEvidence,
  RetrievedMemoryEvidence,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";
import { MemoryRelevanceSchema } from "@personasim/contracts";

import { buildConversationContextPlan } from "./conversation-context-plan.js";
import {
  recallMemory,
  allowsAgingMemoryRecall,
  type MemoryRecallInput,
  type MemorySemanticSignal,
  type RecallableMemory,
} from "./memory-recall.js";
import { selectMemoryUseForTurn } from "./memory-use.js";

const NOW = "2026-09-10T12:00:00.000Z";
const QUERY = "饮料喜好";
const MEMORY: RecallableMemory = {
  id: "memory-tea",
  content: "烘焙乌龙",
  kind: "semantic",
  status: "active",
  confidence: 1,
  importance: 0.6,
  tags: [],
  namespace: "user_model",
  certainty: "explicit",
  attribution: "user_explicit",
  stability: "stable",
  createdAtUtc: NOW,
  updatedAtUtc: NOW,
};
const EVIDENCE: MemoryEvidence = {
  id: "evidence-tea",
  memoryId: MEMORY.id,
  sourceType: "message",
  sourceId: "message-tea",
  quote: MEMORY.content,
  recordedAtUtc: NOW,
};
const SIGNAL: MemorySemanticSignal = {
  query: QUERY,
  memoryId: MEMORY.id,
  memoryContent: MEMORY.content,
  evidenceId: EVIDENCE.id,
  evidenceSourceId: EVIDENCE.sourceId,
  evidenceText: EVIDENCE.quote!,
  evidenceSourceType: EVIDENCE.sourceType,
  evidenceQuote: EVIDENCE.quote ?? null,
  evidenceContextSummary: EVIDENCE.contextSummary ?? null,
  score: 0.95,
};
function recall(overrides: Partial<MemoryRecallInput> = {}) {
  return recallMemory({
    query: QUERY,
    memories: [MEMORY],
    evidence: [EVIDENCE],
    nowUtc: NOW,
    ...overrides,
  });
}
function plan(query = QUERY) {
  return buildConversationContextPlan({
    originalQuery: query,
    agentId: "agent",
    sessionId: "session",
    recentMessages: [],
  });
}
function selected(): RetrievedMemoryEvidence {
  const result = recall({ semanticSignals: [SIGNAL] });
  if (result.abstained)
    throw new Error("Expected the bound semantic fixture to be selected");
  return result.evidenceBundle.evidence[0]!;
}

describe("shared recall relevance", () => {
  it("reuses a tag/evidence match when the compressed memory has no lexical overlap", () => {
    const result = recall({
      memories: [{ ...MEMORY, tags: [QUERY] }],
      evidence: [{ ...EVIDENCE, quote: `${QUERY}：${MEMORY.content}` }],
    });
    expect(result.abstained).toBe(false);
    if (result.abstained) return;
    expect(result.evidenceBundle.evidence[0]?.relevance?.reasons).toEqual([
      "lexical",
      "tag",
    ]);
    const input = { plan: plan(), evidence: result.evidenceBundle.evidence };
    expect(selectMemoryUseForTurn(input).explicitMentionEvidenceIds).toEqual([
      EVIDENCE.id,
    ]);
    expect(
      selectMemoryUseForTurn({ ...input, relevanceMode: "legacy_lexical" })
        .explicitMentionEvidenceIds,
    ).toEqual([]);
  });

  it("does not promote importance and recency alone into relevance", () => {
    expect(
      recall({ memories: [{ ...MEMORY, importance: 1 }], minimumScore: 0 })
        .abstained,
    ).toBe(true);
  });

  it("supports a bound semantic fixture without inventing a current-fact projection", () => {
    expect(recall().abstained).toBe(true);
    const item = selected();
    expect(item.relevance?.reasons).toEqual(["semantic"]);
    expect(item.scoreBreakdown.semantic).toBe(0.95);
    expect(item.currentFact).toBeUndefined();
    expect(
      selectMemoryUseForTurn({ plan: plan(), evidence: [item] })
        .explicitMentionEvidenceIds,
    ).toEqual([EVIDENCE.id]);
    expect(
      selectMemoryUseForTurn({
        plan: plan(),
        evidence: [item],
        relevanceMode: "legacy_lexical",
      }).explicitMentionEvidenceIds,
    ).toEqual([]);
  });

  it.each([
    { query: "another turn" },
    { memoryId: "another-memory" },
    { memoryContent: "stale content" },
    { evidenceId: "another-evidence" },
    { evidenceSourceId: "another-source" },
    { evidenceText: "stale quote" },
    { evidenceSourceType: "manual" as const },
    { evidenceQuote: "stale quote" },
    { evidenceContextSummary: "changed secondary text" },
    { score: Number.NaN },
    { score: 1.1 },
    { score: -1 },
  ])("ignores unbound or invalid semantic signals: %j", (patch) => {
    expect(
      recall({ semanticSignals: [{ ...SIGNAL, ...patch }] }).abstained,
    ).toBe(true);
  });

  it("does not let similarity rescue mismatched exact identifiers", () => {
    const query = "BGW-7419";
    const memory = { ...MEMORY, content: "BGW-7420" };
    const evidence = { ...EVIDENCE, quote: memory.content };
    expect(
      recall({
        query,
        memories: [memory],
        evidence: [evidence],
        semanticSignals: [
          {
            ...SIGNAL,
            query,
            memoryContent: memory.content,
            evidenceText: evidence.quote,
            evidenceQuote: evidence.quote,
            score: 1,
          },
        ],
      }).abstained,
    ).toBe(true);
  });

  it.each([
    { memories: [{ ...MEMORY, status: "superseded" as const }] },
    { memories: [{ ...MEMORY, expiresAtUtc: NOW }] },
    { evidence: [] },
    { evidence: [{ ...EVIDENCE, sourceType: "schedule_event" as const }] },
    { namespaceFilters: ["character_self" as const] },
    {
      memories: [{ ...MEMORY, evidence: [{ ...EVIDENCE, memoryId: "other" }] }],
      evidence: [],
    },
  ])("retains hard candidate/evidence constraints: %j", (patch) => {
    expect(recall({ ...patch, semanticSignals: [SIGNAL] }).abstained).toBe(
      true,
    );
  });

  it("retains suppression and repetition permissions with shared relevance", () => {
    const item = selected();
    const suppressed = selectMemoryUseForTurn({
      plan: plan(),
      evidence: [item],
      suppressedMemoryIds: [item.memoryId],
    });
    expect(suppressed.backgroundEvidenceIds).toEqual([]);
    expect(suppressed.explicitMentionEvidenceIds).toEqual([]);
    const repeated = selectMemoryUseForTurn({
      plan: plan(),
      evidence: [item],
      recentlyMentionedMemoryIds: [item.memoryId],
    });
    expect(repeated.backgroundEvidenceIds).toEqual([EVIDENCE.id]);
    expect(repeated.explicitMentionEvidenceIds).toEqual([]);
  });

  it("rejects shared explanations replayed on another query or changed evidence", () => {
    const item = selected();
    const otherTurn = selectMemoryUseForTurn({
      plan: plan("another turn"),
      evidence: [item],
    });
    expect(otherTurn.backgroundEvidenceIds).toEqual([]);
    const changed = selectMemoryUseForTurn({
      plan: plan(),
      evidence: [{ ...item, evidence: { ...item.evidence, quote: "changed" } }],
    });
    expect(changed.backgroundEvidenceIds).toEqual([]);
  });

  it.each([
    { contextSummary: "changed secondary context" },
    { sourceType: "manual" as const },
  ])("rejects reuse after any bound source field changes: %j", (patch) => {
    const item = selected();
    expect(
      selectMemoryUseForTurn({
        plan: plan(),
        evidence: [{ ...item, evidence: { ...item.evidence, ...patch } }],
      }).backgroundEvidenceIds,
    ).toEqual([]);
  });

  it("accepts historical metadata for reading but fails closed on old or partial bindings", () => {
    const item = selected();
    const old = {
      ...item.relevance!,
      policyVersion: "memory_relevance_v1" as const,
    };
    delete old.evidenceSourceType;
    delete old.evidenceQuote;
    delete old.evidenceContextSummary;
    expect(MemoryRelevanceSchema.safeParse(old).success).toBe(true);
    expect(
      selectMemoryUseForTurn({
        plan: plan(),
        evidence: [{ ...item, relevance: old }],
      }).backgroundEvidenceIds,
    ).toEqual([]);
    const partial = { ...old, policyVersion: "memory_relevance_v2" as const };
    expect(MemoryRelevanceSchema.safeParse(partial).success).toBe(false);
    expect(
      selectMemoryUseForTurn({
        plan: plan(),
        evidence: [{ ...item, relevance: partial }],
      }).backgroundEvidenceIds,
    ).toEqual([]);
    const withoutMetadata = { ...item };
    delete withoutMetadata.relevance;
    expect(
      selectMemoryUseForTurn({
        plan: plan(MEMORY.content),
        evidence: [withoutMetadata],
      }).explicitMentionEvidenceIds,
    ).toEqual([EVIDENCE.id]);
  });

  it("rejects a semantic signal missing the new source binding fields", () => {
    const partial: Partial<MemorySemanticSignal> = { ...SIGNAL };
    delete partial.evidenceSourceType;
    delete partial.evidenceQuote;
    delete partial.evidenceContextSummary;
    expect(
      recall({ semanticSignals: [partial as MemorySemanticSignal] }).abstained,
    ).toBe(true);
  });
});

describe("explicit aging recollection scope", () => {
  it.each([
    "你还记得我们去过苔藓陶艺展吗？",
    "你记不记得我们去过苔藓陶艺展？",
    "你还记得我说过我们去过苔藓陶艺展吗？",
    "请回忆一下我们去过苔藓陶艺展的事。",
    "Can you recall the pottery exhibition?",
    "Do you remember the pottery exhibition?",
    "Please recollect the pottery exhibition.",
    "她说‘你还记得别的展览吗’。请回忆一下我们去过苔藓陶艺展的事。",
    "不用回忆一下旧行程，而是请回忆一下我们去过苔藓陶艺展的事。",
  ])("permits a direct original recollection: %s", (query) => {
    expect(allowsAgingMemoryRecall(query)).toBe(true);
  });
  it.each([
    "我不是让你回忆一下我们去过苔藓陶艺展的事，换个话题吧。",
    "不用回忆一下我们去过苔藓陶艺展的事。",
    "请暂时先不要回忆一下我们去过苔藓陶艺展的事。",
    "她说‘你还记得我们去过苔藓陶艺展吗’，我只是转述。",
    "她问我：你还记得我们去过苔藓陶艺展吗？",
    "同事问我，你还记得我们去过苔藓陶艺展吗？",
    "如果她问，你还记得我们去过苔藓陶艺展吗？",
    "我准备回忆一下我们去过苔藓陶艺展的事。",
    "Do not recollect the pottery exhibition.",
    "She asked, do you remember the pottery exhibition?",
    "If I ask, can you recall the pottery exhibition?",
    "I can recollect the pottery exhibition.",
    "你还记得我现在去哪个苔藓陶艺展吗？",
  ])(
    "excludes denied, reported, hypothetical or current recall: %s",
    (query) => {
      expect(allowsAgingMemoryRecall(query)).toBe(false);
      const content = "我们去过苔藓陶艺展。";
      expect(
        recall({
          query,
          memories: [{ ...MEMORY, content, status: "aging" }],
          evidence: [{ ...EVIDENCE, quote: content }],
        }).selectedMemoryIds,
      ).toEqual([]);
    },
  );
});
