import { describe, expect, it } from "vitest";

import {
  assembleChatPrompt,
  type AssemblePromptInput,
} from "./prompt-assembler.js";
import {
  DEFAULT_PROMPT_SEGMENT_IDS,
  estimatePromptTokens,
} from "./prompt-segments/index.js";

const NOW = "2026-08-21T12:00:00.000Z";

function baseInput(
  overrides: Partial<AssemblePromptInput> = {},
): AssemblePromptInput {
  const input: AssemblePromptInput = {
    character: {
      id: "agent-private-id",
      tier: "high_fidelity",
      sourceType: "structured",
      identity: {
        name: "Lin",
        workOrRole: "student",
        worldSetting: "a contemporary city",
        selfDescription: "steady and observant",
        timezone: "Asia/Shanghai",
      },
      persona: {
        traits: ["steady"],
        values: ["honesty"],
        contradictions: ["independent but caring"],
        goals: ["finish the term well"],
        preferences: ["quiet walks"],
        boundaries: ["do not invent completed actions"],
      },
      dialogue: {
        register: "warm and concise",
        vocabulary: "everyday",
        avoidedPhrases: ["as an AI"],
      },
      userRelationship: { relationshipType: "friend" },
      routines: [],
      schedulePolicy: {},
      proactivePolicy: {},
      knowledge: {
        knownFacts: ["The term ends in June."],
        uncertainFacts: [],
        forbiddenMetaKnowledge: [],
      },
      sources: [{ excerpt: "A short allowed source excerpt." }],
    },
    state: {
      agentId: "agent-private-id",
      asOfUtc: NOW,
      moodValence: 0.1,
      moodArousal: 0.4,
      energy: 0.6,
      stress: 0.2,
      socialBattery: 0.7,
      focus: 0.8,
      relationship: {
        userId: "user-private-id",
        closeness: 0.6,
        trust: 0.7,
        familiarity: 0.5,
        recentInteractionValence: 0.2,
      },
      revision: 1,
    },
    schedule: [],
    memories: [],
    recentMessages: [],
    nowUtc: NOW,
    userMessage: "How was your day?",
  };
  return { ...input, ...overrides };
}

describe("assembleChatPrompt registry integration", () => {
  it("assembles through exactly the 17 defaults while retaining legacy contracts", () => {
    const result = assembleChatPrompt(baseInput());

    expect(result.segmentTrace.segments.map((segment) => segment.id)).toEqual(
      DEFAULT_PROMPT_SEGMENT_IDS,
    );
    expect(
      result.segmentTrace.segments
        .filter((segment) => segment.required)
        .every((segment) => segment.included),
    ).toBe(true);
    expect(result.system).toContain(
      "external action or schedule change has been completed",
    );
    expect(result.system).toContain('"text" is the only required key');
    expect(result.prompt).toContain("REFERENCE_CONTEXT_JSON\n");
    const promptLines = result.prompt.split("\n");
    const referenceIndex = promptLines.indexOf("REFERENCE_CONTEXT_JSON");
    expect(referenceIndex).toBeGreaterThan(-1);
    expect(() => {
      JSON.parse(promptLines[referenceIndex + 1] ?? "");
    }).not.toThrow();
    expect(result.prompt).toContain("REPLY_STRATEGY_JSON");
    expect(result.prompt).toContain("OUTPUT_CONTRACT_JSON");
    expect(result.messages).toEqual([
      { role: "system", content: result.system },
      { role: "user", content: result.prompt },
    ]);
  });

  it("registers bounded extensions per call without putting content in the trace", () => {
    const extensionSecret = "PLUGIN_CONTEXT_CONTENT";
    const result = assembleChatPrompt(
      baseInput({
        autobiography: {
          id: "autobiography-private-id",
          agentId: "agent-private-id",
          sourceCheckpointId: "checkpoint-private-id",
          revision: 1,
          summaryFirstPerson: "I remember finishing the morning run.",
          importantExperiences: ["I finished the morning run."],
          relationshipChanges: [],
          activeGoals: [],
          unresolvedThreads: [],
          commitments: [],
          sourceEvidenceIds: ["evidence-private-id"],
          fromUtc: "2026-08-21T09:00:00.000Z",
          throughUtc: NOW,
          createdAtUtc: NOW,
        },
        calendarContext: [
          {
            ref: "calendar_1",
            scope: "public_system",
            label: "Autumn festival",
            localDate: "2026-09-01",
            allDay: true,
          },
        ],
        followUpContext: {
          pending: [{ ref: "followup_1", topic: "exam result" }],
        },
        additionalPromptSegments: [
          {
            id: "12y_plugin_context",
            placement: "prompt",
            priority: 65,
            tokenBudget: 100,
            required: false,
            cacheable: false,
            render: () => extensionSecret,
          },
        ],
      }),
    );

    const ids = result.segmentTrace.segments.map((segment) => segment.id);
    expect(ids).toContain("06_autobiography");
    expect(ids).toContain("07z_followup_context");
    expect(ids).toContain("12y_plugin_context");
    expect(ids).toContain("12z_calendar_context");
    expect(result.prompt).toContain("I remember finishing the morning run.");
    expect(result.prompt).toContain("calendar_1");
    expect(result.prompt).toContain("followup_1");
    expect(result.prompt).toContain(extensionSecret);
    expect(result.prompt).not.toContain("autobiography-private-id");
    expect(JSON.stringify(result.segmentTrace)).not.toContain(extensionSecret);

    const nextCall = assembleChatPrompt(baseInput());
    expect(
      nextCall.segmentTrace.segments.some(
        (segment) => segment.id === "12y_plugin_context",
      ),
    ).toBe(false);
  });

  it("honors the global input budget without dropping required segments", () => {
    const result = assembleChatPrompt(
      baseInput({
        userMessage: "u".repeat(20_000),
        recentMessages: Array.from({ length: 300 }, (_, index) => ({
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          content: "m".repeat(2_000),
        })),
        maxInputTokens: 512,
      }),
    );

    expect(result.segmentTrace.estimatedInputTokens).toBeLessThanOrEqual(512);
    expect(
      estimatePromptTokens(result.system) + estimatePromptTokens(result.prompt),
    ).toBeLessThanOrEqual(512);
    expect(
      result.segmentTrace.segments
        .filter((segment) => segment.required)
        .every((segment) => segment.included),
    ).toBe(true);
  });

  it("hard-bounds a caller-provided history of ten thousand messages", () => {
    const history = Array.from({ length: 10_000 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: "message-" + index + "-" + "x".repeat(400),
    }));
    const result = assembleChatPrompt(
      baseInput({
        recentMessages: history,
        maxRecentMessages: 10_000,
      }),
    );

    expect(result.segmentTrace.estimatedInputTokens).toBeLessThan(30_000);
    expect(result.system.length + result.prompt.length).toBeLessThan(120_000);
    expect(result.prompt).not.toContain("message-0-");
    expect(JSON.stringify(result.segmentTrace)).not.toContain("message-9999-");
  });
  it("advertises grounded continuity effects in the canonical world envelope", () => {
    const result = assembleChatPrompt(
      baseInput({ liveWorldEffectsMode: "enforced" }),
    );
    const instructions = result.system + "\n" + result.prompt;

    expect(instructions).toContain("followUpCandidates");
    expect(instructions).toContain("followUpTransitions");
    expect(instructions).toContain("careCueCandidates");
    expect(instructions).toContain("model-side proposals");
    expect(instructions).toContain("exact verbatim turn evidence");
    expect(instructions).toContain("Keep followUpTransitions empty");
    expect(instructions).toContain("Never emit ids");
    expect(instructions).toContain("persisted timestamps");
    expect(instructions).toContain("reason metadata");

    const promptLines = result.prompt.split("\n");
    const contractIndex = promptLines.indexOf("OUTPUT_CONTRACT_JSON");
    expect(contractIndex).toBeGreaterThan(-1);
    const contract = JSON.parse(
      promptLines[contractIndex + 1] ?? "",
    ) as unknown;
    expect(contract).toMatchObject({
      worldEffects: {
        continuityEffects: {
          followUpCandidates: [],
          followUpTransitions: [],
          careCueCandidates: [],
        },
      },
    });
  });
  it("keeps bounded schedule truth visible throughout the loaded 72-hour horizon", () => {
    const scheduleBase = {
      agentId: "agent-private-id",
      description: "",
      category: "work",
      timezone: "Asia/Shanghai",
      rigidity: "flexible" as const,
      priority: 0.7,
      source: "self_initiated" as const,
      adherenceProbability: 0.8,
      narrativeImportance: 0.7,
      shareable: true,
      stateEffects: {},
      status: "planned" as const,
      revision: 0,
      createdAtUtc: NOW,
      updatedAtUtc: NOW,
    };
    const result = assembleChatPrompt(
      baseInput({
        schedule: [
          {
            ...scheduleBase,
            id: "schedule-visible-48h",
            title: "Sunday documentary screening",
            startAtUtc: "2026-08-23T12:00:00.000Z",
            endAtUtc: "2026-08-23T14:00:00.000Z",
          },
          {
            ...scheduleBase,
            id: "schedule-hidden-80h",
            title: "Outside loaded horizon",
            startAtUtc: "2026-08-25T00:00:00.000Z",
            endAtUtc: "2026-08-25T01:00:00.000Z",
          },
        ],
      }),
    );

    expect(result.prompt).toContain("Sunday documentary screening");
    expect(result.prompt).not.toContain("Outside loaded horizon");
  });
});
