import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as configuration from "../config.js";
import * as steering from "./reply-steering-runner.js";
import * as fixtures from "./architecture-evaluation-runtime.js";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";
import {
  runStateMatrixValidation,
  stateMatrixWireProof,
} from "./state-matrix-validation.js";

const testRoot = resolve(
  CONTINUITY_WORKSPACE_ROOT,
  "tmp",
  `state-matrix-test-${randomUUID()}`,
);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const inside = relative(resolve(CONTINUITY_WORKSPACE_ROOT, "tmp"), testRoot);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Unsafe fixture cleanup directory");
  rmSync(testRoot, { recursive: true, force: true });
});
const read = (output: string, name: string) =>
  JSON.parse(readFileSync(join(output, name), "utf8")) as unknown;
function offlineGuard() {
  const config = vi
    .spyOn(configuration, "readConfig")
    .mockImplementation(() => {
      throw new Error("Offline run must not load deployment config");
    });
  const profile = vi
    .spyOn(steering, "resolveSteeringProfile")
    .mockImplementation(() => {
      throw new Error("Offline run must not load private profiles");
    });
  const network = vi.fn(() =>
    Promise.reject(new Error("Offline network forbidden")),
  );
  vi.stubGlobal("fetch", network);
  vi.stubEnv("RUN_PAID_ARCHITECTURE_EVAL", "");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => {
    expect(config).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  };
}

describe("bounded state matrix execution", () => {
  it("runs the fixed 56+40 comparison with no retries and at most two concurrent requests", async () => {
    const checkOffline = offlineGuard();
    const fetchFixture = fixtures.architectureFixtureFetch;
    let inFlight = 0;
    let peak = 0;
    const fetchSpy = vi
      .spyOn(fixtures, "architectureFixtureFetch")
      .mockImplementation(async (...args) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          return await fetchFixture(...args);
        } finally {
          inFlight--;
        }
      });
    const baseline = join(testRoot, "baseline");
    expect(
      await runStateMatrixValidation({ output: baseline, fixture: true }),
    ).toMatchObject({
      phase: "baseline",
      completed: 56,
      errors: 0,
      physicalRequests: 56,
      usageComplete: true,
    });
    const candidate = join(testRoot, "candidate");
    expect(
      await runStateMatrixValidation({
        output: candidate,
        phase: "candidate",
        baseline,
        fixture: true,
      }),
    ).toMatchObject({
      phase: "candidate",
      completed: 40,
      errors: 0,
      physicalRequests: 40,
      usageComplete: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(96);
    expect(peak).toBeLessThanOrEqual(2);
    for (const [directory, count] of [
      [baseline, 56],
      [candidate, 40],
    ] as const) {
      const results = read(directory, "results.json") as Array<{
        accounting: { retries: number; physicalRequests: number };
      }>;
      expect(results).toHaveLength(count);
      expect(
        results.every(
          (row) =>
            row.accounting.retries === 0 &&
            row.accounting.physicalRequests === 1,
        ),
      ).toBe(true);
      expect(read(directory, "anonymous-candidates.json")).toHaveLength(count);
      expect(read(directory, "private-anonymous-mapping.json")).toHaveLength(
        count,
      );
      expect(
        (read(directory, "wire-proof.json") as { requests: unknown[] })
          .requests,
      ).toHaveLength(count);
    }
    checkOffline();
  });

  it.each(["rate_limit", "malformed"] as const)(
    "records %s without repair or replacement calls",
    async (failure) => {
      const checkOffline = offlineGuard();
      const fetchSpy = vi
        .spyOn(fixtures, "architectureFixtureFetch")
        .mockImplementation(() =>
          Promise.resolve(
            new Response(
              failure === "rate_limit"
                ? "rate limited"
                : JSON.stringify({
                    id: "bad-response",
                    choices: [
                      {
                        finish_reason: "stop",
                        message: { role: "assistant", content: "not JSON" },
                      },
                    ],
                    usage: {
                      prompt_tokens: 1,
                      completion_tokens: 1,
                      total_tokens: 2,
                    },
                  }),
              {
                status: failure === "rate_limit" ? 429 : 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          ),
        );
      const summary = await runStateMatrixValidation({
        output: join(testRoot, failure),
        fixture: true,
      });
      expect(summary).toMatchObject({
        completed: 0,
        errors: 56,
        physicalRequests: 56,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(56);
      checkOffline();
    },
  );

  it("preflights offline and gates paid calls before profile resolution or artifact creation", async () => {
    const checkOffline = offlineGuard();
    expect(
      await runStateMatrixValidation({
        output: join(testRoot, "preflight"),
        preflightOnly: true,
      }),
    ).toMatchObject({
      candidates: 56,
      physicalRequests: 0,
    });
    const output = join(testRoot, "unarmed");
    await expect(runStateMatrixValidation({ output })).rejects.toThrow(
      "RUN_PAID_ARCHITECTURE_EVAL",
    );
    expect(existsSync(output)).toBe(false);
    await expect(
      runStateMatrixValidation({ output, phase: "candidate", fixture: true }),
    ).rejects.toThrow("--baseline");
    checkOffline();
  });

  it("refuses an inherited wire parameter change without dispatching candidate calls", async () => {
    const checkOffline = offlineGuard();
    const fetchSpy = vi.spyOn(fixtures, "architectureFixtureFetch");
    const baseline = join(testRoot, "baseline");
    await runStateMatrixValidation({ output: baseline, fixture: true });
    const path = join(baseline, "wire-proof.json");
    const proof = read(baseline, "wire-proof.json") as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify({ ...proof, nonPromptRequestSha256: "changed" }),
    );
    const summary = await runStateMatrixValidation({
      output: join(testRoot, "candidate"),
      phase: "candidate",
      baseline,
      fixture: true,
    });
    expect(summary).toMatchObject({
      completed: 0,
      errors: 40,
      physicalRequests: 0,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(56);
    checkOffline();
  });
});

describe("state matrix actual request proof", () => {
  const cell = { system: "state policy", prompt: "actual state and request" };
  const body = {
    model: "fixture",
    max_tokens: 4096,
    messages: [
      { role: "system", content: `schema header\n${cell.system}` },
      { role: "user", content: cell.prompt },
    ],
  };
  it("holds every provider parameter and schema header fixed while allowing prepared prompts", () => {
    const changed = {
      system: "new state policy",
      prompt: "changed state and request",
    };
    const otherBody = {
      ...body,
      messages: [
        { role: "system", content: `schema header\n${changed.system}` },
        { role: "user", content: changed.prompt },
      ],
    };
    expect(stateMatrixWireProof(body, cell).nonPromptRequestSha256).toBe(
      stateMatrixWireProof(otherBody, changed).nonPromptRequestSha256,
    );
    expect(
      stateMatrixWireProof({ ...body, max_tokens: 2048 }, cell)
        .nonPromptRequestSha256,
    ).not.toBe(stateMatrixWireProof(body, cell).nonPromptRequestSha256);
  });
  it("rejects lost, replaced or duplicated logical prompt content", () => {
    expect(() =>
      stateMatrixWireProof(body, { ...cell, prompt: "missing" }),
    ).toThrow("differs");
    expect(() =>
      stateMatrixWireProof(
        { ...body, messages: [...body.messages, body.messages[0]] },
        cell,
      ),
    ).toThrow("exactly one");
  });
});
