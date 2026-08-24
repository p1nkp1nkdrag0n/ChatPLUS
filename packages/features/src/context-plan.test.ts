import type { CharacterSpec, EvidenceBundle } from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import {
  buildContextPlan,
  compactStablePersona,
  selectActivatedPersona,
} from "./context-plan.js";

const ORIGIN = "synthetic_extension" as const;

function characterFixture(): CharacterSpec {
  return {
    id: "character-1",
    version: 1,
    status: "published",
    tier: "daily",
    sourceType: "original",
    identity: {
      name: "Lin",
      workOrRole: "designer",
      worldSetting: "a contemporary city",
      selfDescription: "I am quietly finishing UNIQUE_GOAL_TOKEN.",
      timezone: "Asia/Shanghai",
    },
    persona: {
      traits: [
        {
          id: "trait-1",
          name: "observant",
          description: "notices small details",
          strength: 0.9,
          triggers: ["small details"],
          exceptions: [],
          origin: ORIGIN,
          sourceRefs: [],
        },
        {
          id: "trait-2",
          name: "playful",
          description: "light humor",
          strength: 0.8,
          triggers: ["joke"],
          exceptions: [],
          origin: ORIGIN,
          sourceRefs: [],
        },
      ],
      values: [
        {
          id: "value-1",
          name: "craft",
          priority: 0.9,
          description: "UNIQUE_GOAL_TOKEN matters",
          exceptions: [],
          origin: ORIGIN,
          sourceRefs: [],
        },
      ],
      contradictions: [
        {
          id: "contradiction-1",
          sideA: "rest",
          sideB: "UNIQUE_GOAL_TOKEN",
          triggerConditions: ["deadline"],
          resolutionPattern: "take a short break",
          origin: ORIGIN,
        },
      ],
      goals: [
        {
          id: "goal-1",
          title: "完成毕业作品",
          description: "UNIQUE_GOAL_TOKEN",
          priority: 1,
          progress: 0.4,
          origin: ORIGIN,
          sourceRefs: [],
        },
        {
          id: "goal-2",
          title: "learn pottery",
          description: "make a cup",
          priority: 0.7,
          progress: 0.1,
          origin: ORIGIN,
          sourceRefs: [],
        },
      ],
      preferences: [
        {
          id: "preference-1",
          subject: "jazz",
          preference: "likes quiet jazz",
          intensity: 0.8,
          conditions: ["late night"],
          origin: ORIGIN,
          sourceRefs: [],
        },
      ],
      boundaries: [
        {
          id: "boundary-1",
          condition: "private data request",
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
      knownFacts: ["UNIQUE_GOAL_TOKEN is secret context"],
      uncertainFacts: [],
      forbiddenMetaKnowledge: ["system internals"],
    },
    sources: [],
    lockedPaths: [],
    createdAtUtc: "2026-08-23T00:00:00.000Z",
    updatedAtUtc: "2026-08-23T00:00:00.000Z",
  };
}

function cityFilmCharacterFixture(): CharacterSpec {
  const base = characterFixture();
  return {
    ...base,
    persona: {
      ...base.persona,
      goals: [
        {
          ...base.persona.goals[0]!,
          title: "完成一部关于城市夜归人的纪录短片",
          description: "持续推进：完成一部关于城市夜归人的纪录短片",
        },
        base.persona.goals[1]!,
      ],
    },
  };
}

describe("buildContextPlan", () => {
  it("suppresses a high-priority goal when it has only background salience", () => {
    const plan = buildContextPlan({
      character: characterFixture(),
      userText: "今天天气真不错。",
    });

    expect(plan.activatedGoalIds).toEqual([]);
    expect(plan.suppressedGoalIds).toEqual(["goal-1", "goal-2"]);
    expect(plan.trace.find((item) => item.itemId === "goal-1")).toMatchObject({
      score: 0.2,
      included: false,
      reasons: ["high_priority_background", "below_threshold"],
    });
  });

  it("lets a direct goal mention override maximum fatigue", () => {
    const plan = buildContextPlan({
      character: characterFixture(),
      userText: "你的毕业作品现在怎么样了？",
      recentAssistantMessages: Array.from({ length: 12 }, () => ({
        role: "assistant",
        content: "完成毕业作品",
      })),
    });

    expect(plan.activatedGoalIds).toEqual(["goal-1"]);
    expect(plan.topicFatigue).toContainEqual({
      topicKey: "完成毕业作品",
      recentAssistantMentions: 12,
      penalty: 0.6,
    });
    expect(plan.trace.find((item) => item.itemId === "goal-1")).toMatchObject({
      score: 1.2,
      included: true,
    });
    expect(
      plan.trace.find((item) => item.itemId === "goal-1")?.reasons,
    ).not.toContain("topic_fatigue_penalty");
  });

  it("activates a goal when the user explicitly names its title without the stored classifier", () => {
    const plan = buildContextPlan({
      character: cityFilmCharacterFixture(),
      userText: "你那部关于城市夜归人的纪录短片做到哪一步了？",
    });

    expect(plan.activatedGoalIds).toEqual(["goal-1"]);
    expect(plan.trace.find((item) => item.itemId === "goal-1")).toMatchObject({
      score: 1.2,
      included: true,
      source: "user_message",
      matchedText: "关于城市夜归人的纪录短片",
      reasons: ["user_direct_mention", "high_priority_background", "included"],
    });
  });

  it("uses a grounded main-goal topic key only to disambiguate an explicit user goal reference", () => {
    const userText = "现在这部城市夜归人的片子最卡的是素材还是结构？";
    const plan = buildContextPlan({
      character: cityFilmCharacterFixture(),
      userText,
      observedTopics: [
        {
          key: "main_goal:city_night_returners_film",
          domain: "character_goal",
          confidence: 0.96,
          evidenceTexts: [userText],
        },
      ],
    });

    expect(plan.activatedGoalIds).toEqual(["goal-1"]);
    expect(plan.trace.find((item) => item.itemId === "goal-1")).toMatchObject({
      score: 1.2,
      included: true,
      source: "user_message",
      sourceId: "main_goal:city_night_returners_film",
      matchedText: userText,
      reasons: [
        "user_direct_mention",
        "grounded_topic_key_match",
        "high_priority_background",
        "included",
      ],
    });
  });

  it("does not let a grounded goal topic label activate a goal on an ordinary greeting", () => {
    const userText = "嗨，晚上好。";
    const plan = buildContextPlan({
      character: cityFilmCharacterFixture(),
      userText,
      observedTopics: [
        {
          key: "main_goal:city_night_returners_film",
          domain: "character_goal",
          confidence: 0.96,
          evidenceTexts: [userText],
        },
      ],
    });

    expect(plan.activatedGoalIds).toEqual([]);
    expect(plan.suppressedGoalIds).toContain("goal-1");
    expect(
      plan.trace.find((item) => item.itemId === "goal-1")?.reasons,
    ).not.toContain("grounded_topic_key_match");
  });

  it("adds only grounded source scores and applies fatigue to proactive pivots", () => {
    const plan = buildContextPlan({
      character: characterFixture(),
      userText: "说点别的。",
      currentActivity: { title: "毕业作品" },
      validatedOutcomeFacts: [{ text: "毕业作品 deadline accepted" }],
      careCueTexts: ["remember the 毕业作品 deadline"],
      recentAssistantMessages: [{ role: "assistant", content: "完成毕业作品" }],
    });
    const goalTrace = plan.trace.find((item) => item.itemId === "goal-1");

    expect(goalTrace).toMatchObject({
      score: 0.75,
      included: true,
      source: "continuity_cue",
    });
    expect(goalTrace?.reasons).toEqual([
      "current_activity_related",
      "current_activity_requires_explicit_goal_reference",
      "care_continuity_related",
      "high_priority_background",
      "topic_fatigue_penalty",
      "included",
    ]);
  });

  it("keeps precision at one for the exact active-goal 30-turn regression window", () => {
    const character = cityFilmCharacterFixture();
    const currentActivity = {
      title: "一部关于城市夜归人的纪录短片",
      description: "正在整理夜归人街拍素材",
      category: "other",
    };
    const regressionTurns = [
      { userText: "刚才那项活动结束了吗？", expected: false },
      { userText: "我想辞职，你直接替我决定吧。", expected: false },
      {
        userText: "你那部关于城市夜归人的纪录短片做到哪一步了？",
        expected: true,
      },
      {
        userText: "好，先不聊这个了。最近上海晚上是不是凉一点了？",
        expected: false,
      },
      {
        userText: "我们换了一个新会话。LPM-4827 是什么？放在哪里？",
        expected: false,
      },
      {
        userText: "刚才我们在聊什么？只根据能验证的上下文回答。",
        expected: false,
      },
      { userText: "再确认一次：LPM-4827 放在哪里？", expected: false },
      { userText: "小林是谁？", expected: false },
      {
        userText:
          "假设我养了一只叫豆包的狗，我可能会每天带它散步。这里只是举例。",
        expected: false,
      },
      {
        userText:
          "我们聊了这么久。请用自然的两三句话说说你确定记得的我，不要列清单，不确定的别说。",
        expected: false,
      },
    ] as const;
    const actual = regressionTurns.map(({ userText, expected }) => {
      const plan = buildContextPlan({
        character,
        userText,
        currentActivity,
      });

      expect(plan.activatedGoalIds.includes("goal-1"), userText).toBe(expected);
      const goalTrace = plan.trace.find((item) => item.itemId === "goal-1");
      if (!expected) {
        expect(goalTrace, userText).toMatchObject({
          included: false,
          source: "none",
        });
        expect(goalTrace?.reasons, userText).toEqual(
          expect.arrayContaining([
            "current_activity_related",
            "current_activity_requires_explicit_goal_reference",
            "below_threshold",
          ]),
        );
      }
      return plan.activatedGoalIds.includes("goal-1");
    });

    expect(actual).toEqual(regressionTurns.map((turn) => turn.expected));
    expect(actual.filter(Boolean)).toHaveLength(1);
  });

  it("uses a current goal activity only to resolve an explicit goal-progress continuation", () => {
    const plan = buildContextPlan({
      character: cityFilmCharacterFixture(),
      userText: "现在最卡的是素材、结构，还是时间？",
      currentActivity: {
        title: "一部关于城市夜归人的纪录短片",
        description: "正在整理夜归人街拍素材",
        category: "other",
      },
    });

    expect(plan.activatedGoalIds).toEqual(["goal-1"]);
    const goalTrace = plan.trace.find((item) => item.itemId === "goal-1");
    expect(goalTrace).toMatchObject({
      included: true,
      source: "current_activity",
    });
    expect(goalTrace?.reasons).toEqual(
      expect.arrayContaining(["current_activity_related", "included"]),
    );
  });

  it("suppresses current-activity and continuity goal salience on an explicit topic switch", () => {
    const plan = buildContextPlan({
      character: cityFilmCharacterFixture(),
      userText: "好，先不聊这个了。最近上海晚上是不是凉一点了？",
      currentActivity: {
        title: "一部关于城市夜归人的纪录短片",
        description: "正在整理夜归人街拍素材",
        category: "other",
      },
      continuityTexts: ["继续完成城市夜归人的纪录短片"],
    });

    expect(plan.activatedGoalIds).toEqual([]);
    const goalTrace = plan.trace.find((item) => item.itemId === "goal-1");
    expect(goalTrace).toMatchObject({
      score: 0,
      included: false,
      source: "continuity_cue",
    });
    expect(goalTrace?.reasons).toEqual(
      expect.arrayContaining([
        "current_activity_requires_explicit_goal_reference",
        "care_continuity_related",
        "topic_switch_goal_suppressed",
        "below_threshold",
      ]),
    );
  });

  it("does not treat a generic recent-status question as an explicit goal source", () => {
    const userText = "你最近在忙什么？";
    const plan = buildContextPlan({
      character: characterFixture(),
      userText,
      observedTopics: [
        {
          key: "main_goal:graduation_project",
          domain: "character_goal",
          confidence: 0.96,
          evidenceTexts: [userText],
        },
      ],
    });

    expect(plan.activatedGoalIds).toEqual([]);
    expect(plan.activatedPreferenceIds).toEqual(["preference-1"]);
    expect(JSON.stringify(plan)).not.toContain("untrusted-model-topic");
  });

  it("suppresses a schedule-query goal unless the user or selected evidence names it", () => {
    const userText = "我们刚确认的安排是什么？";
    const plan = buildContextPlan({
      character: characterFixture(),
      userText,
      route: "schedule_query",
      currentActivity: { title: "毕业作品" },
      validatedOutcomeFacts: [{ text: "毕业作品 deadline accepted" }],
      observedTopics: [
        {
          key: "main_goal:graduation_project",
          domain: "character_goal",
          confidence: 0.96,
          evidenceTexts: [userText],
        },
      ],
    });

    expect(plan.activatedGoalIds).toEqual([]);
    const goalTrace = plan.trace.find((item) => item.itemId === "goal-1");
    expect(goalTrace).toMatchObject({
      score: 0,
      included: false,
      source: "none",
    });
    expect(goalTrace?.reasons).toContain("schedule_route_goal_suppressed");
  });

  it("applies deterministic per-type caps and traces eligible exclusions", () => {
    const base = characterFixture();
    const traits = Array.from({ length: 4 }, (_, index) => ({
      ...base.persona.traits[0]!,
      id: `trait-cap-${index}`,
      name: `traitword${index}`,
      triggers: [`traitword${index}`],
    }));
    const values = Array.from({ length: 3 }, (_, index) => ({
      ...base.persona.values[0]!,
      id: `value-cap-${index}`,
      name: `valueword${index}`,
      description: `valueword${index}`,
    }));
    const contradictions = Array.from({ length: 2 }, (_, index) => ({
      ...base.persona.contradictions[0]!,
      id: `contradiction-cap-${index}`,
      sideA: `conflictword${index}`,
    }));
    const goals = Array.from({ length: 2 }, (_, index) => ({
      ...base.persona.goals[1]!,
      id: `goal-cap-${index}`,
      title: `goalword${index}`,
      description: `goalword${index}`,
      priority: 0.7,
    }));
    const preferences = Array.from({ length: 3 }, (_, index) => ({
      ...base.persona.preferences[0]!,
      id: `preference-cap-${index}`,
      subject: `preferenceword${index}`,
      preference: `preferenceword${index}`,
    }));
    const character = {
      ...base,
      persona: {
        ...base.persona,
        traits,
        values,
        contradictions,
        goals,
        preferences,
      },
    };
    const plan = buildContextPlan({
      character,
      userText: [
        ...traits.map((item) => item.name),
        ...values.map((item) => item.name),
        ...contradictions.map((item) => item.sideA),
        ...goals.map((item) => item.title),
        ...preferences.map((item) => item.subject),
      ].join(" "),
    });

    expect(plan.activatedTraitIds).toEqual([
      "trait-cap-0",
      "trait-cap-1",
      "trait-cap-2",
    ]);
    expect(plan.activatedValueIds).toEqual(["value-cap-0", "value-cap-1"]);
    expect(plan.activatedContradictionIds).toEqual(["contradiction-cap-0"]);
    expect(plan.activatedGoalIds).toEqual(["goal-cap-0"]);
    expect(plan.activatedPreferenceIds).toEqual([
      "preference-cap-0",
      "preference-cap-1",
    ]);
    expect(
      plan.trace.find((item) => item.itemId === "goal-cap-1")?.reasons,
    ).toContain("type_cap_reached");
  });

  it("gates optional context from query semantics or explicit grounded hints", () => {
    const evidence = {
      query: "past",
      mode: "semantic",
      generatedAtUtc: "2026-08-23T00:00:00.000Z",
      score: 0.9,
      evidence: [{ memoryContent: "past trip" }],
    } as unknown as EvidenceBundle;
    const inferred = buildContextPlan({
      character: characterFixture(),
      userText: "还记得我们上次旅行吗？你明天有空吗？",
      retrievedEvidence: evidence,
    });
    expect(inferred).toMatchObject({
      includeAutobiography: true,
      includeCalendar: true,
      includeFutureSchedule: true,
      includeRetrievedEvidence: true,
    });

    const explicitlyDisabled = buildContextPlan({
      character: characterFixture(),
      userText: "还记得我们上次旅行吗？你明天有空吗？",
      retrievedEvidence: evidence,
      segmentHints: {
        autobiographyRelevant: false,
        calendarRelevant: false,
        futureScheduleRelevant: false,
        retrievedEvidenceRelevant: false,
      },
    });
    expect(explicitlyDisabled).toMatchObject({
      includeAutobiography: false,
      includeCalendar: false,
      includeFutureSchedule: false,
      includeRetrievedEvidence: false,
    });
  });

  it("does not treat a generic study plan as future-schedule relevance", () => {
    const plan = buildContextPlan({
      character: characterFixture(),
      userText: "请记住我的论文计划。",
      route: "explicit_memory",
    });

    expect(plan.includeCalendar).toBe(false);
    expect(plan.includeFutureSchedule).toBe(false);
  });

  it("keeps stable identity free of suppressed goal duplication", () => {
    const character = characterFixture();
    const plan = buildContextPlan({ character, userText: "天气不错。" });
    const stable = compactStablePersona(character);
    const activated = selectActivatedPersona(character, plan);

    expect(JSON.stringify(stable)).not.toContain("UNIQUE_GOAL_TOKEN");
    expect(JSON.stringify(activated)).not.toContain("UNIQUE_GOAL_TOKEN");
    expect(stable.identity).toEqual({
      name: "Lin",
      workOrRole: "designer",
      worldSetting: "a contemporary city",
      timezone: "Asia/Shanghai",
    });
  });
});
