import type { LetterGenerationSnapshot } from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import {
  buildLetterReplyPrompt,
  deriveAllowedLetterReplyReferenceIds,
} from "./letter-prompt.js";
import { deriveLetterStrategy } from "./letter-strategy.js";

const ARRIVAL = "2026-09-08T12:00:00.000Z";
const PROCESSED = "2026-09-09T01:00:00.000Z";

const snapshot: LetterGenerationSnapshot = {
  id: "snapshot-prompt-1",
  incomingLetterId: "letter-incoming-1",
  agentId: "agent-1",
  effectiveAtUtc: ARRIVAL,
  characterVersion: 3,
  stateRevision: 8,
  contextJson: {
    schemaVersion: 1,
    effectiveAtUtc: ARRIVAL,
    sourceWindow: {
      fromUtc: "2026-09-03T12:00:00.000Z",
      throughUtc: ARRIVAL,
    },
    character: {
      version: 3,
      identity: { name: "林" },
      persona: { coreTraits: ["克制", "温暖"] },
      dialogue: { verbosity: 0.7 },
      userRelationship: { preferredAddress: "朋友" },
      knowledge: {},
    },
    runtimeState: { energy: 0.65 },
    relationship: { closeness: 0.7, trust: 0.8 },
    fuzzyLife: {
      dailyContext: { summary: "抵达日前的生活" },
      intents: [{ text: "也许去散步", status: "planned" }],
      threads: [],
      verifiedOutcomes: [],
      causalRecords: [],
    },
    intervalDigest: { activityEvents: [], lifeOutcomes: [] },
    memoryEvidence: [{ id: "evidence-before-arrival", fact: "旧日散步" }],
    conversationTail: [],
    priorCorrespondence: [],
    readyKeepsakes: [
      {
        id: "keepsake-before-arrival",
        recordType: "keepsake",
        title: "雨夜票根",
        kind: "ticket_stub",
        description: "一起看完电影后留下的票根。",
        sourceEventIds: ["milestone-before-arrival"],
        sourceMemoryIds: [],
        sourceLetterIds: [],
        createdEffectiveAtUtc: "2026-09-06T12:00:00.000Z",
        readyAtUtc: "2026-09-07T12:00:00.000Z",
      },
    ],
    budgets: { maxEvidenceItems: 20 },
  },
  evidenceIds: [
    "evidence-before-arrival",
    "keepsake-before-arrival",
    "milestone-before-arrival",
  ],
  contextHash: "a".repeat(64),
  createdAtUtc: PROCESSED,
};

describe("buildLetterReplyPrompt", () => {
  it("uses the arrival snapshot without leaking processing time or live future facts", () => {
    const built = buildLetterReplyPrompt({
      snapshot,
      incomingLetter: {
        id: snapshot.incomingLetterId,
        subject: "九月来信",
        body: "等你读到时，我大概已经出发了。",
        contentHash: "b".repeat(64),
      },
      strategy: deriveLetterStrategy("等你读到时，我大概已经出发了。"),
      postmark: "上海 · 9月8日",
    });

    expect(built.system).toContain(`LETTER_ARRIVAL_EFFECTIVE_TIME=${ARRIVAL}`);
    expect(built.system).toContain("A plan is not an outcome");
    expect(built.system).toContain("complete correspondence letter");
    expect(built.prompt).toContain(ARRIVAL);
    expect(built.prompt).toContain("evidence-before-arrival");
    expect(built.prompt).toContain("keepsake-before-arrival");
    expect(built.prompt).toContain("雨夜票根");
    expect(built.prompt).not.toContain(PROCESSED);
    expect(built.prompt).not.toContain("future-evidence-from-september-9");

    const parsed = JSON.parse(built.prompt) as Record<string, unknown>;
    expect(parsed["ALLOWED_REFERENCED_EVIDENCE_IDS"]).toEqual([
      ...snapshot.evidenceIds,
      snapshot.incomingLetterId,
    ]);
    expect(
      (parsed["SNAPSHOT_EVIDENCE"] as Record<string, unknown>)["evidenceIds"],
    ).toEqual(snapshot.evidenceIds);
  });

  it("serializes stable named prompt sections and keeps strategy non-factual", () => {
    const built = buildLetterReplyPrompt({
      snapshot,
      incomingLetter: {
        id: snapshot.incomingLetterId,
        body: "见字如面。",
        contentHash: "b".repeat(64),
      },
      strategy: deriveLetterStrategy("见字如面。"),
    });
    const parsed = JSON.parse(built.prompt) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual([
      "ALLOWED_REFERENCED_EVIDENCE_IDS",
      "ARRIVAL_TIME_AND_POSTMARK",
      "CHARACTER_SPEC_COMPACT",
      "LETTER_ARRIVAL_EFFECTIVE_TIME",
      "LETTER_STRATEGY",
      "LIFE_INTERVAL_DIGEST",
      "PRIOR_CORRESPONDENCE_SUMMARY",
      "RELATIONSHIP_SNAPSHOT",
      "RUNTIME_STATE_AT_ARRIVAL",
      "SNAPSHOT_EVIDENCE",
      "USER_LETTER",
    ]);
    expect(parsed["LETTER_STRATEGY"]).not.toHaveProperty("facts");
  });

  it("derives the current letter reference without duplicating snapshot evidence", () => {
    expect(deriveAllowedLetterReplyReferenceIds(snapshot)).toEqual([
      ...snapshot.evidenceIds,
      snapshot.incomingLetterId,
    ]);
    expect(
      deriveAllowedLetterReplyReferenceIds({
        incomingLetterId: "letter-incoming-1",
        evidenceIds: ["evidence-1", "letter-incoming-1"],
      }),
    ).toEqual(["evidence-1", "letter-incoming-1"]);
  });

  it("uses frozen finite practices while keeping raw adaptation text, provenance and suppressed memory out of model input", () => {
    const effectivePersona = {
      policyVersion: "scoped_practice_v1",
      agentId: snapshot.agentId,
      baseCharacterVersion: snapshot.characterVersion,
      revision: 7,
      memoryRevision: 13,
      persona: {
        traits: [
          {
            id: "trait_warm",
            name: "温暖",
            description: "愿意倾听",
            strength: 0.6,
            triggers: [],
            exceptions: [],
            origin: "user_spec",
            sourceRefs: [],
          },
        ],
        values: [
          {
            id: "value_truth",
            name: "诚实",
            description: "忠于事实",
            priority: 0.8,
            exceptions: [],
            origin: "user_spec",
            sourceRefs: [],
          },
        ],
        contradictions: [],
        goals: [],
        preferences: [],
        boundaries: [],
      },
      dialogue: {
        primaryLanguage: "zh-CN",
        formality: 0.4,
        directness: 0.6,
        warmth: 0.7,
        verbosity: 0.5,
        humor: 0.3,
        averageMessageLength: 150,
        averageChunksPerTurn: 1,
        frequentPhrases: [],
        avoidedPhrases: [],
        greetingPatterns: [],
        refusalPatterns: [],
        comfortingPatterns: [],
      },
      relationshipPractices: [
        {
          id: "practice_at_arrival",
          agentId: snapshot.agentId,
          baseCharacterVersion: snapshot.characterVersion,
          revision: 7,
          proposal: {
            kind: "relationship_practice",
            facet: "advice_timing",
            practice: "listen_first",
            scope: { userId: "local_user", topic: "工作" },
            content: "RAW_PERSONA_REQUEST_MUST_NOT_BECOME_A_PROMPT_INSTRUCTION",
          },
          sourceMessageId: "raw_persona_source_message",
          sources: [
            {
              sourceType: "message",
              sourceId: "raw_persona_source_message",
              sourceHash: "d".repeat(64),
            },
            {
              sourceType: "memory",
              sourceId: "raw_persona_source_memory",
              sourceHash: "e".repeat(64),
            },
          ],
          status: "accepted",
          effectiveFromUtc: "2026-09-07T12:00:00.000Z",
          policyVersion: "scoped_practice_v1",
        },
      ],
      excludedAdaptationIds: [],
      suppressedMemoryIds: ["suppressed_preference"],
    };
    const frozen: LetterGenerationSnapshot = {
      ...snapshot,
      evidenceIds: [
        ...snapshot.evidenceIds,
        "suppressed_preference",
        "suppressed_preference_alias",
      ],
      contextJson: {
        ...snapshot.contextJson,
        effectivePersona,
        memoryEvidence: [
          ...snapshot.contextJson.memoryEvidence,
          {
            id: "suppressed_preference",
            content: "SUPPRESSED_MEMORY_MUST_NOT_RESTORE_WITHDRAWN_PRACTICE",
          },
          {
            id: "suppressed_preference_alias",
            memoryId: "suppressed_preference",
            content: "SUPPRESSED_MEMORY_ALIAS_MUST_NOT_REMAIN_CITABLE",
          },
        ],
      },
    };
    const before = JSON.stringify(frozen);
    const built = buildLetterReplyPrompt({
      snapshot: frozen,
      incomingLetter: {
        id: snapshot.incomingLetterId,
        body: "工作有点烦恼，给你写信。",
        contentHash: "b".repeat(64),
      },
      strategy: deriveLetterStrategy("工作有点烦恼，给你写信。"),
    });
    const parsed = JSON.parse(built.prompt) as Record<string, unknown>;
    expect(parsed["EFFECTIVE_PERSONA_AT_ARRIVAL"]).toMatchObject({
      baseCharacterVersion: 3,
      revision: 7,
      memoryRevision: 13,
      relationshipPractices: [
        {
          id: "practice_at_arrival",
          facet: "advice_timing",
          practice: "listen_first",
          scope: { userId: "local_user", topic: "工作" },
        },
      ],
    });
    expect(built.prompt).not.toContain(
      "RAW_PERSONA_REQUEST_MUST_NOT_BECOME_A_PROMPT_INSTRUCTION",
    );
    expect(built.prompt).not.toContain("raw_persona_source_message");
    expect(built.prompt).not.toContain("raw_persona_source_memory");
    expect(built.prompt).not.toContain("suppressed_preference");
    expect(built.prompt).not.toContain(
      "SUPPRESSED_MEMORY_MUST_NOT_RESTORE_WITHDRAWN_PRACTICE",
    );
    expect(built.prompt).not.toContain(
      "SUPPRESSED_MEMORY_ALIAS_MUST_NOT_REMAIN_CITABLE",
    );
    expect(deriveAllowedLetterReplyReferenceIds(frozen)).toEqual([
      ...snapshot.evidenceIds,
      snapshot.incomingLetterId,
    ]);
    expect(parsed["ALLOWED_REFERENCED_EVIDENCE_IDS"]).toEqual(
      deriveAllowedLetterReplyReferenceIds(frozen),
    );
    expect(
      (parsed["SNAPSHOT_EVIDENCE"] as Record<string, unknown>)["evidenceIds"],
    ).toEqual(snapshot.evidenceIds);
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it("fails closed when the prompt letter does not match the snapshot", () => {
    expect(() =>
      buildLetterReplyPrompt({
        snapshot,
        incomingLetter: {
          id: "letter-different",
          body: "这不是快照对应的信。",
          contentHash: "c".repeat(64),
        },
        strategy: deriveLetterStrategy("这不是快照对应的信。"),
      }),
    ).toThrow("Incoming letter must match the immutable arrival snapshot");
  });
});
