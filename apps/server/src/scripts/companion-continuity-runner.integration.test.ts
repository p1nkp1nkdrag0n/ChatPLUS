import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { sha256Text } from "./companion-long-run-v2-artifacts.js";
import { loadContinuityInputs } from "./companion-continuity-input.js";
import { writeContinuityAudit } from "./companion-continuity-audit.js";
import {
  runCompanionContinuity,
  type ContinuityRunOptions,
} from "./companion-continuity-runner.js";

async function fixtureInputs(directory: string) {
  const publicPath = join(directory, "public.json");
  const oraclePath = join(directory, "oracle.json");
  const publicText = JSON.stringify({
    version: "companion-continuity-real-v1-proposal",
    simulatedStart: "2026-09-07T09:00:00+09:00",
    timezone: "Asia/Tokyo",
    characterInput: {
      name: "许岚",
      workOrRole: "设计师",
      worldSetting: "当代城市",
      coreTraits: ["直接"],
      initialRelationship: "朋友",
      dialogueStyle: "自然简洁",
      tier: "high_fidelity",
      timezone: "Asia/Tokyo",
    },
    steps: Array.from({ length: 120 }, (_, index) => ({
      turn: index + 1,
      sessionKey: `S${Math.floor(index / 8) + 1}`,
      simulatedDay: Math.floor(index / 8),
      minuteInSession: (index % 8) * 3,
      kind: "interaction",
      userText:
        index === 119
          ? "FUTURE_ONLY_CANARY"
          : `这是第${index + 1}次普通聊天，今天只是散了会步。`,
      clientMessageIdTemplate: `{runId}-turn-${index + 1}`,
    })),
    driverOnlyActions: [],
  });
  await writeFile(publicPath, publicText);
  await writeFile(
    oraclePath,
    JSON.stringify({
      artifactKind: "private_oracle_not_for_character_or_simulator",
      version: "companion-continuity-real-v1-proposal",
      publicScenarioSha256: sha256Text(publicText),
      factLedger: ["PRIVATE_ORACLE_CANARY"],
      practiceLedger: [],
      globalChecks: [],
      probeChecks: [
        { turn: 8, expectedBehavior: "PRIVATE_ORACLE_CANARY" },
        { turn: 120, expectedBehavior: "unknown" },
      ],
    }),
  );
  return { publicPath, oraclePath };
}

describe("fixed continuity acceptance driver", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const directory of directories.splice(0)) {
      const contained = relative(resolve(tmpdir()), resolve(directory));
      if (
        contained.startsWith("..") ||
        !contained.startsWith("continuity-driver-")
      )
        throw new Error("Unexpected cleanup path");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses TCP product routes, isolates oracle/future inputs, resumes fixed IDs and shares an untouched baseline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-driver-"));
    directories.push(directory);
    const input = await fixtureInputs(directory);
    const nativeFetch = globalThis.fetch;
    const external = vi.fn();
    vi.stubGlobal(
      "fetch",
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const target =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (!target.startsWith("http://127.0.0.1:")) {
          external();
          throw new Error("External network forbidden in fixture test");
        }
        return nativeFetch(url, init);
      },
    );
    const options: ContinuityRunOptions = {
      ...input,
      runId: "fixture",
      runDirectory: join(directory, "a2"),
      config: readConfig({
        nodeEnv: "test",
        seedDemo: false,
        llm: {
          provider: "fixture",
          model: "personasim-fixture-v1",
          baseUrl: "https://fixture.invalid",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      }),
      group: "A2",
      maxTurns: 8,
      budget: { maxPhysicalRequests: 20, maxReservedTokenUnits: 1000000 },
      onProgress: (message) => {
        if (message.includes("4/8"))
          throw new Error("controlled_driver_interruption");
      },
    };
    const interrupted = await runCompanionContinuity(options);
    expect(interrupted).toMatchObject({ status: "failed", completedTurns: 4 });
    const resumeOptions = { ...options, onProgress: () => {} };
    const completed = await runCompanionContinuity({
      ...resumeOptions,
      resume: true,
    });
    expect(completed, completed.error).toMatchObject({
      status: "completed",
      completedTurns: 8,
    });
    const io = await readFile(
      join(options.runDirectory, "model-io.jsonl"),
      "utf8",
    );
    expect(io).not.toMatch(/PRIVATE_ORACLE_CANARY|FUTURE_ONLY_CANARY/);
    const review = JSON.parse(
      await readFile(
        join(options.runDirectory, "review-worksheet.json"),
        "utf8",
      ),
    ) as { probes: Array<{ coverage: string; finalProductJudgment: string }> };
    expect(review.probes.map((probe) => probe.coverage)).toEqual([
      "observed",
      "not_covered",
    ]);
    expect(review.probes[0]?.finalProductJudgment).toBe("pending");
    await writeFile(
      join(options.runDirectory, "review.json"),
      '{"human_review":"preserve this judgment"}',
    );
    await writeContinuityAudit(options.runDirectory);
    expect(
      await readFile(join(options.runDirectory, "review.json"), "utf8"),
    ).toBe('{"human_review":"preserve this judgment"}');
    const db = openDatabase(join(options.runDirectory, "personasim.sqlite"));
    expect(
      db
        .prepare("SELECT count(*) AS n FROM messages WHERE role = 'user'")
        .get(),
    ).toEqual({ n: 8 });
    db.close();
    await expect(
      runCompanionContinuity({ ...resumeOptions, resume: true, group: "A0" }),
    ).rejects.toThrow("identity_mismatch");
    const baseline = await readFile(
      join(options.runDirectory, "baseline-character.json"),
      "utf8",
    );
    const control = await runCompanionContinuity({
      ...resumeOptions,
      runId: "control",
      runDirectory: join(directory, "a0"),
      baselineDirectory: options.runDirectory,
      group: "A0",
      maxTurns: 2,
    });
    expect(control, control.error).toMatchObject({
      status: "completed",
      completedTurns: 2,
    });
    expect(
      await readFile(join(directory, "a0", "baseline-character.json"), "utf8"),
    ).toBe(baseline);
    expect(external).not.toHaveBeenCalled();
  }, 60000);

  it("rejects changed scenario bytes before opening the application", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-driver-"));
    directories.push(directory);
    const input = await fixtureInputs(directory);
    await writeFile(
      input.publicPath,
      `${await readFile(input.publicPath, "utf8")}\n`,
    );
    await expect(
      loadContinuityInputs(input.publicPath, input.oraclePath),
    ).rejects.toThrow("scenario_oracle_mismatch");
  });

  it("retries incomplete session activation before sending the first user turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-driver-"));
    directories.push(directory);
    const input = await fixtureInputs(directory);
    const nativeFetch = globalThis.fetch;
    let activations = 0;
    vi.stubGlobal(
      "fetch",
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const target =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (!target.startsWith("http://127.0.0.1:"))
          throw new Error("External network forbidden");
        if (target.endsWith("/activate") && ++activations === 1)
          return new Response(
            JSON.stringify({ error: "injected_activation_failure" }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        return nativeFetch(url, init);
      },
    );
    const options: ContinuityRunOptions = {
      ...input,
      runId: "arrival",
      runDirectory: join(directory, "run"),
      config: readConfig({
        nodeEnv: "test",
        seedDemo: false,
        llm: {
          provider: "fixture",
          model: "personasim-fixture-v1",
          baseUrl: "https://fixture.invalid",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      }),
      group: "A2",
      maxTurns: 1,
      budget: { maxPhysicalRequests: 5, maxReservedTokenUnits: 100000 },
    };
    expect(await runCompanionContinuity(options)).toMatchObject({
      status: "failed",
      completedTurns: 0,
    });
    expect(
      await runCompanionContinuity({ ...options, resume: true }),
    ).toMatchObject({ status: "completed", completedTurns: 1 });
    expect(activations).toBe(2);
  }, 30000);
});
