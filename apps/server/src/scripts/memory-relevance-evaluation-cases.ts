import type { MemoryNamespace } from "@personasim/contracts";
import type { RecallableMemory } from "@personasim/features";

export const MEMORY_EVALUATION_NOW = "2026-09-10T12:00:00.000Z";

export interface MemoryRelevanceCase {
  id: string;
  description: string;
  query: string;
  memories: RecallableMemory[];
  /** Deliberately injected scores, including adversarial positives; not embeddings. */
  semanticScores: Record<string, number>;
  namespaces?: MemoryNamespace[];
  suppressedMemoryIds?: string[];
  recentlyMentionedMemoryIds?: string[];
  expected: {
    relevantMemoryIds: string[];
    mentionableMemoryIds: string[];
    forbiddenRecallMemoryIds: string[];
    forbiddenUseMemoryIds: string[];
  };
}

function memory(
  id: string,
  content: string,
  overrides: Partial<RecallableMemory> = {},
): RecallableMemory {
  return {
    id,
    content,
    kind: "episodic",
    importance: 0.35,
    confidence: 1,
    tags: [],
    status: "active",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "situational",
    createdAtUtc: MEMORY_EVALUATION_NOW,
    updatedAtUtc: MEMORY_EVALUATION_NOW,
    evidence: [
      {
        id: `evidence-${id}`,
        memoryId: id,
        sourceType: "message",
        sourceId: `message-${id}`,
        quote: content,
        recordedAtUtc: MEMORY_EVALUATION_NOW,
      },
    ],
    ...overrides,
  };
}

function scenario(
  id: string,
  description: string,
  query: string,
  memories: RecallableMemory[],
  options: Partial<
    Omit<MemoryRelevanceCase, "id" | "description" | "query" | "memories">
  > = {},
): MemoryRelevanceCase {
  return {
    id,
    description,
    query,
    memories,
    semanticScores: {},
    expected: {
      relevantMemoryIds: memories.map((item) => item.id),
      mentionableMemoryIds: memories.map((item) => item.id),
      forbiddenRecallMemoryIds: [],
      forbiddenUseMemoryIds: [],
    },
    ...options,
  };
}

function forbidden(id: string) {
  return {
    relevantMemoryIds: [],
    mentionableMemoryIds: [],
    forbiddenRecallMemoryIds: [id],
    forbiddenUseMemoryIds: [id],
  };
}

/** Synthetic mechanism probes with explicit labels, not a naturalness benchmark. */
export const MEMORY_RELEVANCE_CASES: MemoryRelevanceCase[] = [
  scenario(
    "paraphrase",
    "No shared lexical tokens; semantic recall must reach the use gate.",
    "How did that recruitment meeting go?",
    [memory("interview", "Yesterday's interview felt reassuring.")],
    { semanticScores: { interview: 0.96 } },
  ),
  scenario(
    "chinese-paraphrase",
    "Chinese paraphrase without shared bigrams.",
    "那场招聘交流感觉如何？",
    [memory("meeting", "昨天面试结束后心里踏实多了。")],
    { semanticScores: { meeting: 0.96 } },
  ),
  scenario(
    "lexical-unindexed",
    "A memory without a semantic signal stays in the lexical candidate pool.",
    "orchard harvest",
    [memory("harvest", "orchard harvest")],
  ),
  scenario(
    "identifier-collision",
    "A nearby project identifier cannot borrow semantic similarity.",
    "BGW-7419",
    [memory("correct", "BGW-7419"), memory("wrong", "BGW-7420")],
    {
      semanticScores: { correct: 0.9, wrong: 1 },
      expected: {
        relevantMemoryIds: ["correct"],
        mentionableMemoryIds: ["correct"],
        forbiddenRecallMemoryIds: ["wrong"],
        forbiddenUseMemoryIds: ["wrong"],
      },
    },
  ),
  scenario(
    "expired",
    "A perfect semantic score cannot revive an expired memory.",
    "orchard harvest",
    [
      memory("expired", "orchard harvest", {
        expiresAtUtc: "2026-09-09T00:00:00.000Z",
      }),
    ],
    { semanticScores: { expired: 1 }, expected: forbidden("expired") },
  ),
  scenario(
    "superseded",
    "A superseded fact stays excluded.",
    "orchard harvest",
    [memory("superseded", "orchard harvest", { status: "superseded" })],
    { semanticScores: { superseded: 1 }, expected: forbidden("superseded") },
  ),
  scenario(
    "namespace",
    "Semantic matching cannot cross an explicit namespace filter.",
    "orchard harvest",
    [memory("other", "orchard harvest", { namespace: "character_self" })],
    {
      semanticScores: { other: 1 },
      namespaces: ["user_model"],
      expected: forbidden("other"),
    },
  ),
  scenario(
    "no-evidence",
    "Similarity cannot replace a source record.",
    "orchard harvest",
    [memory("unsupported", "orchard harvest", { evidence: [] })],
    { semanticScores: { unsupported: 1 }, expected: forbidden("unsupported") },
  ),
  scenario(
    "withdrawn-use",
    "Turn-local withdrawal excludes every use even after recall.",
    "orchard harvest",
    [memory("withdrawn", "orchard harvest")],
    {
      semanticScores: { withdrawn: 1 },
      suppressedMemoryIds: ["withdrawn"],
      expected: {
        relevantMemoryIds: ["withdrawn"],
        mentionableMemoryIds: [],
        forbiddenRecallMemoryIds: [],
        forbiddenUseMemoryIds: ["withdrawn"],
      },
    },
  ),
  scenario(
    "recent-mention",
    "Recent mention retains background while preventing repetition.",
    "orchard harvest",
    [memory("recent", "orchard harvest")],
    {
      semanticScores: { recent: 1 },
      recentlyMentionedMemoryIds: ["recent"],
      expected: {
        relevantMemoryIds: ["recent"],
        mentionableMemoryIds: [],
        forbiddenRecallMemoryIds: [],
        forbiddenUseMemoryIds: [],
      },
    },
  ),
  scenario(
    "behavior-only",
    "Listening preference should affect behavior without being recited.",
    "just listen",
    [memory("listening", "just listen")],
    {
      semanticScores: { listening: 1 },
      expected: {
        relevantMemoryIds: ["listening"],
        mentionableMemoryIds: [],
        forbiddenRecallMemoryIds: [],
        forbiddenUseMemoryIds: [],
      },
    },
  ),
  scenario(
    "irrelevant-important",
    "Importance and recency alone do not justify explicit mention.",
    "orbital mechanics",
    [memory("unrelated", "orchard harvest", { importance: 1 })],
    {
      expected: {
        relevantMemoryIds: [],
        mentionableMemoryIds: [],
        forbiddenRecallMemoryIds: [],
        forbiddenUseMemoryIds: [],
      },
    },
  ),
];
