import type { ContextPlan } from "@personasim/contracts";
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

function promptContextPlan(overrides: Partial<ContextPlan> = {}): ContextPlan {
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
    suppressedGoalIds: ["goal-hidden"],
    topicFatigue: [
      {
        topicKey: "goal-hidden",
        recentAssistantMentions: 3,
        penalty: 0.6,
      },
    ],
    trace: [],
    ...overrides,
  };
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
    expect(result.system).toContain("replyDecision and worldEffects");
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

  it("applies enforced persona selection independently in the legacy turn prompt", () => {
    const hiddenSelf = "LEGACY_PIPELINE_HIDDEN_SELF";
    const hiddenGoal = "LEGACY_PIPELINE_HIDDEN_GOAL";
    const input = baseInput();
    const character = {
      ...input.character,
      identity: {
        ...input.character.identity,
        selfDescription: hiddenSelf,
      },
      persona: {
        ...input.character.persona,
        traits: [
          {
            id: "trait-stable",
            name: "observant",
            strength: 0.9,
          },
        ],
        values: [],
        contradictions: [],
        goals: [
          {
            id: "goal-hidden",
            title: hiddenGoal,
            description: hiddenGoal,
          },
        ],
        preferences: [],
      },
    };
    const suppressed = promptContextPlan();
    const legacy = assembleChatPrompt({ ...input, character });
    const shadow = assembleChatPrompt({
      ...input,
      character,
      personaContextMode: "shadow",
      contextPlan: suppressed,
    });
    const enforced = assembleChatPrompt({
      ...input,
      character,
      personaContextMode: "enforced",
      contextPlan: suppressed,
    });

    expect(legacy.system).toContain(hiddenSelf);
    expect(legacy.system).toContain(hiddenGoal);
    expect(shadow.system).toBe(legacy.system);
    expect(shadow.prompt).toBe(legacy.prompt);
    expect(enforced.system + enforced.prompt).not.toContain(hiddenSelf);
    expect(enforced.system + enforced.prompt).not.toContain(hiddenGoal);
    expect(enforced.prompt).toContain("TOPIC_FATIGUE_JSON");
    expect(enforced.prompt).not.toContain("ACTIVATED_PERSONA_JSON");

    const activated = assembleChatPrompt({
      ...input,
      character,
      personaContextMode: "enforced",
      contextPlan: promptContextPlan({
        activatedGoalIds: ["goal-hidden"],
        suppressedGoalIds: [],
      }),
    });
    expect(activated.prompt).toContain("ACTIVATED_PERSONA_JSON");
    expect(activated.prompt).toContain(hiddenGoal);
    expect(activated.system).not.toContain(hiddenSelf);
  });

  it("fails closed when enforced persona mode has no ContextPlan", () => {
    expect(() =>
      assembleChatPrompt(
        baseInput({
          personaContextMode: "enforced",
        }),
      ),
    ).toThrow(/requires a server-owned ContextPlan/u);
  });

  it.each([
    ["reply_only", false],
    ["legacy_effects", true],
    ["schedule_negotiation", false],
    ["schedule_negotiation_shadow", true],
  ] as const)(
    "advertises a canonical envelope in %s mode",
    (decisionMode, scheduleEffectsAllowed) => {
      const result = assembleChatPrompt(
        baseInput({
          decisionMode,
          liveWorldEffectsMode: "off",
        }),
      );
      const lines = result.prompt.split("\n");
      const contractIndex = lines.indexOf("OUTPUT_CONTRACT_JSON");
      expect(contractIndex).toBeGreaterThan(-1);
      const contract = JSON.parse(lines[contractIndex + 1] ?? "") as Record<
        string,
        unknown
      >;

      expect(contract).toHaveProperty("replyDecision");
      expect(contract.worldEffects).toEqual({});
      expect(
        Object.prototype.hasOwnProperty.call(
          contract["replyDecision"],
          "scheduleEffects",
        ),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(contract, "scheduleEffects"),
      ).toBe(scheduleEffectsAllowed);
      expect(result.system).toContain(
        "Return exactly one JSON object with replyDecision and worldEffects.",
      );
      if (
        decisionMode === "schedule_negotiation" ||
        decisionMode === "schedule_negotiation_shadow"
      ) {
        expect(result.system).toContain(
          "replyDecision.text and replyDecision.scheduleAction are required",
        );
        expect(result.system).not.toContain("optional scheduleAction");
      }
    },
  );

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
    expect(instructions).toContain("user_goal, user_event");
    expect(instructions).toContain(
      "evidenceQuotes must always be a JSON array",
    );
    expect(instructions).toContain("次日");
    expect(instructions).toContain("Never emit ids");
    expect(instructions).toContain("persisted timestamps");
    expect(instructions).toContain("reason metadata");
    expect(instructions).toContain("user_fact, user_preference");
    expect(instructions).toContain(
      "exact JSON keys activity (a fuzzy natural-language description)",
    );
    expect(instructions).toContain("self_care, errand, or other");

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
  it("keeps the required schedule action visible when world effects are enabled", () => {
    const result = assembleChatPrompt(
      baseInput({
        decisionMode: "schedule_negotiation",
        liveWorldEffectsMode: "enforced",
      }),
    );
    const promptLines = result.prompt.split("\n");
    const contractIndex = promptLines.indexOf("OUTPUT_CONTRACT_JSON");
    const contract = JSON.parse(promptLines[contractIndex + 1] ?? "") as {
      replyDecision?: Record<string, unknown>;
      worldEffects?: Record<string, unknown>;
    };

    expect(contract.replyDecision).toMatchObject({
      text: "the complete reply",
      scheduleAction: { kind: "none" },
    });
    expect(contract.worldEffects).toHaveProperty("continuityEffects");
    expect(result.system).toContain(
      "replyDecision.scheduleAction is required on every schedule-negotiation turn",
    );
    expect(result.system).toContain(
      "Questions that only recall, inspect, or describe an existing",
    );
    expect(result.system).toContain("must use kind none");
  });
  it("keeps a parseable authoritative schedule payload under the segment budget", () => {
    const schedule: AssemblePromptInput["schedule"] = Array.from(
      { length: 24 },
      (_, index) => {
        const sharedCommitment = index === 23;
        const startAtUtc = new Date(
          Date.parse(NOW) + (index + 1) * 60 * 60 * 1_000,
        ).toISOString();
        const endAtUtc = new Date(
          Date.parse(startAtUtc) + 45 * 60 * 1_000,
        ).toISOString();
        return {
          id: sharedCommitment
            ? "shared-committed-invitation"
            : `ordinary-${index}`,
          agentId: "agent-private-id",
          title: sharedCommitment
            ? "Tea with the user at North Shore Bookshop"
            : `Long ordinary project ${index} ${"t".repeat(100)}`,
          description: `Detailed schedule context ${index} ${"d".repeat(900)}`,
          category: "social",
          startAtUtc,
          endAtUtc,
          timezone: "Asia/Shanghai",
          rigidity: sharedCommitment ? "committed" : "flexible",
          priority: 0.7,
          source: sharedCommitment ? "user_invitation" : "self_initiated",
          adherenceProbability: 0.8,
          narrativeImportance: 0.7,
          shareable: true,
          stateEffects: {},
          status: "planned",
          revision: 0,
          createdAtUtc: NOW,
          updatedAtUtc: NOW,
        };
      },
    );
    const result = assembleChatPrompt(baseInput({ schedule }));
    const lines = result.prompt.split("\n");
    const scheduleIndex = lines.indexOf("FUTURE_SCHEDULE_JSON");
    const serialized = lines[scheduleIndex + 1] ?? "";
    const payload = JSON.parse(serialized) as {
      authority: string;
      asOfUtc: string;
      timezone: string;
      items: Array<Record<string, unknown>>;
      omittedItemCount: number;
    };

    expect(payload).toMatchObject({
      authority: "server_persisted_current_schedule",
      asOfUtc: NOW,
      timezone: "Asia/Shanghai",
    });
    expect(payload.omittedItemCount).toBeGreaterThan(0);
    const committedInvitation = payload.items.find(
      (item) => item["title"] === "Tea with the user at North Shore Bookshop",
    );
    expect(committedInvitation).toMatchObject({
      title: "Tea with the user at North Shore Bookshop",
      source: "user_invitation",
      timezone: "Asia/Shanghai",
      status: "planned",
      rigidity: "committed",
    });
    expect(typeof committedInvitation?.["description"]).toBe("string");
    expect(typeof committedInvitation?.["startAtUtc"]).toBe("string");
    expect(typeof committedInvitation?.["endAtUtc"]).toBe("string");
    expect(payload.items.map((item) => String(item["startAtUtc"]))).toEqual(
      payload.items
        .map((item) => String(item["startAtUtc"]))
        .sort((left, right) => left.localeCompare(right)),
    );
    expect(
      "FUTURE_SCHEDULE_JSON\n".length + serialized.length,
    ).toBeLessThanOrEqual(700 * 4);
    expect(
      result.segmentTrace.segments.find(
        (segment) => segment.id === "12_future_schedule",
      ),
    ).toMatchObject({ included: true, truncated: false });
    expect(result.system).toContain(
      "authority=server_persisted_current_schedule",
    );
    expect(result.system).toContain(
      "not a claim that this turn performed a write",
    );

    const tight = assembleChatPrompt(
      baseInput({ schedule, maxInputTokens: 512 }),
    );
    const tightTrace = tight.segmentTrace.segments.find(
      (segment) => segment.id === "12_future_schedule",
    );
    expect(tightTrace).toBeDefined();
    expect(tightTrace?.truncated).toBe(false);
    const tightLines = tight.prompt.split("\n");
    const tightScheduleIndex = tightLines.indexOf("FUTURE_SCHEDULE_JSON");
    if (tightTrace?.included === true) {
      expect(() => {
        JSON.parse(tightLines[tightScheduleIndex + 1] ?? "");
      }).not.toThrow();
    } else {
      expect(tightScheduleIndex).toBe(-1);
      expect(tightTrace?.reason).toBe("global_budget");
    }
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
