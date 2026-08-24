import { describe, expect, it } from "vitest";

import { ContextPlanSchema } from "./context-plan.js";

describe("ContextPlanSchema", () => {
  it("validates the server-owned activation and suppression trace", () => {
    expect(
      ContextPlanSchema.parse({
        schemaVersion: 1,
        activatedTraitIds: ["trait-curious"],
        activatedValueIds: [],
        activatedContradictionIds: [],
        activatedGoalIds: ["goal-portfolio"],
        activatedPreferenceIds: [],
        includeAutobiography: false,
        includeCalendar: false,
        includeFutureSchedule: false,
        includeRetrievedEvidence: true,
        suppressedGoalIds: ["goal-marathon"],
        topicFatigue: [
          {
            topicKey: "goal:marathon",
            recentAssistantMentions: 4,
            penalty: 0.6,
          },
        ],
        trace: [
          {
            itemType: "goal",
            itemId: "goal-portfolio",
            score: 1,
            included: true,
            source: "user_message",
            reasons: ["user_direct_mention"],
          },
        ],
      }),
    ).toMatchObject({
      activatedGoalIds: ["goal-portfolio"],
      suppressedGoalIds: ["goal-marathon"],
    });
  });

  it("rejects out-of-policy topic fatigue penalties", () => {
    const result = ContextPlanSchema.safeParse({
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
      suppressedGoalIds: [],
      topicFatigue: [
        {
          topicKey: "goal:test",
          recentAssistantMentions: 5,
          penalty: 0.75,
        },
      ],
      trace: [],
    });
    expect(result.success).toBe(false);
  });
});
