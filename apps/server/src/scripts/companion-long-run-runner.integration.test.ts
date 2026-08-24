import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "../config.js";
import { companionLongRunManifest } from "../scenarios/companion-long-run-manifest.js";
import type { CompanionLongRunTurnCount } from "../scenarios/companion-long-run-profiles.js";
import {
  runSingleCompanionLongRun,
  type CompanionLongRunExecution,
  type CompanionLongRunOptions,
  type CompanionLongRunTurnExecution,
} from "./companion-long-run-runner.js";

const temporaryDirectories: string[] = [];
let requestedUrls: string[] = [];
let replaceSuccessfulPublishWithSetup500 = false;
let replaceTurnPostNumberWith500: number | undefined;
let turnPostCount = 0;

beforeEach(() => {
  for (const name of [
    "DEEPSEEK_LONG_RUN_MAX_RUNS",
    "DEEPSEEK_LONG_RUN_MAX_TURNS",
    "DEEPSEEK_LONG_RUN_MAX_TOTAL_INPUT_TOKENS",
  ]) {
    vi.stubEnv(name, "");
  }

  requestedUrls = [];
  replaceSuccessfulPublishWithSetup500 = false;
  replaceTurnPostNumberWith500 = undefined;
  turnPostCount = 0;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const href =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const url = new URL(href);
    requestedUrls.push(url.href);
    if (!isLoopback(url)) {
      throw new Error(
        `Fixture long-run attempted external network access: ${url.origin}`,
      );
    }
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      method === "POST" &&
      /^\/api\/sessions\/[^/]+\/messages$/u.test(url.pathname)
    ) {
      turnPostCount += 1;
      if (turnPostCount === replaceTurnPostNumberWith500) {
        return new Response(
          JSON.stringify({
            code: "injected_turn_500",
            responseBody: "DROP_TURN_RESPONSE_BODY",
          }),
          {
            status: 500,
            headers: {
              "content-type": "application/json",
              "x-private-debug": "DROP_TURN_RESPONSE_HEADER",
              "x-request-id": "turn-500-request-id",
            },
          },
        );
      }
    }
    const response = await nativeFetch(input, init);
    if (
      replaceSuccessfulPublishWithSetup500 &&
      /^\/api\/characters\/[^/]+\/publish$/u.test(url.pathname) &&
      response.ok
    ) {
      await response.arrayBuffer();
      return new Response(JSON.stringify({ code: "injected_setup_500" }), {
        status: 500,
        headers: {
          "content-type": "application/json",
          "x-request-id": "setup-500-request-id",
        },
      });
    }
    return response;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("companion long-run runner integration", () => {
  it("retains setup HTTP 500 evidence and all persisted partial LLM audit rows without retrying to a pass", async () => {
    replaceSuccessfulPublishWithSetup500 = true;

    const result = await runFixtureLongRun(20, "setup-500-audit");

    expect(result).toMatchObject({
      status: "FAIL",
      completionReason: "runner_error",
      logicalTurnCount: 0,
      httpExchangeCount: 3,
      sessionCount: 0,
      failure: {
        name: "LongRunHttpError",
        code: "injected_setup_500",
        stage: "setup_publish_character",
        message: "HTTP 500 (injected_setup_500).",
        retryable: true,
      },
    });
    expect(result.runHttp).toEqual([
      expect.objectContaining({
        label: "health",
        method: "GET",
        route: "/api/health",
        status: 200,
      }),
      expect.objectContaining({
        label: "compile_character",
        method: "POST",
        route: "/api/characters/generate",
        status: 201,
      }),
      expect.objectContaining({
        label: "publish_character",
        method: "POST",
        status: 500,
        requestId: "setup-500-request-id",
      }),
    ]);
    expect(result.runHttp?.[2]?.route).toMatch(
      /^\/api\/characters\/[^/]+\/publish$/u,
    );
    expect(
      result.runHttp?.every((exchange) =>
        Object.keys(exchange).every((key) =>
          [
            "label",
            "method",
            "route",
            "status",
            "durationMs",
            "requestId",
            "idempotentReplay",
          ].includes(key),
        ),
      ),
    ).toBe(true);
    expect(
      requestedUrls.filter(
        (href) => new URL(href).pathname === "/api/characters/generate",
      ),
    ).toHaveLength(1);
    expect(
      requestedUrls.filter((href) =>
        /^\/api\/characters\/[^/]+\/publish$/u.test(new URL(href).pathname),
      ),
    ).toHaveLength(1);

    expect(result.llmCalls.map((call) => call.purpose)).toEqual([
      "compile_character",
      "plan_schedule",
    ]);
    expect(result.llmCalls).toHaveLength(2);
    expect(
      result.llmCalls.every(
        (call) =>
          call.attemptTelemetrySource === "exact" &&
          call.attemptCount === 1 &&
          call.failedAttemptCount === 0 &&
          call.providerInputUsageAttemptCount === 0 &&
          call.providerOutputUsageAttemptCount === 0,
      ),
    ).toBe(true);
    expect(
      result.assertions.find((assertion) => assertion.code === "RUN-COMPLETE"),
    ).toMatchObject({ passed: false });

    const logText = await readFile(result.logPath, "utf8");
    const log = await readLongRunLog(result.logPath);
    expect(log.find((entry) => entry["event"] === "run_failed")).toMatchObject({
      code: "injected_setup_500",
      stage: "setup_publish_character",
      retryable: true,
      http: [
        expect.objectContaining({ label: "health", status: 200 }),
        expect.objectContaining({
          label: "compile_character",
          status: 201,
        }),
        expect.objectContaining({
          label: "publish_character",
          status: 500,
        }),
      ],
      llmCalls: [
        expect.objectContaining({ purpose: "compile_character" }),
        expect.objectContaining({ purpose: "plan_schedule" }),
      ],
    });
    expect(logText).not.toContain("fixture-only-not-a-secret");
    expect(logText).not.toContain("requestHeaders");
    expect(logText).not.toContain("responseBody");
  }, 60_000);

  it("retains a safe per-turn HTTP 500 failure and continues the logical run", async () => {
    replaceTurnPostNumberWith500 = 17;

    const result = await runFixtureLongRun(20, "turn-500-audit");
    const failedTurn = result.turns[16];

    expect(result).toMatchObject({
      status: "FAIL",
      completionReason: "completed",
      logicalTurnCount: 20,
    });
    expect(result.failure).toBeUndefined();
    expect(failedTurn).toMatchObject({
      sequence: 17,
      number: 82,
      error: {
        name: "LongRunHttpError",
        code: "injected_turn_500",
        stage: "http_turn_17_send",
        message: "HTTP 500 (injected_turn_500).",
        turnNumber: 82,
        retryable: true,
      },
      http: [
        expect.objectContaining({
          label: "turn_17_send",
          status: 500,
          requestId: "turn-500-request-id",
        }),
      ],
    });
    expect(result.turns.at(-1)?.sequence).toBe(20);

    const logText = await readFile(result.logPath, "utf8");
    const log = await readLongRunLog(result.logPath);
    expect(
      log.find(
        (entry) => entry["event"] === "turn_failed" && entry["sequence"] === 17,
      ),
    ).toMatchObject({
      manifestTurnNumber: 82,
      error: {
        code: "injected_turn_500",
        stage: "http_turn_17_send",
        retryable: true,
      },
    });
    expect(logText).not.toContain("DROP_TURN_RESPONSE_BODY");
    expect(logText).not.toContain("DROP_TURN_RESPONSE_HEADER");
  }, 180_000);

  it("executes all 100 target turns through real loopback HTTP with restart and durable replay audits", async () => {
    const result = await runFixtureLongRun(100, "complete-100");

    expect(result.completionReason).toBe("completed");
    expect(result.failure).toBeUndefined();
    expect(result.status, failedRunSummary(result)).toBe("PASS");
    expect(result).toMatchObject({
      providerMode: "fixture",
      provider: "fixture",
      model: "fixture-v1",
      realNetwork: false,
      pipelineExpectation: "target",
      requestedTurnCount: 100,
      logicalTurnCount: 100,
      sessionCount: 3,
      restartCount: 1,
    });
    expect(result.turns).toHaveLength(100);
    expect(result.httpExchangeCount).toBe(
      (result.runHttp?.length ?? 0) +
        result.turns.reduce((count, turn) => count + turn.http.length, 0),
    );
    expect(
      result.assertions.find((item) => item.code === "RUN-COMPLETE"),
    ).toMatchObject({ passed: true });

    for (const [turnNumber, code] of [
      [58, "R-EMOTION-CONTINUITY"],
      [59, "R-REPAIR"],
      [62, "R-STOP"],
      [69, "G1"],
      [89, "M-CORRECT"],
      [90, "M-RECALL-DURABLE"],
      [97, "M-RECALL-DURABLE"],
    ] as const) {
      expect(
        requiredTurn(result, turnNumber).assertions.find(
          (assertion) => assertion.code === code,
        ),
        `manifest turn ${String(turnNumber)} ${code}`,
      ).toMatchObject({ passed: true });
    }
    expect(
      result.assertions.find((item) => item.code === "PIPELINE-AUDIT"),
    ).toMatchObject({ passed: true });
    expect(result.metrics).toMatchObject({
      goalActivationRecall: 1,
      goalActivationPrecision: 1,
      currentTurnRetrievalMappingRate: 1,
      DurableRecallMappingRate: 1,
      DurableRecallAssertionPassRate: 1,
      RecentContextRecallPassRate: 1,
    });

    assertCompleteTargetAudit(result.turns);

    const sessionIds = new Set(result.turns.map((turn) => turn.sessionId));
    expect(new Set(result.turns.map((turn) => turn.sessionKey))).toEqual(
      new Set(["A", "B", "C"]),
    );
    expect(sessionIds.size).toBe(3);

    const occurredTurn = requiredTurn(result, 52);
    const occurredClockAction = occurredTurn.preActionResults.find(
      (action) => action["kind"] === "set_clock_from_schedule_item",
    );
    const occurredAssertion = occurredTurn.assertions.find(
      (assertion) => assertion.code === "T-OCCURRED",
    );
    expect(occurredClockAction?.["scheduleItemId"]).toBeTypeOf("string");
    expect(occurredAssertion).toMatchObject({
      passed: true,
      evidence: {
        occurredTargetScheduleItemId: occurredClockAction?.["scheduleItemId"],
        occurredTargetScheduleItemIdCount: 1,
        occurredResponseAffirmative: true,
        occurredResponseNegative: false,
      },
    });
    expect(["completed", "partial", "skipped", "cancelled"]).toContain(
      occurredAssertion?.evidence["occurredMatchedActivityEventType"],
    );
    expect(
      occurredTurn.after.activityEvents.some(
        (event) =>
          event["id"] ===
            occurredAssertion?.evidence["occurredMatchedActivityEventId"] &&
          event["scheduleItemId"] === occurredClockAction?.["scheduleItemId"],
      ),
    ).toBe(true);

    const restartTurn = requiredTurn(result, 81);
    const restartAction = restartTurn.preActionResults.find(
      (action) => action["kind"] === "restart_app",
    );
    expect(restartAction).toMatchObject({ stable: true });

    const replayTurn = requiredTurn(result, 82);
    const replayExchange = replayTurn.http.find(
      (exchange) => exchange.label === "turn_82_idempotent_replay",
    );
    expect(replayExchange).toMatchObject({
      method: "POST",
      status: 200,
      idempotentReplay: true,
    });
    const replayAssertion = replayTurn.assertions.find(
      (assertion) => assertion.code === "X-IDEMPOTENT",
    );
    expect(replayAssertion).toMatchObject({
      passed: true,
      evidence: { replayStable: true, replayStatus: 200 },
    });

    expect(result.llmCalls.length).toBeGreaterThanOrEqual(100);
    expect(
      result.llmCalls.every(
        (call) =>
          call.provider === "fixture" && call.model === "personasim-fixture-v1",
      ),
    ).toBe(true);
    expect(
      result.llmCalls.some(
        (call) =>
          call.success &&
          ["turn_understanding", "reply_generation"].includes(call.purpose),
      ),
    ).toBe(true);
    assertOnlyLoopbackFetches(2);

    const log = await readLongRunLog(result.logPath);
    expect(
      log.filter((entry) => entry["event"] === "turn_evidence"),
    ).toHaveLength(100);
    expect(log.some((entry) => entry["event"] === "run_failed")).toBe(false);
    expect(log.at(-1)).toMatchObject({
      event: "run_finished",
      completionReason: "completed",
      logicalTurns: 100,
      failedAssertionCodes: [],
      failedAssertions: [],
    });
  }, 600_000);

  it("audits authoritative pending negotiation without allowing reply text to authorize a schedule write", async () => {
    const checkpoints: Array<{
      logicalTurnCount: number;
      status: CompanionLongRunExecution["status"];
      completionReason: CompanionLongRunExecution["completionReason"];
    }> = [];
    const result = await runFixtureLongRun(
      30,
      "mutation-authority-30",
      (checkpoint) => {
        checkpoints.push({
          logicalTurnCount: checkpoint.logicalTurnCount,
          status: checkpoint.status,
          completionReason: checkpoint.completionReason,
        });
        return Promise.resolve();
      },
    );

    expect(result.completionReason).toBe("completed");
    expect(result.failure).toBeUndefined();
    expect(result.status).toBe("PASS");
    expect(result.logicalTurnCount).toBe(30);
    expect(checkpoints).toEqual([
      {
        logicalTurnCount: 10,
        status: "PARTIAL",
        completionReason: "interval_checkpoint",
      },
      {
        logicalTurnCount: 20,
        status: "PARTIAL",
        completionReason: "interval_checkpoint",
      },
    ]);

    const mutationTurns = result.turns.filter((turn) =>
      [
        "pending_only",
        "commit_exactly_one",
        "withdraw_pending",
        "clarification_only",
      ].includes(turn.expected.scheduleExpectation),
    );
    expect(mutationTurns.length).toBeGreaterThanOrEqual(6);
    for (const turn of mutationTurns) {
      expect(turn.error).toBeUndefined();
      expect(turn.validatedOutcome["replyMutationAuthorization"]).toBe(
        "disabled",
      );
      expect(
        turn.llmCalls.some(
          (call) => call.purpose === "reply_generation" && call.success,
        ),
      ).toBe(true);
    }

    // The server-validated negotiation is authoritative. Reply text can describe
    // the pending state, but it remains mutation-disabled and creates no item.
    const pending = requiredTurn(result, 31);
    expect(pending.assistantText).toContain("待确认");
    expect(pending.validatedOutcome).toMatchObject({
      scheduleOutcomeKind: "pending_confirmation",
      replyMutationAuthorization: "disabled",
    });
    expect(stringArray(pending.changes["scheduleItemIdsAdded"])).toEqual([]);
    expect(stringArray(pending.changes["scheduleItemIdsUpdated"])).toEqual([]);

    const pendingAssertion = pending.assertions.find(
      (assertion) => assertion.code === "S-PENDING",
    );
    expect(pendingAssertion).toMatchObject({
      passed: true,
      evidence: {
        scheduleKind: "pending_confirmation",
        scheduleAdded: 0,
        currentPendingNegotiationCount: 1,
      },
    });

    const committedEvent = pending.domainEvents.find(
      (event) => event["eventType"] === "conversation.turn_committed",
    );
    const committedPayload = asRecord(committedEvent?.["payload"]);
    expect(committedEvent?.["correlationId"]).toBe(pending.clientMessageId);
    expect(stringArray(committedPayload["scheduleItemIds"])).toEqual([]);
    assertOnlyLoopbackFetches(2);
  }, 300_000);
});

async function runFixtureLongRun(
  turns: CompanionLongRunTurnCount,
  runIdPrefix: string,
  onCheckpoint?: CompanionLongRunOptions["onCheckpoint"],
): Promise<CompanionLongRunExecution> {
  const directory = await mkdtemp(join(tmpdir(), "chatplus-long-run-test-"));
  temporaryDirectories.push(directory);
  return runSingleCompanionLongRun({
    provider: "fixture",
    turns,
    runs: 1,
    pipeline: "target",
    scenarioVersion: companionLongRunManifest.scenarioVersion,
    reportDir: join(directory, "reports"),
    databaseDir: join(directory, "database"),
    runIdPrefix,
    now: new Date("2026-08-23T00:00:00.000Z"),
    config: fixtureServerConfig(directory),
    ...(onCheckpoint === undefined ? {} : { onCheckpoint }),
  });
}

function fixtureServerConfig(directory: string): ServerConfig {
  return {
    nodeEnv: "test",
    profile: "companion-long-run-runner-integration",
    port: 0,
    host: "127.0.0.1",
    webOrigin: "http://127.0.0.1",
    databasePath: join(directory, "base.sqlite"),
    clockMode: "fake",
    fakeClockStart: "2026-08-24T00:00:00.000Z",
    llm: {
      provider: "fixture",
      baseUrl: "https://fixture.invalid",
      apiKey: "fixture-only-not-a-secret",
      model: "fixture-v1",
      timeoutMs: 2_000,
      maxRetries: 0,
      maxOutputTokens: 8_192,
      capabilities: {
        structuredOutputMode: "json_object",
        supportsThinkingControl: false,
        supportsStreaming: false,
        maxOutputTokens: 8_192,
      },
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
    turnPipelineMode: "legacy",
    personaContextMode: "enforced",
    scheduleNegotiationMode: "enforced",
    selfInitiatedPlanningMode: "enforced",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "enforced",
  };
}

function assertCompleteTargetAudit(
  turns: readonly CompanionLongRunTurnExecution[],
): void {
  for (const turn of turns) {
    expect(
      turn.error,
      `manifest turn ${String(turn.number)} runner error`,
    ).toBeUndefined();
    expect(
      turn.http.length,
      `manifest turn ${String(turn.number)} HTTP audit`,
    ).toBeGreaterThanOrEqual(2);
    expect(
      turn.http.every(
        (exchange) => exchange.status >= 200 && exchange.status < 300,
      ),
      `manifest turn ${String(turn.number)} HTTP status`,
    ).toBe(true);
    expect(turn.assistantText.length).toBeGreaterThan(0);
    expect(turn.actualRoute).not.toBe("missing");
    expect(turn.understandingOrigin).not.toBe("missing");
    expect(turn.turnObservation).not.toBeNull();
    expect(turn.contextPlan).not.toBeNull();
    expect(turn.promptSegmentTrace.length).toBeGreaterThan(0);
    expect(turn.validatedOutcome["replyMutationAuthorization"]).toBe(
      "disabled",
    );
    expect(
      turn.domainEvents.some(
        (event) =>
          event["eventType"] === "conversation.turn_understanding_resolved",
      ),
    ).toBe(true);
    expect(
      turn.domainEvents.some(
        (event) => event["eventType"] === "conversation.turn_committed",
      ),
    ).toBe(true);
    expect(
      turn.llmCalls.some(
        (call) => call.purpose === "reply_generation" && call.success,
      ),
    ).toBe(true);
  }
}

function failedRunSummary(result: CompanionLongRunExecution): string {
  return JSON.stringify(
    {
      failedRunAssertions: result.assertions
        .filter((assertion) => assertion.scope === "run" && !assertion.passed)
        .map((assertion) => ({
          code: assertion.code,
          evidence: assertion.evidence,
        })),
      failedTurns: result.turns.flatMap((turn) => {
        const assertions = turn.assertions.filter(
          (assertion) => !assertion.passed,
        );
        return assertions.length === 0
          ? []
          : [
              {
                sequence: turn.sequence,
                manifestTurnNumber: turn.number,
                assistantText: turn.assistantText,
                selectedEvidenceIds: turn.selectedEvidenceIds,
                assertions: assertions.map((assertion) => ({
                  code: assertion.code,
                  evidence: assertion.evidence,
                })),
              },
            ];
      }),
      metrics: result.metrics,
    },
    null,
    2,
  );
}

function requiredTurn(
  result: CompanionLongRunExecution,
  number: number,
): CompanionLongRunTurnExecution {
  const turn = result.turns.find((item) => item.number === number);
  expect(turn, `missing manifest turn ${String(number)}`).toBeDefined();
  return turn!;
}

function assertOnlyLoopbackFetches(minimumOrigins: number): void {
  expect(requestedUrls.length).toBeGreaterThan(0);
  const urls = requestedUrls.map((href) => new URL(href));
  expect(urls.every(isLoopback)).toBe(true);
  expect(new Set(urls.map((url) => url.origin)).size).toBeGreaterThanOrEqual(
    minimumOrigins,
  );
}

function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

async function readLongRunLog(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => asRecord(JSON.parse(line) as unknown));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
