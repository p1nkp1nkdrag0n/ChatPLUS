import { describe, expect, it } from "vitest";

import { buildOriginalDraft } from "../domain/defaults.js";
import { characterSpecSchema } from "../domain/schemas.js";
import { ContextPlanService } from "./context-plan-service.js";
import type { ValidatedTurnOutcome } from "./turn-execution-service.js";

const NOW_UTC = "2026-08-23T00:00:00.000Z";

describe("ContextPlanService", () => {
  it("passes grounded observation topics through as auxiliary user-message evidence", () => {
    const userText = "现在最卡的是素材、结构，还是时间？";
    const service = new ContextPlanService();
    const plan = service.build({
      character: characterFixture(),
      userText,
      outcome: outcomeFixture(userText),
    });

    expect(plan.activatedGoalIds).toEqual(["goal-1"]);
    const goalTrace = plan.trace.find((item) => item.itemId === "goal-1");
    expect(goalTrace).toMatchObject({
      included: true,
      source: "user_message",
      sourceId: "main_goal:city_night_returners_film",
      matchedText: userText,
    });
    expect(goalTrace?.reasons).toEqual(
      expect.arrayContaining([
        "user_direct_mention",
        "grounded_topic_key_match",
      ]),
    );
  });

  it("keeps an active main-goal work block suppressed across unrelated turns and a topic switch", () => {
    const service = new ContextPlanService();
    const character = characterFixture();
    const currentActivity = {
      title: "一部关于城市夜归人的纪录短片",
      description: "正在整理夜归人街拍素材",
      category: "other",
    };

    for (const userText of [
      "我想辞职，你直接替我决定吧。",
      "好，先不聊这个了。最近上海晚上是不是凉一点了？",
      "我们换了一个新会话。LPM-4827 是什么？放在哪里？",
      "小林是谁？",
    ]) {
      const plan = service.build({
        character,
        userText,
        currentActivity,
      });

      expect(plan.activatedGoalIds, userText).toEqual([]);
      expect(plan.suppressedGoalIds, userText).toContain("goal-1");
    }
  });

  it("still activates an explicit goal continuation while that goal is the current activity", () => {
    const userText = "现在最卡的是素材、结构，还是时间？";
    const service = new ContextPlanService();
    const plan = service.build({
      character: characterFixture(),
      userText,
      currentActivity: {
        title: "一部关于城市夜归人的纪录短片",
        description: "正在整理夜归人街拍素材",
        category: "other",
      },
      outcome: outcomeFixture(userText),
    });

    expect(plan.activatedGoalIds).toEqual(["goal-1"]);
  });
});

function characterFixture() {
  return characterSpecSchema.parse({
    id: "character-context-plan",
    version: 1,
    status: "published",
    ...buildOriginalDraft({
      name: "林澈",
      worldSetting: "当代上海",
      workOrRole: "纪录片导演",
      coreTraits: ["克制", "敏锐", "真诚"],
      coreContradiction: "想忠实记录，又担心打扰被拍摄者",
      mainGoal: "完成一部关于城市夜归人的纪录短片",
      initialRelationship: "朋友",
      dialogueStyle: "自然、简洁",
      tier: "daily",
      timezone: "Asia/Shanghai",
    }),
    createdAtUtc: NOW_UTC,
    updatedAtUtc: NOW_UTC,
  });
}

function outcomeFixture(userText: string): ValidatedTurnOutcome {
  return {
    route: "conversation",
    observation: {
      topics: [
        {
          key: "main_goal:city_night_returners_film",
          domain: "character_goal",
          confidence: 0.96,
          evidenceQuotes: [{ text: userText }],
        },
      ],
    },
    replyDirectives: { authoritativeFacts: [] },
  } as unknown as ValidatedTurnOutcome;
}
