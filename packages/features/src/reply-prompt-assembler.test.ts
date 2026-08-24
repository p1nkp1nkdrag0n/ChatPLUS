import {
  PersonaChatResponseSchema,
  type AgentAutobiographySnapshot,
  type CharacterSpec,
  type ContextPlan,
  type EvidenceBundle,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import {
  assembleReplyPrompt,
  type AssembleReplyPromptInput,
} from "./reply-prompt-assembler.js";
import type { MemoryLike } from "./memory-engine.js";
import type { ScheduleItemLike } from "./schedule-validator.js";

const NOW = "2026-08-23T08:00:00.000Z";
const UNIQUE_GOAL_TOKEN = "CITRINE_GOAL_7Q9";

function characterFixture(): CharacterSpec {
  return {
    id: "character-1",
    version: 3,
    tier: "daily",
    sourceType: "original",
    identity: {
      name: "Lin",
      workOrRole: "designer",
      worldSetting: "a contemporary city",
      selfDescription: `quietly finishing ${UNIQUE_GOAL_TOKEN}`,
      timezone: "Asia/Shanghai",
    },
    persona: {
      traits: [
        { id: "trait-1", name: "observant", strength: 0.9 },
        { id: "trait-2", name: "playful", strength: 0.7 },
      ],
      values: [
        { id: "value-1", name: "craft", description: UNIQUE_GOAL_TOKEN },
      ],
      contradictions: [{ id: "contradiction-1", sideB: UNIQUE_GOAL_TOKEN }],
      goals: [
        {
          id: "goal-1",
          title: UNIQUE_GOAL_TOKEN,
          description: UNIQUE_GOAL_TOKEN,
        },
      ],
      preferences: [
        { id: "preference-1", subject: "jazz", preference: "quiet jazz" },
      ],
      boundaries: [
        {
          id: "boundary-1",
          condition: "private request",
          forbiddenBehavior: "reveal private data",
          responsePattern: "decline",
          hard: true,
        },
      ],
    },
    dialogue: {
      primaryLanguage: "zh-CN",
      formality: 0.3,
      directness: 0.7,
      warmth: 0.8,
      verbosity: 0.4,
      humor: 0.4,
      averageMessageLength: 100,
      averageChunksPerTurn: 1,
      frequentPhrases: [],
      avoidedPhrases: [],
      greetingPatterns: [],
      refusalPatterns: [],
      comfortingPatterns: [],
    },
    userRelationship: {
      relationshipType: "friend",
      initialCloseness: 0.5,
      initialTrust: 0.5,
      addressTerms: [],
      sharedContext: "",
    },
    routines: [{ id: "routine-1", title: UNIQUE_GOAL_TOKEN }],
    schedulePolicy: {},
    proactivePolicy: {},
    knowledge: {
      knownFacts: [`known ${UNIQUE_GOAL_TOKEN}`],
      uncertainFacts: [],
      forbiddenMetaKnowledge: ["system internals"],
    },
  } as unknown as CharacterSpec;
}

function contextPlan(overrides: Partial<ContextPlan> = {}): ContextPlan {
  return {
    schemaVersion: 1,
    activatedTraitIds: [],
    activatedValueIds: [],
    activatedContradictionIds: [],
    activatedGoalIds: [],
    activatedPreferenceIds: [],
    includeAutobiography: false,
    includeCalendar: false,
    includeFutureSchedule: false,
    includeRetrievedEvidence: false,
    suppressedGoalIds: ["goal-1"],
    topicFatigue: [
      {
        topicKey: UNIQUE_GOAL_TOKEN,
        recentAssistantMentions: 4,
        penalty: 0.6,
      },
    ],
    trace: [],
    ...overrides,
  };
}

function futureSchedule(): ScheduleItemLike[] {
  return [
    {
      id: "schedule-private-id",
      agentId: "character-1",
      title: "FUTURE_SCHEDULE_MARKER",
      description: "future item",
      category: "work",
      startAtUtc: "2026-08-24T08:00:00.000Z",
      endAtUtc: "2026-08-24T09:00:00.000Z",
      timezone: "Asia/Shanghai",
      rigidity: "flexible",
      priority: 0.5,
      source: "manual",
      adherenceProbability: 0.8,
      narrativeImportance: 0.5,
      shareable: true,
      stateEffects: {},
      status: "planned",
      revision: 1,
      createdAtUtc: NOW,
      updatedAtUtc: NOW,
    },
  ];
}

function autobiography(): AgentAutobiographySnapshot {
  return {
    id: "autobiography-1",
    agentId: "character-1",
    sourceCheckpointId: "checkpoint-1",
    revision: 1,
    summaryFirstPerson: "AUTOBIOGRAPHY_MARKER",
    importantExperiences: [],
    relationshipChanges: [],
    activeGoals: [UNIQUE_GOAL_TOKEN],
    unresolvedThreads: [],
    commitments: [],
    sourceEvidenceIds: ["evidence-1"],
    fromUtc: "2026-08-01T00:00:00.000Z",
    throughUtc: NOW,
    createdAtUtc: NOW,
  };
}

function evidenceBundle(): EvidenceBundle {
  return {
    query: "memory",
    mode: "verbatim_quote",
    generatedAtUtc: NOW,
    score: 0.9,
    evidence: [
      {
        memoryId: "memory-1",
        memoryContent: "RETRIEVED_EVIDENCE_MARKER",
        memoryKind: "semantic",
        namespace: "shared_relationship",
        certainty: "explicit",
        attribution: "user_explicit",
        stability: "stable",
        evidence: {
          id: "evidence-1",
          memoryId: "memory-1",
          sourceType: "message",
          sourceId: "message-1",
          quote: "RETRIEVED_EVIDENCE_MARKER",
          recordedAtUtc: NOW,
        },
        score: 0.9,
        scoreBreakdown: {
          lexical: 1,
          tag: 0,
          importance: 0.8,
          recency: 0.8,
          temporal: 0.5,
          namespace: 1,
        },
      },
    ],
  };
}

function memoryFixture(index: number): MemoryLike {
  return {
    id: `PRIVATE_MEMORY_ID_${index}`,
    agentId: "character-1",
    kind: "semantic",
    content: `LEGACY_MEMORY_${index}_` + "x".repeat(500),
    importance: 0.8,
    confidence: 0.9,
    tags: ["private-tag"],
    sourceMessageIds: [`PRIVATE_MESSAGE_ID_${index}`],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    status: "active",
    dedupeKey: `memory-${index}`,
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  };
}

function referenceContext(prompt: string): {
  relevantMemories: Array<Record<string, unknown>>;
} {
  const lines = prompt.split("\n");
  const index = lines.indexOf("REFERENCE_CONTEXT_JSON");
  if (index < 0) throw new Error("Missing REFERENCE_CONTEXT_JSON");
  return JSON.parse(lines[index + 1] ?? "") as {
    relevantMemories: Array<Record<string, unknown>>;
  };
}

function baseInput(
  overrides: Partial<AssembleReplyPromptInput> = {},
): AssembleReplyPromptInput {
  const input: AssembleReplyPromptInput = {
    character: characterFixture(),
    state: {
      agentId: "character-1",
      asOfUtc: NOW,
      moodValence: 0.1,
      moodArousal: 0.4,
      energy: 0.6,
      stress: 0.2,
      socialBattery: 0.7,
      focus: 0.8,
      relationship: {
        userId: "user-1",
        closeness: 0.6,
        trust: 0.7,
        familiarity: 0.5,
        recentInteractionValence: 0.2,
      },
      revision: 1,
    },
    schedule: [],
    memories: [],
    recentMessages: [{ role: "assistant", content: "Earlier small talk." }],
    nowUtc: NOW,
    userMessage: "今天天气怎么样？",
    contextPlan: contextPlan(),
    personaContextMode: "enforced",
    validatedOutcome: {
      route: "conversation",
      scheduleOutcome: { kind: "none" },
      stateChanged: false,
      replyDirectives: {
        mode: "answer",
        mustAddressUserQuotes: ["今天天气怎么样？"],
        authoritativeFacts: [],
        mustNotClaim: ["future_action_guaranteed"],
      },
      proposalRejections: [],
    },
    replyStrategy: {
      complexity: "standard",
      targetMinChars: 40,
      targetChars: 80,
      targetMaxChars: 160,
      maxOutputTokens: 500,
      deliveryPreference: "prefer_single_block",
      preferredChunkCount: 1,
      lengthGuidance: "Stay proportionate.",
      deliveryGuidance: "Choose a natural delivery.",
    },
  };
  return { ...input, ...overrides };
}

describe("assembleReplyPrompt", () => {
  it("keeps legacy and shadow persona modes on the full legacy compaction", () => {
    const enforcedBase = baseInput({
      contextPlan: contextPlan({
        activatedGoalIds: ["goal-1"],
        suppressedGoalIds: [],
      }),
      autobiography: autobiography(),
      calendarContext: [
        {
          ref: "calendar_1",
          scope: "public_system",
          label: "CALENDAR_MARKER",
          localDate: "2026-08-24",
          allDay: true,
        },
      ],
      schedule: futureSchedule(),
      memoryEvidence: evidenceBundle(),
    });
    const defaultLegacyInput = { ...enforcedBase };
    delete defaultLegacyInput.personaContextMode;
    const defaultLegacy = assembleReplyPrompt(defaultLegacyInput);
    const legacy = assembleReplyPrompt({
      ...enforcedBase,
      personaContextMode: "legacy",
    });
    const shadow = assembleReplyPrompt({
      ...enforcedBase,
      personaContextMode: "shadow",
    });

    for (const result of [defaultLegacy, legacy, shadow]) {
      expect(result.system + result.prompt).toContain(UNIQUE_GOAL_TOKEN);
      expect(result.system).toContain("selfDescription");
      expect(result.system + result.prompt).toContain("VALUES_CONFLICTS_JSON");
      expect(result.prompt).toContain("REFERENCE_CONTEXT_JSON");
      expect(result.prompt).not.toContain("ACTIVATED_PERSONA_JSON");
      expect(result.prompt).not.toContain("TOPIC_FATIGUE_JSON");
      expect(result.prompt).toContain("AUTOBIOGRAPHY_MARKER");
      expect(result.prompt).toContain("CALENDAR_MARKER");
      expect(result.prompt).toContain("FUTURE_SCHEDULE_MARKER");
      expect(result.prompt).toContain("RETRIEVED_EVIDENCE_MARKER");
    }
    expect(shadow.system).toBe(legacy.system);
    expect(shadow.prompt).toBe(legacy.prompt);
  });

  it("bounds legacy active memories and lets EvidenceBundle replace them", () => {
    const memories = Array.from({ length: 25 }, (_, index) =>
      memoryFixture(index),
    );
    const legacy = assembleReplyPrompt(
      baseInput({ personaContextMode: "legacy", memories }),
    );
    const defaultMemories = referenceContext(legacy.prompt).relevantMemories;

    expect(defaultMemories).toHaveLength(12);
    expect(defaultMemories[0]).toMatchObject({
      kind: "semantic",
      importance: 0.8,
      confidence: 0.9,
      createdAtUtc: NOW,
    });
    const firstMemoryContent = defaultMemories[0]?.["content"];
    if (typeof firstMemoryContent !== "string") {
      throw new Error("Expected compacted memory content");
    }
    expect(firstMemoryContent).toMatch(/^LEGACY_MEMORY_0_/u);
    expect(firstMemoryContent).toHaveLength(360);
    expect(legacy.prompt).not.toContain("PRIVATE_MEMORY_ID_0");
    expect(legacy.prompt).not.toContain("PRIVATE_MESSAGE_ID_0");
    expect(legacy.prompt).not.toContain("LEGACY_MEMORY_12_");

    const upperBound = assembleReplyPrompt(
      baseInput({
        personaContextMode: "shadow",
        memories,
        maxMemories: 100,
      }),
    );
    expect(referenceContext(upperBound.prompt).relevantMemories).toHaveLength(
      20,
    );

    const evidenceReplacesLegacy = assembleReplyPrompt(
      baseInput({
        personaContextMode: "legacy",
        memories,
        memoryEvidence: evidenceBundle(),
      }),
    );
    expect(
      referenceContext(evidenceReplacesLegacy.prompt).relevantMemories,
    ).toEqual([]);
    expect(evidenceReplacesLegacy.prompt).toContain(
      "RETRIEVED_EVIDENCE_MARKER",
    );

    const enforced = assembleReplyPrompt(
      baseInput({ memories, personaContextMode: "enforced" }),
    );
    expect(referenceContext(enforced.prompt).relevantMemories).toHaveLength(12);
    expect(enforced.prompt).toContain("LEGACY_MEMORY_0_");
    expect(enforced.prompt).not.toContain("LEGACY_MEMORY_12_");
    expect(enforced.prompt).not.toContain("selfDescription");
    expect(enforced.prompt).not.toContain(UNIQUE_GOAL_TOKEN);

    const enforcedEvidenceReplacesLegacy = assembleReplyPrompt(
      baseInput({
        memories,
        memoryEvidence: evidenceBundle(),
        personaContextMode: "enforced",
        contextPlan: contextPlan({ includeRetrievedEvidence: true }),
      }),
    );
    expect(enforcedEvidenceReplacesLegacy.prompt).not.toContain(
      "LEGACY_MEMORY_",
    );
    expect(enforcedEvidenceReplacesLegacy.prompt).not.toContain(
      "REFERENCE_CONTEXT_JSON",
    );
    expect(enforcedEvidenceReplacesLegacy.prompt).toContain(
      "RETRIEVED_EVIDENCE_MARKER",
    );
  });

  it("advertises only the PersonaChatResponse fields", () => {
    const result = assembleReplyPrompt(baseInput());
    const lines = result.prompt.split("\n");
    const contractIndex = lines.indexOf("OUTPUT_CONTRACT_JSON");
    const contract = JSON.parse(lines[contractIndex + 1] ?? "") as Record<
      string,
      unknown
    >;

    expect(Object.keys(contract).sort()).toEqual([
      "chunks",
      "deliveryMode",
      "text",
      "toneTags",
    ]);
    expect(() => PersonaChatResponseSchema.parse(contract)).not.toThrow();
    expect(result.system + result.prompt).not.toContain("replyDecision");
    expect(result.system + result.prompt).not.toContain("worldEffects");
    expect(result.system + result.prompt).not.toContain("scheduleAction");
    expect(result.segmentTrace.segments.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "13b_activated_persona",
        "13c_topic_fatigue",
        "16a_validated_turn_outcome",
      ]),
    );
  });

  it("does not leak a suppressed goal duplicated across character stores", () => {
    const result = assembleReplyPrompt(
      baseInput({
        schedule: futureSchedule().map((item) => ({
          ...item,
          title: UNIQUE_GOAL_TOKEN,
        })),
        autobiography: autobiography(),
        memoryEvidence: {
          ...evidenceBundle(),
          evidence: evidenceBundle().evidence.map((item) => ({
            ...item,
            memoryContent: UNIQUE_GOAL_TOKEN,
          })),
        },
        calendarContext: [
          {
            ref: "calendar_1",
            scope: "public_system",
            label: UNIQUE_GOAL_TOKEN,
            localDate: "2026-08-24",
            allDay: true,
          },
        ],
      }),
    );

    expect(result.system + result.prompt).not.toContain(UNIQUE_GOAL_TOKEN);
    expect(result.system + result.prompt).toContain("contemporary city");
    expect(result.prompt).not.toContain("ACTIVATED_PERSONA_JSON");
  });

  it("injects a directly activated goal without restoring the full persona", () => {
    const result = assembleReplyPrompt(
      baseInput({
        contextPlan: contextPlan({
          activatedGoalIds: ["goal-1"],
          suppressedGoalIds: [],
        }),
      }),
    );

    expect(result.prompt).toContain("ACTIVATED_PERSONA_JSON");
    expect(result.prompt).toContain(UNIQUE_GOAL_TOKEN);
    expect(result.prompt).not.toContain("known " + UNIQUE_GOAL_TOKEN);
  });

  it("enforces autobiography, calendar, future schedule and evidence gates", () => {
    const optionalInput = {
      autobiography: autobiography(),
      calendarContext: [
        {
          ref: "calendar_1" as const,
          scope: "public_system" as const,
          label: "CALENDAR_MARKER",
          localDate: "2026-08-24",
          allDay: true,
        },
      ],
      schedule: futureSchedule(),
      memoryEvidence: evidenceBundle(),
    };
    const gatedOff = assembleReplyPrompt(baseInput(optionalInput));
    for (const marker of [
      "AUTOBIOGRAPHY_MARKER",
      "CALENDAR_MARKER",
      "FUTURE_SCHEDULE_MARKER",
      "RETRIEVED_EVIDENCE_MARKER",
    ]) {
      expect(gatedOff.prompt).not.toContain(marker);
    }
    expect(gatedOff.prompt).not.toContain("AUTOBIOGRAPHY_JSON");
    expect(gatedOff.prompt).not.toContain("CALENDAR_CONTEXT_JSON");
    expect(gatedOff.prompt).not.toContain("FUTURE_SCHEDULE_JSON");
    expect(gatedOff.prompt).not.toContain("RETRIEVED_EVIDENCE_JSON");

    const gatedOn = assembleReplyPrompt(
      baseInput({
        ...optionalInput,
        contextPlan: contextPlan({
          includeAutobiography: true,
          includeCalendar: true,
          includeFutureSchedule: true,
          includeRetrievedEvidence: true,
        }),
      }),
    );
    for (const marker of [
      "AUTOBIOGRAPHY_MARKER",
      "CALENDAR_MARKER",
      "FUTURE_SCHEDULE_MARKER",
      "RETRIEVED_EVIDENCE_MARKER",
    ]) {
      expect(gatedOn.prompt).toContain(marker);
    }
  });

  it("places a sanitized validated outcome near the tail as required context", () => {
    const result = assembleReplyPrompt(
      baseInput({
        validatedOutcome: {
          route: "schedule_mutation",
          scheduleOutcome: {
            kind: "needs_clarification",
            missingFields: ["time"],
          },
          stateChanged: false,
          replyDirectives: {
            mode: "clarify",
            mustAddressUserQuotes: ["一起吃饭"],
            authoritativeFacts: [
              {
                kind: "schedule",
                text: "AUTHORITATIVE_FACT_MARKER",
                sourceId: "PRIVATE_SOURCE_ID",
              },
            ],
            mustNotClaim: ["schedule_committed"],
            presentationText: "Please ask when.",
          },
          proposalRejections: [{ reasonCode: "missing_time" }],
        },
      }),
    );
    const outcomeTrace = result.segmentTrace.segments.find(
      (item) => item.id === "16a_validated_turn_outcome",
    );

    expect(outcomeTrace).toMatchObject({
      included: true,
      required: true,
      priority: 100,
    });
    expect(result.prompt).toContain("AUTHORITATIVE_FACT_MARKER");
    expect(result.prompt).not.toContain("PRIVATE_SOURCE_ID");
    expect(result.prompt.indexOf("CURRENT_USER_MESSAGE_JSON")).toBeLessThan(
      result.prompt.indexOf("VALIDATED_TURN_OUTCOME_JSON"),
    );
    expect(result.prompt.indexOf("VALIDATED_TURN_OUTCOME_JSON")).toBeLessThan(
      result.prompt.indexOf("OUTPUT_CONTRACT_JSON"),
    );
    expect(
      result.segmentTrace.segments.find(
        (item) => item.id === "08_runtime_state",
      ),
    ).toMatchObject({ included: true, required: true, priority: 98 });
  });

  it("keeps a targeted schedule query from seeing unrelated future or calendar items", () => {
    const result = assembleReplyPrompt(
      baseInput({
        schedule: futureSchedule(),
        calendarContext: [
          {
            ref: "calendar_1",
            scope: "public_system",
            label: "UNRELATED_CALENDAR_MARKER",
            localDate: "2026-08-24",
            allDay: true,
          },
        ],
        contextPlan: contextPlan({
          activatedGoalIds: ["goal-1"],
          suppressedGoalIds: [],
          includeCalendar: true,
          includeFutureSchedule: true,
        }),
        validatedOutcome: {
          ...baseInput().validatedOutcome,
          route: "schedule_query",
          scheduleOutcome: { kind: "read_only" },
          replyDirectives: {
            ...baseInput().validatedOutcome.replyDirectives,
            authoritativeFacts: [
              {
                kind: "schedule",
                text: "2026-08-26 16:00–16:45，北岸书店喝茶。",
                requiredAnchors: ["北岸书店", "16:00", "16:45"],
              },
            ],
          },
        },
      }),
    );

    expect(result.prompt).toContain("北岸书店");
    expect(result.prompt).not.toContain("FUTURE_SCHEDULE_MARKER");
    expect(result.prompt).not.toContain("UNRELATED_CALENDAR_MARKER");
    expect(result.prompt).not.toContain("FUTURE_SCHEDULE_JSON");
    expect(result.prompt).not.toContain("CALENDAR_CONTEXT_JSON");
    expect(result.prompt).not.toContain(UNIQUE_GOAL_TOKEN);
  });

  it("keeps a recent settled-activity answer from seeing a different current activity", () => {
    const currentActivity: ScheduleItemLike = {
      ...futureSchedule()[0]!,
      id: "schedule-current-goal",
      title: "CURRENT_GOAL_ACTIVITY_MARKER",
      startAtUtc: "2026-08-23T07:55:00.000Z",
      endAtUtc: "2026-08-23T09:00:00.000Z",
      status: "in_progress",
      source: "self_initiated",
    };
    const result = assembleReplyPrompt(
      baseInput({
        state: {
          ...baseInput().state,
          currentActivityId: currentActivity.id,
        },
        schedule: [currentActivity],
        userMessage: "刚才那项活动结束了吗？",
        contextPlan: contextPlan({ includeFutureSchedule: true }),
        validatedOutcome: {
          ...baseInput().validatedOutcome,
          replyDirectives: {
            ...baseInput().validatedOutcome.replyDirectives,
            authoritativeFacts: [
              {
                kind: "activity",
                text: "最近一次已结算活动“早晨创作时间”已经结束，结果为已完成。",
                sourceId: "event-private-completed",
                activityEventType: "completed",
                requiredAnchors: ["早晨创作时间", "已完成"],
              },
            ],
          },
        },
      }),
    );

    expect(result.prompt).toContain("早晨创作时间");
    expect(result.prompt).toContain('"activityEventType":"completed"');
    expect(result.prompt).not.toContain("event-private-completed");
    expect(result.prompt).not.toContain("CURRENT_GOAL_ACTIVITY_MARKER");
    expect(result.prompt).not.toContain("CURRENT_ACTIVITY_JSON");
    expect(result.prompt).not.toContain("FUTURE_SCHEDULE_JSON");
  });

  it("drops the previous topic after an explicit user switch", () => {
    const result = assembleReplyPrompt(
      baseInput({
        userMessage: "好，先不聊这个了。最近上海晚上是不是凉一点了？",
        recentMessages: [
          {
            role: "assistant",
            content: `刚才仍在讨论 ${UNIQUE_GOAL_TOKEN}`,
          },
        ],
      }),
    );

    expect(result.prompt).not.toContain(`刚才仍在讨论 ${UNIQUE_GOAL_TOKEN}`);
    expect(result.prompt).toContain('"topicSwitch":true');
  });

  it("drops prior context and forbids extension questions after an explicit stop", () => {
    const result = assembleReplyPrompt(
      baseInput({
        userMessage: "现在好一点了，我不想继续谈这件事。",
        recentMessages: [
          {
            role: "assistant",
            content: `继续追问 ${UNIQUE_GOAL_TOKEN}`,
          },
        ],
      }),
    );

    expect(result.prompt).not.toContain(`继续追问 ${UNIQUE_GOAL_TOKEN}`);
    expect(result.prompt).toContain('"topicSwitch":true');
    expect(result.prompt).toContain('"forbidFollowUpQuestions":true');
    expect(result.system).toContain(
      "end the reply without asking any question",
    );
  });

  it("makes selected evidence the only user-fact source in evidence-only mode", () => {
    const base = baseInput();
    const result = assembleReplyPrompt(
      baseInput({
        personaContextMode: "legacy",
        schedule: futureSchedule(),
        memories: [memoryFixture(1)],
        memoryEvidence: evidenceBundle(),
        autobiography: autobiography(),
        calendarContext: [
          {
            ref: "calendar_1",
            scope: "public_system",
            label: "UNRELATED_CALENDAR_MARKER",
            localDate: "2026-08-24",
            allDay: true,
          },
        ],
        recentMessages: [
          {
            role: "user",
            content: "HYPOTHETICAL_DOG_MARKER",
          },
        ],
        contextPlan: contextPlan({
          activatedGoalIds: ["goal-1"],
          suppressedGoalIds: [],
          includeAutobiography: true,
          includeCalendar: true,
          includeFutureSchedule: true,
          includeRetrievedEvidence: true,
        }),
        validatedOutcome: {
          ...base.validatedOutcome,
          replyDirectives: {
            ...base.validatedOutcome.replyDirectives,
            evidenceOnly: true,
            mustAbstain: false,
            mustNotInferFromPersona: true,
            allowedEvidenceIds: ["evidence-1"],
          },
        },
      }),
    );

    expect(result.system).toContain("evidence-only answer");
    expect(result.prompt).toContain("RETRIEVED_EVIDENCE_MARKER");
    expect(result.prompt).toContain('"allowedEvidenceIds":["evidence-1"]');
    for (const forbidden of [
      "HYPOTHETICAL_DOG_MARKER",
      "LEGACY_MEMORY_1_",
      "AUTOBIOGRAPHY_MARKER",
      "UNRELATED_CALENDAR_MARKER",
      "FUTURE_SCHEDULE_MARKER",
      UNIQUE_GOAL_TOKEN,
    ]) {
      expect(result.system + result.prompt).not.toContain(forbidden);
    }
  });

  it("prevents persona inference for a selected-evidence factual recall", () => {
    const base = baseInput();
    const result = assembleReplyPrompt(
      baseInput({
        personaContextMode: "legacy",
        memoryEvidence: evidenceBundle(),
        recentMessages: [
          { role: "assistant", content: "HYPOTHETICAL_DOG_MARKER" },
        ],
        contextPlan: contextPlan({
          activatedGoalIds: ["goal-1"],
          suppressedGoalIds: [],
          includeRetrievedEvidence: true,
        }),
        validatedOutcome: {
          ...base.validatedOutcome,
          replyDirectives: {
            ...base.validatedOutcome.replyDirectives,
            evidenceOnly: false,
            mustAbstain: false,
            mustNotInferFromPersona: true,
            allowedEvidenceIds: ["evidence-1"],
          },
        },
      }),
    );

    expect(result.system).toContain("do not infer from the character persona");
    expect(result.prompt).toContain("RETRIEVED_EVIDENCE_MARKER");
    expect(result.system + result.prompt).not.toContain(
      "HYPOTHETICAL_DOG_MARKER",
    );
    expect(result.system + result.prompt).not.toContain(UNIQUE_GOAL_TOKEN);
  });
});
