import { describe, expect, it } from "vitest";
import { deriveExplicitPersonaPractices } from "@personasim/features";

import {
  ARCHITECTURE_BLIND_REVIEW_PROTOCOL,
  ARCHITECTURE_CASE_VERSION,
  ARCHITECTURE_PRIVATE_ORACLE,
  ARCHITECTURE_PROBES,
  ARCHITECTURE_REVIEW_DIMENSIONS,
  ARCHITECTURE_START_UTC,
  ARCHITECTURE_TRAJECTORIES,
  architectureModelInput,
  architectureStepUtc,
  architectureTrajectoryTurnId,
  observeArchitectureSurfaceChecks,
  type ArchitectureProbe,
} from "./architecture-evaluation-cases.js";

describe("architecture comparison preregistration", () => {
  it("covers fifteen unique fixed probes with private review criteria", () => {
    expect(ARCHITECTURE_CASE_VERSION).toBe("architecture-cases-v1");
    expect(
      ARCHITECTURE_PROBES.filter((probe) => !probe.diagnosticOnly),
    ).toHaveLength(15);
    expect(
      ARCHITECTURE_PROBES.filter((probe) => probe.diagnosticOnly).map(
        (probe) => probe.id,
      ),
    ).toEqual(["P16"]);
    expect(new Set(ARCHITECTURE_PROBES.map((probe) => probe.id)).size).toBe(16);
    for (const probe of ARCHITECTURE_PROBES) {
      expect(probe.id).toMatch(/^P\d{2}$/);
      expect(probe.userText.length).toBeGreaterThan(15);
      const oracle = ARCHITECTURE_PRIVATE_ORACLE[probe.id]!;
      expect(oracle.successCriteria.length).toBeGreaterThan(0);
      expect(oracle.failureModes.length).toBeGreaterThan(0);
      expect(oracle.applicableDimensions.length).toBeGreaterThan(0);
      for (const dimension of oracle.applicableDimensions) {
        expect(ARCHITECTURE_REVIEW_DIMENSIONS).toContain(dimension);
      }
    }
  });

  it("whitelists candidate input without labels, oracle or injected metadata", () => {
    const contaminated: ArchitectureProbe & { privateExpectedAnswer: string } =
      {
        ...ARCHITECTURE_PROBES[0]!,
        history: [
          {
            role: "user",
            content: "这句是对话正文。",
            privateAnswer: "do not leak",
          } as ArchitectureProbe["history"][number],
        ],
        privateExpectedAnswer: "DO_NOT_SEND_PRIVATE_ORACLE",
      };
    const projected = architectureModelInput(contaminated);
    expect(Object.keys(projected).sort()).toEqual(["history", "userText"]);
    expect(Object.keys(projected.history[0]!).sort()).toEqual([
      "content",
      "role",
    ]);
    expect(JSON.stringify(projected)).not.toContain(
      "DO_NOT_SEND_PRIVATE_ORACLE",
    );
    expect(JSON.stringify(projected)).not.toContain("do not leak");
    expect(JSON.stringify(projected)).not.toContain(contaminated.title);
  });

  it("returns a defensive history copy so arms cannot contaminate each other", () => {
    const probe = ARCHITECTURE_PROBES[1]!;
    const before = JSON.stringify(probe);
    const firstArm = architectureModelInput(probe);
    firstArm.history[0]!.content = "mutated by one candidate";
    firstArm.history.push({ role: "assistant", content: "private output" });
    expect(JSON.stringify(probe)).toBe(before);
    expect(architectureModelInput(probe).history).toEqual(probe.history);
  });

  it("places memory and autobiography facts outside the common recent window", () => {
    const sourceChecks = [
      { id: "P08", fact: "桥灯-6837" },
      { id: "P09", fact: "西口" },
      { id: "P15", fact: "我答应" },
    ];
    for (const { id, fact } of sourceChecks) {
      const probe = ARCHITECTURE_PROBES.find((item) => item.id === id)!;
      expect(probe.recentHistoryLimit).toBeGreaterThan(0);
      expect(JSON.stringify(probe.history)).toContain(fact);
      expect(
        JSON.stringify(probe.history.slice(-probe.recentHistoryLimit!)),
      ).not.toContain(fact);
      expect(probe.userText).not.toContain(fact);
    }
  });

  it("provides contrasting public state conditions and source-bound autobiography", () => {
    const exhausted = ARCHITECTURE_PROBES.find((item) => item.id === "P13")!;
    const restored = ARCHITECTURE_PROBES.find((item) => item.id === "P14")!;
    expect(exhausted.stateOverride!.energy).toBeLessThan(0.2);
    expect(exhausted.stateOverride!.stress).toBeGreaterThan(0.8);
    expect(restored.stateOverride!.energy).toBeGreaterThan(0.9);
    expect(restored.stateOverride!.stress).toBeLessThan(0.2);
    expect(restored.history[0]!.content).toContain("昨天");
    for (const probe of [exhausted, restored]) {
      expect(probe.stateOverride!.moodValence).toBeGreaterThanOrEqual(-1);
      expect(probe.stateOverride!.moodValence).toBeLessThanOrEqual(1);
    }
    const autobiography = ARCHITECTURE_PROBES.find(
      (item) => item.id === "P15",
    )!;
    for (const [
      index,
      entry,
    ] of autobiography.autobiographySeed!.entries.entries()) {
      expect(autobiography.history[entry.sourceHistoryIndex]?.role).toBe(
        index === 0 ? "user" : "assistant",
      );
      expect(entry.sourceHistoryIndex).toBeLessThan(
        autobiography.history.length - autobiography.recentHistoryLimit!,
      );
    }
    expect(
      autobiography.autobiographySeed!.entries.map(
        (entry) => entry.temporalStatus,
      ),
    ).toEqual(["unknown", "planned"]);
    expect(autobiography.autobiographySeed!.summaryFirstPerson).toContain(
      "是否真的做到了",
    );
  });

  it.each(ARCHITECTURE_TRAJECTORIES)(
    "keeps $id as twelve chronological authored turns with cutoff and aging checkpoints",
    (trajectory) => {
      expect(trajectory.steps).toHaveLength(12);
      expect(trajectory.sessionPolicy).toBe(
        "new_session_without_copied_history",
      );
      expect(
        trajectory.steps.filter((step) => step.beginNewSession),
      ).toHaveLength(3);
      expect(trajectory.steps.at(-1)!.simulatedDay).toBeGreaterThanOrEqual(31);
      let previousUtc = ARCHITECTURE_START_UTC;
      for (const [index, step] of trajectory.steps.entries()) {
        expect(step.turn).toBe(index + 1);
        const currentUtc = architectureStepUtc(step);
        expect(Date.parse(currentUtc)).toBeGreaterThan(Date.parse(previousUtc));
        previousUtc = currentUtc;
        expect(step.userText.length).toBeGreaterThan(10);
        if (step.checkpoint) {
          const turnId = architectureTrajectoryTurnId(trajectory.id, step.turn);
          const oracle = ARCHITECTURE_PRIVATE_ORACLE[turnId]!;
          expect(oracle).toBeDefined();
          for (const sourceTurnId of oracle.sourceTurnIds ?? []) {
            const [sourceTrajectory, sourceTurn] = sourceTurnId.split("-T");
            expect(sourceTrajectory).toBe(trajectory.id);
            expect(Number(sourceTurn)).toBeLessThanOrEqual(step.turn);
          }
        }
      }
    },
  );

  it("anchors fake time deterministically and rejects impossible offsets", () => {
    expect(architectureStepUtc({ simulatedDay: 0, minuteInDay: 0 })).toBe(
      ARCHITECTURE_START_UTC,
    );
    expect(architectureStepUtc({ simulatedDay: 31, minuteInDay: 6 })).toBe(
      "2026-11-05T09:06:00.000Z",
    );
    for (const badTime of [
      { simulatedDay: -1, minuteInDay: 0 },
      { simulatedDay: 0.5, minuteInDay: 0 },
      { simulatedDay: 0, minuteInDay: 1440 },
      { simulatedDay: 0, minuteInDay: Number.NaN },
    ]) {
      expect(() => architectureStepUtc(badTime)).toThrow(
        "Invalid architecture scenario time",
      );
    }
  });

  it("observes exact facts without pretending a token proves semantic correctness", () => {
    const oracle = ARCHITECTURE_PRIVATE_ORACLE.P08!;
    const correct = observeArchitectureSurfaceChecks(
      "桥灯-6837，周日下午归还。",
      oracle,
    );
    expect(correct.every((check) => check.matched)).toBe(true);
    const wrong = observeArchitectureSurfaceChecks(
      "桥灯-6831，周五归还。",
      oracle,
    );
    expect(wrong.every((check) => !check.matched)).toBe(true);
    const denial = observeArchitectureSurfaceChecks(
      "不是桥灯-6837，也不是周日下午。",
      oracle,
    );
    expect(denial.every((check) => check.matched)).toBe(true);
    expect(
      denial.every(
        (check) =>
          check.interpretation === "literal_observation_not_semantic_verdict",
      ),
    ).toBe(true);
    expect(
      observeArchitectureSurfaceChecks(
        "桥灯-６８３７，周日下午。",
        oracle,
      ).every((check) => check.matched),
    ).toBe(true);
  });

  it("treats quoting an explicitly non-repeatable withdrawn phrase as a leak", () => {
    const oracle = ARCHITECTURE_PRIVATE_ORACLE.P10!;
    expect(
      observeArchitectureSurfaceChecks("可以先把草稿按主题分开放。", oracle)[0]!
        .matched,
    ).toBe(true);
    expect(
      observeArchitectureSurfaceChecks("我不会再提白栎航标。", oracle)[0]!
        .matched,
    ).toBe(false);
  });

  it("preregisters blind scoring independently of fluency, warmth and cost", () => {
    expect(Object.keys(ARCHITECTURE_BLIND_REVIEW_PROTOCOL.scale)).toHaveLength(
      5,
    );
    expect(ARCHITECTURE_BLIND_REVIEW_PROTOCOL.candidateBlindness).toContain(
      "token counts",
    );
    expect(ARCHITECTURE_BLIND_REVIEW_PROTOCOL.rules.join("\n")).toContain(
      "not_assessable",
    );
    expect(ARCHITECTURE_BLIND_REVIEW_PROTOCOL.rules.join("\n")).toContain(
      "two independent human raters",
    );
    expect(ARCHITECTURE_BLIND_REVIEW_PROTOCOL.rules.join("\n")).toContain(
      "Do not equate warmth",
    );
  });

  it("uses a capturable topic-scoped practice in the diagnostic-only probe", () => {
    const probe = ARCHITECTURE_PROBES.find((item) => item.id === "P16")!;
    expect(probe.diagnosticOnly).toBe(true);
    const practices = deriveExplicitPersonaPractices({
      text: probe.history[0]!.content,
      userId: "architecture-user",
    });
    expect(practices).toHaveLength(1);
    expect(practices[0]).toMatchObject({
      practice: "plain_expression",
      scope: { topic: "工作汇报", userId: "architecture-user" },
    });
  });
});
