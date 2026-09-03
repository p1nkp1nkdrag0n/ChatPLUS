import type { CharacterSpec, DailyLifeIntent } from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import { buildOriginalDraft, initialRuntimeState } from "../domain/defaults.js";
import { characterSpecSchema } from "../domain/schemas.js";
import {
  assertTimelinePlanHash,
  availabilityFor,
  buildDailyIntents,
  buildDeterministicLifeOutcome,
  createDailyLifeContext,
  dayPeriod,
  focusForPeriod,
  freezeTimelinePlan,
  refreshDailyLifeContext,
  timelineLocalDate,
} from "./fuzzy-life-planning.js";

const AT_UTC = "2026-09-03T06:00:00.000Z";
const LOCAL_DATE = "2026-09-03";

describe("fuzzy life planning", () => {
  it.each([
    [5, "early_morning"],
    [6, "morning"],
    [10, "morning"],
    [11, "midday"],
    [13, "midday"],
    [14, "afternoon"],
    [17, "afternoon"],
    [18, "evening"],
    [22, "evening"],
    [23, "late_night"],
  ] as const)("maps local hour %i to %s", (hour, expected) => {
    expect(dayPeriod(hour)).toBe(expected);
  });

  it("keeps availability thresholds strict and deterministic", () => {
    const spec = testSpec();
    const state = initialRuntimeState(spec.id, AT_UTC, spec);
    const boundary = {
      ...state,
      stress: 0.78,
      focus: 0.58,
      energy: 0.4,
      socialBattery: 0.35,
    };

    expect(availabilityFor(boundary)).toBe("free");
    expect(availabilityFor({ ...boundary, stress: 0.781 })).toBe("occupied");
    expect(availabilityFor({ ...boundary, focus: 0.801, energy: 0.399 })).toBe(
      "occupied",
    );
    expect(availabilityFor({ ...boundary, focus: 0.581 })).toBe(
      "interruptible",
    );
    expect(availabilityFor({ ...boundary, socialBattery: 0.349 })).toBe(
      "interruptible",
    );
  });

  it("builds stable bounded intents and uses the spontaneous fallback", () => {
    const spec = testSpec();
    const first = buildDailyIntents(spec, [], LOCAL_DATE, AT_UTC);
    const replay = buildDailyIntents(spec, [], LOCAL_DATE, AT_UTC);

    expect(replay).toEqual(first);
    expect(first).toHaveLength(4);
    expect(first[0]).toMatchObject({
      sourceKind: "goal",
      durationBand: "most_of_period",
      commitmentLevel: "priority",
    });
    expect(first.some((intent) => intent.title === "早餐")).toBe(false);
    expect(first.some((intent) => intent.title === "睡眠")).toBe(false);

    const emptySpec: CharacterSpec = {
      ...spec,
      persona: { ...spec.persona, goals: [] },
      routines: [],
    };
    expect(buildDailyIntents(emptySpec, [], LOCAL_DATE, AT_UTC)).toMatchObject([
      {
        title: "照顾今天的生活状态",
        sourceKind: "spontaneous",
        period: "anytime",
      },
    ]);
  });

  it("selects focus by exact period, anytime fallback, then first intent", () => {
    const intent = buildDailyIntents(testSpec(), [], LOCAL_DATE, AT_UTC)[0]!;
    const morning: DailyLifeIntent = {
      ...intent,
      id: "intent-morning",
      title: "上午焦点",
      period: "morning",
    };
    const anytime: DailyLifeIntent = {
      ...intent,
      id: "intent-anytime",
      title: "随时焦点",
      period: "anytime",
    };

    expect(focusForPeriod([morning, anytime], "morning")).toBe("上午焦点");
    expect(focusForPeriod([morning, anytime], "evening")).toBe("随时焦点");
    expect(focusForPeriod([morning], "evening")).toBe("上午焦点");
    expect(focusForPeriod([], "evening")).toBeUndefined();
  });

  it("freezes and verifies a story timeline independently of later clocks", () => {
    const spec = testSpec({
      temporalFrame: {
        mode: "anchored_story",
        eraLabel: "1951 年的故事世界",
        storyAnchorLocalDate: "1951-09-03",
        anchorPrecision: "year",
        systemAnchorUtc: AT_UTC,
      },
    });
    const plan = freezeTimelinePlan(spec, spec.persona.goals[0]!, AT_UTC);

    expect(plan.timeBasis).toMatchObject({
      mode: "anchored_story",
      storyAnchorLocalDate: "1951-09-03",
      systemAnchorUtc: AT_UTC,
    });
    expect(timelineLocalDate(plan.timeBasis, AT_UTC)).toBe("1951-09-03");
    expect(() => assertTimelinePlanHash(plan)).not.toThrow();
    expect(() =>
      assertTimelinePlanHash({
        ...plan,
        milestones: plan.milestones.map((milestone, index) =>
          index === 0 ? { ...milestone, title: "篡改后的阶段" } : milestone,
        ),
      }),
    ).toThrow(/timeline plan hash mismatch/u);
  });

  it("builds stable evidenced outcomes and refreshes contexts only on change", () => {
    const spec = testSpec();
    const state = initialRuntimeState(spec.id, AT_UTC, spec);
    const intents = buildDailyIntents(spec, [], LOCAL_DATE, AT_UTC);
    const context = createDailyLifeContext({
      agentId: spec.id,
      spec,
      state,
      threads: [],
      intents,
      localDate: LOCAL_DATE,
      localHour: 9,
      currentPressureEpisodeIds: [],
      recentOutcomeIds: [],
      atUtc: AT_UTC,
    });
    const unchanged = refreshDailyLifeContext({
      context,
      state,
      intents,
      threads: [],
      localHour: 9,
      currentPressureEpisodeIds: [],
      recentOutcomeIds: [],
      atUtc: AT_UTC,
    });
    const refreshed = refreshDailyLifeContext({
      context,
      state,
      intents,
      threads: [],
      localHour: 19,
      currentPressureEpisodeIds: [],
      recentOutcomeIds: [],
      atUtc: "2026-09-03T11:00:00.000Z",
    });
    const outcome = buildDeterministicLifeOutcome({
      agentId: spec.id,
      intent: intents[0]!,
      evidenceId: "event-evidence",
      effectiveLocalDate: LOCAL_DATE,
      recordedAtUtc: AT_UTC,
    });

    expect(unchanged).toBe(context);
    expect(refreshed).toMatchObject({
      currentPeriod: "evening",
      revision: context.revision + 1,
    });
    expect(
      buildDeterministicLifeOutcome({
        agentId: spec.id,
        intent: intents[0]!,
        evidenceId: "event-evidence",
        effectiveLocalDate: LOCAL_DATE,
        recordedAtUtc: AT_UTC,
      }),
    ).toEqual(outcome);
    expect(outcome).toMatchObject({
      intentId: intents[0]!.id,
      sourceEvidenceIds: ["event-evidence"],
      effectiveLocalDate: LOCAL_DATE,
    });
    expect(outcome.summary).toContain(intents[0]!.title);
  });
});

function testSpec(
  identityOverride: Partial<CharacterSpec["identity"]> = {},
): CharacterSpec {
  const draft = buildOriginalDraft({
    name: "规划测试角色",
    worldSetting: "当代城市生活",
    workOrRole: "插画师",
    coreTraits: ["认真", "独立", "温和"],
    coreContradiction: "计划与变化之间的张力",
    mainGoal: "完成毕业作品",
    initialRelationship: "认识了一段时间的朋友",
    dialogueStyle: "自然简洁",
    tier: "high_fidelity",
    timezone: "Asia/Shanghai",
  });
  return characterSpecSchema.parse({
    ...draft,
    identity: { ...draft.identity, ...identityOverride },
    id: "planning-character",
    version: 1,
    status: "published",
    createdAtUtc: AT_UTC,
    updatedAtUtc: AT_UTC,
  });
}
