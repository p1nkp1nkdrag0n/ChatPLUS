import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARCHITECTURE_LONGITUDINAL_BUDGET,
  architectureLongitudinalAccounting,
  runArchitectureLongitudinalCli,
} from "./architecture-longitudinal.js";

const roots: string[] = [];
function ledger(rows: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "architecture-ledger-test-"));
  roots.push(root);
  const path = join(root, "attempts.jsonl");
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return path;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("longitudinal CLI admission and physical accounting", () => {
  it("freezes separate request-count and reservation-unit budgets", () => {
    expect(ARCHITECTURE_LONGITUDINAL_BUDGET).toEqual({
      maxPhysicalRequests: 280,
      maxReservedTokenUnits: 20_000_000,
    });
  });

  it("groups retries per candidate so reused logical indices in fresh providers do not invent retries", () => {
    const rows = [
      {
        stage: "reserved",
        attempt: 1,
        context: { id: "a", logicalCallIndex: 1 },
      },
      {
        stage: "responded",
        attempt: 1,
        context: { id: "a", logicalCallIndex: 1 },
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      },
      {
        stage: "reserved",
        attempt: 2,
        context: { id: "b", logicalCallIndex: 1 },
      },
      {
        stage: "responded",
        attempt: 2,
        context: { id: "b", logicalCallIndex: 1 },
        usage: { prompt_tokens: 120, completion_tokens: 20 },
      },
      {
        stage: "reserved",
        attempt: 3,
        context: { id: "b", logicalCallIndex: 1 },
      },
      {
        stage: "responded",
        attempt: 3,
        context: { id: "b", logicalCallIndex: 1 },
        usage: { prompt_tokens: 130, completion_tokens: 30 },
      },
    ];
    expect(
      architectureLongitudinalAccounting(ledger(rows), ["a", "b", "skipped"]),
    ).toMatchObject({
      physicalRequests: 3,
      retries: 1,
      usageComplete: true,
      inputTokens: 350,
      outputTokens: 60,
    });
  });

  it("keeps totals unknown when an actually dispatched attempt lacks provider usage", () => {
    const path = ledger([
      {
        stage: "reserved",
        attempt: 1,
        context: { id: "a", logicalCallIndex: 1 },
      },
      {
        stage: "transport_failed",
        attempt: 1,
        context: { id: "a", logicalCallIndex: 1 },
      },
      { stage: "blocked", context: { id: "b", logicalCallIndex: 1 } },
    ]);
    expect(architectureLongitudinalAccounting(path, ["a", "b"])).toMatchObject({
      physicalRequests: 1,
      usageComplete: false,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("rejects paid mode before accessing files when its explicit authorization guard is absent", async () => {
    vi.stubEnv("RUN_PAID_ARCHITECTURE_EVAL", "");
    await expect(
      runArchitectureLongitudinalCli({
        output: "tmp/never-created-paid-architecture-test",
        fixture: false,
      }),
    ).rejects.toThrow("RUN_PAID_ARCHITECTURE_EVAL=1");
  });
});
