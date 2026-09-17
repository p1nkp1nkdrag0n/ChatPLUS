import { describe, expect, it } from "vitest";
import { auditRuntimeStateLifecycle } from "./runtime-state-lifecycle-audit.js";

function row(
  turnId: string,
  atUtc: string,
  before: Record<string, number>,
  after = before,
  runtime: Record<string, number> | null = before,
) {
  return {
    branchId: "character-a",
    turnId,
    actualPrompt: { runtime },
    commitEvent: { recordedAtUtc: atUtc, before, after },
    userText: "Private quoted content must not appear in aggregate reports",
  };
}

describe("runtime state lifecycle audit", () => {
  it("distinguishes committed changes, delivered values and long unchanged gaps", () => {
    const result = auditRuntimeStateLifecycle({
      rows: [
        row("t1", "2026-09-01T00:00:00Z", { energy: 0.7 }, { energy: 0.4 }),
        row("t2", "2026-09-03T00:00:00Z", { energy: 0.4 }),
        row("t3", "2026-09-03T00:01:00Z", { energy: 0.3 }),
      ],
    });
    expect(result.fields["energy"]).toMatchObject({
      promptObservations: 3,
      uniquePromptValues: 3,
      changedCommits: 1,
      promptBeforeDifferences: 0,
      comparableNextTurns: 2,
      nextTurnDifferences: 1,
      unchangedAcrossDayOrLonger: 1,
      maximumGapHoursWithoutValueChange: 48,
    });
    expect(JSON.stringify(result)).not.toContain("Private quoted content");
  });

  it("never substitutes zero for omitted sleep or missing runtime snapshots", () => {
    const result = auditRuntimeStateLifecycle({
      rows: [
        row("t1", "2026-09-01T00:00:00Z", { energy: 0.7 }),
        row("t2", "2026-09-01T00:01:00Z", { energy: 0.7 }, undefined, null),
      ],
    });
    expect(result.fields["sleepDebtMinutes"]).toMatchObject({
      promptObservations: 0,
      missingPromptObservations: 2,
      minimum: null,
      maximum: null,
      comparableCommits: 0,
      changedCommits: 0,
      comparableNextTurns: 0,
      maximumGapHoursWithoutValueChange: null,
    });
    expect(result.fields["energy"]).toMatchObject({
      promptObservations: 1,
      comparableCommits: 2,
      comparableNextTurns: 0,
      maximumGapHoursWithoutValueChange: null,
    });
  });

  it("reports no unchanged gap when every comparable next turn differs", () => {
    const result = auditRuntimeStateLifecycle({
      rows: [
        row("t1", "2026-09-01T00:00:00Z", { energy: 0.7 }, { energy: 0.4 }),
        row("t2", "2026-09-02T00:00:00Z", { energy: 0.3 }, { energy: 0.2 }),
        row("t3", "2026-09-03T00:00:00Z", { energy: 0.1 }),
      ],
    });
    expect(result.fields["energy"]).toMatchObject({
      comparableNextTurns: 2,
      nextTurnDifferences: 2,
      unchangedAcrossDayOrLonger: 0,
      maximumGapHoursWithoutValueChange: null,
    });
  });

  it("preserves an observed zero-hour unchanged gap as zero", () => {
    const result = auditRuntimeStateLifecycle({
      rows: [
        row("t1", "2026-09-01T00:00:00Z", { energy: 0.7 }, { energy: 0.4 }),
        row("t2", "2026-09-01T00:00:00Z", { energy: 0.4 }),
      ],
    });
    expect(result.fields["energy"]).toMatchObject({
      comparableNextTurns: 1,
      nextTurnDifferences: 0,
      unchangedAcrossDayOrLonger: 0,
      maximumGapHoursWithoutValueChange: 0,
    });
  });

  it("does not treat observations from separate branches as consecutive", () => {
    const first = row("t1", "2026-09-01T00:00:00Z", { stress: 0.2 });
    const second = {
      ...row("t1", "2026-09-04T00:00:00Z", { stress: 0.2 }),
      branchId: "character-b",
    };
    expect(
      auditRuntimeStateLifecycle({ rows: [first, second] }).fields["stress"],
    ).toMatchObject({ comparableNextTurns: 0, unchangedAcrossDayOrLonger: 0 });
  });

  it("rejects duplicate turns and reversed within-branch chronology", () => {
    const first = row("t1", "2026-09-02T00:00:00Z", {});
    expect(() => auditRuntimeStateLifecycle({ rows: [first, first] })).toThrow(
      "Duplicate",
    );
    expect(() =>
      auditRuntimeStateLifecycle({
        rows: [first, row("t2", "2026-09-01T00:00:00Z", {})],
      }),
    ).toThrow("chronological");
  });
});
