import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ServerConfig } from "../config.js";
import { companionLongRunV2Manifest } from "../scenarios/companion-long-run-v2-manifest.js";
import { readTurnEvidence } from "./companion-long-run-v2-artifacts.js";
import {
  LONG_RUN_V2_EVIDENCE_TAIL_LIMIT,
  buildLongRunV2ServerConfig,
  compactLongRunV2EvidenceSnapshots,
  fixtureProfileSnapshot,
  liveProfileSnapshot,
  listLongRunV2DatabaseArtifacts,
  runCompanionLongRunV2Single,
  suggestedMatrixId,
  suggestedRunId,
} from "./companion-long-run-v2-runner.js";
import {
  LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS,
  type LongRunStateSnapshot,
} from "./companion-long-run-v2-run-types.js";

const cleanup: string[] = [];
const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("companion long-run v2 runner", () => {
  it("forces the frozen feature profile and keeps fixture credentials absent", () => {
    const config = buildLongRunV2ServerConfig(
      fixtureConfig("placeholder.sqlite"),
      "isolated.sqlite",
      true,
    );
    expect(config).toMatchObject({
      databasePath: "isolated.sqlite",
      clockMode: "fake",
      chatEffectsMode: "gated",
      scheduleNegotiationMode: "enforced",
      selfInitiatedPlanningMode: "enforced",
      liveWorldEffectsMode: "enforced",
      memoryRecallMode: "enforced",
      autobiographyMode: "off",
      llm: {
        provider: "fixture",
        model: "personasim-fixture-v1",
      },
    });
    expect(config.llm.apiKey).toBeUndefined();
  });

  it("records the full endpoint path and legacy DeepSeek provider name", () => {
    const profile = liveProfileSnapshot({
      profile: "deepseek",
      profileSource: "legacy",
      configuredProfileName: null,
      provider: "openai-compatible",
      requestedModel: "deepseek-v4-flash",
      baseOrigin: "https://api.deepseek.example",
      baseUrl: "https://api.deepseek.example/v1",
      reasoningEffort: "max",
      reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
      capabilities: {
        structuredOutputMode: "json_object",
        supportsThinkingControl: false,
        supportsStreaming: false,
        reasoningEffort: "max",
        reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
        maxOutputTokens: 8_192,
      },
      timeoutMs: 120_000,
      maxRetries: 1,
      apiKeyEnvironment: "OPENAI_COMPATIBLE_API_KEY",
      apiKeyPresent: true,
      configSha256: "profile-hash",
    });
    expect(profile.profileName).toBe("legacy");
    expect(profile.baseUrl).toBe("https://api.deepseek.example/v1");
  });

  it("keeps mutable authority complete and projects immutable history to bounded tails", () => {
    const mutable = {
      runtimeState: {
        energy: 0.42,
        relationship: { closeness: 0.72, trust: 0.81 },
      },
      cursor: { settledThroughUtc: "2026-09-02T00:00:00.000Z" },
      schedule: rows("schedule", 19),
      scheduleNegotiations: rows("negotiation", 17),
      memories: rows("memory", 23),
      proactiveCandidates: rows("proactive", 16),
    };
    const before = snapshot({
      ...mutable,
      ...historicalRows(25, "before"),
    });
    const after = snapshot({
      ...mutable,
      ...historicalRows(26, "after"),
    });

    const compact = compactLongRunV2EvidenceSnapshots(before, after, 4);

    for (const key of [
      "runtimeState",
      "cursor",
      "schedule",
      "scheduleNegotiations",
      "memories",
      "proactiveCandidates",
    ] as const) {
      expect(compact.before[key]).toEqual(before[key]);
      expect(compact.after[key]).toEqual(after[key]);
    }
    expect(
      (compact.after.runtimeState as { relationship: unknown }).relationship,
    ).toEqual({ closeness: 0.72, trust: 0.81 });
    for (const collection of LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS) {
      expect(compact.before[collection]).toEqual(before[collection].slice(-4));
      expect(compact.after[collection]).toEqual(after[collection].slice(-4));
      expect(
        compact.before.evidenceHistory?.collections[collection],
      ).toMatchObject({
        total: 25,
        retainedTailCount: 4,
      });
      expect(
        compact.before.evidenceHistory?.collections[collection].sha256,
      ).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(compact.before.evidenceHistory).toMatchObject({
      format: "bounded-tail-with-turn-delta-v1",
      tailLimit: 4,
    });
    expect(compact.before.durableSha256).toBe(before.durableSha256);
    expect(compact.after.durableSha256).toBe(after.durableSha256);
  });

  it("retains every new row in the after delta even when additions exceed the tail", () => {
    const priorMessages = rows("message", 5);
    const addedMessages = rows("message-new", 11);
    const before = snapshot({ messages: priorMessages });
    const after = snapshot({
      messages: [...priorMessages, ...addedMessages],
    });

    const first = compactLongRunV2EvidenceSnapshots(before, after, 3);
    const second = compactLongRunV2EvidenceSnapshots(before, after, 3);
    const beforeAudit = first.before.evidenceHistory!.collections.messages;
    const afterAudit = first.after.evidenceHistory!.collections.messages;

    expect(first.after.messages).toEqual(after.messages.slice(-3));
    expect(afterAudit.total).toBe(16);
    expect(afterAudit.deltaFromBefore).toMatchObject({
      baseSha256: beforeAudit.sha256,
      addedRows: addedMessages,
      updatedRows: [],
      removedRowKeys: [],
    });
    expect(first).toEqual(second);
    expect(before.messages).toEqual(priorMessages);
    expect(after.messages).toEqual([...priorMessages, ...addedMessages]);
  });

  it("captures unexpected history updates and removals for reconstruction", () => {
    const before = snapshot({
      domainEvents: [
        { id: "event-1", payload: { revision: 1 } },
        { id: "event-2", payload: { revision: 1 } },
      ],
    });
    const after = snapshot({
      domainEvents: [
        { id: "event-2", payload: { revision: 2 } },
        { id: "event-3", payload: { revision: 1 } },
      ],
    });

    const compact = compactLongRunV2EvidenceSnapshots(before, after, 2);
    const delta =
      compact.after.evidenceHistory!.collections.domainEvents.deltaFromBefore!;

    expect(delta.addedRows).toEqual([
      { id: "event-3", payload: { revision: 1 } },
    ]);
    expect(delta.updatedRows).toEqual([
      {
        rowKey: "id:event-2#0",
        row: { id: "event-2", payload: { revision: 2 } },
      },
    ]);
    expect(delta.removedRowKeys).toEqual(["id:event-1#0"]);
  });

  it("materially reduces repeated snapshot history without touching source snapshots", () => {
    const beforeHistory = historicalRows(120, "large");
    const afterHistory = Object.fromEntries(
      LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS.map((collection) => [
        collection,
        [
          ...beforeHistory[collection],
          {
            id: `${collection}-new`,
            payload: "n".repeat(2_048),
          },
        ],
      ]),
    ) as Pick<
      LongRunStateSnapshot,
      (typeof LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS)[number]
    >;
    const before = snapshot(beforeHistory);
    const after = snapshot(afterHistory);
    const fullSize = JSON.stringify({ before, after }).length;

    const compact = compactLongRunV2EvidenceSnapshots(before, after);
    const compactSize = JSON.stringify(compact).length;

    expect(compactSize).toBeLessThan(fullSize * 0.2);
    expect(
      compact.after.evidenceHistory!.collections.messages.deltaFromBefore
        ?.addedRows,
    ).toHaveLength(1);
    expect(before.messages).toHaveLength(120);
    expect(after.messages).toHaveLength(121);
    expect(compact.before.messages).toHaveLength(
      LONG_RUN_V2_EVIDENCE_TAIL_LIMIT,
    );
  });

  it("reuses byte-identical paired setup snapshots and produces equal prompts", async () => {
    const matrixDirectory = await mkdtemp(
      join(tmpdir(), "chatplus-long-run-v2-runner-"),
    );
    cleanup.push(matrixDirectory);
    const fixture = fixtureProfileSnapshot();
    const config = fixtureConfig(join(matrixDirectory, "placeholder.sqlite"));

    for (const repetition of [1, 2] as const) {
      const result = await runCompanionLongRunV2Single({
        workspaceRoot,
        matrixDirectory,
        matrixId: "fixture-paired-equality",
        runId: suggestedRunId("fixture", repetition),
        mode: "fixture",
        profile: "fixture",
        repetition,
        serverConfig: config,
        profileConfig: fixture.profileConfig,
        profileConfigSha256: fixture.configSha256,
        tracks: ["paired"],
        stopAfterCandidate: 18,
      });
      expect(result.summary.databasePaths).toHaveLength(18);
      expect(
        await listLongRunV2DatabaseArtifacts(
          join(
            matrixDirectory,
            "runs",
            suggestedRunId("fixture", repetition),
            "databases",
          ),
        ),
      ).toHaveLength(18);
    }

    const first = await readTurnEvidence(
      join(matrixDirectory, "runs", "fixture-r1", "turn-evidence.jsonl"),
    );
    const second = await readTurnEvidence(
      join(matrixDirectory, "runs", "fixture-r2", "turn-evidence.jsonl"),
    );
    expect(first).toHaveLength(18);
    expect(second).toHaveLength(18);
    expect(first.map((item) => item.primaryPromptSha256)).toEqual(
      second.map((item) => item.primaryPromptSha256),
    );
    expect(first.map((item) => item.pairedProbe?.baselineSha256)).toEqual(
      second.map((item) => item.pairedProbe?.baselineSha256),
    );
    const conversation = await readFile(
      join(matrixDirectory, "runs", "fixture-r1", "conversation.md"),
      "utf8",
    );
    expect(conversation).toContain("配对探针——独立对话");
    expect(conversation).toContain("`memory-02-comparison`");
    expect(conversation).toContain("**用户**");
    expect(conversation).toContain("**顾澜**");
    expect(conversation).not.toContain("EXPECTED_JSON_SCHEMA");
    expect(conversation).not.toContain("Hard assertion");
    const modelIoText = await readFile(
      join(matrixDirectory, "runs", "fixture-r1", "model-io.jsonl"),
      "utf8",
    );
    const modelIo = modelIoText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(modelIo.length).toBeGreaterThanOrEqual(18);
    const logicalModelIo = modelIo.find(
      (record) =>
        record["recordType"] === "logical_call" &&
        record["runId"] === "fixture-r1" &&
        record["phase"] === "message",
    );
    expect(logicalModelIo).toBeDefined();
    const logicalRequest = logicalModelIo?.["request"] as Record<
      string,
      unknown
    >;
    const logicalResponse = logicalModelIo?.["response"] as Record<
      string,
      unknown
    >;
    const requestMessages = logicalRequest["messages"] as Array<
      Record<string, unknown>
    >;
    const requestParameters = logicalRequest["parameters"] as Record<
      string,
      unknown
    >;
    expect(logicalModelIo?.["repetition"]).toBe(1);
    expect(logicalRequest["purpose"]).toBe("chat_turn");
    expect(requestMessages.map((message) => message["role"])).toEqual([
      "system",
      "user",
    ]);
    expect(requestParameters["maxRetries"]).toBe(0);
    expect(logicalResponse["success"]).toBe(true);
    expect(modelIoText.toLowerCase()).not.toContain("authorization");
    expect(modelIoText.toLowerCase()).not.toContain("api_key");

    const preference = first.find(
      (item) => item.turnId === "memory-01-control",
    );
    expect(preference?.before.memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "semantic",
          namespace: "user_model",
          certainty: "explicit",
          attribution: "user_explicit",
          claim_subject_key: "user_preference:drink:usual",
          status: "active",
        }),
      ]),
    );
    expect(preference?.before.memoryEvidence).toHaveLength(1);

    const correction = first.find(
      (item) => item.turnId === "memory-02-comparison",
    );
    expect(
      correction?.assertions.find(
        (assertion) => assertion.code === "memory_correction_supersedes",
      )?.status,
    ).toBe("PASS");
    const correctionMemories = correction?.before.memories as Array<
      Record<string, unknown>
    >;
    const replaced = correctionMemories.find(
      (memory) => memory["status"] === "superseded",
    );
    const replacement = correctionMemories.find(
      (memory) => memory["id"] === replaced?.["superseded_by_id"],
    );
    expect(replaced).toMatchObject({
      claim_subject_key: "user_fact:relationship:小林",
      claim_disposition: "affirmed",
    });
    expect(replacement).toMatchObject({
      claim_subject_key: "user_fact:relationship:小林",
      claim_disposition: "affirmed",
      status: "active",
    });
    const correctionUserMessages = correction?.before.messages
      .filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as Record<string, unknown>)["role"] === "user",
      )
      .map(
        (message) =>
          (message as Record<string, unknown>)["created_at_utc"] as string,
      );
    expect(Date.parse(correctionUserMessages?.[1] ?? "")).toBeGreaterThan(
      Date.parse(correctionUserMessages?.[0] ?? ""),
    );

    const completedPlan = first.find(
      (item) => item.turnId === "memory-03-comparison",
    );
    const planMemories = completedPlan?.before.memories as Array<
      Record<string, unknown>
    >;
    expect(planMemories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim_subject_key: "user_task:report",
          claim_disposition: "affirmed",
          temporal_status: "planned",
          status: "superseded",
        }),
        expect.objectContaining({
          claim_subject_key: "user_task:report",
          claim_disposition: "completed",
          temporal_status: "occurred",
          status: "active",
        }),
      ]),
    );
  }, 30_000);

  it("keeps both run delivery files current across an interrupted commit and resume truncation", async () => {
    const matrixDirectory = await mkdtemp(
      join(tmpdir(), "chatplus-long-run-v2-interrupted-"),
    );
    cleanup.push(matrixDirectory);
    const fixture = fixtureProfileSnapshot();
    const config = fixtureConfig(join(matrixDirectory, "placeholder.sqlite"));
    const manifest = {
      ...companionLongRunV2Manifest,
      pairedProbes: companionLongRunV2Manifest.pairedProbes.map(
        (probe, index) =>
          index === 1
            ? {
                ...probe,
                setupMessages: [
                  {
                    userText: "这条设置会在首轮提交后模拟进程中断。",
                    actionsBefore: [{ kind: "close_app" as const }],
                  },
                ],
              }
            : probe,
      ),
    };
    const input = {
      workspaceRoot,
      matrixDirectory,
      matrixId: "fixture-interrupted-delivery",
      runId: "fixture-r1",
      mode: "fixture" as const,
      profile: "fixture" as const,
      repetition: 1 as const,
      serverConfig: config,
      profileConfig: fixture.profileConfig,
      profileConfigSha256: fixture.configSha256,
      tracks: ["paired"] as const,
      manifest,
    };

    await expect(runCompanionLongRunV2Single(input)).rejects.toThrow(
      /application is closed/u,
    );
    const runDirectory = join(matrixDirectory, "runs", "fixture-r1");
    expect(
      (await readTurnEvidence(join(runDirectory, "turn-evidence.jsonl"))).map(
        (item) => item.turnId,
      ),
    ).toEqual(["persona-01-control"]);
    expect(
      await readFile(join(runDirectory, "conversation.md"), "utf8"),
    ).toContain("`persona-01-control`");
    expect(
      await readFile(join(runDirectory, "model-io.jsonl"), "utf8"),
    ).toContain('"turnId":"persona-01-control"');

    await writeFile(
      join(
        matrixDirectory,
        "paired-baselines-v4",
        "01-persona-01-control.json",
      ),
      "{}\n",
      "utf8",
    );
    await expect(
      runCompanionLongRunV2Single({ ...input, resume: true }),
    ).rejects.toThrow(/Prepared paired baseline is incompatible/u);
    const resumedConversation = await readFile(
      join(runDirectory, "conversation.md"),
      "utf8",
    );
    expect(resumedConversation).toContain("没有已完成的候选轮次");
    expect(resumedConversation).not.toContain("`persona-01-control`");
    expect(
      await readTurnEvidence(join(runDirectory, "turn-evidence.jsonl")),
    ).toEqual([]);
    expect(await readFile(join(runDirectory, "model-io.jsonl"), "utf8")).toBe(
      "",
    );
  });

  it("generates filesystem-safe stable ids", () => {
    expect(suggestedRunId("gpt56-sol", 3)).toBe("gpt56-sol-r3");
    expect(
      suggestedMatrixId("matrix", new Date("2026-09-01T01:02:03.004Z")),
    ).toBe("matrix-20260901T010203004Z");
  });
});

function fixtureConfig(databasePath: string): ServerConfig {
  return {
    nodeEnv: "test",
    profile: "test",
    port: 0,
    host: "127.0.0.1",
    webOrigin: "http://127.0.0.1",
    databasePath,
    clockMode: "fake",
    fakeClockStart: "2026-09-01T01:00:00.000Z",
    llm: {
      provider: "fixture",
      profileName: "fixture",
      baseUrl: "https://fixture.invalid",
      model: "fixture-model",
      timeoutMs: 1_000,
      maxRetries: 0,
      maxOutputTokens: 8_192,
    },
    conversationRetention: {
      fullVerbatimHours: 24,
      softTokenLimit: 8_000,
      hardTokenLimit: 12_000,
      minimumTailTokens: 3_000,
      minimumRecentTurns: 12,
    },
    logLevel: "silent",
    seedDemo: false,
    developerRoutes: true,
    chatEffectsMode: "gated",
    scheduleNegotiationMode: "enforced",
    selfInitiatedPlanningMode: "enforced",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "off",
  };
}

function snapshot(
  overrides: Partial<LongRunStateSnapshot> = {},
): LongRunStateSnapshot {
  return {
    capturedAtUtc: "2026-09-01T00:00:00.000Z",
    runtimeState: {
      energy: 0.7,
      relationship: { closeness: 0.5, trust: 0.5 },
    },
    cursor: { settledThroughUtc: "2026-09-01T00:00:00.000Z" },
    schedule: [],
    scheduleNegotiations: [],
    settlements: [],
    activityEvents: [],
    memories: [],
    memoryEvidence: [],
    proactiveCandidates: [],
    messages: [],
    domainEvents: [],
    rejectedProposals: [],
    retrievalRuns: [],
    llmCalls: [],
    tableCounts: {},
    durableSha256: "full-snapshot-sha256",
    ...overrides,
  };
}

function rows(prefix: string, count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(3, "0")}`,
    payload: `${prefix}:${String(index)}:${"x".repeat(2_048)}`,
  }));
}

function historicalRows(
  count: number,
  prefix: string,
): Pick<
  LongRunStateSnapshot,
  (typeof LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS)[number]
> {
  return Object.fromEntries(
    LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS.map((collection) => [
      collection,
      rows(`${prefix}-${collection}`, count),
    ]),
  ) as Pick<
    LongRunStateSnapshot,
    (typeof LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS)[number]
  >;
}
