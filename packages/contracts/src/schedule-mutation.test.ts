import { describe, expect, it } from "vitest";

import { PersonaChatDecisionSchema } from "./persona-chat-decision.js";
import { ScheduleSourceSchema } from "./schedule.js";
import {
  ScheduleMutationBundleSchema,
  SelfPlanBundleSchema,
} from "./schedule-mutation.js";

const activity = {
  title: "night stargazing",
  description: "self-initiated server plan",
  category: "leisure" as const,
  startAtUtc: "2026-06-01T23:00:00.000Z",
  endAtUtc: "2026-06-02T01:00:00.000Z",
  timezone: "UTC",
  rigidity: "flexible" as const,
  priority: 0.6,
  adherenceProbability: 0.8,
  narrativeImportance: 0.7,
  shareable: true,
  stateEffects: { energy: -0.1 },
};

describe("server-owned schedule mutation contracts", () => {
  it("adds self_initiated as a persisted schedule source", () => {
    expect(ScheduleSourceSchema.parse("self_initiated")).toBe("self_initiated");
  });

  it("keeps source out of server create drafts", () => {
    expect(
      ScheduleMutationBundleSchema.safeParse({
        owner: "self_planner",
        create: [{ ...activity, source: "manual" }],
      }).success,
    ).toBe(false);
    expect(
      ScheduleMutationBundleSchema.parse({
        owner: "self_planner",
        create: [activity],
      }),
    ).toMatchObject({ owner: "self_planner", create: [activity] });
  });

  it("accepts an atomic night self-plan bundle", () => {
    expect(
      SelfPlanBundleSchema.parse({
        intentId: "intent-1",
        activity,
        sleepAdjustment: {
          sleepItemId: "sleep-1",
          newStartAtUtc: "2026-06-02T01:00:00.000Z",
          newEndAtUtc: "2026-06-02T07:00:00.000Z",
          lostSleepMinutes: 120,
        },
      }),
    ).toMatchObject({
      intentId: "intent-1",
      sleepAdjustment: {
        sleepItemId: "sleep-1",
        lostSleepMinutes: 120,
      },
    });
  });

  it("does not expose server mutation bundles in model-facing decisions", () => {
    const parsed = PersonaChatDecisionSchema.parse({
      text: "I want to go stargazing tonight.",
      scheduleMutationBundle: {
        owner: "self_planner",
        create: [activity],
      },
      selfPlanBundle: {
        intentId: "intent-1",
        activity,
      },
    });

    expect(parsed).not.toHaveProperty("scheduleMutationBundle");
    expect(parsed).not.toHaveProperty("selfPlanBundle");
  });

  it("rejects empty bundles and invalid sleep ranges", () => {
    expect(
      ScheduleMutationBundleSchema.safeParse({
        owner: "manual",
      }).success,
    ).toBe(false);
    expect(
      SelfPlanBundleSchema.safeParse({
        intentId: "intent-1",
        activity,
        sleepAdjustment: {
          sleepItemId: "sleep-1",
          newStartAtUtc: "2026-06-02T07:00:00.000Z",
          newEndAtUtc: "2026-06-02T01:00:00.000Z",
          lostSleepMinutes: 120,
        },
      }).success,
    ).toBe(false);
  });
});
