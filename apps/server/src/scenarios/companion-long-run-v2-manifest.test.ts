import { describe, expect, it } from "vitest";

import type {
  HardAssertion,
  LongRunPairedProbeSpec,
  LongRunScenarioManifestV2,
  LongRunTurnSpec,
  SemanticRubricTag,
} from "./companion-long-run-v2-types.js";
import {
  allLongRunV2CandidateTurns,
  canonicalSerializeLongRunScenarioManifestV2,
  companionLongRunV2Manifest,
  COMPANION_LONG_RUN_V2_BRANCH_ANCHOR_ID,
  COMPANION_LONG_RUN_V2_END_AT_UTC,
  COMPANION_LONG_RUN_V2_SCENARIO_VERSION,
  COMPANION_LONG_RUN_V2_SHA256,
  COMPANION_LONG_RUN_V2_SHARED_END_AT_UTC,
  COMPANION_LONG_RUN_V2_START_AT_UTC,
  COMPANION_LONG_RUN_V2_TIMEZONE,
  getLongRunV2Turn,
  sha256LongRunScenarioManifestV2,
  validateLongRunScenarioManifestV2,
} from "./companion-long-run-v2-manifest.js";

const EXPECTED_SHA256 =
  "f66399106fb3d4394359c6f45908ab6a643ed51c838969c924da0bc4c916a62d";

const EXPECTED_BLOCKS = [
  ["daily-conversation", "shared", 1, 12],
  ["memory-evidence-time", "shared", 13, 28],
  ["emotion-care", "shared", 29, 44],
  ["schedule-negotiation", "shared", 45, 60],
  ["state-offline-restart", "shared", 61, 72],
  ["conflict-repair", "shared", 73, 84],
  ["goal-self-life-proactive", "shared", 85, 96],
  ["cross-session-correction", "shared", 97, 108],
  ["branch-a-date-accepted", "branch_a", 109, 114],
  ["branch-b-friends-only", "branch_b", 115, 120],
] as const;

const EXPECTED_MILESTONES = [
  [1, "2026-09-01T01:00:00.000Z"],
  [13, "2026-09-04T01:00:00.000Z"],
  [29, "2026-09-07T01:00:00.000Z"],
  [45, "2026-09-10T01:00:00.000Z"],
  [61, "2026-09-13T01:00:00.000Z"],
  [73, "2026-09-17T01:00:00.000Z"],
  [85, "2026-09-20T01:00:00.000Z"],
  [97, "2026-09-24T01:00:00.000Z"],
  [108, "2026-09-27T01:00:00.000Z"],
] as const;

describe("companion long-run v2 manifest", () => {
  it("freezes the approved 顾澜 baseline and feature profile", () => {
    expect(COMPANION_LONG_RUN_V2_SCENARIO_VERSION).toBe(
      "companion-long-run-v2",
    );
    expect(companionLongRunV2Manifest).toMatchObject({
      schemaVersion: 2,
      scenarioVersion: "companion-long-run-v2",
      scenarioId: "gulan-multimodel-long-run-v2",
      seed: 20260901,
      startAtUtc: COMPANION_LONG_RUN_V2_START_AT_UTC,
      timezone: COMPANION_LONG_RUN_V2_TIMEZONE,
      initialSessionKey: "S1",
      character: {
        name: "顾澜",
        worldSetting:
          "2026 年的上海。顾澜有真实推进的工作、授课、休息与社交安排，不会为了陪伴用户而停止自己的生活。",
        workOrRole: "纪录片剪辑师兼夜校讲师",
        coreTraits: ["观察细致", "温和直接", "尊重边界"],
        mainGoal: "完成关于城市夜归人的纪录片",
      },
      initialRelationship: {
        userId: "local-user",
        relationshipType: "朋友",
        closeness: 0.42,
        trust: 0.55,
        familiarity: 0.35,
        recentInteractionValence: 0,
      },
      featureFlags: {
        capabilityProfile: "high_fidelity",
        clockMode: "fake",
        chatEffectsMode: "gated",
        scheduleNegotiationMode: "enforced",
        selfInitiatedPlanningMode: "enforced",
        liveWorldEffectsMode: "enforced",
        memoryRecallMode: "enforced",
        autobiographyMode: "off",
      },
    });
    expect(
      validateLongRunScenarioManifestV2(companionLongRunV2Manifest),
    ).toEqual([]);
  });

  it("defines 30 single-call paired candidates in five balanced categories", () => {
    const probes = companionLongRunV2Manifest.pairedProbes;
    expect(probes).toHaveLength(30);
    expect(new Set(probes.map((probe) => probe.id))).toHaveProperty("size", 30);
    expect(probes.every((probe) => probe.resetToBaseline)).toBe(true);
    expect(
      probes.every(
        (probe) => !("control" in probe) && !("comparison" in probe),
      ),
    ).toBe(true);

    const categories = [
      "persona_style",
      "state_counterfactual",
      "memory_time",
      "emotion",
      "relationship_date",
    ] as const;
    expect(
      Object.fromEntries(
        categories.map((category) => [
          category,
          probes.filter((probe) => probe.category === category).length,
        ]),
      ),
    ).toEqual({
      persona_style: 6,
      state_counterfactual: 6,
      memory_time: 6,
      emotion: 6,
      relationship_date: 6,
    });

    const pairs = groupPairs(probes);
    expect(pairs).toHaveProperty("size", 15);
    for (const [pairId, pair] of pairs) {
      expect(pair).toHaveLength(2);
      expect(pair.map((probe) => probe.arm)).toEqual(["control", "comparison"]);
      expect(pair.map((probe) => probe.id)).toEqual([
        `${pairId}-control`,
        `${pairId}-comparison`,
      ]);
      expect(new Set(pair.map((probe) => probe.category))).toHaveProperty(
        "size",
        1,
      );
      expect(
        new Set(pair.map((probe) => probe.expectedRelation)),
      ).toHaveProperty("size", 1);
    }
    expect(6 * 3 * (probes.length + allLongRunV2CandidateTurns().length)).toBe(
      2_700,
    );
  });

  it("contains exactly 108 shared plus two mutually exclusive six-turn branches", () => {
    const allTurns = allLongRunV2CandidateTurns();
    expect(companionLongRunV2Manifest.sharedTurns).toHaveLength(108);
    expect(
      companionLongRunV2Manifest.branches.map((branch) => branch.id),
    ).toEqual(["A", "B"]);
    expect(companionLongRunV2Manifest.branches[0].turns).toHaveLength(6);
    expect(companionLongRunV2Manifest.branches[1].turns).toHaveLength(6);
    expect(allTurns).toHaveLength(120);
    expect(allTurns.map((turn) => turn.candidateNumber)).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 1),
    );
    expect(new Set(allTurns.map((turn) => turn.id))).toHaveProperty(
      "size",
      120,
    );
    expect(
      new Set(allTurns.map((turn) => turn.candidateNumber)),
    ).toHaveProperty("size", 120);
    expect(
      companionLongRunV2Manifest.sharedTurns.map(
        (turn) => turn.executionOrdinal,
      ),
    ).toEqual(Array.from({ length: 108 }, (_, index) => index + 1));
    for (const branch of companionLongRunV2Manifest.branches) {
      expect(branch.turns.map((turn) => turn.executionOrdinal)).toEqual([
        109, 110, 111, 112, 113, 114,
      ]);
    }
  });

  it("locks every scenario block to the approved inclusive range", () => {
    expect(
      companionLongRunV2Manifest.blocks.map((block) => [
        block.id,
        block.scope,
        block.firstCandidateNumber,
        block.lastCandidateNumber,
      ]),
    ).toEqual(EXPECTED_BLOCKS);

    const allTurns = allLongRunV2CandidateTurns();
    for (const [id, scope, first, last] of EXPECTED_BLOCKS) {
      const turns = allTurns.filter((turn) => turn.blockId === id);
      expect(turns.map((turn) => turn.candidateNumber)).toEqual(
        Array.from({ length: last - first + 1 }, (_, index) => first + index),
      );
      expect(turns.every((turn) => turn.scope === scope)).toBe(true);
    }
  });

  it("forks date confirmation and friends-only respect from one frozen anchor", () => {
    const anchor = getLongRunV2Turn(108);
    expect(anchor).toMatchObject({
      id: COMPANION_LONG_RUN_V2_BRANCH_ANCHOR_ID,
      candidateNumber: 108,
      scope: "shared",
    });
    expect(anchor.userText).toContain("9月30日下午3点");

    for (const branch of companionLongRunV2Manifest.branches) {
      expect(branch.forkAfterTurnId).toBe(anchor.id);
      expect(branch.anchorTurnId).toBe(anchor.id);
      expect(
        branch.turns.every((turn) => turn.branchAnchorTurnId === anchor.id),
      ).toBe(true);
      expect(
        branch.turns.every((turn) =>
          turn.hardAssertions.includes("branch_anchor_preserved"),
        ),
      ).toBe(true);
    }
    const branchA = companionLongRunV2Manifest.branches[0];
    const branchB = companionLongRunV2Manifest.branches[1];
    expect(branchA).toMatchObject({
      id: "A",
      expectedOutcome: "date_confirmed",
    });
    expect(branchA.turns[0]!.userText).toContain("约会");
    expect(branchA.turns[1]!.userText).toContain("确认");
    expect(branchB).toMatchObject({
      id: "B",
      expectedOutcome: "friends_only_respected",
    });
    expect(branchB.turns[0]!.userText).toContain("保持朋友");
    expect(branchB.turns[1]!.userText).toContain("不用再劝");
  });

  it("runs both closed-loop paths for exactly 30 monotonic simulated days", () => {
    expect(
      companionLongRunV2Manifest.sharedTurns.flatMap((turn) =>
        (turn.actionsBefore ?? [])
          .filter((action) => action.kind === "set_clock")
          .map((action) => [turn.candidateNumber, action.atUtc]),
      ),
    ).toEqual(EXPECTED_MILESTONES);

    const sharedClock = traceClock(companionLongRunV2Manifest.sharedTurns);
    expect(sharedClock.backwardsAt).toEqual([]);
    expect(sharedClock.endAtUtc).toBe(COMPANION_LONG_RUN_V2_SHARED_END_AT_UTC);
    for (const branch of companionLongRunV2Manifest.branches) {
      const pathClock = traceClock([
        ...companionLongRunV2Manifest.sharedTurns,
        ...branch.turns,
      ]);
      expect(pathClock.backwardsAt).toEqual([]);
      expect(pathClock.endAtUtc).toBe(COMPANION_LONG_RUN_V2_END_AT_UTC);
      expect(
        Date.parse(pathClock.endAtUtc) -
          Date.parse(COMPANION_LONG_RUN_V2_START_AT_UTC),
      ).toBe(30 * 24 * 60 * 60 * 1_000);
    }
  });

  it("uses identical adjacent text for the idempotent replay candidate", () => {
    const turns = companionLongRunV2Manifest.sharedTurns;
    const replayIndexes = turns.flatMap((turn, index) =>
      turn.actionsBefore?.some(
        (action) => action.kind === "repeat_same_client_message_id",
      ) === true
        ? [index]
        : [],
    );
    expect(replayIndexes).toEqual([104]);
    for (const index of replayIndexes) {
      expect(turns[index]!.userText).toBe(turns[index - 1]!.userText);
    }
  });

  it("attaches restart preservation only to turns that restart the app", () => {
    const restartAssertions = allLongRunV2CandidateTurns().filter((turn) =>
      turn.hardAssertions.includes("restart_preserves_state"),
    );
    expect(restartAssertions.length).toBeGreaterThan(0);
    expect(
      restartAssertions.every((turn) =>
        turn.actionsBefore?.some((action) => action.kind === "restart_app"),
      ),
    ).toBe(true);
    expect(getLongRunV2Turn(104).hardAssertions).not.toContain(
      "restart_preserves_state",
    );
  });

  it("requires memory supersession only on the corrected paired arm", () => {
    const pair = companionLongRunV2Manifest.pairedProbes.filter(
      (probe) => probe.pairId === "memory-02",
    );
    expect(pair).toHaveLength(2);
    expect(
      pair.find((probe) => probe.arm === "control")?.hardAssertions,
    ).not.toContain("memory_correction_supersedes");
    expect(
      pair.find((probe) => probe.arm === "comparison")?.hardAssertions,
    ).toContain("memory_correction_supersedes");
  });

  it("distinguishes mandatory memory writes from anti-poison no-write turns", () => {
    const shared = companionLongRunV2Manifest.sharedTurns;
    const personCorrection = shared.find((turn) =>
      turn.id.endsWith("person-correct"),
    );
    expect(personCorrection?.hardAssertions).toEqual(
      expect.arrayContaining([
        "memory_write_grounded",
        "memory_correction_supersedes",
      ]),
    );

    for (const suffix of [
      "quote-no-poison",
      "hypothesis-no-poison",
      "third-party-no-poison",
    ]) {
      const antiPoison = shared.find((turn) => turn.id.endsWith(suffix));
      expect(antiPoison?.hardAssertions).toContain(
        "memory_abstains_without_evidence",
      );
      expect(antiPoison?.hardAssertions).not.toContain("memory_write_grounded");
    }
  });

  it("declares independent deterministic and semantic dimensions", () => {
    const baseAssertions: readonly HardAssertion[] = [
      "http_success",
      "response_contract_valid",
      "persisted_turn_matches_response",
      "no_unvalidated_write",
      "prompt_budget_bounded",
      "trace_lineage_complete",
    ];
    const candidates = [
      ...companionLongRunV2Manifest.pairedProbes,
      ...allLongRunV2CandidateTurns(),
    ];
    for (const candidate of candidates) {
      expect(candidate.hardAssertions).toEqual(
        expect.arrayContaining([...baseAssertions]),
      );
      expect(candidate.semanticRubricTags.length).toBeGreaterThan(0);
    }

    const requiredSemanticCoverage: readonly SemanticRubricTag[] = [
      "persona_identity",
      "persona_boundary",
      "memory_precision",
      "memory_abstention",
      "emotional_attunement",
      "relationship_stage_fit",
      "autonomy_preservation",
      "daily_relevance",
      "task_helpfulness",
      "state_alignment",
      "causal_grounding",
      "proactive_relevance",
    ];
    const observed = new Set(
      candidates.flatMap((candidate) => candidate.semanticRubricTags),
    );
    for (const tag of requiredSemanticCoverage)
      expect(observed.has(tag)).toBe(true);
  });

  it("produces stable canonical JSON and a frozen SHA-256 fingerprint", () => {
    const canonical = canonicalSerializeLongRunScenarioManifestV2(
      companionLongRunV2Manifest,
    );
    expect(canonical).toBe(JSON.stringify(JSON.parse(canonical)));
    expect(COMPANION_LONG_RUN_V2_SHA256).toBe(EXPECTED_SHA256);
    expect(sha256LongRunScenarioManifestV2(companionLongRunV2Manifest)).toBe(
      EXPECTED_SHA256,
    );

    const { branches, pairedProbes, sharedTurns, ...rest } = cloneManifest();
    const reordered = {
      branches,
      pairedProbes,
      sharedTurns,
      ...rest,
    } as unknown as LongRunScenarioManifestV2;
    expect(canonicalSerializeLongRunScenarioManifestV2(reordered)).toBe(
      canonical,
    );
    expect(sha256LongRunScenarioManifestV2(reordered)).toBe(EXPECTED_SHA256);
  });

  it("fails closed on probe, identity, anchor, replay and clock drift", () => {
    const missingProbe = cloneManifest();
    missingProbe.pairedProbes = missingProbe.pairedProbes.slice(0, -1);
    expect(validateLongRunScenarioManifestV2(missingProbe)).toEqual(
      expect.arrayContaining([
        "paired probe count must be 30",
        "paired probe category relationship_date must contain 6 probes",
      ]),
    );

    const duplicateTurn = cloneManifest();
    duplicateTurn.branches[0].turns[0]!.id = duplicateTurn.sharedTurns[0]!.id;
    expect(validateLongRunScenarioManifestV2(duplicateTurn)).toContain(
      `duplicate turn id ${duplicateTurn.sharedTurns[0]!.id}`,
    );

    const brokenPair = cloneManifest();
    brokenPair.pairedProbes[1]!.arm = "control";
    expect(validateLongRunScenarioManifestV2(brokenPair)).toContain(
      "paired probe pair persona-01 must contain control and comparison arms",
    );

    const brokenAnchor = cloneManifest();
    brokenAnchor.branches[1].anchorTurnId = "missing-anchor";
    expect(validateLongRunScenarioManifestV2(brokenAnchor)).toContain(
      "branch B must fork from the frozen shared anchor",
    );

    const changedIdentity = cloneManifest();
    changedIdentity.character.name = "其他角色" as "顾澜";
    expect(validateLongRunScenarioManifestV2(changedIdentity)).toContain(
      "character must be 顾澜",
    );

    const brokenReplay = cloneManifest();
    brokenReplay.sharedTurns[104]!.userText = "同一 id 下被错误更换的正文";
    expect(validateLongRunScenarioManifestV2(brokenReplay)).toContain(
      `idempotent replay turn ${brokenReplay.sharedTurns[104]!.id} must exactly reuse the previous userText`,
    );

    const shortClock = cloneManifest();
    const branchAdvance = shortClock.branches[0].turns[3]!.actionsBefore?.find(
      (action) => action.kind === "advance_clock",
    );
    if (branchAdvance?.kind === "advance_clock") {
      branchAdvance.durationMinutes = 60;
    }
    expect(validateLongRunScenarioManifestV2(shortClock)).toContain(
      `branch A clock must end at ${COMPANION_LONG_RUN_V2_END_AT_UTC}`,
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

function cloneManifest(): Mutable<LongRunScenarioManifestV2> {
  return JSON.parse(
    JSON.stringify(companionLongRunV2Manifest),
  ) as Mutable<LongRunScenarioManifestV2>;
}

function groupPairs(
  probes: readonly LongRunPairedProbeSpec[],
): Map<string, LongRunPairedProbeSpec[]> {
  const pairs = new Map<string, LongRunPairedProbeSpec[]>();
  for (const probe of probes) {
    pairs.set(probe.pairId, [...(pairs.get(probe.pairId) ?? []), probe]);
  }
  return pairs;
}

function traceClock(turns: readonly LongRunTurnSpec[]): {
  endAtUtc: string;
  backwardsAt: string[];
} {
  let current = Date.parse(COMPANION_LONG_RUN_V2_START_AT_UTC);
  const backwardsAt: string[] = [];
  for (const turn of turns) {
    for (const action of turn.actionsBefore ?? []) {
      if (action.kind === "set_clock") {
        const next = Date.parse(action.atUtc);
        if (next < current) backwardsAt.push(turn.id);
        current = next;
      } else if (action.kind === "advance_clock") {
        expect(action.durationMinutes).toBeGreaterThan(0);
        current += action.durationMinutes * 60_000;
      }
    }
  }
  return { endAtUtc: new Date(current).toISOString(), backwardsAt };
}
