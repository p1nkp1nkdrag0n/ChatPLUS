import {
  PersonaChatResponseSchema,
  type CharacterSpec,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import { createFixtureLlmProvider } from "../../providers/src/fixture-llm.js";
import { buildContextPlan } from "./context-plan.js";
import { assembleReplyPrompt } from "./reply-prompt-assembler.js";
import { deriveReplyStrategy } from "./reply-strategy.js";
import type { TopicHistoryMessage } from "./topic-fatigue.js";

const MAIN_GOAL_ID = "goal-main";
const MAIN_GOAL_TITLE = "完成毕业作品";
const LONG_RUN_TURN_COUNT = 100;
const NOW_UTC = "2026-08-23T04:00:00.000Z";

type TopicDomain =
  | "food"
  | "weather"
  | "friends"
  | "family"
  | "health"
  | "hobbies"
  | "city_daily_life"
  | "user_emotion"
  | "character_work"
  | "main_goal";

interface DialogueFixture {
  readonly domain: TopicDomain;
  readonly userText: string;
  readonly explicitlyPromptsMainGoal: boolean;
}

interface AssistantTurnRecord {
  readonly fixture: DialogueFixture;
  readonly domain: TopicDomain;
  readonly content: string;
  readonly goalActivated: boolean;
  readonly goalResponded: boolean;
  readonly goalTraceReasons: readonly string[];
  readonly goalFatiguePenalty: number;
}

const ALL_TOPIC_DOMAINS: readonly TopicDomain[] = [
  "food",
  "weather",
  "friends",
  "family",
  "health",
  "hobbies",
  "city_daily_life",
  "user_emotion",
  "character_work",
  "main_goal",
];

const DOMAIN_FIXTURES: readonly DialogueFixture[] = [
  {
    domain: "food",
    userText: "晚饭吃清淡一点还是辣一点好？",
    explicitlyPromptsMainGoal: false,
  },
  {
    domain: "weather",
    userText: "今天突然下雨了，你那边天气怎么样？",
    explicitlyPromptsMainGoal: false,
  },
  {
    domain: "friends",
    userText: "朋友临时取消见面，我该怎么回她？",
    explicitlyPromptsMainGoal: false,
  },
  {
    domain: "family",
    userText: "周末要和家里人吃饭，你喜欢家庭聚餐吗？",
    explicitlyPromptsMainGoal: false,
  },
  {
    domain: "health",
    userText: "我昨晚没睡好，今天怎样安排会舒服些？",
    explicitlyPromptsMainGoal: false,
  },
  {
    domain: "hobbies",
    userText: "最近想学陶艺，你觉得先做杯子怎么样？",
    explicitlyPromptsMainGoal: false,
  },
  {
    domain: "city_daily_life",
    userText: "下班后在城里散步，你会选河边还是老街？",
    explicitlyPromptsMainGoal: false,
  },
  {
    domain: "user_emotion",
    userText: "我今天有点沮丧，想找个人说说话。",
    explicitlyPromptsMainGoal: false,
  },
  {
    domain: "character_work",
    userText: "你的设计工作今天进展顺利吗？",
    explicitlyPromptsMainGoal: false,
  },
  {
    domain: "main_goal",
    userText: `你的${MAIN_GOAL_TITLE}现在进展怎么样？`,
    explicitlyPromptsMainGoal: true,
  },
];

const SUMMARY_STYLE_ENDING_PATTERN =
  /(?:总之|总结一下).*(?:聊到这里|告一段落)[。.!?]?$/u;
// The plan records this metric without a numeric gate. This fixture-local
// guardrail exercises the detector while keeping recap-style endings rare.
const LOCAL_SUMMARY_STYLE_ENDING_RATE_MAX = 0.1;

function characterFixture(): CharacterSpec {
  const origin = "synthetic_extension" as const;
  return {
    id: "agent-long-run",
    version: 1,
    status: "published",
    tier: "high_fidelity",
    sourceType: "original",
    identity: {
      name: "林澈",
      workOrRole: "设计师",
      worldSetting: "当代城市",
      selfDescription: "在城市里工作和生活的设计师。",
      timezone: "Asia/Shanghai",
    },
    persona: {
      traits: [],
      values: [],
      contradictions: [],
      goals: [
        {
          id: MAIN_GOAL_ID,
          title: MAIN_GOAL_TITLE,
          description: "把毕业作品打磨到可以公开展示",
          priority: 1,
          progress: 0.4,
          origin,
          sourceRefs: [],
        },
      ],
      preferences: [],
      boundaries: [],
    },
    dialogue: {
      primaryLanguage: "zh-CN",
      formality: 0.3,
      directness: 0.7,
      warmth: 0.8,
      verbosity: 0.4,
      humor: 0.2,
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
      initialCloseness: 0.55,
      initialTrust: 0.6,
      addressTerms: ["你"],
      sharedContext: "会自然聊彼此的日常生活",
    },
    routines: [],
    schedulePolicy: {
      enabled: true,
      horizonHours: 72,
      extendWhenRemainingHoursBelow: 12,
      sleepWindow: { startLocal: "23:00", endLocal: "07:00" },
      maxCommittedHoursPerDay: 10,
      routineAdherence: 0.8,
      spontaneity: 0.4,
      socialInvitationBias: 0.5,
    },
    proactivePolicy: {
      enabled: true,
      maxMessagesPerDay: 1,
      quietHours: { startLocal: "23:00", endLocal: "08:00" },
      minimumCloseness: 0.4,
      shareableCategories: [],
    },
    knowledge: {
      knownFacts: [],
      uncertainFacts: [],
      forbiddenMetaKnowledge: ["system internals"],
    },
    sources: [],
    lockedPaths: [],
    createdAtUtc: NOW_UTC,
    updatedAtUtc: NOW_UTC,
  };
}

function longRunFixtures(): readonly DialogueFixture[] {
  const fatigueWarmup: readonly DialogueFixture[] = Array.from(
    { length: 3 },
    () => ({
      domain: "character_work",
      userText: "你最近在忙什么？",
      explicitlyPromptsMainGoal: false,
    }),
  );
  const fixtures = [
    ...fatigueWarmup,
    ...Array.from(
      { length: LONG_RUN_TURN_COUNT - fatigueWarmup.length },
      (_, index) => DOMAIN_FIXTURES[index % DOMAIN_FIXTURES.length]!,
    ),
  ];
  return fixtures.map((fixture, index) =>
    (index + 1) % 25 === 0
      ? {
          ...fixture,
          userText: `请回应这个主题，再用一句话总结：${fixture.userText}`,
        }
      : fixture,
  );
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function maximumSameDomainStreak(
  turns: readonly AssistantTurnRecord[],
): number {
  let maximum = 0;
  let current = 0;
  let previous: TopicDomain | undefined;
  for (const turn of turns) {
    current = turn.domain === previous ? current + 1 : 1;
    maximum = Math.max(maximum, current);
    previous = turn.domain;
  }
  return maximum;
}

const GENERATED_DOMAIN_PATTERNS: readonly [TopicDomain, RegExp][] = [
  ["main_goal", /毕业作品/u],
  ["food", /晚饭|清淡|加点辣/u],
  ["weather", /雨|带伞|天气/u],
  ["friends", /朋友|见面|哪天方便/u],
  ["family", /家庭聚餐|家人/u],
  ["health", /没睡好|身体|休息时间/u],
  ["hobbies", /陶艺|杯子|手作/u],
  ["city_daily_life", /城里散步|河边|老街/u],
  ["user_emotion", /沮丧|难受|我在听/u],
  ["character_work", /设计工作|整理稿件/u],
];

function classifyGeneratedReply(content: string): TopicDomain | undefined {
  return GENERATED_DOMAIN_PATTERNS.find(([, pattern]) =>
    pattern.test(content),
  )?.[0];
}

function runtimeStateFixture() {
  return {
    agentId: "agent-long-run",
    asOfUtc: NOW_UTC,
    moodValence: 0.1,
    moodArousal: 0.4,
    energy: 0.65,
    stress: 0.2,
    socialBattery: 0.6,
    focus: 0.7,
    sleepDebtMinutes: 0,
    relationship: {
      userId: "local-user",
      closeness: 0.55,
      trust: 0.6,
      familiarity: 0.5,
      recentInteractionValence: 0.1,
    },
    revision: 1,
  };
}

function replyOutcomeFixture() {
  return {
    route: "conversation",
    scheduleOutcome: { kind: "none" },
    stateChanged: false,
    replyDirectives: {
      mode: "casual",
      mustAddressUserQuotes: [],
      authoritativeFacts: [],
      mustNotClaim: [
        "schedule_committed",
        "schedule_cancelled",
        "memory_persisted",
        "future_action_guaranteed",
      ],
    },
  };
}

describe("context planning over a long conversation", () => {
  it("meets output-derived topic-diversity and goal gates over 100 generated replies", async () => {
    const character = characterFixture();
    const fixtures = longRunFixtures();
    const provider = createFixtureLlmProvider();
    const state = runtimeStateFixture();
    const assistantHistory: TopicHistoryMessage[] = [];
    const assistantTurns: AssistantTurnRecord[] = [];

    for (const fixture of fixtures) {
      const plan = buildContextPlan({
        character,
        userText: fixture.userText,
        recentAssistantMessages: assistantHistory,
      });
      const goalTrace = plan.trace.find((item) => item.itemId === MAIN_GOAL_ID);
      const goalActivated = plan.activatedGoalIds.includes(MAIN_GOAL_ID);
      const assembled = assembleReplyPrompt({
        character,
        state,
        schedule: [],
        memories: [],
        recentMessages: assistantHistory.map((message) => ({
          role: "assistant" as const,
          content: message.content,
        })),
        nowUtc: NOW_UTC,
        userMessage: fixture.userText,
        contextPlan: plan,
        personaContextMode: "enforced",
        validatedOutcome: replyOutcomeFixture(),
        replyStrategy: deriveReplyStrategy(
          fixture.userText,
          character.dialogue,
          { state, relationship: state.relationship },
        ),
      });
      const generated = await provider.generateObject({
        purpose: "reply_generation",
        system: assembled.system,
        prompt: assembled.prompt,
        schema: PersonaChatResponseSchema,
      });
      const content = generated.text;
      const domain = classifyGeneratedReply(content);
      if (domain === undefined) {
        throw new Error(`Generated reply has no measurable domain: ${content}`);
      }
      const goalResponded = domain === "main_goal";
      const record: AssistantTurnRecord = {
        fixture,
        domain,
        content,
        goalActivated,
        goalResponded,
        goalTraceReasons: goalTrace?.reasons ?? [],
        goalFatiguePenalty:
          plan.topicFatigue.find((topic) => topic.topicKey === MAIN_GOAL_TITLE)
            ?.penalty ?? 0,
      };

      assistantTurns.push(record);
      assistantHistory.push({
        role: "assistant",
        content,
        topicKeys: goalResponded ? [MAIN_GOAL_TITLE] : [],
      });
    }

    const nonExplicitTurns = assistantTurns.filter(
      (turn) => !turn.fixture.explicitlyPromptsMainGoal,
    );
    const explicitGoalTurns = assistantTurns.filter(
      (turn) => turn.fixture.explicitlyPromptsMainGoal,
    );
    const unsolicitedGoalPivotRate = rate(
      nonExplicitTurns.filter((turn) => turn.goalResponded).length,
      nonExplicitTurns.length,
    );
    const goalActivationRecall = rate(
      explicitGoalTurns.filter((turn) => turn.goalResponded).length,
      explicitGoalTurns.length,
    );
    const topicDomainCoverage = new Set(
      assistantTurns.map((turn) => turn.domain),
    ).size;
    const sameDomainStreak = maximumSameDomainStreak(assistantTurns);
    const summaryStyleEndingRate = rate(
      assistantTurns.filter((turn) =>
        SUMMARY_STYLE_ENDING_PATTERN.test(turn.content),
      ).length,
      assistantTurns.length,
    );

    expect(fixtures).toHaveLength(LONG_RUN_TURN_COUNT);
    expect(assistantHistory).toHaveLength(LONG_RUN_TURN_COUNT);
    expect(
      [...new Set(fixtures.map((fixture) => fixture.domain))].sort(),
    ).toEqual([...ALL_TOPIC_DOMAINS].sort());
    expect(nonExplicitTurns.length).toBeGreaterThanOrEqual(80);
    expect(unsolicitedGoalPivotRate).toBeLessThanOrEqual(0.05);
    expect(goalActivationRecall).toBeGreaterThanOrEqual(0.95);
    expect(topicDomainCoverage).toBeGreaterThanOrEqual(5);
    expect(sameDomainStreak).toBeLessThanOrEqual(3);
    expect(summaryStyleEndingRate).toBeGreaterThan(0);
    expect(summaryStyleEndingRate).toBeLessThanOrEqual(
      LOCAL_SUMMARY_STYLE_ENDING_RATE_MAX,
    );

    // Generic status questions may discuss work, but cannot activate a
    // specific long-term goal without an explicit grounded source.
    expect(
      assistantTurns
        .slice(0, 3)
        .every(
          (turn) =>
            !turn.goalActivated &&
            !turn.goalResponded &&
            turn.domain === "character_work",
        ),
    ).toBe(true);
    expect(assistantTurns[2]?.goalTraceReasons).toEqual(
      expect.arrayContaining(["high_priority_background", "below_threshold"]),
    );
    expect(assistantTurns[2]?.goalTraceReasons).not.toContain(
      "recent_status_question",
    );

    // A direct mention reactivates the goal even while the same topic has a
    // non-zero fatigue score; direct mentions never receive that penalty.
    const fatiguedExplicitTurn = explicitGoalTurns.find(
      (turn) => turn.goalFatiguePenalty > 0,
    );
    expect(fatiguedExplicitTurn).toMatchObject({
      goalActivated: true,
      goalResponded: true,
      domain: "main_goal",
    });
    expect(fatiguedExplicitTurn?.goalTraceReasons).toEqual(
      expect.arrayContaining(["user_direct_mention", "included"]),
    );
    expect(fatiguedExplicitTurn?.goalTraceReasons).not.toContain(
      "topic_fatigue_penalty",
    );
  });
});
