import {
  OutcomeRecordSchema,
  PressureEpisodeSchema,
  ReflectionRecordSchema,
  type OutcomeRecord,
  type PressureEpisode,
  type ReflectionRecord,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import {
  linkPressureOutcomeEvidence,
  pressureLifecycleSnapshot,
  progressPressureFromOutcome,
  progressPressureFromReflection,
} from "./fuzzy-life-pressure-projection.js";

const START_UTC = "2026-09-01T08:00:00.000Z";
const LATER_UTC = "2026-09-02T08:00:00.000Z";

function pressure(overrides: Partial<PressureEpisode> = {}): PressureEpisode {
  return PressureEpisodeSchema.parse({
    id: "pressure-1",
    agentId: "agent-1",
    sessionId: "session-1",
    subject: "user",
    pressureKind: "work",
    triggerSummary: "正在权衡工作选择",
    status: "open",
    initialPressure: 0.6,
    currentPressure: 0.6,
    initialClarity: 0.4,
    currentClarity: 0.4,
    initialFeltUnderstood: 0.2,
    currentFeltUnderstood: 0.2,
    interventionIds: [],
    outcomeIds: [],
    sourceMessageIds: ["message-1"],
    latestEvidenceMessageId: "message-1",
    effectiveLocalDate: "2026-09-01",
    effectivePeriod: "morning",
    temporalPrecision: "period",
    recordedAtUtc: START_UTC,
    updatedAtUtc: START_UTC,
    idempotencyKey: "pressure:key",
    schemaVersion: 1,
    ...overrides,
  });
}

function outcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return OutcomeRecordSchema.parse({
    id: "outcome-1",
    agentId: "agent-1",
    sessionId: "session-1",
    decisionId: "decision-1",
    actionIds: ["action-1"],
    causeKind: "action",
    valence: "positive",
    summary: "申请得到积极答复",
    consequenceFacts: ["公司同意了申请"],
    sourceEvidenceIds: ["message-2"],
    confidence: 0.9,
    status: "confirmed",
    effectiveLocalDate: "2026-09-02",
    effectivePeriod: "afternoon",
    temporalPrecision: "period",
    recordedAtUtc: LATER_UTC,
    idempotencyKey: "outcome:key",
    schemaVersion: 1,
    ...overrides,
  });
}

function reflection(
  overrides: Partial<ReflectionRecord> = {},
): ReflectionRecord {
  return ReflectionRecordSchema.parse({
    id: "reflection-1",
    agentId: "agent-1",
    sessionId: "session-1",
    subject: "user",
    reflectedBy: "user",
    decisionId: "decision-1",
    outcomeId: "outcome-1",
    summary: "回头看仍然认同这个选择",
    lessons: ["愿意承担选择的代价"],
    stanceTowardDecision: "affirm",
    changedInterpretation: false,
    sourceMessageIds: ["message-3"],
    effectiveLocalDate: "2026-09-02",
    effectivePeriod: "evening",
    temporalPrecision: "period",
    recordedAtUtc: LATER_UTC,
    idempotencyKey: "reflection:key",
    schemaVersion: 1,
    ...overrides,
  });
}

describe("fuzzy-life pressure projections", () => {
  it("can link outcome evidence without changing the pressure trajectory", () => {
    const updated = linkPressureOutcomeEvidence(
      pressure(),
      outcome(),
      LATER_UTC,
    );

    expect(updated).toMatchObject({
      status: "open",
      currentPressure: 0.6,
      currentClarity: 0.4,
      outcomeIds: ["outcome-1"],
      sourceMessageIds: ["message-1", "message-2"],
      latestEvidenceMessageId: "message-2",
      effectiveLocalDate: "2026-09-02",
      effectivePeriod: "afternoon",
      temporalPrecision: "period",
      updatedAtUtc: LATER_UTC,
    });
  });

  it("projects positive and negative outcomes with the original deltas", () => {
    const positive = progressPressureFromOutcome(
      pressure(),
      outcome(),
      LATER_UTC,
    );
    const negative = progressPressureFromOutcome(
      pressure(),
      outcome({ valence: "negative" }),
      LATER_UTC,
    );

    expect(pressureLifecycleSnapshot(positive)).toMatchObject({
      status: "improving",
      pressure: 0.48,
      clarity: 0.54,
      outcomeIds: ["outcome-1"],
      latestEvidenceMessageId: "message-2",
    });
    const negativeSnapshot = pressureLifecycleSnapshot(negative);
    expect(negativeSnapshot.status).toBe("worsening");
    expect(negativeSnapshot.pressure).toBeCloseTo(0.7);
    expect(negativeSnapshot.clarity).toBeCloseTo(0.48);
  });

  it("resolves a completed chain only when a linked outcome is affirmed", () => {
    const linked = pressure({ outcomeIds: ["outcome-1"] });
    const resolved = progressPressureFromReflection(
      linked,
      reflection(),
      LATER_UTC,
    );
    const questioned = progressPressureFromReflection(
      pressure(),
      reflection({ stanceTowardDecision: "question" }),
      LATER_UTC,
    );

    expect(resolved).toMatchObject({
      status: "resolved",
      currentPressure: 0.54,
      currentClarity: 0.52,
      sourceMessageIds: ["message-1", "message-3"],
      latestEvidenceMessageId: "message-3",
      resolutionEvidenceMessageId: "message-3",
    });
    expect(questioned).toMatchObject({
      status: "worsening",
      currentPressure: 0.62,
      currentClarity: 0.46,
      resolutionEvidenceMessageId: undefined,
    });
  });
});
