import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmCallMetric } from "@personasim/providers";
import { afterEach, describe, expect, it } from "vitest";

import { readConfig } from "../config.js";
import { ARCHITECTURE_TRAJECTORIES } from "./architecture-evaluation-cases.js";
import {
  architectureConfig,
  architectureFixtureFetch,
} from "./architecture-evaluation-runtime.js";
import {
  architectureLongitudinalBranches,
  runArchitectureLongitudinal,
  runArchitectureLongitudinalExperiment,
  type ArchitectureLongitudinalTurnInput,
  type ArchitectureLongitudinalTurnResult,
} from "./architecture-longitudinal-experiment.js";

const temporaryRoots: string[] = [];
function outputDirectory() {
  const root = mkdtempSync(join(tmpdir(), "architecture-longitudinal-test-"));
  temporaryRoots.push(root);
  return join(root, "run");
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function providerMetric(overrides: Partial<LlmCallMetric> = {}): LlmCallMetric {
  return {
    provider: "openai-compatible",
    model: "offline-test",
    purpose: "chat_turn",
    attempt: 1,
    latencyMs: 10,
    success: true,
    usageSource: "provider",
    inputTokens: 80,
    outputTokens: 8,
    ...overrides,
  };
}
function reply(
  text: string,
  overrides: Partial<ArchitectureLongitudinalTurnResult> = {},
): ArchitectureLongitudinalTurnResult {
  return {
    text,
    events: [],
    metrics: [providerMetric()],
    elapsedMs: 10,
    ...overrides,
  };
}

describe("architecture longitudinal matrix", () => {
  it("preregisters 12 branches and 144 authored-user candidates with a stable shuffled order", () => {
    const branches = architectureLongitudinalBranches();
    expect(branches).toHaveLength(12);
    expect(branches.length * 12).toBe(144);
    expect(new Set(branches.map((branch) => branch.branchId)).size).toBe(12);
    expect(branches).toEqual(architectureLongitudinalBranches());
    expect(branches).not.toEqual(
      architectureLongitudinalBranches({
        randomizationSeed: "different-order",
      }),
    );
    expect(() =>
      architectureLongitudinalBranches({
        personas: ["social-outward", "social-outward"],
      }),
    ).toThrow("duplicate personas");
    expect(() =>
      architectureLongitudinalBranches({ personas: ["../outside"] }),
    ).toThrow("Invalid");
    expect(() => architectureLongitudinalBranches({ repetitions: 0 })).toThrow(
      "Invalid longitudinal matrix",
    );
  });

  it("keeps own generated history isolated, preserves a global tail across sessions and freezes blind prefixes", async () => {
    const directory = outputDirectory();
    const seen: { arm: string; input: ArchitectureLongitudinalTurnInput }[] =
      [];
    const closes: string[] = [];
    const sessions: { arm: string; ordinal: number }[] = [];
    const result = await runArchitectureLongitudinalExperiment({
      directory,
      personas: ["social-outward"],
      trajectories: [ARCHITECTURE_TRAJECTORIES[0]!],
      createDriver: (branch) =>
        Promise.resolve({
          beginSession: ({ sessionOrdinal }) => {
            sessions.push({ arm: branch.arm, ordinal: sessionOrdinal });
            return Promise.resolve();
          },
          turn: (input) => {
            seen.push({ arm: branch.arm, input: structuredClone(input) });
            return Promise.resolve(
              reply(`${branch.arm} 的回答 ${input.turnId}`),
            );
          },
          close: () => {
            closes.push(branch.arm);
            return Promise.resolve();
          },
        }),
    });
    expect(result).toMatchObject({
      plannedCandidates: 36,
      completedCandidates: 36,
      failedCandidates: 0,
      skippedCandidates: 0,
    });
    expect(closes).toHaveLength(3);
    expect(sessions).toHaveLength(9);
    for (const { arm, input } of seen) {
      expect(
        input.history
          .filter((message) => message.role === "assistant")
          .every((message) => message.content.startsWith(arm)),
      ).toBe(true);
      expect(Object.keys(input)).not.toContain("privateExpectation");
      expect(input.history).toHaveLength((input.step.turn - 1) * 2);
      if ([1, 9, 11].includes(input.step.turn))
        expect(input.sessionHistory).toHaveLength(0);
      if (input.step.turn === 9) expect(input.history).toHaveLength(16);
    }
    const blind = JSON.parse(
      readFileSync(join(directory, "blind-review.json"), "utf8"),
    ) as {
      label: string;
      ownPriorMessages: unknown[];
      currentUserText: string;
    }[];
    const firstCheckpointUser =
      ARCHITECTURE_TRAJECTORIES[0]!.steps[3]!.userText;
    expect(
      blind
        .filter((packet) => packet.currentUserText === firstCheckpointUser)
        .every((packet) => packet.ownPriorMessages.length === 6),
    ).toBe(true);
    expect(
      blind.every(
        (packet) =>
          !packet.label.includes("simple") && !packet.label.includes("full"),
      ),
    ).toBe(true);
    expect(readFileSync(join(directory, "manifest.json"), "utf8")).toContain(
      "favors a stronger recent-only baseline",
    );
  });

  it("stops a failed branch without fabricated replies and continues independent branches", async () => {
    const seen = new Map<string, number>();
    const result = await runArchitectureLongitudinalExperiment({
      directory: outputDirectory(),
      personas: ["social-private"],
      arms: ["full_native", "simple_recent"],
      trajectories: [ARCHITECTURE_TRAJECTORIES[0]!],
      createDriver: (branch) =>
        Promise.resolve({
          beginSession: () => Promise.resolve(),
          turn: (input) => {
            seen.set(branch.arm, (seen.get(branch.arm) ?? 0) + 1);
            return Promise.resolve(
              branch.arm === "full_native" && input.step.turn === 2
                ? reply("", {
                    error: "provider_failed",
                    metrics: [providerMetric({ success: false })],
                  })
                : reply("这是一条独立回答。"),
            );
          },
          close: () => Promise.resolve(),
        }),
    });
    expect(seen.get("full_native")).toBe(2);
    expect(seen.get("simple_recent")).toBe(12);
    expect(result).toMatchObject({
      plannedCandidates: 24,
      completedCandidates: 13,
      failedCandidates: 1,
      skippedCandidates: 10,
    });
    expect(
      result.records.find((record) => record.status === "failed")
        ?.providerInputTokens,
    ).toBe(80);
    expect(
      result.records
        .filter((record) => record.status === "skipped")
        .every(
          (record) => record.text === "" && record.physicalMetricCount === 0,
        ),
    ).toBe(true);
  });

  it("retains paid-attempt evidence if a read-only checkpoint fails after generation", async () => {
    const trajectory = {
      ...ARCHITECTURE_TRAJECTORIES[0]!,
      steps: [{ ...ARCHITECTURE_TRAJECTORIES[0]!.steps[0]!, checkpoint: true }],
    };
    const directory = outputDirectory();
    const result = await runArchitectureLongitudinalExperiment({
      directory,
      personas: ["social-private"],
      arms: ["full_native"],
      trajectories: [trajectory],
      createDriver: () =>
        Promise.resolve({
          beginSession: () => Promise.resolve(),
          turn: () =>
            Promise.resolve(
              reply("已经生成的回答。", {
                events: [{ stage: "completed", audit: "preserved" }],
              }),
            ),
          checkpoint: () => Promise.reject(new Error("snapshot_failed")),
          close: () => Promise.resolve(),
        }),
    });
    expect(result.records[0]).toMatchObject({
      status: "failed",
      error: "snapshot_failed",
      text: "已经生成的回答。",
      providerInputTokens: 80,
      physicalMetricCount: 1,
    });
    const turnFile = join(
      directory,
      result.records[0]!.branchId,
      "L01-T01.json",
    );
    expect(readFileSync(turnFile, "utf8")).toContain("preserved");
  });

  it("refuses to overwrite an existing experiment before creating a runtime", async () => {
    const directory = outputDirectory();
    const options = {
      directory,
      personas: ["social-private"],
      arms: ["simple_recent" as const],
      trajectories: [
        {
          ...ARCHITECTURE_TRAJECTORIES[0]!,
          steps: [ARCHITECTURE_TRAJECTORIES[0]!.steps[0]!],
        },
      ],
      createDriver: () =>
        Promise.resolve({
          beginSession: () => Promise.resolve(),
          turn: () => Promise.resolve(reply("可以。")),
          close: () => Promise.resolve(),
        }),
    };
    await runArchitectureLongitudinalExperiment(options);
    await expect(
      runArchitectureLongitudinalExperiment(options),
    ).rejects.toThrow("must be new");
  });

  it("runs the concrete full-native adapter through the product route without network", async () => {
    const directory = outputDirectory();
    const base = readConfig();
    const config = architectureConfig(
      base,
      {
        ...base.llm,
        provider: "openai-compatible",
        profileName: "offline-architecture-test",
        apiKey: "offline-test-key",
        baseUrl: "https://example.invalid",
        model: "offline-test-model",
        maxRetries: 0,
      },
      directory,
    );
    let calls = 0;
    const result = await runArchitectureLongitudinal({
      directory,
      config,
      transport: (url, init) => {
        calls += 1;
        return architectureFixtureFetch(url, init);
      },
      personas: ["social-private"],
      arms: ["full_native"],
      trajectories: [
        {
          ...ARCHITECTURE_TRAJECTORIES[1]!,
          steps: ARCHITECTURE_TRAJECTORIES[1]!.steps.slice(0, 2),
        },
      ],
    });
    expect(result.plannedCandidates).toBe(2);
    expect(result.failedCandidates).toBe(0);
    expect(result.completedCandidates).toBe(2);
    expect(calls).toBeGreaterThanOrEqual(2);
    const checkpoint = JSON.parse(
      readFileSync(
        join(directory, result.records[1]!.branchId, "L02-T02.json"),
        "utf8",
      ),
    ) as { checkpointEvidence: { rows: Record<string, unknown[]> } };
    expect(
      checkpoint.checkpointEvidence.rows.messages!.length,
    ).toBeGreaterThanOrEqual(4);
  }, 30000);
});
