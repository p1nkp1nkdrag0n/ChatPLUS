import { describe, expect, it } from "vitest";

import type {
  LongRunScenarioManifestV3,
  LongRunTurnSpec,
} from "./companion-long-run-v3-types.js";
import {
  allLongRunV3CandidateTurns,
  canonicalSerializeLongRunScenarioManifestV3,
  companionLongRunV3Manifest,
  COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID,
  COMPANION_LONG_RUN_V3_BRANCH_END_AT_UTC,
  COMPANION_LONG_RUN_V3_SCENARIO_VERSION,
  COMPANION_LONG_RUN_V3_SHA256,
  COMPANION_LONG_RUN_V3_SHARED_END_AT_UTC,
  COMPANION_LONG_RUN_V3_START_AT_UTC,
  getLongRunV3Turn,
  resolveLongRunV3ConditionalUserText,
  sha256LongRunScenarioManifestV3,
  validateLongRunScenarioManifestV3,
} from "./companion-long-run-v3-manifest.js";

const EXPECTED_SHA256 =
  "0df44e91c4637d068260adbee0bf5560bb8aba7f887026931449a144aa315592";

describe("companion long-run v3 manifest", () => {
  it("freezes the approved DeepSeek fuzzy-life baseline", () => {
    expect(COMPANION_LONG_RUN_V3_SCENARIO_VERSION).toBe(
      "companion-long-run-v3",
    );
    expect(companionLongRunV3Manifest).toMatchObject({
      schemaVersion: 3,
      scenarioVersion: "companion-long-run-v3",
      scenarioId: "gulan-deepseek-fuzzy-life-long-run-v3",
      startAtUtc: COMPANION_LONG_RUN_V3_START_AT_UTC,
      timezone: "Asia/Shanghai",
      candidateCount: 120,
      sharedCandidateCount: 108,
      branchCandidateCount: 6,
      simulatedDayCount: 30,
      character: {
        name: "顾澜",
        workOrRole: "纪录片剪辑师兼社区夜校讲师",
        coreTraits: ["温和直接", "观察细致", "重视真实与边界", "有独立判断"],
      },
      initialRelationship: {
        userId: "local-user",
        relationshipType: "朋友",
        closeness: 0.42,
        trust: 0.55,
        familiarity: 0.35,
      },
      featureFlags: {
        lifePlanningMode: "fuzzy",
        scheduleCapability: false,
        backgroundScheduler: "off",
      },
      profileExpectation: {
        provider: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        requestModel: "deepseek-v4-flash",
        reasoningEffort: "max",
        reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
        attemptTimeoutMs: 300000,
        maxTransportRetries: 2,
        maxContextTokens: 131072,
        providerMaxOutputTokens: 32768,
      },
    });
    expect(
      validateLongRunScenarioManifestV3(companionLongRunV3Manifest),
    ).toEqual([]);
  });

  it("contains 108 shared candidates and two six-turn branches exactly once", () => {
    expect(companionLongRunV3Manifest.sharedTurns).toHaveLength(108);
    expect(
      companionLongRunV3Manifest.branches.map((branch) => branch.id),
    ).toEqual(["A", "B"]);
    expect(companionLongRunV3Manifest.branches[0].turns).toHaveLength(6);
    expect(companionLongRunV3Manifest.branches[1].turns).toHaveLength(6);
    const all = allLongRunV3CandidateTurns();
    expect(all).toHaveLength(120);
    expect(all.map((turn) => turn.candidateNumber)).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 1),
    );
    expect(new Set(all.map((turn) => turn.id))).toHaveProperty("size", 120);
    expect(getLongRunV3Turn(108).id).toBe("shared-108");
    expect(getLongRunV3Turn(109).id).toBe("branch-a-109");
    expect(getLongRunV3Turn(115).id).toBe("branch-b-109");
  });

  it("freezes representative reviewed inputs verbatim", () => {
    expect(getLongRunV3Turn(1).userText).toBe(
      "早上好。我今天醒得有点慢，不想一开口就聊什么重大问题。",
    );
    expect(getLongRunV3Turn(14).userText).toBe(
      "我刚才说错了，包是藏青色，不是绿色。笔记仍在内层，书签还是 M-417。",
    );
    expect(getLongRunV3Turn(48).userText).toBe(
      "现在我明确授权你替我在 A 和 B 之间作决定。请只选一个，不要同时给两个答案；我会把你的选择当作决定，但不会假装自己已经行动。",
    );
    expect(getLongRunV3Turn(108).userText).toBe(
      "今天你的生活大概在推进什么？只要模糊背景和主线，不要给我一张日程表。",
    );
    expect(getLongRunV3Turn(109).userText).toContain("副主编岗位");
    expect(getLongRunV3Turn(115).userText).toContain("独立影像项目");
  });

  it("resolves T55 and T64 from the persisted T48 decision with an executable fallback", () => {
    const t55 = getLongRunV3Turn(55);
    const t64 = getLongRunV3Turn(64);
    expect(typeof t55.userText).toBe("object");
    expect(typeof t64.userText).toBe("object");
    expect(resolveLongRunV3ConditionalUserText(t55, "B")).toBe(
      "我刚给山鸣影像发了接受 offer 的邮件，也向现在的主管提出离职。这是已经做了，不是计划。",
    );
    expect(resolveLongRunV3ConditionalUserText(t55, "A")).toContain(
      "正式拒绝山鸣影像",
    );
    expect(resolveLongRunV3ConditionalUserText(t55, null)).toContain(
      "我现在自己选择 B",
    );
    expect(resolveLongRunV3ConditionalUserText(t64, "B")).toContain(
      "头两个月可能只能拿八成薪资",
    );
    expect(resolveLongRunV3ConditionalUserText(t64, "A")).toContain(
      "所谓自主权比承诺的少",
    );
    expect(resolveLongRunV3ConditionalUserText(t64, undefined)).toContain(
      "山鸣影像确认接受我",
    );
    expect(resolveLongRunV3ConditionalUserText(getLongRunV3Turn(1), "A")).toBe(
      getLongRunV3Turn(1).userText,
    );
  });

  it("expresses every reviewed control action at the correct boundary", () => {
    expect(kinds(getLongRunV3Turn(1).actionsBefore)).toEqual([
      "set_clock",
      "activate_agent",
    ]);
    expect(kinds(getLongRunV3Turn(60).actionsAfter)).toEqual(["restart_app"]);
    expect(getLongRunV3Turn(61).actionsAfter).toEqual([
      {
        kind: "replay_turn",
        sourceTurnId: "shared-055",
        reuseClientMessageId: true,
        expectNoLlmCall: true,
      },
    ]);
    expect(kinds(getLongRunV3Turn(72).actionsBefore)).toContain(
      "inject_character_dilemma",
    );
    expect(kinds(getLongRunV3Turn(76).actionsAfter)).toContain(
      "inject_character_action_from_decision",
    );
    expect(kinds(getLongRunV3Turn(78).actionsBefore)).toContain(
      "inject_character_mixed_outcome",
    );
    expect(kinds(getLongRunV3Turn(81).actionsAfter)).toEqual([
      "close_app",
      "advance_clock",
      "open_app",
      "activate_agent",
    ]);
    expect(kinds(getLongRunV3Turn(96).actionsAfter)).toEqual([
      "restart_app",
      "replay_turn",
    ]);
    expect(kinds(getLongRunV3Turn(100).actionsAfter)).toEqual([
      "rollback_clock",
    ]);
    expect(kinds(getLongRunV3Turn(108).actionsAfter)).toEqual([
      "inject_user_branch_dilemma",
      "verify_retired_schedule",
      "verify_frontend",
      "fork_branches",
    ]);
  });

  it("declares the four support modes without conflating them", () => {
    expect(getLongRunV3Turn(26).supportMode).toBe("listen_only");
    expect(getLongRunV3Turn(26).hardAssertions).toContain(
      "pressure_change_requires_explicit_evidence",
    );
    expect(getLongRunV3Turn(33).supportMode).toBe("deliberate");
    expect(getLongRunV3Turn(46).supportMode).toBe("recommend");
    expect(getLongRunV3Turn(48).supportMode).toBe("delegated_decision");
    expect(getLongRunV3Turn(48).hardAssertions).toEqual(
      expect.arrayContaining([
        "delegated_decision_authorized",
        "delegated_decision_unique",
        "causal_stage_separation",
      ]),
    );
  });

  it("separates durable memory recall probes from causal provenance recaps", () => {
    for (const candidate of [20, 22, 24, 92, 97, 98, 101, 107]) {
      expect(getLongRunV3Turn(candidate).hardAssertions).toContain(
        "memory_recall_evidence_bound",
      );
    }
    for (const candidate of [61, 69, 105]) {
      expect(getLongRunV3Turn(candidate).hardAssertions).not.toContain(
        "memory_recall_evidence_bound",
      );
      expect(getLongRunV3Turn(candidate).hardAssertions).toContain(
        "causal_stage_separation",
      );
    }
    expect(getLongRunV3Turn(61).hardAssertions).toContain(
      "causal_recap_grounded",
    );
    expect(getLongRunV3Turn(69).hardAssertions).toContain(
      "causal_recap_grounded",
    );
    expect(getLongRunV3Turn(105).hardAssertions).toContain(
      "causal_provenance_grounded",
    );
    expect(getLongRunV3Turn(107).hardAssertions).toContain(
      "relationship_continuity_grounded",
    );
  });

  it("pins every recall probe to the reviewed durable facts and sources", () => {
    expect(getLongRunV3Turn(20).memoryRecallExpectation).toMatchObject({
      minimumSelectedMemories: 1,
      forbiddenSourceTurnIds: ["shared-013"],
      requiredGroups: [
        {
          sourceTurnIds: ["shared-014"],
          contentIncludesAll: ["藏青色", "内层", "M-417"],
        },
      ],
    });
    expect(getLongRunV3Turn(22).memoryRecallExpectation).toMatchObject({
      minimumSelectedMemories: 2,
      requireDistinctGroupMatches: true,
      requiredGroups: [
        {
          sourceTurnIds: ["shared-015"],
          contentIncludesAll: ["许宁", "朋友"],
        },
        {
          sourceTurnIds: ["shared-015"],
          contentIncludesAll: ["许宁", "重庆", "进修"],
        },
      ],
    });
    expect(getLongRunV3Turn(24).memoryRecallExpectation).toMatchObject({
      minimumSelectedMemories: 3,
      requireDistinctGroupMatches: true,
      forbiddenContent: ["去年一起去苏州看展", "父亲生日"],
      forbiddenSourceTurnIds: ["shared-013"],
      requiredGroups: [
        { sourceTurnIds: ["shared-012"] },
        { sourceTurnIds: ["shared-014"] },
        {
          sourceTurnIds: ["shared-016"],
          contentIncludesAll: ["先陪我坐会儿", "先听我说"],
          contentIncludesAny: ["倾听", "不要立刻建议", "不要立刻列建议"],
        },
      ],
    });
    expect(getLongRunV3Turn(97).memoryRecallExpectation).toMatchObject({
      minimumSelectedMemories: 2,
      requireDistinctGroupMatches: true,
      requiredGroups: [
        { sourceTurnIds: ["shared-085"] },
        { sourceTurnIds: ["shared-096"] },
      ],
    });
    expect(getLongRunV3Turn(101).memoryRecallExpectation).toMatchObject({
      requiredGroups: [{ sourceTurnIds: ["shared-099"] }],
      forbiddenSourceTurnIds: ["shared-015"],
    });
    expect(getLongRunV3Turn(107).memoryRecallExpectation).toEqual(
      getLongRunV3Turn(97).memoryRecallExpectation,
    );
  });

  it("keeps exact schedules retired throughout the candidate path", () => {
    for (const turn of allLongRunV3CandidateTurns()) {
      expect(turn.hardAssertions).toEqual(
        expect.arrayContaining([
          "no_exact_schedule_created",
          "prompt_excludes_future_schedule",
          "prompt_includes_life_context",
        ]),
      );
      expect(JSON.stringify(turn)).not.toContain('FUTURE_SCHEDULE_JSON":');
      expect(JSON.stringify(turn)).not.toContain('CURRENT_ACTIVITY_JSON":');
    }
    expect(getLongRunV3Turn(108).hardAssertions).toEqual(
      expect.arrayContaining([
        "schedule_capability_disabled",
        "retired_schedule_api_returns_410",
        "frontend_schedule_absent",
      ]),
    );
    expect(getLongRunV3Turn(108).hardAssertions).not.toContain(
      "branch_anchor_preserved",
    );
  });

  it("keeps both branch paths anchored, isolated and temporally symmetric", () => {
    for (const branch of companionLongRunV3Manifest.branches) {
      expect(branch.forkAfterTurnId).toBe(
        COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID,
      );
      expect(branch.anchorTurnId).toBe(COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID);
      expect(branch.turns.map((turn) => turn.executionOrdinal)).toEqual([
        109, 110, 111, 112, 113, 114,
      ]);
      expect(
        branch.turns.every((turn) =>
          turn.hardAssertions.includes("branch_isolation"),
        ),
      ).toBe(true);
      expect(
        branch.turns.every((turn) =>
          turn.hardAssertions.includes("branch_anchor_preserved"),
        ),
      ).toBe(true);
      expect(
        traceClock([
          ...companionLongRunV3Manifest.sharedTurns,
          ...branch.turns,
        ]),
      ).toBe(COMPANION_LONG_RUN_V3_BRANCH_END_AT_UTC);
    }
    expect(traceClock(companionLongRunV3Manifest.sharedTurns)).toBe(
      COMPANION_LONG_RUN_V3_SHARED_END_AT_UTC,
    );
    expect(companionLongRunV3Manifest.branches[0].turns[4]!.userText).toContain(
      "不要提另一条没有发生的路线",
    );
    expect(companionLongRunV3Manifest.branches[1].turns[4]!.userText).toContain(
      "不要提另一条没有发生的路线",
    );
  });

  it("produces stable canonical JSON and a frozen SHA-256", () => {
    const canonical = canonicalSerializeLongRunScenarioManifestV3(
      companionLongRunV3Manifest,
    );
    expect(canonical).toBe(JSON.stringify(JSON.parse(canonical)));
    expect(COMPANION_LONG_RUN_V3_SHA256).toBe(EXPECTED_SHA256);
    expect(sha256LongRunScenarioManifestV3(companionLongRunV3Manifest)).toBe(
      EXPECTED_SHA256,
    );
    const clone = cloneManifest();
    const { branches, blocks, sharedTurns, ...rest } = clone;
    const reordered = {
      branches,
      blocks,
      sharedTurns,
      ...rest,
    } as LongRunScenarioManifestV3;
    expect(canonicalSerializeLongRunScenarioManifestV3(reordered)).toBe(
      canonical,
    );
  });

  it("fails closed on input, identity, action, branch and profile drift", () => {
    const changedInput = cloneManifest();
    changedInput.sharedTurns[0]!.userText = "被临场改写的输入";
    expect(validateLongRunScenarioManifestV3(changedInput)).toContain(
      "shared user inputs drifted from the reviewed 108-turn script",
    );

    const duplicate = cloneManifest();
    duplicate.branches[0].turns[0]!.id = duplicate.sharedTurns[0]!.id;
    expect(validateLongRunScenarioManifestV3(duplicate)).toContain(
      `duplicate turn id ${duplicate.sharedTurns[0]!.id}`,
    );

    const wrongProfile = cloneManifest();
    wrongProfile.profileExpectation.requestModel =
      "other" as "deepseek-v4-flash";
    expect(validateLongRunScenarioManifestV3(wrongProfile)).toContain(
      "DeepSeek profile expectation drifted from the reviewed plan",
    );

    const noFork = cloneManifest();
    const actionsAfter = noFork.sharedTurns[107]!.actionsAfter;
    if (actionsAfter === undefined) throw new Error("missing T108 actions");
    noFork.sharedTurns[107]!.actionsAfter = actionsAfter.filter(
      (action) => action.kind !== "fork_branches",
    );
    expect(validateLongRunScenarioManifestV3(noFork)).toContain(
      "shared turn 108 must after action fork_branches",
    );

    const crossedBranch = cloneManifest();
    crossedBranch.branches[1].anchorTurnId = "other" as "shared-108";
    expect(validateLongRunScenarioManifestV3(crossedBranch)).toContain(
      "branch B must fork from shared-108",
    );

    const weakenedRecall = cloneManifest();
    weakenedRecall.sharedTurns[21]!.memoryRecallExpectation = {
      minimumSelectedMemories: 1,
    };
    expect(validateLongRunScenarioManifestV3(weakenedRecall)).toContain(
      "memory recall expectation drifted at shared-022",
    );

    const removedPromptGrounding = cloneManifest();
    removedPromptGrounding.sharedTurns[60]!.hardAssertions =
      removedPromptGrounding.sharedTurns[60]!.hardAssertions.filter(
        (assertion) => assertion !== "causal_recap_grounded",
      );
    expect(validateLongRunScenarioManifestV3(removedPromptGrounding)).toContain(
      "prompt evidence hard gate drifted at shared-061",
    );

    const removedLifeContextGate = cloneManifest();
    removedLifeContextGate.sharedTurns[0]!.hardAssertions =
      removedLifeContextGate.sharedTurns[0]!.hardAssertions.filter(
        (assertion) => assertion !== "prompt_includes_life_context",
      );
    expect(validateLongRunScenarioManifestV3(removedLifeContextGate)).toContain(
      "turn shared-001 is missing base assertion prompt_includes_life_context",
    );

    const futureRecallSource = cloneManifest();
    const t20Expectation =
      futureRecallSource.sharedTurns[19]!.memoryRecallExpectation;
    if (t20Expectation === undefined)
      throw new Error("missing T20 expectation");
    t20Expectation.requiredSourceTurnIds = ["shared-020"];
    expect(validateLongRunScenarioManifestV3(futureRecallSource)).toContain(
      "shared-020 has invalid earlier memory source turn shared-020",
    );

    const backwards = cloneManifest();
    const clock = backwards.branches[0].turns[0]!.actionsBefore?.find(
      (action) => action.kind === "set_clock",
    );
    if (clock?.kind === "set_clock") clock.atUtc = "2026-09-01T01:00:00.000Z";
    expect(validateLongRunScenarioManifestV3(backwards)).toEqual(
      expect.arrayContaining([
        "branch A turn 1 must set clock to 2026-10-01T01:00:00.000Z",
        "branch A clock moves backwards at branch-a-109",
      ]),
    );
  });
});

type Mutable<T> = T extends readonly [infer First, infer Second]
  ? [Mutable<First>, Mutable<Second>]
  : T extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;

function cloneManifest(): Mutable<LongRunScenarioManifestV3> {
  return JSON.parse(
    JSON.stringify(companionLongRunV3Manifest),
  ) as Mutable<LongRunScenarioManifestV3>;
}

function kinds(actions: LongRunTurnSpec["actionsBefore"]): string[] {
  return (actions ?? []).map((action) => action.kind);
}

function traceClock(turns: readonly LongRunTurnSpec[]): string {
  let current = Date.parse(COMPANION_LONG_RUN_V3_START_AT_UTC);
  for (const turn of turns) {
    for (const action of [
      ...(turn.actionsBefore ?? []),
      ...(turn.actionsAfter ?? []),
    ]) {
      if (action.kind === "set_clock") current = Date.parse(action.atUtc);
      if (action.kind === "advance_clock")
        current += action.durationMinutes * 60_000;
    }
  }
  return new Date(current).toISOString();
}
