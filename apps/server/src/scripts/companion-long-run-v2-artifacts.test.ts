import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  aggregateLongRunProfileModelIo,
  appendLongRunModelIoEvidence,
  assertResumeCompatible,
  atomicWriteMutableText,
  redactLongRunArtifact,
  writeJsonExclusive,
} from "./companion-long-run-v2-artifacts.js";
import type {
  LongRunCheckpoint,
  RunManifest,
  TurnEvidence,
} from "./companion-long-run-v2-run-types.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("companion long-run v2 artifacts", () => {
  it("redacts key-shaped fields, bearer values and explicit secrets", () => {
    const value = redactLongRunArtifact(
      {
        apiKey: "top-secret",
        apiKeyPresent: true,
        nested: { authorization: "Bearer abcdefghijklmnop" },
        prompt: "never echo top-secret or sk-abcdefghijklmnop",
      },
      ["top-secret"],
    );
    expect(JSON.stringify(value)).not.toContain("top-secret");
    expect(JSON.stringify(value)).not.toContain("abcdefghijklmnop");
    expect(value).toMatchObject({ apiKeyPresent: true });
  });

  it("preserves usage and token-budget counters", () => {
    expect(
      redactLongRunArtifact({
        inputTokens: 123,
        outputTokens: 45,
        maxContextTokens: 200_000,
        accessToken: "credential-value",
      }),
    ).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      maxContextTokens: 200_000,
      accessToken: "[REDACTED]",
    });
  });

  it("writes redacted logical and physical model I/O records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatplus-model-io-"));
    cleanup.push(directory);
    const path = join(directory, "model-io.jsonl");
    const secret = "vendor-credential-123456";
    const manifest = fakeManifest();
    manifest.profile = "deepseek";
    manifest.profileConfig = {
      provider: "openai-compatible",
      profileName: "deepseek",
      baseOrigin: "https://provider.example",
      baseUrl: "https://provider.example/v1",
      requestedModel: "deepseek-v4-flash",
      timeoutMs: 90_000,
      maxRetries: 2,
      reasoningEffort: "max",
      reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
      structuredOutputMode: "json_schema",
      maxContextTokens: 128_000,
      maxOutputTokens: 32_768,
      apiKeyEnvironment: "LLM_PROFILE_DEEPSEEK_API_KEY",
      apiKeyPresent: true,
    };

    await appendLongRunModelIoEvidence(
      path,
      fakeTurnEvidence(secret),
      manifest,
      [secret],
    );

    const text = await readFile(path, "utf8");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("never-store-this-bearer");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      recordType: "logical_call",
      runId: "run-test",
      repetition: 1,
      request: {
        messages: [{ role: "system" }, { role: "user" }],
        requestedModel: "deepseek-v4-flash",
        parameters: {
          maxRetries: 1,
          maxOutputTokens: 24_000,
          maxContextTokens: 128_000,
          reasoningEffort: "max",
          reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
        },
      },
      response: {
        success: true,
        parsedOutput: { reply: "parsed" },
        latencyMs: 321,
      },
      physicalAttemptIds: ["attempt-1"],
    });
    expect(records[1]).toMatchObject({
      recordType: "physical_attempt",
      attemptId: "attempt-1",
      attemptNumber: 1,
      logicalCallIndex: 7,
      request: {
        method: "POST",
        requestModel: "deepseek-v4-flash",
        body: {
          max_tokens: 24_000,
          reasoning_effort: "max",
          authorization: "[REDACTED]",
          api_key: "[REDACTED]",
        },
      },
      response: {
        success: true,
        status: 200,
        raw: { choices: [{ message: { content: '{"reply":"raw"}' } }] },
        usage: {
          source: "provider",
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 100,
          cacheWriteTokens: 0,
          cacheReadSource: "usage.prompt_tokens_details.cached_tokens",
        },
        latencyMs: 300,
      },
    });
  });

  it("never overwrites a final artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatplus-artifacts-"));
    cleanup.push(directory);
    const path = join(directory, "final.json");
    await writeJsonExclusive(path, { status: "PASS" });
    await expect(
      writeJsonExclusive(path, { status: "FAIL" }),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(path, "utf8")).toContain("PASS");
  });

  it("atomically refreshes a mutable text artifact for resumed runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatplus-artifacts-"));
    cleanup.push(directory);
    const path = join(directory, "conversation.md");

    await atomicWriteMutableText(path, "first turn\n");
    await atomicWriteMutableText(path, "first turn\nsecond turn\n");

    expect(await readFile(path, "utf8")).toBe("first turn\nsecond turn\n");
  });

  it("aggregates repetitions by profile and replaces stale resumed output", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chatplus-model-io-matrix-"),
    );
    cleanup.push(directory);
    const runOne = join(directory, "runs", "deepseek-run-1");
    const runTwo = join(directory, "runs", "deepseek-run-2");
    await atomicWriteMutableText(
      join(runOne, "model-io.jsonl"),
      `${JSON.stringify({
        profile: "deepseek",
        runId: "deepseek-run-1",
        repetition: 1,
        recordType: "logical_call",
      })}\n`,
    );
    await atomicWriteMutableText(
      join(runTwo, "model-io.jsonl"),
      `${JSON.stringify({
        profile: "deepseek",
        runId: "deepseek-run-2",
        repetition: 2,
        recordType: "physical_attempt",
        authorization: "Bearer never-aggregate-this-token",
      })}\n`,
    );

    const destination = await aggregateLongRunProfileModelIo({
      matrixDirectory: directory,
      profile: "deepseek",
      runDirectories: [runOne, runTwo],
    });
    let text = await readFile(destination, "utf8");
    expect(text).not.toContain("never-aggregate-this-token");
    expect(
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { repetition: number })
        .map((record) => record.repetition),
    ).toEqual([1, 2]);

    await aggregateLongRunProfileModelIo({
      matrixDirectory: directory,
      profile: "deepseek",
      runDirectories: [runOne],
    });
    text = await readFile(destination, "utf8");
    expect(text).toContain("deepseek-run-1");
    expect(text).not.toContain("deepseek-run-2");
  });

  it("rejects a checkpoint when any frozen compatibility field changes", () => {
    const manifest = fakeManifest();
    const checkpoint: LongRunCheckpoint = {
      schemaVersion: "companion-long-run-checkpoint-v2",
      runId: manifest.runId,
      completedCandidateTurns: 10,
      completedTurnIds: [],
      createdAtUtc: manifest.createdAtUtc,
      compatibility: {
        configSha256: manifest.configSha256,
        git: manifest.git,
        scenario: manifest.scenario,
        baseline: manifest.baseline,
        profileConfig: manifest.profileConfig,
      },
      databases: [],
      evidenceJsonlSha256: "0".repeat(64),
    };
    expect(() => assertResumeCompatible(manifest, checkpoint)).not.toThrow();
    checkpoint.compatibility.scenario = {
      ...checkpoint.compatibility.scenario,
      manifestSha256: "changed",
    };
    expect(() => assertResumeCompatible(manifest, checkpoint)).toThrow(
      "Checkpoint is incompatible",
    );
  });
});

function fakeManifest(): RunManifest {
  return {
    schemaVersion: "companion-long-run-run-manifest-v2",
    matrixId: "matrix-test",
    runId: "run-test",
    mode: "fixture",
    profile: "fixture",
    repetition: 1,
    plannedTracks: ["paired", "closed_loop"],
    createdAtUtc: "2026-09-01T01:00:00.000Z",
    git: { revision: "abc", dirty: false },
    scenario: { version: "v2", manifestSha256: "scenario" },
    baseline: {
      databaseSha256: "database",
      characterSpecSha256: "character",
      initialStateSha256: "state",
      scheduleSha256: "schedule",
    },
    profileConfig: {
      provider: "fixture",
      profileName: "fixture",
      baseOrigin: "fixture://local",
      baseUrl: "fixture://local",
      requestedModel: "fixture-model",
      timeoutMs: 5_000,
      maxRetries: 0,
      apiKeyPresent: false,
    },
    featureFlags: {
      chatEffectsMode: "gated",
      scheduleNegotiationMode: "enforced",
      selfInitiatedPlanningMode: "enforced",
      liveWorldEffectsMode: "enforced",
      memoryRecallMode: "enforced",
      autobiographyMode: "off",
      scheduler: "disabled",
    },
    checkpointEveryTurns: 10,
    configSha256: "config",
  };
}

function fakeTurnEvidence(secret: string): TurnEvidence {
  const snapshot = {
    capturedAtUtc: "2026-09-01T01:00:00.000Z",
    runtimeState: null,
    cursor: null,
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
    durableSha256: "snapshot",
  };
  return {
    schemaVersion: "companion-long-run-turn-evidence-v2",
    matrixId: "matrix-test",
    runId: "run-test",
    profile: "deepseek",
    repetition: 1,
    track: "paired",
    branch: "shared",
    turnId: "paired-01",
    logicalOrdinal: 1,
    candidateOrdinal: 1,
    scenarioBlock: "personality",
    rubricTags: ["personality_consistency"],
    fakeTimeBeforeUtc: "2026-09-01T01:00:00.000Z",
    fakeTimeAfterUtc: "2026-09-01T01:00:01.000Z",
    sessionId: "session-test",
    clientMessageId: "message-test",
    userMessage: "hello",
    actions: [],
    http: { method: "POST", path: "/messages", status: 200, latencyMs: 350 },
    logicalCalls: [
      {
        index: 7,
        purpose: "chat_turn",
        system: `system includes ${secret}`,
        prompt: "full prompt",
        promptSha256: "prompt-sha",
        maxRetries: 1,
        maxOutputTokens: 24_000,
        startedAtUtc: "2026-09-01T01:00:00.000Z",
        completedAtUtc: "2026-09-01T01:00:00.321Z",
        latencyMs: 321,
        success: true,
        parsedOutput: { reply: "parsed" },
      },
    ],
    providerAttempts: [
      {
        attemptId: "attempt-1",
        logicalCallIndex: 7,
        provider: "openai-compatible",
        model: "deepseek-v4-flash",
        requestModel: "deepseek-v4-flash",
        purpose: "chat_turn",
        attempt: 1,
        latencyMs: 300,
        success: true,
        status: 200,
        responseModel: "deepseek-v4-flash",
        finishReason: "stop",
        usageSource: "provider",
        inputTokens: 120,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        cacheReadSource: "usage.prompt_tokens_details.cached_tokens",
        outputTokens: 30,
        requestBody: {
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "full prompt" }],
          max_tokens: 24_000,
          reasoning_effort: "max",
          authorization: "Bearer never-store-this-bearer",
          api_key: secret,
        },
        rawResponse: {
          choices: [{ message: { content: '{"reply":"raw"}' } }],
          echoed: secret,
        },
        startedAtUtc: "2026-09-01T01:00:00.000Z",
        completedAtUtc: "2026-09-01T01:00:00.300Z",
      },
    ],
    primaryPromptSha256: "prompt-sha",
    rawCandidateOutput: { reply: "raw" },
    parsedCandidateOutput: { reply: "parsed" },
    applicationResponse: { ok: true },
    before: snapshot,
    after: snapshot,
    assertions: [],
    status: "PASS",
    repairAttempted: false,
    idempotentReplay: false,
  };
}
