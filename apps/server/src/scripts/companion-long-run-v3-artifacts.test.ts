import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendLongRunV3ModelIo,
  appendLongRunV3CausalEvidence,
  appendLongRunV3TurnEvidence,
  assertLongRunV3ResumeCompatible,
  createLongRunV3Checkpoint,
  inspectLongRunV3ArtifactCoverage,
  projectLongRunV3ModelIoRecords,
  readLongRunV3Evidence,
  readLatestLongRunV3Checkpoint,
  redactLongRunV3Artifact,
  renderLongRunV3Conversation,
  resolveLongRunV3ArtifactPaths,
  restoreLongRunV3Checkpoint,
  validateLongRunV3ArtifactCoverage,
  verifyLongRunV3CheckpointFiles,
  writeLongRunV3ArtifactBundle,
  writeLongRunV3Checkpoint,
  writeLongRunV3JsonExclusive,
} from "./companion-long-run-v3-artifacts.js";
import type {
  LongRunV3RunManifest,
  LongRunV3Snapshot,
  LongRunV3TurnEvidence,
} from "./companion-long-run-v3-artifacts.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("companion long-run v3 artifacts", () => {
  it("redacts authentication fields, bearer text, explicit secrets and URL queries", () => {
    const secret = "vendor-credential-123456";
    const safe = redactLongRunV3Artifact(
      {
        apiKey: secret,
        apiKeyPresent: true,
        authorization: "Bearer never-store-this-token",
        url: `https://provider.example/v1/chat?api_key=${secret}&trace=1`,
        error: `request failed for ${["sk", "abcdefghijklmnop"].join("-")} and ${secret}`,
        inputTokens: 123,
        maxOutputTokens: 32_768,
      },
      [secret],
    );
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("never-store-this-token");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(safe).toMatchObject({
      apiKey: "[REDACTED]",
      apiKeyPresent: true,
      inputTokens: 123,
      maxOutputTokens: 32_768,
    });
  });

  it("renders a dialogue-only document without model internals", () => {
    const turn = fakeTurn("conversation-secret");
    const markdown = renderLongRunV3Conversation([turn]);
    expect(markdown).toContain("用户输入 conversation-secret");
    expect(markdown).toContain("角色回复");
    expect(markdown).not.toContain("SYSTEM POLICY");
    expect(markdown).not.toContain("prompt-sha");
    expect(markdown).not.toContain("inputTokens");
  });

  it("writes all immutable evidence files and redacts both dialogue and model I/O", async () => {
    const directory = await createTempDirectory();
    const secret = "vendor-credential-123456";
    const manifest = fakeManifest();
    const turn = fakeTurn(secret);

    const result = await writeLongRunV3ArtifactBundle({
      directory,
      manifest,
      turns: [turn],
      explicitSecrets: [secret],
    });

    const conversation = await readFile(result.paths.conversation, "utf8");
    expect(conversation).not.toContain(secret);
    expect(conversation).toContain("[REDACTED]");

    const modelIo = await readFile(result.paths.modelIo, "utf8");
    expect(modelIo).not.toContain(secret);
    expect(modelIo).not.toContain("never-store-this-bearer");
    const ioRecords = modelIo
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(ioRecords).toHaveLength(2);
    expect(ioRecords[0]).toMatchObject({
      schemaVersion: "companion-long-run-model-io-v3",
      recordType: "logical_call",
      turnId: "T001",
      request: {
        system: "SYSTEM POLICY [REDACTED]",
        requestedModel: "deepseek-v4-flash",
        parameters: {
          timeoutMs: 300_000,
          maxRetries: 2,
          maxOutputTokens: 24_576,
          maxContextTokens: 128_000,
          reasoningEffort: "max",
        },
      },
      response: {
        success: true,
        repairAttempt: false,
      },
      physicalAttemptIds: ["attempt-1"],
    });
    expect(ioRecords[1]).toMatchObject({
      recordType: "physical_attempt",
      attemptId: "attempt-1",
      request: {
        headers: { authorization: "[REDACTED]" },
        body: { api_key: "[REDACTED]" },
      },
      response: {
        responseModel: "deepseek-v4-flash",
        finishReason: "stop",
        usage: {
          inputTokens: 250,
          outputTokens: 75,
          cacheReadTokens: 200,
          cacheWriteTokens: 0,
          cacheReadSource: "usage.prompt_tokens_details.cached_tokens",
        },
      },
    });

    const causal = await readFile(result.paths.causalEvidence, "utf8");
    expect(causal.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(causal)).toMatchObject({
      stage: "support",
      sourceMessageIds: ["message-1"],
    });
    const evidence = await readLongRunV3Evidence(result.paths.turnEvidence);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ turnId: "T001" });
    expect(result.digests.modelIo.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails before replacing any final artifact", async () => {
    const directory = await createTempDirectory();
    const paths = resolveLongRunV3ArtifactPaths(directory);
    await writeLongRunV3JsonExclusive(paths.modelIo, { immutable: true });

    await expect(
      writeLongRunV3ArtifactBundle({
        directory,
        manifest: fakeManifest(),
        turns: [fakeTurn("safe")],
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(paths.runManifest, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(paths.modelIo, "utf8")).toContain("immutable");
  });

  it("supports append-only runner writes and reads turn evidence", async () => {
    const directory = await createTempDirectory();
    const paths = resolveLongRunV3ArtifactPaths(directory);
    const manifest = fakeManifest();
    const first = fakeTurn("first");
    const second = {
      ...fakeTurn("second"),
      turnId: "T002",
      candidateOrdinal: 2,
    };

    await appendLongRunV3TurnEvidence(paths.turnEvidence, first);
    await appendLongRunV3TurnEvidence(paths.turnEvidence, second);
    await appendLongRunV3ModelIo(paths.modelIo, first, manifest);

    expect(
      (await readLongRunV3Evidence(paths.turnEvidence)).map(
        (turn) => turn.turnId,
      ),
    ).toEqual(["T001", "T002"]);
    expect(
      (await readFile(paths.modelIo, "utf8")).trim().split("\n"),
    ).toHaveLength(2);
  });

  it("validates full per-turn conversation, logical/physical model I/O, and causal projections", () => {
    const manifest = fakeManifest();
    const turn = withCoverageEnvelope(fakeTurn("safe"));
    const expectedTurns = [
      { turnId: "T001", candidateOrdinal: 1, branch: "shared" as const },
    ];
    const modelIo = projectLongRunV3ModelIoRecords(turn, manifest);
    const causalEvidence = turn.causalEvidence;
    const conversation = renderLongRunV3Conversation([turn]);
    expect(
      validateLongRunV3ArtifactCoverage({
        expectedTurns,
        manifest,
        conversation,
        modelIo,
        causalEvidence,
        turnEvidence: [turn],
      }),
    ).toMatchObject({ passed: true, issues: [] });

    const withoutNonPrimaryLogical = withCoverageEnvelope({
      ...turn,
      logicalCalls: [
        ...turn.logicalCalls,
        {
          ...turn.logicalCalls[0]!,
          logicalCallId: "logical-memory",
          index: 2,
          purpose: "memory_extract",
        },
      ],
    });
    const completeIo = projectLongRunV3ModelIoRecords(
      withoutNonPrimaryLogical,
      manifest,
    );
    const missingNonPrimary = completeIo.filter(
      (record) =>
        !(
          record.recordType === "logical_call" &&
          record.logicalCallId === "logical-memory"
        ),
    );
    expect(
      validateLongRunV3ArtifactCoverage({
        expectedTurns,
        manifest,
        conversation: renderLongRunV3Conversation([withoutNonPrimaryLogical]),
        modelIo: missingNonPrimary,
        causalEvidence: withoutNonPrimaryLogical.causalEvidence,
        turnEvidence: [withoutNonPrimaryLogical],
      }).issues,
    ).toContain("model_io_projection_mismatch");

    const orphanPhysical = {
      ...modelIo.find((record) => record.recordType === "physical_attempt")!,
      attemptId: "orphan-attempt",
    };
    expect(
      validateLongRunV3ArtifactCoverage({
        expectedTurns,
        manifest,
        conversation: conversation.replace("角色回复", "被篡改的回复"),
        modelIo: [...modelIo, orphanPhysical],
        causalEvidence: causalEvidence.map((record) =>
          record.stage === "turn"
            ? { ...record, stage: "memory" as const }
            : record,
        ),
        turnEvidence: [turn],
      }).issues,
    ).toEqual(
      expect.arrayContaining([
        "conversation_projection_mismatch",
        "model_io_projection_mismatch",
        "causal_envelope_missing:T001",
        "causal_evidence_projection_mismatch",
      ]),
    );
  });

  it("restores the latest immutable checkpoint and discards complete and partial post-checkpoint turns", async () => {
    const directory = await createTempDirectory();
    const manifest = fakeManifest();
    const first = withCoverageEnvelope(fakeTurn("first"));
    const result = await writeLongRunV3ArtifactBundle({
      directory,
      manifest,
      turns: [first],
    });
    await writeFile(
      join(directory, "baseline.json"),
      JSON.stringify({ databaseSha256: manifest.baseline.databaseSha256 }),
      "utf8",
    );
    await writeFile(join(directory, "baseline.sqlite"), "baseline", "utf8");
    const sharedDatabase = join(directory, "run.sqlite");
    const stableDatabase = join(directory, "branches", "stable.sqlite");
    const independentDatabase = join(
      directory,
      "branches",
      "independent.sqlite",
    );
    await writeFile(sharedDatabase, "checkpoint-database", "utf8");
    const checkpoint = await createLongRunV3Checkpoint({
      runDirectory: directory,
      manifest,
      completedCandidateTurns: 1,
      completedTurnIds: ["T001"],
      databases: [{ role: "shared", path: sharedDatabase }],
    });
    await writeLongRunV3Checkpoint(directory, checkpoint);

    const second = numberedTurn(first, 2);
    const third = numberedTurn(first, 3);
    await appendLongRunV3TurnEvidence(result.paths.turnEvidence, second);
    await appendLongRunV3ModelIo(result.paths.modelIo, second, manifest);
    await appendLongRunV3CausalEvidence(
      result.paths.causalEvidence,
      second.causalEvidence,
    );
    await writeFile(
      result.paths.conversation,
      renderLongRunV3Conversation([first, second]),
      "utf8",
    );
    // Simulate the critical crash point: turn evidence committed, but the
    // remaining three artifacts were never written for the next candidate.
    await appendLongRunV3TurnEvidence(result.paths.turnEvidence, third);
    await writeFile(sharedDatabase, "post-checkpoint-database", "utf8");
    await mkdir(join(directory, "branches"), { recursive: true });
    await writeFile(stableDatabase, "partial-stable", "utf8");
    await writeFile(independentDatabase, "partial-independent", "utf8");

    const latest = await readLatestLongRunV3Checkpoint(directory);
    expect(latest.completedCandidateTurns).toBe(1);
    await restoreLongRunV3Checkpoint({
      runDirectory: directory,
      manifest,
      checkpoint: latest,
      activeDatabases: {
        shared: sharedDatabase,
        stable: stableDatabase,
        independent: independentDatabase,
      },
    });

    expect(
      (await readLongRunV3Evidence(result.paths.turnEvidence)).map(
        (turn) => turn.turnId,
      ),
    ).toEqual(["T001"]);
    expect(await readFile(result.paths.conversation, "utf8")).toBe(
      renderLongRunV3Conversation([first]),
    );
    expect(await readFile(sharedDatabase, "utf8")).toBe("checkpoint-database");
    await expect(readFile(stableDatabase, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(independentDatabase, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      inspectLongRunV3ArtifactCoverage({
        paths: resolveLongRunV3ArtifactPaths(directory),
        expectedTurns: [
          { turnId: "T001", candidateOrdinal: 1, branch: "shared" },
        ],
        manifest,
      }),
    ).resolves.toMatchObject({ passed: true });
  });

  it("hashes every checkpoint artifact and detects compatibility or file changes", async () => {
    const directory = await createTempDirectory();
    const manifest = fakeManifest();
    const result = await writeLongRunV3ArtifactBundle({
      directory,
      manifest,
      turns: [fakeTurn("safe")],
    });
    const database = join(directory, "run.sqlite");
    await writeFile(
      join(directory, "baseline.json"),
      JSON.stringify({ databaseSha256: manifest.baseline.databaseSha256 }),
      "utf8",
    );
    await writeFile(join(directory, "baseline.sqlite"), "baseline", "utf8");
    await writeFile(database, "sqlite-evidence", "utf8");
    const checkpoint = await createLongRunV3Checkpoint({
      runDirectory: directory,
      manifest,
      completedCandidateTurns: 1,
      completedTurnIds: ["T001"],
      databases: [{ role: "shared", path: database }],
      createdAtUtc: "2026-09-01T02:00:00.000Z",
    });

    expect(checkpoint.compatibilitySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(checkpoint.checkpointSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(checkpoint.artifacts.turnEvidence.sha256).toBe(
      result.digests.turnEvidence.sha256,
    );
    expect(() =>
      assertLongRunV3ResumeCompatible(manifest, checkpoint),
    ).not.toThrow();
    await expect(
      verifyLongRunV3CheckpointFiles(directory, checkpoint),
    ).resolves.toBeUndefined();

    const checkpointPath = await writeLongRunV3Checkpoint(
      directory,
      checkpoint,
    );
    expect(checkpointPath).toContain("checkpoint-001.json");
    await expect(
      writeLongRunV3Checkpoint(directory, checkpoint),
    ).rejects.toMatchObject({ code: "EEXIST" });

    const incompatible = fakeManifest();
    incompatible.scenario = {
      ...incompatible.scenario,
      manifestSha256: "different",
    };
    expect(() =>
      assertLongRunV3ResumeCompatible(incompatible, checkpoint),
    ).toThrow("Checkpoint is incompatible");
    for (const flag of [
      "companionContextMode",
      "personaRuntimeMode",
    ] as const) {
      expect(() =>
        assertLongRunV3ResumeCompatible(
          {
            ...manifest,
            featureFlags: { ...manifest.featureFlags, [flag]: "enforced" },
          },
          checkpoint,
        ),
      ).toThrow("Checkpoint is incompatible");
    }
    expect(() =>
      assertLongRunV3ResumeCompatible(
        { ...manifest, configSha256: "changed-final-config" },
        checkpoint,
      ),
    ).toThrow("Checkpoint is incompatible");

    await writeFile(result.paths.conversation, "active growth", "utf8");
    await expect(
      verifyLongRunV3CheckpointFiles(directory, checkpoint),
    ).resolves.toBeUndefined();
    await writeFile(
      join(directory, checkpoint.artifacts.conversation.path),
      "tampered snapshot",
      "utf8",
    );
    await expect(
      verifyLongRunV3CheckpointFiles(directory, checkpoint),
    ).rejects.toThrow("hash mismatch");

    const tamperedCheckpoint = JSON.parse(
      await readFile(checkpointPath, "utf8"),
    ) as Record<string, unknown>;
    tamperedCheckpoint["createdAtUtc"] = "2026-09-01T03:00:00.000Z";
    await writeFile(
      checkpointPath,
      `${JSON.stringify(tamperedCheckpoint, null, 2)}\n`,
      "utf8",
    );
    await expect(readLatestLongRunV3Checkpoint(directory)).rejects.toThrow(
      "self hash mismatch",
    );
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chatplus-long-run-v3-"));
  cleanup.push(directory);
  return directory;
}

function withCoverageEnvelope(
  turn: LongRunV3TurnEvidence,
): LongRunV3TurnEvidence {
  return {
    ...turn,
    causalEvidence: [
      {
        schemaVersion: "companion-long-run-causal-evidence-v3",
        runId: turn.runId,
        turnId: turn.turnId,
        candidateOrdinal: turn.candidateOrdinal,
        branch: turn.branch,
        capturedAtUtc: turn.fakeTimeAfterUtc,
        stage: "turn",
        subject: "system",
        sourceMessageIds: [],
        summary: "Candidate turn artifact coverage envelope.",
      },
      ...turn.causalEvidence,
    ],
  };
}

function numberedTurn(
  template: LongRunV3TurnEvidence,
  ordinal: number,
): LongRunV3TurnEvidence {
  const turnId = `T${String(ordinal).padStart(3, "0")}`;
  return {
    ...template,
    turnId,
    logicalOrdinal: ordinal,
    candidateOrdinal: ordinal,
    clientMessageId: `message-${String(ordinal)}`,
    userMessage: `用户输入 ${String(ordinal)}`,
    providerAttempts: template.providerAttempts.map((attempt) => ({
      ...attempt,
      attemptId: `attempt-${String(ordinal)}`,
    })),
    causalEvidence: template.causalEvidence.map((record) => ({
      ...record,
      turnId,
      candidateOrdinal: ordinal,
    })),
  };
}

function fakeManifest(): LongRunV3RunManifest {
  return {
    schemaVersion: "companion-long-run-run-manifest-v3",
    runId: "deepseek-v3-run",
    profile: "deepseek",
    createdAtUtc: "2026-09-01T01:00:00.000Z",
    plannedCandidateTurns: 120,
    git: { revision: "a".repeat(40), dirty: false },
    scenario: {
      version: "companion-long-run-v3",
      manifestSha256: "b".repeat(64),
    },
    baseline: {
      databaseSha256: "c".repeat(64),
      characterSpecSha256: "d".repeat(64),
    },
    profileConfig: {
      provider: "openai-compatible",
      profileName: "deepseek",
      baseOrigin: "https://api.deepseek.com",
      baseUrl: "https://api.deepseek.com/v1",
      requestedModel: "deepseek-v4-flash",
      timeoutMs: 300_000,
      maxRetries: 2,
      reasoningEffort: "max",
      reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
      structuredOutputMode: "json_schema",
      maxContextTokens: 128_000,
      maxOutputTokens: 32_768,
      repairMaxOutputTokens: 16_384,
      apiKeyEnvironment: "LLM_PROFILE_DEEPSEEK_API_KEY",
      apiKeyPresent: true,
    },
    featureFlags: {
      lifePlanningMode: "fuzzy",
      liveWorldEffectsMode: "enforced",
      memoryRecallMode: "enforced",
      scheduler: "disabled",
      autobiographyMode: "off",
    },
    checkpointEveryTurns: 10,
    configSha256: "e".repeat(64),
  };
}

function fakeTurn(secret: string): LongRunV3TurnEvidence {
  const snapshot = emptySnapshot();
  return {
    schemaVersion: "companion-long-run-turn-evidence-v3",
    runId: "deepseek-v3-run",
    profile: "deepseek",
    branch: "shared",
    turnId: "T001",
    logicalOrdinal: 1,
    candidateOrdinal: 1,
    scenarioBlock: "ordinary-life",
    rubricTags: ["emotional_understanding"],
    fakeTimeBeforeUtc: "2026-09-01T01:00:00.000Z",
    fakeTimeAfterUtc: "2026-09-01T01:00:01.000Z",
    sessionId: "session-1",
    clientMessageId: "message-1",
    userMessage: `用户输入 ${secret}`,
    assistantMessage: "角色回复",
    actions: [],
    http: {
      method: "POST",
      path: "/api/messages",
      status: 201,
      latencyMs: 350,
    },
    logicalCalls: [
      {
        index: 1,
        purpose: "chat_turn",
        system: `SYSTEM POLICY ${secret}`,
        prompt: "dynamic prompt",
        promptSha256: "prompt-sha",
        maxRetries: 2,
        maxOutputTokens: 24_576,
        startedAtUtc: "2026-09-01T01:00:00.000Z",
        completedAtUtc: "2026-09-01T01:00:00.321Z",
        latencyMs: 321,
        success: true,
        rawOutput: { content: "raw" },
        parsedOutput: { reply: "角色回复" },
      },
    ],
    providerAttempts: [
      {
        attemptId: "attempt-1",
        logicalCallIndex: 1,
        provider: "openai-compatible",
        model: "deepseek-v4-flash",
        requestModel: "deepseek-v4-flash",
        purpose: "chat_turn",
        attempt: 1,
        requestUrl:
          "https://api.deepseek.com/v1/chat/completions?api_key=never-store-query",
        requestHeaders: {
          authorization: "Bearer never-store-this-bearer",
        },
        requestBody: { api_key: secret, messages: [] },
        success: true,
        status: 200,
        responseModel: "deepseek-v4-flash",
        finishReason: "stop",
        rawResponse: { choices: [{ message: { content: "raw" } }] },
        responseText: "raw",
        usageSource: "provider",
        inputTokens: 250,
        cacheReadTokens: 200,
        cacheWriteTokens: 0,
        cacheReadSource: "usage.prompt_tokens_details.cached_tokens",
        outputTokens: 75,
        latencyMs: 300,
        startedAtUtc: "2026-09-01T01:00:00.000Z",
        completedAtUtc: "2026-09-01T01:00:00.300Z",
      },
    ],
    primaryPromptSha256: "prompt-sha",
    rawCandidateOutput: { reply: "角色回复" },
    parsedCandidateOutput: { reply: "角色回复" },
    applicationResponse: { ok: true },
    persistedAssistant: { messageId: "assistant-1" },
    before: snapshot,
    after: snapshot,
    causalEvidence: [
      {
        schemaVersion: "companion-long-run-causal-evidence-v3",
        runId: "deepseek-v3-run",
        turnId: "T001",
        candidateOrdinal: 1,
        branch: "shared",
        capturedAtUtc: "2026-09-01T01:00:01.000Z",
        stage: "support",
        subject: "user",
        sourceMessageIds: ["message-1"],
        summary: "用户得到了倾听",
      },
    ],
    assertions: [
      {
        code: "response_contract_valid",
        status: "PASS",
        summary: "valid",
      },
    ],
    status: "PASS",
    repairAttempted: false,
    idempotentReplay: false,
  };
}

function emptySnapshot(): LongRunV3Snapshot {
  return {
    capturedAtUtc: "2026-09-01T01:00:00.000Z",
    runtimeState: null,
    cursor: null,
    lifeContext: null,
    lifeThreads: [],
    dailyContexts: [],
    dilemmas: [],
    supportInterventions: [],
    decisions: [],
    actions: [],
    outcomes: [],
    reflections: [],
    pressureEpisodes: [],
    relationshipMilestones: [],
    memories: [],
    memoryEvidence: [],
    messages: [],
    activityEvents: [],
    domainEvents: [],
    proactiveCandidates: [],
    rejectedProposals: [],
    retrievalRuns: [],
    llmCalls: [],
    scheduleItems: [],
    tableCounts: {},
    durableSha256: "f".repeat(64),
    auditSha256: "a".repeat(64),
  };
}
