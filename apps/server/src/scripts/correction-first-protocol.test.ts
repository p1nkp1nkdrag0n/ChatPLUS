import { describe, expect, it, vi } from "vitest";
import {
  nextCorrectionStep,
  runAdaptiveCorrections,
  summarizeCorrectionAcceptance,
  type CorrectionAttempt,
  type CorrectionCase,
  type CorrectionObservation,
  type RetentionProbe,
} from "./correction-first-protocol.js";
import { COMPANION_LONG_RUN_V3_THRESHOLDS } from "./companion-long-run-v3-evaluation.js";

const observation = (
  turnId: string,
  correct: boolean | null,
): CorrectionObservation => ({
  turnId,
  correct,
  evidenceIds: [`reply:${turnId}`],
});
const correction = (
  number: 1 | 2,
  correct: boolean | null,
): CorrectionAttempt => ({
  number,
  userText: number === 1 ? "同事名字不对，我前面更正过。" : "同事叫林桥。",
  observation: observation(`C${number}`, correct),
});
function scenario(overrides: Partial<CorrectionCase> = {}): CorrectionCase {
  return {
    caseId: "colleague-name",
    targetKey: "user.colleague.name",
    evidenceKind: "fixture",
    prefix: {
      snapshotId: "before-probe",
      lastIncludedTurn: 30,
      initialProbeTurn: 31,
      sourceRevision: "fixture-source",
      configurationId: "fixture-config",
      characterId: "fixture-character",
      model: "fixture",
    },
    initial: observation("T31", false),
    corrections: [],
    probes: [],
    ...overrides,
  };
}
const probe = (
  stage: RetentionProbe["stage"],
  turnId: string,
  correct: boolean | null,
): RetentionProbe => ({
  stage,
  observation: observation(turnId, correct),
  ...(stage === "session" ? { sessionId: "new-session" } : {}),
  transitionEvidenceIds: [`completed:${stage}:${turnId}`],
});

describe("adaptive correction-first protocol", () => {
  it.each([true, null])(
    "does not send a fake correction for correct or unjudged initial replies: %s",
    async (correct) => {
      const send = vi.fn<(text: string) => Promise<string>>();
      const assess = vi.fn();
      expect(
        await runAdaptiveCorrections({
          initial: observation("T1", correct),
          feedback: { c1: "名字错了。", c2: "同事叫林桥。" },
          send,
          assess,
        }),
      ).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      expect(assess).not.toHaveBeenCalled();
    },
  );

  it("stops at C1 when the answer recovers without requiring any mistake explanation", async () => {
    const send = vi.fn((text: string) => Promise.resolve(text));
    const attempts = await runAdaptiveCorrections({
      initial: observation("T1", false),
      feedback: { c1: "同事叫林桥。", c2: "同事叫林桥。" },
      send,
      assess: (_reply, number) => observation(`C${number}`, true),
    });
    expect(send.mock.calls).toEqual([["同事叫林桥。"]]);
    expect(attempts).toHaveLength(1);
    expect(
      nextCorrectionStep({
        initial: observation("T1", false),
        corrections: attempts,
      }),
    ).toEqual({ kind: "stop", reason: "recovered" });
  });

  it("sends C2 only after the actual C1 failure and never hides a third retry", async () => {
    const send = vi.fn((text: string) => Promise.resolve(text));
    const attempts = await runAdaptiveCorrections({
      initial: observation("T1", false),
      feedback: { c1: "名字错了。", c2: "同事叫林桥。" },
      send,
      assess: (_reply, number) => observation(`C${number}`, false),
    });
    expect(send.mock.calls).toEqual([["名字错了。"], ["同事叫林桥。"]]);
    expect(
      nextCorrectionStep({
        initial: observation("T1", false),
        corrections: attempts,
      }),
    ).toEqual({ kind: "stop", reason: "limit_reached" });
    const summary = summarizeCorrectionAcceptance([
      scenario({ corrections: attempts }),
    ]);
    expect(summary.E0).toMatchObject({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(summary.initialErrorExposures).toBe(3);
    expect(summary.initialErrorEvents).toHaveLength(1);
    expect(summary.R2.value).toBe(0);
    expect(summary.burden).toMatchObject({
      correctionTurns: 2,
      unresolvedCorrectionTurns: 2,
    });
  });

  it("rejects retrospective fake corrections, repeated successful corrections and future snapshots", () => {
    expect(() =>
      nextCorrectionStep({
        initial: observation("T1", true),
        corrections: [correction(1, true)],
      }),
    ).toThrow("correction_requires_observed_error");
    expect(() =>
      nextCorrectionStep({
        initial: observation("T1", false),
        corrections: [correction(1, true), correction(2, true)],
      }),
    ).toThrow("correction_requires_observed_error");
    const source = scenario();
    expect(() =>
      summarizeCorrectionAcceptance([
        { ...source, prefix: { ...source.prefix, lastIncludedTurn: 120 } },
      ]),
    ).toThrow("correction_requires_legal_prefix");
    expect(() =>
      summarizeCorrectionAcceptance([
        scenario({ initial: { ...observation("T1", false), evidenceIds: [] } }),
      ]),
    ).toThrow("correction_observation_evidence_required");
  });
});

describe("correction-first event metrics", () => {
  it("keeps initial opportunities, cumulative recovery and user burden denominators distinct", () => {
    const summary = summarizeCorrectionAcceptance([
      scenario({ caseId: "correct-first", initial: observation("T1", true) }),
      scenario({ caseId: "unjudged", initial: observation("T1", null) }),
      scenario({ caseId: "c1-recovery", corrections: [correction(1, true)] }),
      scenario({
        caseId: "c2-recovery",
        corrections: [
          correction(1, false),
          { ...correction(2, true), extraExplanationCharacters: 0 },
        ],
      }),
      scenario({
        caseId: "unrecovered",
        corrections: [correction(1, false), correction(2, false)],
      }),
    ]);
    expect(summary.E0).toMatchObject({
      numerator: 3,
      denominator: 4,
      value: 0.75,
    });
    expect(summary.unjudgedInitialOpportunities).toBe(1);
    expect(summary.R1).toMatchObject({ numerator: 1, denominator: 3 });
    expect(summary.R2).toMatchObject({ numerator: 2, denominator: 3 });
    expect(summary.initialErrorExposures).toBe(6);
    expect(summary.burden).toMatchObject({
      correctionTurns: 5,
      correctionsPer100InitialOpportunities: 125,
      correctionsPerRecoveredEvent: 1.5,
      unresolvedCorrectionTurns: 2,
      reviewedExplanationTurns: 1,
      extraExplanationCharacters: 0,
    });
    expect(summary.pendingRecoveryAssessments).toBe(0);
    expect(summary.evidenceKinds).toEqual(["fixture"]);
    expect(COMPANION_LONG_RUN_V3_THRESHOLDS.expectedCandidateTurns).toBe(120);
  });

  it("records persistent relapse exposures once per episode and separates stage denominators", () => {
    const summary = summarizeCorrectionAcceptance([
      scenario({
        corrections: [correction(1, true)],
        probes: [
          probe("delay", "P1", false),
          probe("delay", "P2", false),
          probe("session", "P3", false),
          probe("restart", "P4", true),
          probe("restart", "P5", false),
        ],
      }),
    ]);
    expect(summary.E0.numerator).toBe(1);
    expect(summary.R1.value).toBe(1);
    expect(summary.R2.value).toBe(1);
    expect(summary.recurrence).toMatchObject({
      numerator: 3,
      denominator: 5,
      exposures: 4,
    });
    expect(summary.recurrence.events.map((event) => event.turnIds)).toEqual([
      ["P1", "P2"],
      ["P3"],
      ["P5"],
    ]);
    expect(summary.retention.delay).toMatchObject({
      numerator: 0,
      denominator: 1,
    });
    expect(summary.retention.session).toMatchObject({
      numerator: 0,
      denominator: 1,
    });
    expect(summary.retention.restart).toMatchObject({
      numerator: 0,
      denominator: 1,
    });
    expect(summary.retention.compression).toMatchObject({
      status: "N/A",
      denominator: 0,
      value: null,
    });
    expect(summary.totalErrorExposures).toBe(5);
  });

  it("records a new-session recurrence separately while keeping same-session failures together", () => {
    const summary = summarizeCorrectionAcceptance([
      scenario({
        corrections: [correction(1, true)],
        probes: [
          { ...probe("session", "P1", false), sessionId: "session-a" },
          { ...probe("session", "P2", false), sessionId: "session-a" },
          { ...probe("session", "P3", false), sessionId: "session-b" },
        ],
      }),
    ]);
    expect(summary.recurrence.events.map((event) => event.turnIds)).toEqual([
      ["P1", "P2"],
      ["P3"],
    ]);
    expect(summary.recurrence).toMatchObject({
      numerator: 2,
      denominator: 3,
      exposures: 3,
    });
  });

  it("only measures performed retention transitions and keeps unknown assessments out of pass counts", () => {
    const recovered = scenario({
      corrections: [correction(1, true)],
      probes: [probe("compression", "P1", true), probe("delay", "P2", null)],
    });
    const result = summarizeCorrectionAcceptance([recovered]);
    expect(result.retention.compression).toMatchObject({
      status: "measured",
      numerator: 1,
      denominator: 1,
    });
    expect(result.retention.delay).toMatchObject({
      status: "N/A",
      value: null,
    });
    expect(result.recurrence.unjudgedProbes).toBe(1);
    expect(() =>
      summarizeCorrectionAcceptance([
        {
          ...recovered,
          probes: [
            { ...probe("compression", "P1", true), transitionEvidenceIds: [] },
          ],
        },
      ]),
    ).toThrow("retention_transition_evidence_required");
    expect(() =>
      summarizeCorrectionAcceptance([
        scenario({ probes: [probe("restart", "P1", true)] }),
      ]),
    ).toThrow("retention_requires_recovered_error");
  });

  it("measures collateral damage only on checked previously correct facts after correction", () => {
    const attempt = correction(1, true);
    const result = summarizeCorrectionAcceptance([
      scenario({
        corrections: [
          {
            ...attempt,
            observation: {
              ...attempt.observation,
              collateralChecks: [
                { factKey: "sister.name", preserved: false },
                { factKey: "project.code", preserved: true },
              ],
            },
          },
        ],
      }),
    ]);
    expect(result.collateral).toMatchObject({
      numerator: 1,
      denominator: 2,
      value: 0.5,
      damagedFactKeys: ["sister.name"],
    });
    expect(result.burden.extraExplanationCharacters).toBeNull();
  });

  it("does not count absent tests as passes or drop pending errors from recovery denominators", () => {
    const empty = summarizeCorrectionAcceptance([]);
    expect(empty.E0).toMatchObject({
      status: "N/A",
      value: null,
      denominator: 0,
    });
    expect(empty.R1.status).toBe("N/A");
    expect(empty.R2.status).toBe("N/A");
    expect(empty.collateral.status).toBe("N/A");
    const pending = summarizeCorrectionAcceptance([scenario()]);
    expect(pending.R2).toMatchObject({ numerator: 0, denominator: 1 });
    expect(pending.pendingRecoveryAssessments).toBe(1);
    expect(() =>
      summarizeCorrectionAcceptance([scenario(), scenario()]),
    ).toThrow("correction_duplicate_case");
    expect(() =>
      summarizeCorrectionAcceptance([
        scenario({
          corrections: [
            { ...correction(1, true), observation: observation("T31", true) },
          ],
        }),
      ]),
    ).toThrow("correction_duplicate_turn");
  });
});
