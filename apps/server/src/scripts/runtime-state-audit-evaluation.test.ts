import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleChatPrompt } from "@personasim/features";
import * as configuration from "../config.js";
import * as steering from "./reply-steering-runner.js";
import * as architectureRuntime from "./architecture-evaluation-runtime.js";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";
import {
  RUNTIME_STATE_AUDIT_CASES,
  RUNTIME_STATE_AUDIT_NEUTRAL,
} from "./runtime-state-audit-cases.js";
import {
  buildRuntimeStateAuditCells,
  loadLegacyRuntimeStateReadout,
  runtimeStateAuditInput,
} from "./runtime-state-audit-prompts.js";
import {
  RUNTIME_STATE_AUDIT_BUDGET,
  runRuntimeStateAuditEvaluation,
} from "./runtime-state-audit-evaluation.js";

const testRoot = resolve(
  CONTINUITY_WORKSPACE_ROOT,
  "tmp",
  `runtime-state-audit-test-${randomUUID()}`,
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const inside = relative(resolve(CONTINUITY_WORKSPACE_ROOT, "tmp"), testRoot);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Unsafe fixture cleanup directory");
  rmSync(testRoot, { recursive: true, force: true });
});
function payload(prompt: string, label: string): Record<string, unknown> {
  const lines = prompt.split("\n");
  return JSON.parse(lines[lines.indexOf(label) + 1]!) as Record<
    string,
    unknown
  >;
}
function offlineGuard() {
  const deployment = vi
    .spyOn(configuration, "readConfig")
    .mockImplementation(() => {
      throw new Error("Offline must not read deployment credentials");
    });
  const profile = vi
    .spyOn(steering, "resolveSteeringProfile")
    .mockImplementation(() => {
      throw new Error("Offline must not resolve private model profiles");
    });
  const network = vi.fn(() =>
    Promise.reject(new Error("Paid network forbidden in fixture")),
  );
  vi.stubGlobal("fetch", network);
  vi.stubEnv("RUN_PAID_ARCHITECTURE_EVAL", "");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => {
    expect(deployment).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  };
}

describe("runtime state audit readout validity", () => {
  it("uses frozen old production functions instead of an invented baseline", () => {
    const legacy = loadLegacyRuntimeStateReadout();
    const input = runtimeStateAuditInput(
      "social-outward",
      RUNTIME_STATE_AUDIT_CASES[2]!,
    );
    const old = legacy.runtimeState(input.state);
    const descriptions = old["qualitative"] as Record<string, unknown>;
    expect(descriptions["energy"]).toBe("精力见底，注意力已经明显下降");
    expect(descriptions["focus"]).toBe("注意力高度集中");
    expect(descriptions["sleepDebt"]).toBe("没有累积睡眠债");
    expect(legacy.stateGuidance(input.state)).toContain("Focus is high");
    expect(Object.keys(legacy.sourceHashes)).toHaveLength(4);
  });

  it("freezes all three arms to a neutral-state strategy and removes complete target readouts", () => {
    const { cells } = buildRuntimeStateAuditCells();
    expect(cells).toHaveLength(48);
    expect(cells.filter((cell) => cell.skipped)).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.proof.nonTargetEqual).toBe(true);
      expect(cell.proof.budgetAndIntentEqual).toBe(true);
      const strategy = payload(cell.prompt, "REPLY_STRATEGY_JSON");
      expect("stateGuidance" in strategy).toBe(
        cell.arm === "legacy_state_readout",
      );
      delete strategy["stateGuidance"];
      const probe = RUNTIME_STATE_AUDIT_CASES.find(
        (item) => item.id === cell.caseId,
      )!;
      const input = runtimeStateAuditInput(cell.personaId, probe);
      const neutral = assembleChatPrompt({
        ...input,
        state: { ...input.state, ...RUNTIME_STATE_AUDIT_NEUTRAL },
      });
      expect(strategy).toEqual(payload(neutral.prompt, "REPLY_STRATEGY_JSON"));
      if (cell.arm !== "param_ablation") continue;
      const state = payload(cell.prompt, "RUNTIME_STATE_JSON");
      const descriptions = state["qualitative"] as Record<string, unknown>;
      expect(descriptions).not.toHaveProperty("summary");
      if (probe.target === "all_short_term") {
        expect(descriptions).toEqual({});
        expect(cell.proof.removedPaths).toHaveLength(12);
      } else {
        expect(state).not.toHaveProperty(probe.target);
        expect(descriptions).not.toHaveProperty(
          probe.target === "sleepDebtMinutes" ? "sleepDebt" : probe.target,
        );
        expect(cell.proof.removedPaths).toHaveLength(
          probe.target === "sleepDebtMinutes" ? 0 : 2,
        );
      }
    }
  });

  it("keeps private judgments out of prompts and validates separately sourced legacy sleep", () => {
    const { cells, legacySleepFixture } = buildRuntimeStateAuditCells();
    for (const cell of cells)
      for (const probe of RUNTIME_STATE_AUDIT_CASES) {
        expect(cell.system + cell.prompt).not.toContain(probe.title);
        for (const criterion of probe.criteria)
          expect(cell.system + cell.prompt).not.toContain(criterion);
      }
    expect(legacySleepFixture.original["sleepDebtMinutes"]).toBe(360);
    expect(legacySleepFixture.ablated).not.toHaveProperty("sleepDebtMinutes");
    expect(legacySleepFixture.ablated["qualitative"]).not.toHaveProperty(
      "sleepDebt",
    );
    expect(legacySleepFixture.removedPaths).toEqual([
      "runtime.sleepDebtMinutes",
      "runtime.qualitative.sleepDebt",
    ]);
  });
});

describe("runtime state audit bounded execution", () => {
  it("runs all 46 fixture requests without private config/network and saves actual evidence", async () => {
    const assertOffline = offlineGuard();
    const output = join(testRoot, "complete");
    const result = await runRuntimeStateAuditEvaluation({
      output,
      fixture: true,
    });
    expect(result).toMatchObject({
      completed: 46,
      skipped: 2,
      errors: 0,
      physicalRequests: 46,
      usageComplete: true,
    });
    const requests = readFileSync(join(output, "attempts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            stage: string;
            request?: { max_tokens: number; messages: unknown[] };
          },
      )
      .filter((row) => row.stage === "reserved");
    expect(requests).toHaveLength(46);
    for (const row of requests) {
      expect(row.request?.max_tokens).toBe(4096);
      expect(row.request?.messages.length).toBe(4);
      expect(JSON.stringify(row.request?.messages)).not.toContain(
        "STRUCTURED_OUTPUT_REPAIR",
      );
    }
    const candidates = readFileSync(
      join(output, "anonymous-candidates.json"),
      "utf8",
    );
    expect(candidates).not.toContain("legacy_state_readout");
    expect(candidates).not.toContain("param_ablation");
    expect(readFileSync(join(output, "manifest.json"), "utf8")).not.toContain(
      "offline-fixture-key",
    );
    expect(RUNTIME_STATE_AUDIT_BUDGET.maxPhysicalRequests).toBe(46);
    await expect(
      runRuntimeStateAuditEvaluation({ output, fixture: true }),
    ).rejects.toThrow("Never overwrite");
    assertOffline();
  }, 30_000);

  it("records malformed provider responses as one failed physical attempt without repair or refill", async () => {
    const assertOffline = offlineGuard();
    vi.spyOn(
      architectureRuntime,
      "architectureFixtureFetch",
    ).mockImplementation(() =>
      Promise.resolve(
        Response.json({
          choices: [
            {
              message: { role: "assistant", content: "not-json" },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    );
    const result = await runRuntimeStateAuditEvaluation({
      output: join(testRoot, "failures"),
      fixture: true,
    });
    expect(result).toMatchObject({
      completed: 0,
      errors: 46,
      skipped: 2,
      physicalRequests: 46,
      usageComplete: false,
    });
    assertOffline();
  }, 30_000);

  it("preflights without dispatch and rejects paid mode before private config or output", async () => {
    const assertOffline = offlineGuard();
    const denied = join(testRoot, "paid");
    await expect(
      runRuntimeStateAuditEvaluation({ output: denied }),
    ).rejects.toThrow("RUN_PAID_ARCHITECTURE_EVAL=1");
    expect(existsSync(denied)).toBe(false);
    const output = join(testRoot, "preflight");
    await expect(
      runRuntimeStateAuditEvaluation({ output, preflightOnly: true }),
    ).resolves.toMatchObject({
      candidates: 48,
      dispatchable: 46,
      physicalRequests: 0,
    });
    expect(existsSync(join(output, "attempts.jsonl"))).toBe(false);
    assertOffline();
  }, 30_000);
});
