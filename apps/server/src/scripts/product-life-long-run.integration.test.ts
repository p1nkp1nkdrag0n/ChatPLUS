import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  FixtureLlmProvider,
  StructuredOutputError,
  type GenerateObjectInput,
  type LlmCallMetric,
} from "@personasim/providers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import {
  productLifeAcceptanceStatus,
  runProductLifeLongRun,
} from "./product-life-long-run.js";

class FullRunFixtureUser extends FixtureLlmProvider {
  calls = 0;
  interruptOpenRecallOnce = false;
  prompts: Record<string, unknown>[] = [];
  constructor(private readonly metrics?: LlmCallMetric[]) {
    super({ model: "product-life-user-offline" });
  }
  override generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
    this.calls += 1;
    this.metrics?.push({
      provider: "fixture",
      model: this.model,
      purpose: input.purpose,
      attempt: 1,
      latencyMs: 1,
      success: true,
      usageSource: "provider",
      inputTokens: 100,
      outputTokens: 10,
      ...(this.calls === 1
        ? {}
        : {
            logicalCallId: `user-call-${this.calls}`,
            cacheReadTokens: 60,
            cacheReadSource: "usage.prompt_tokens_details.cached_tokens",
            cacheWriteTokens: 0,
            cacheWriteSource:
              "usage.prompt_tokens_details.cache_creation_input_tokens",
          }),
    });
    const context = JSON.parse(input.prompt) as {
      controlledRecallProbe?: { kind: string; questions: string[] };
    };
    this.prompts.push(context);
    if (
      this.interruptOpenRecallOnce &&
      context.controlledRecallProbe?.kind === "open_recall"
    ) {
      this.interruptOpenRecallOnce = false;
      return Promise.reject(new Error("deliberate_validation_interrupt"));
    }
    if (this.calls === 1)
      return Promise.resolve(
        input.schema.parse({ text: "林舟，你回来啦，我刚剪完片。" }),
      );
    if (context.controlledRecallProbe)
      return Promise.resolve(
        input.schema.parse({
          text: context.controlledRecallProbe.questions[0],
        }),
      );
    if (input.purpose === "simulate_product_life_letter") {
      return Promise.resolve(
        input.schema.parse({
          subject: "一碗热汤的近况",
          body: "顾澜：\n\n这几天我会少上线。最近开始认真给自己做晚饭，还没把每一个问题都想明白，但愿意从一碗热汤慢慢开始。谢谢你听我聊，等回来时也想听听你的近况。\n\n林舟",
        }),
      );
    }
    // Deliberately substantive ordinary turns cross the configured retention
    // threshold. No runtime state, memories, or checkpoint records are seeded.
    const text =
      `这是我们第${this.calls}次聊到近况。最近我还是想把自己的节奏慢慢理清楚，今天先不急着决定新的事情。` +
      "忙起来的时候，我总担心自己把时间都交给工作，回家就顾不上喜欢的事情。现在愿意先承认精力有限，也想听听你最近自己的生活。还没做的事情我就先不说成已经做到了，等有实际变化再告诉你。".repeat(
        3,
      );
    return Promise.resolve(input.schema.parse({ text }));
  }
}

async function parsed<T = Record<string, unknown>>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function rows(directory: string): {
  messages: unknown[];
  calls: unknown[];
  sessions: number;
  checkpoints: number;
} {
  const database = openDatabase(join(directory, "personasim.sqlite"));
  try {
    return {
      messages: database.prepare("SELECT * FROM messages ORDER BY id").all(),
      calls: database.prepare("SELECT * FROM llm_calls ORDER BY id").all(),
      sessions: (
        database.prepare("SELECT count(*) AS count FROM sessions").get() as {
          count: number;
        }
      ).count,
      checkpoints: (
        database
          .prepare(
            "SELECT count(*) AS count FROM conversation_checkpoints WHERE status = 'committed'",
          )
          .get() as { count: number }
      ).count,
    };
  } finally {
    database.close();
  }
}

describe("42-turn product life long-run", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const directory of directories.splice(0)) {
      const contained = relative(resolve(tmpdir()), resolve(directory));
      if (
        contained.startsWith("..") ||
        !contained.startsWith("product-life-full-test-")
      )
        throw new Error("Unexpected cleanup path");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exercises all 42 real fixture turns, checkpoints, correspondence, control and idempotent completed-run resume", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new Error("External network disabled in full product fixture test"),
        ),
    );
    const parent = await mkdtemp(join(tmpdir(), "product-life-full-test-"));
    directories.push(parent);
    const runDirectory = join(parent, "run");
    const config = readConfig({
      nodeEnv: "test",
      profile: "test",
      host: "127.0.0.1",
      seedDemo: false,
      databasePath: join(parent, "untouched.sqlite"),
      llm: {
        provider: "fixture",
        model: "personasim-fixture-v1",
        baseUrl: "https://fixture.invalid",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
    });
    const userMetrics: LlmCallMetric[] = [];
    const userProvider = new FullRunFixtureUser(userMetrics);
    const result = await runProductLifeLongRun({
      runDirectory,
      config,
      userProvider,
      userMetrics,
    });
    expect(result, JSON.stringify(result.error)).toMatchObject({
      status: "completed",
      completedTurns: 42,
    });
    expect(userProvider.calls).toBe(44);
    expect(
      await parsed(join(runDirectory, "provider-metrics.json")),
    ).toMatchObject({
      user: {
        total: {
          physicalAttempts: 44,
          logicalCalls: 43,
          logicalIdUnknownAttempts: 1,
          cacheRead: { tokens: 2580, knownAttempts: 43, unknownAttempts: 1 },
          cacheWrite: { tokens: 0, knownAttempts: 43, unknownAttempts: 1 },
          cacheReadRate: { value: 0.6, inputTokens: 4300 },
        },
      },
    });
    const recordedMetrics = await readFile(
      join(runDirectory, "user-metrics.json"),
      "utf8",
    );
    const recordedAccounting = await readFile(
      join(runDirectory, "provider-metrics.json"),
      "utf8",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const before = rows(runDirectory);
    expect(before.sessions).toBe(3);
    expect(before.messages).toHaveLength(84);
    expect(JSON.stringify(before.messages)).not.toContain("林舟，你回来啦");
    const inputChecks = (
      await readFile(join(runDirectory, "user-input-checks.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(inputChecks[0]).toMatchObject({
      step: "user-1",
      attempt: 1,
      accepted: false,
    });
    expect(inputChecks[1]).toMatchObject({
      step: "user-1",
      attempt: 2,
      accepted: true,
    });
    const lastHistory = userProvider.prompts.at(-1)!.publicHistory as Array<{
      sourceId: string;
      speakerName: string;
      authoredAtLocal: string;
      channel?: string;
    }>;
    expect(
      lastHistory.filter((message) => message.channel === "letter"),
    ).toHaveLength(2);
    expect(new Set(lastHistory.map((message) => message.sourceId)).size).toBe(
      lastHistory.length,
    );
    expect(
      lastHistory.every(
        (message) =>
          ["林舟", "顾澜"].includes(message.speakerName) &&
          message.authoredAtLocal.length > 0,
      ),
    ).toBe(true);
    const acceptance = await parsed(
      join(runDirectory, "acceptance-status.json"),
    );
    expect(acceptance).toMatchObject({
      execution: "completed",
      semanticQuality: "pending_review",
      readmeGoals: "not_evaluated",
    });
    expect(before.checkpoints).toBeGreaterThan(0);
    const turnFiles = (await readdir(runDirectory)).filter((name) =>
      /^turn-\d\d\.json$/u.test(name),
    );
    expect(turnFiles).toHaveLength(42);
    const lifecycle = (
      await readFile(join(runDirectory, "lifecycle.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            beforeCloseAtUtc: string;
            atUtc: string;
            beforeClose: { counts: Record<string, number> };
            afterStartup: { counts: Record<string, number> };
          },
      );
    expect(lifecycle).toHaveLength(2);
    expect(
      lifecycle.every(
        (item) => item.event === "reopened_same_database_after_absence",
      ),
    ).toBe(true);
    for (const restart of lifecycle) {
      expect(Date.parse(restart.atUtc)).toBeGreaterThan(
        Date.parse(restart.beforeCloseAtUtc),
      );
      expect(restart.afterStartup.counts.daily_life_contexts).toBeGreaterThan(
        restart.beforeClose.counts.daily_life_contexts!,
      );
    }
    const dispatch = await parsed<{ letterId: string; status: string }>(
      join(runDirectory, "letter-dispatch.json"),
    );
    const arrived = await parsed<{
      status: string;
      evidence: {
        internalEvidence: {
          snapshot: { effectiveAtUtc: string };
          replyStorage: { arrivalDueAtUtc: string };
        };
      };
      publicMessages: unknown[];
    }>(join(runDirectory, "phase-3-letters.json"));
    expect(dispatch.status).toBe("completed");
    expect(arrived.status).toBe("completed");
    expect(arrived.publicMessages).toEqual([]);
    expect(arrived.evidence.internalEvidence.snapshot.effectiveAtUtc).toBe(
      "2026-09-13T04:00:00.000Z",
    );
    expect(arrived.evidence.internalEvidence.replyStorage.arrivalDueAtUtc).toBe(
      "2026-09-18T04:00:00.000Z",
    );
    const opened = await parsed<{
      status: string;
      publicMessages: Array<{ content: string }>;
    }>(join(runDirectory, "phase-4-letters.json"));
    expect(opened.status).toBe("completed");
    expect(opened.publicMessages).toHaveLength(1);
    expect(opened.publicMessages[0]?.content).toContain("回信");
    const finalAudit = await parsed<{
      counts: Record<string, number>;
      checks: Record<string, { passed: boolean | null }>;
      lifeProgress: { localDates: string[] };
    }>(join(runDirectory, "final-audit.json"));
    expect(finalAudit.counts.messages).toBe(84);
    expect(finalAudit.counts.daily_life_contexts).toBeGreaterThan(6);
    expect(
      Object.values(finalAudit.checks).every((check) => check.passed !== false),
    ).toBe(true);
    const control = await parsed<{
      before: { counts: Record<string, number> };
      afterStartup: { counts: Record<string, number> };
      after: { counts: Record<string, number> };
      repeated: { counts: Record<string, number> };
    }>(join(runDirectory, "control-final.json"));
    expect(control.after.counts.messages).toBe(0);
    expect(control.before.counts.daily_life_contexts).toBe(1);
    expect(control.afterStartup.counts.daily_life_contexts).toBe(2);
    expect(control.after.counts.daily_life_contexts).toBeGreaterThan(
      control.before.counts.daily_life_contexts!,
    );
    expect(control.repeated.counts).toEqual(control.after.counts);
    const ioBefore = await readFile(
      join(runDirectory, "model-io.jsonl"),
      "utf8",
    );
    const publicBefore = await readFile(
      join(runDirectory, "conversation.md"),
      "utf8",
    );

    const resumed = await runProductLifeLongRun({
      runDirectory,
      config,
      userProvider,
      userMetrics: [],
      resume: true,
    });
    expect(resumed).toMatchObject({ status: "completed", completedTurns: 42 });
    expect(userProvider.calls).toBe(44);
    expect(
      await readFile(join(runDirectory, "user-metrics.json"), "utf8"),
    ).toBe(recordedMetrics);
    expect(
      await readFile(join(runDirectory, "provider-metrics.json"), "utf8"),
    ).toBe(recordedAccounting);
    expect(rows(runDirectory)).toEqual(before);
    expect(await readFile(join(runDirectory, "model-io.jsonl"), "utf8")).toBe(
      ioBefore,
    );
    expect(await readFile(join(runDirectory, "conversation.md"), "utf8")).toBe(
      publicBefore,
    );
    expect(
      (await readFile(join(runDirectory, "lifecycle.jsonl"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(2);

    await expect(
      runProductLifeLongRun({
        runDirectory,
        config: {
          ...config,
          llm: { ...config.llm, model: "unexpected-other-model" },
        },
        userProvider,
        userMetrics: [],
        resume: true,
      }),
    ).rejects.toThrow("Resume configuration or scenario differs");
    expect(userProvider.calls).toBe(44);
    expect(rows(runDirectory)).toEqual(before);
  }, 90_000);

  it("reports failed features separately from completed dialogue without inventing semantic acceptance", () => {
    const report = productLifeAcceptanceStatus({
      status: "completed",
      completedTurns: 42,
      nowUtc: "2026-10-20T04:00:00.000Z",
      steps: {
        artifacts: {
          checks: [
            { id: "image_missing", passed: false, detail: "No ready asset" },
          ],
        },
        "turn-1": {},
      },
    });
    expect(report.featureChecks.status).toBe("failed");
    expect(report.sceneCoverage[0]?.status).toBe("pending_review");
    expect(report.sceneCoverage[1]?.status).toBe("not_executed");
    expect(report.readmeGoals).toBe("not_evaluated");
  });

  it("preserves original letter visibility across a day-45 interrupted-run resume", async () => {
    const parent = await mkdtemp(join(tmpdir(), "product-life-full-test-"));
    directories.push(parent);
    const runDirectory = join(parent, "resume-visibility");
    const config = readConfig({
      nodeEnv: "test",
      profile: "test",
      seedDemo: false,
      llm: {
        provider: "fixture",
        model: "personasim-fixture-v1",
        baseUrl: "https://fixture.invalid",
        timeoutMs: 1000,
        maxRetries: 0,
      },
    });
    const userProvider = new FullRunFixtureUser();
    userProvider.interruptOpenRecallOnce = true;
    const stopped = await runProductLifeLongRun({
      runDirectory,
      config,
      userProvider,
      userMetrics: [],
    });
    expect(stopped).toMatchObject({
      status: "failed",
      completedTurns: 35,
      error: "deliberate_validation_interrupt",
    });
    const before = userProvider.prompts.at(-1)!.publicHistory as Array<{
      sourceId: string;
      firstVisibleAtUtc: string;
      channel?: string;
    }>;
    const originalLetters = before.filter(
      (message) => message.channel === "letter",
    );
    expect(originalLetters.map((message) => message.firstVisibleAtUtc)).toEqual(
      ["2026-09-08T04:00:00.000Z", "2026-09-20T01:00:00.000Z"],
    );
    const promptBoundary = userProvider.prompts.length;
    const resumed = await runProductLifeLongRun({
      runDirectory,
      config,
      userProvider,
      userMetrics: [],
      resume: true,
    });
    expect(resumed).toMatchObject({ status: "completed", completedTurns: 42 });
    const after = userProvider.prompts[promptBoundary]!
      .publicHistory as typeof before;
    expect(after.filter((message) => message.channel === "letter")).toEqual(
      originalLetters,
    );
    expect(rows(runDirectory).messages).toHaveLength(84);
  }, 90_000);

  it.each(["role", "schema", "transport"])(
    "stops invalid %s input before persisting a user message",
    async (failure) => {
      const parent = await mkdtemp(join(tmpdir(), "product-life-full-test-"));
      directories.push(parent);
      const runDirectory = join(parent, "rejected");
      const config = readConfig({
        nodeEnv: "test",
        profile: "test",
        seedDemo: false,
        llm: {
          provider: "fixture",
          model: "personasim-fixture-v1",
          baseUrl: "https://fixture.invalid",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      });
      const provider = new FixtureLlmProvider();
      const generate = vi
        .spyOn(provider, "generateObject")
        .mockImplementation((input) => {
          if (failure === "schema")
            return Promise.reject(new StructuredOutputError("Invalid JSON"));
          if (failure === "transport")
            return Promise.reject(new Error("Connection unavailable"));
          return Promise.resolve(
            input.schema.parse({ text: "林舟，你回来啦。" }),
          );
        });
      const result = await runProductLifeLongRun({
        runDirectory,
        config,
        userProvider: provider,
        userMetrics: [],
      });
      expect(result).toMatchObject({ status: "failed", completedTurns: 0 });
      expect(result.error).toContain(
        failure === "transport"
          ? "Connection unavailable"
          : "simulated_user_input_rejected",
      );
      expect(generate).toHaveBeenCalledTimes(failure === "transport" ? 1 : 2);
      expect(rows(runDirectory).messages).toEqual([]);
    },
  );
});
