import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  FixtureLlmProvider,
  type GenerateObjectInput,
} from "@personasim/providers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { runProductLifeLongRun } from "./product-life-long-run.js";

class FullRunFixtureUser extends FixtureLlmProvider {
  calls = 0;
  constructor() {
    super({ model: "product-life-user-offline" });
  }
  override generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
    this.calls += 1;
    if (input.purpose === "simulate_product_life_letter") {
      return Promise.resolve(
        input.schema.parse({
          subject: "一碗热汤的近况",
          body: "顾澜，这几天我会少上线。最近开始认真给自己做晚饭，还没把每一个问题都想明白，但愿意从一碗热汤慢慢开始。谢谢你听我聊，等回来时也想听听你的近况。",
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
    const userProvider = new FullRunFixtureUser();
    const result = await runProductLifeLongRun({
      runDirectory,
      config,
      userProvider,
      userMetrics: [],
    });
    expect(result, JSON.stringify(result.error)).toMatchObject({
      status: "completed",
      completedTurns: 42,
    });
    expect(userProvider.calls).toBe(43);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const before = rows(runDirectory);
    expect(before.sessions).toBe(3);
    expect(before.messages).toHaveLength(84);
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
    expect(userProvider.calls).toBe(43);
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
    expect(userProvider.calls).toBe(43);
    expect(rows(runDirectory)).toEqual(before);
  }, 90_000);
});
