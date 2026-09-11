import { describe, expect, it } from "vitest";

import { RelationshipMilestoneSchema } from "./life.js";
import {
  LOCAL_USER_ID,
  RelationshipDeltaSchema,
  RelationshipStateSchema,
} from "./relationship.js";
import { RuntimeStateSchema } from "./state.js";

const relationship = {
  userId: LOCAL_USER_ID,
  closeness: 0.1,
  lastInteractionAtUtc: "2026-09-11T00:00:00.000Z",
};

describe("single affinity contracts", () => {
  it("keeps one bounded progress value and interaction metadata", () => {
    expect(RelationshipStateSchema.parse(relationship)).toEqual(relationship);
    for (const closeness of [0, 1]) {
      expect(
        RelationshipStateSchema.safeParse({ ...relationship, closeness })
          .success,
      ).toBe(true);
    }
    for (const closeness of [-0.001, 1.001, Number.NaN]) {
      expect(
        RelationshipStateSchema.safeParse({ ...relationship, closeness })
          .success,
      ).toBe(false);
    }
    expect(RelationshipDeltaSchema.parse({ closeness: -1 })).toEqual({
      closeness: -1,
    });
    expect(RelationshipDeltaSchema.parse({ closeness: 0 })).toEqual({
      closeness: 0,
    });
    expect(RelationshipDeltaSchema.parse({ closeness: 1 })).toEqual({
      closeness: 1,
    });
    expect(RelationshipDeltaSchema.safeParse({}).success).toBe(false);
  });

  it.each(["trust", "familiarity", "recentInteractionValence"])(
    "rejects retired %s payloads instead of silently dropping them",
    (field) => {
      expect(
        RelationshipStateSchema.safeParse({ ...relationship, [field]: 0.2 })
          .success,
      ).toBe(false);
      expect(RelationshipDeltaSchema.safeParse({ [field]: 0.01 }).success).toBe(
        false,
      );
      expect(
        RelationshipDeltaSchema.safeParse({ closeness: 0.01, [field]: 0.01 })
          .success,
      ).toBe(false);
    },
  );

  it("enforces the same single value inside a runtime state", () => {
    const runtime = {
      agentId: "agent-1",
      asOfUtc: "2026-09-11T00:00:00.000Z",
      moodValence: 0,
      moodArousal: 0.5,
      energy: 0.7,
      stress: 0.2,
      socialBattery: 0.7,
      focus: 0.6,
      sleepDebtMinutes: 0,
      relationship,
      revision: 0,
    };
    expect(RuntimeStateSchema.parse(runtime)).toEqual(runtime);
    expect(
      RuntimeStateSchema.safeParse({
        ...runtime,
        relationship: {
          ...relationship,
          trust: 0.1,
          familiarity: 0.1,
          recentInteractionValence: 0,
        },
      }).success,
    ).toBe(false);
  });

  it("requires single-value effects for new relationship milestones", () => {
    const milestone = {
      id: "milestone-1",
      agentId: "agent-1",
      kind: "meaningful_support",
      title: "认真听完了一段烦恼",
      summary: "用户明确表示这次倾听让自己轻松了一些。",
      significance: 0.5,
      relationshipDelta: { closeness: 0.01 },
      interventionIds: ["intervention-1"],
      decisionIds: [],
      outcomeIds: [],
      reflectionIds: [],
      sourceMessageIds: ["message-1"],
      idempotencyKey: "milestone:message-1",
      schemaVersion: 1,
      effectiveLocalDate: "2026-09-11",
      effectivePeriod: "morning",
      temporalPrecision: "period",
      recordedAtUtc: "2026-09-11T00:00:00.000Z",
    };
    expect(RelationshipMilestoneSchema.safeParse(milestone).success).toBe(true);
    expect(
      RelationshipMilestoneSchema.safeParse({
        ...milestone,
        relationshipDelta: { trust: 0.01 },
      }).success,
    ).toBe(false);
  });
});
