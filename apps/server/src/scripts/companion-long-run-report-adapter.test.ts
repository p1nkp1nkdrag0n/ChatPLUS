import type {
  CompanionLongRunExecution,
  CompanionLongRunTurnExecution,
  SafeRuntimeSnapshot,
} from "./companion-long-run-runner.js";
import {
  buildCompanionLongRunReport,
  renderCompanionLongRunReportJson,
  renderCompanionLongRunReportMarkdown,
} from "./companion-long-run-report.js";
import { toCompanionLongRunReportInput } from "./companion-long-run-report-adapter.js";
import { describe, expect, it } from "vitest";

describe("companion long-run report adapter", () => {
  it("projects all runner evidence through explicit allowlists", () => {
    const execution = executionFixture();
    const input = toCompanionLongRunReportInput(execution);
    const report = buildCompanionLongRunReport(input);
    const turn = report.turns[0];

    expect(input).toMatchObject({
      provider: "fixture-llm",
      providerMode: "fixture",
      metrics: {
        currentTurnRetrievalMappingRate: 1,
        hardAssertionPassRate: 1,
        memoryPoisonWriteCount: 0,
        nonScheduleScheduleInterferenceRate: 0,
        providerUsageAvailable: true,
        replyMutationDependenceRate: "not_measured_by_manifest_run",
      },
      artifactLabels: {
        database: "run.sqlite",
        log: "runner-safe.log",
      },
    });
    expect(input.metricDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "nonScheduleScheduleInterferenceRate",
          comparator: "=",
          threshold: 0,
          passed: true,
        }),
        expect.objectContaining({
          name: "memoryPoisonWriteCount",
          comparator: "=",
          threshold: 0,
          passed: true,
        }),
        expect.objectContaining({
          name: "currentTurnRetrievalMappingRate",
          comparator: "=",
          threshold: 1,
          passed: true,
        }),
      ]),
    );
    expect(
      input.metricDetails?.some(
        (metric) => metric.name === "replyMutationDependenceRate",
      ),
    ).toBe(false);
    expect(turn).toMatchObject({
      number: 1,
      manifestTurnNumber: 42,
      actualRoute: "continuity",
      observation: {
        origin: "fixture",
        route: "continuity",
        confidence: 0.91,
        topicKeys: ["memory.anchor"],
        topicDomains: ["memory"],
        scheduleIntentKind: "none",
        uncertaintyCodes: ["explicit_recall"],
        rejectedFieldCodes: ["worldEffects:ungrounded_quote"],
      },
      outcome: {
        route: "continuity",
        decisionPath: "full",
        worldEffectWritesEnabled: true,
        scheduleWritesEnabled: false,
        scheduleWritesEnabledSource: "missing",
        dryRun: false,
        dryRunSource: "missing",
        replyMutationAuthorization: "disabled",
        acceptedEffectCounts: {
          stateDelta: 1,
          relationshipDelta: 0,
          memories: 1,
          personalIntents: 1,
          continuityEffects: 1,
          careCues: 1,
        },
      },
      contextPlan: {
        activatedGoalIds: ["goal-main"],
        suppressedGoalIds: [],
        includeRetrievedEvidence: true,
      },
      assistant: {
        text: "我记得那只蓝色玻璃鲸。",
        chunkCount: 2,
        repairAttempted: true,
        usedFallback: false,
        reasonCode: "full",
        issueCodes: ["anchor_repaired"],
      },
    });
    expect(turn?.http).toEqual([
      {
        label: "send-message",
        method: "POST",
        route: "/api/sessions/session-a/messages",
        status: 201,
        durationMs: 18,
        requestId: "request-1",
      },
    ]);
    expect(turn?.promptSegmentTrace).toEqual([
      {
        id: "retrieved-evidence",
        placement: "prompt",
        priority: 90,
        tokenBudget: 200,
        estimatedTokens: 40,
        required: false,
        included: true,
        truncated: false,
        cacheHit: false,
      },
    ]);
    expect(turn?.stateBefore).toMatchObject({
      runtimeState: {
        revision: 1,
        relationship: {
          userId: "local-user",
          closeness: 0.4,
          trust: 0.5,
          familiarity: 0.3,
          recentInteractionValence: 0.1,
        },
      },
      memoryCount: 1,
      careCueCount: 0,
      followUpCount: 0,
      domainEventCount: 3,
    });
    expect(turn?.stateAfter).toMatchObject({
      memoryCount: 2,
      careCueCount: 1,
      followUpCount: 1,
      domainEventCount: 4,
      scheduleCommitLineage: [
        {
          authorizedItemId: "schedule-1",
          scheduleCommandEventId: "event-schedule-command-1",
          negotiationId: "negotiation-1",
          offerVersion: 2,
          negotiationStatus: "committed",
        },
      ],
    });
    expect(turn?.stateBefore).not.toHaveProperty("scheduleCommitLineage");
    expect(turn?.changes).toMatchObject({
      stateChanged: true,
      memoryIdsAdded: ["memory-2"],
      careCueIdsAdded: ["care-1"],
      followUpIdsAdded: ["follow-1"],
      memoryRejectionCodes: ["memory_conflict"],
    });
    expect(turn?.domainEvents).toEqual([
      {
        id: "event-1",
        type: "conversation.turn_committed",
        aggregateType: "conversation",
        aggregateId: "session-a",
        occurredAtUtc: "2026-08-23T00:01:00.000Z",
        correlationId: "client-1",
        causationId: "user-message-1",
        entityIds: ["user-message-1", "assistant-message-1", "memory-2"],
        reasonCodes: ["full"],
      },
    ]);
    expect(turn?.retrieval).toEqual({
      runIds: ["retrieval-1"],
      selectedEvidenceIds: ["evidence-1"],
      evidenceMappings: [
        {
          evidenceId: "evidence-1",
          memoryId: "memory-1",
          sourceMessageId: "source-message-1",
          currentTurnGrounded: true,
        },
      ],
    });
    expect(turn?.llmCalls).toEqual([
      {
        purpose: "reply_generation",
        provider: "fixture-llm",
        model: "fixture-long-run-v1",
        attempt: 2,
        attemptCount: 2,
        failedAttemptCount: 1,
        providerInputUsageAttemptCount: 2,
        providerOutputUsageAttemptCount: 2,
        attemptTelemetrySource: "exact",
        latencyMs: 25,
        success: true,
        inputTokens: 100,
        outputTokens: 50,
        providerInputTokens: 80,
        providerOutputTokens: 30,
        usageSource: "provider",
      },
    ]);
    expect(turn?.assertions[0]).toMatchObject({
      id: "001-01-Q0",
      code: "Q0",
      message: "Reply is grounded and non-empty.",
      turnNumber: 1,
      evidence: [
        { key: "anchorCount", value: 1 },
        { key: "durationEquivalentAnchorsMatched", value: 1 },
        { key: "durationEquivalentAnchorValues", value: "45" },
        { key: "explicitDurationAnchorsMatched", value: 0 },
        { key: "explicitDurationAnchorValues", value: "none" },
        { key: "passed", value: true },
        {
          key: "requiredAnchorMatchMethods",
          value: "45:authoritative_schedule_duration",
        },
      ],
    });
    expect(report.llmUsageSummary).toMatchObject({
      calls: 2,
      inputTokens: 200,
      outputTokens: 50,
      estimatedInputTokens: 220,
      estimatedOutputTokens: 70,
      providerInputTokens: 80,
      providerOutputTokens: 30,
      comparableEstimatedInputTokens: 100,
      comparableEstimatedOutputTokens: 50,
      inputTokenError: -20,
      outputTokenError: -20,
      providerUsageCalls: 1,
      attemptCount: 3,
      failedAttemptCount: 1,
      providerInputUsageAttemptCount: 2,
      providerOutputUsageAttemptCount: 2,
      exactAttemptTelemetryCalls: 1,
      completeProviderUsageCalls: 1,
    });
    expect(report.runLlmCalls).toEqual([
      {
        purpose: "compile_character",
        provider: "fixture-llm",
        model: "fixture-long-run-v1",
        attempt: 1,
        attemptCount: 1,
        failedAttemptCount: 0,
        latencyMs: 40,
        success: true,
        inputTokens: 120,
        outputTokens: 20,
      },
    ]);
    expect(report.llmUsage.map((usage) => usage.purpose)).toEqual([
      "compile_character",
      "reply_generation",
    ]);
    expect(turn).not.toHaveProperty("failure");
  });

  it("projects only safe per-turn failure scalars into JSON and Markdown", () => {
    const unsafeError = Object.assign(
      {
        name: "DROP_TURN_ERROR_NAME",
        code: "http_500",
        stage: "http_turn_17_send",
        message: "DROP_TURN_ERROR_MESSAGE E:\\private\\turn-error.txt",
        turnNumber: 82,
        retryable: true,
      },
      {
        responseBody: "DROP_TURN_RESPONSE_BODY",
        headers: { authorization: "DROP_TURN_AUTHORIZATION" },
        rawProviderPayload: "DROP_TURN_PROVIDER_PAYLOAD",
        path: "E:\\private\\turn-error.txt",
      },
    );
    const failedTurn = turnFixture({
      sequence: 1,
      number: 82,
      error: unsafeError,
    });
    const report = buildCompanionLongRunReport(
      toCompanionLongRunReportInput(
        executionFixture({
          status: "FAIL",
          requestedTurnCount: 1,
          logicalTurnCount: 1,
          turns: [failedTurn],
          assertions: failedTurn.assertions,
          llmCalls: failedTurn.llmCalls,
        }),
      ),
    );
    const json = renderCompanionLongRunReportJson(report);
    const markdown = renderCompanionLongRunReportMarkdown(report);
    const parsed = JSON.parse(json) as typeof report;

    expect(report.turns[0]?.failure).toEqual({
      code: "http_500",
      stage: "http_turn_17_send",
      retryable: true,
    });
    expect(parsed.turns[0]?.failure).toEqual({
      code: "http_500",
      stage: "http_turn_17_send",
      retryable: true,
    });
    expect(markdown).toContain(
      "Failure: code=http_500; stage=http_turn_17_send; retryable=true",
    );
    expect(markdown).toContain(
      '"failure":{"code":"http_500","stage":"http_turn_17_send","retryable":true}',
    );
    for (const unsafe of [
      "DROP_TURN_ERROR_NAME",
      "DROP_TURN_ERROR_MESSAGE",
      "DROP_TURN_RESPONSE_BODY",
      "DROP_TURN_AUTHORIZATION",
      "DROP_TURN_PROVIDER_PAYLOAD",
      "E:\\private\\turn-error.txt",
    ]) {
      expect(json).not.toContain(unsafe);
      expect(markdown).not.toContain(unsafe);
    }
  });

  it("reports durable mapping and semantic recall as independent sampled metrics", () => {
    const first = durableRecallTurn(1, 16, true);
    const semanticFailure = durableRecallTurn(2, 18, false);
    const input = toCompanionLongRunReportInput(
      executionFixture({
        requestedTurnCount: 2,
        logicalTurnCount: 2,
        turns: [first, semanticFailure],
        metrics: {
          currentTurnRetrievalMappingRate: 1,
          DurableRecallMappingRate: 1,
          DurableRecallAssertionPassRate: 0.5,
        },
      }),
    );

    expect(input.metricDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "DurableRecallMappingRate",
          value: 1,
          numerator: 2,
          denominator: 2,
          failedTurnNumbers: [],
          failedManifestTurnNumbers: [],
          source: "runner evidence-mapping integrity",
          passed: true,
        }),
        expect.objectContaining({
          name: "DurableRecallAssertionPassRate",
          value: 0.5,
          numerator: 1,
          denominator: 2,
          failedTurnNumbers: [2],
          failedManifestTurnNumbers: [18],
          source: "runner end-to-end durable recall hard assertions",
          passed: false,
        }),
        expect.objectContaining({
          name: "currentTurnRetrievalMappingRate",
          value: 1,
          numerator: 2,
          denominator: 2,
          source: "runner (deprecated alias of DurableRecallMappingRate)",
        }),
      ]),
    );
  });

  it("reports a truncated evidence prompt as a failed durable mapping sample", () => {
    const truncated = durableRecallTurn(1, 18, false, {
      mappingPassed: false,
      promptTruncated: true,
    });
    const input = toCompanionLongRunReportInput(
      executionFixture({
        status: "FAIL",
        requestedTurnCount: 1,
        logicalTurnCount: 1,
        turns: [truncated],
        metrics: {
          DurableRecallMappingRate: 0,
          DurableRecallAssertionPassRate: 0,
        },
      }),
    );

    expect(input.turns[0]?.promptSegmentTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "13_retrieved_evidence",
          included: true,
          truncated: true,
          estimatedTokens: 12,
        }),
      ]),
    );
    expect(input.metricDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "DurableRecallMappingRate",
          value: 0,
          numerator: 0,
          denominator: 1,
          failedTurnNumbers: [1],
          failedManifestTurnNumbers: [18],
          passed: false,
        }),
        expect.objectContaining({
          name: "DurableRecallAssertionPassRate",
          value: 0,
          numerator: 0,
          denominator: 1,
          failedTurnNumbers: [1],
          failedManifestTurnNumbers: [18],
          passed: false,
        }),
      ]),
    );
  });

  it("does not mark goal activation metrics as failed before that phase is covered", () => {
    const input = toCompanionLongRunReportInput(
      executionFixture({
        requestedTurnCount: 20,
        metrics: {
          goalActivationRecall: 0,
          goalActivationPrecision: 0,
        },
      }),
    );

    expect(input.metricDetails).toEqual(
      expect.arrayContaining([
        { name: "goalActivationRecall", value: 0, source: "runner" },
        { name: "goalActivationPrecision", value: 0, source: "runner" },
      ]),
    );
  });

  it("applies goal activation thresholds once the 30-turn phase is covered", () => {
    const input = toCompanionLongRunReportInput(
      executionFixture({
        requestedTurnCount: 30,
        metrics: {
          goalActivationRecall: 0,
          goalActivationPrecision: 0.89,
        },
      }),
    );

    expect(input.metricDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "goalActivationRecall",
          threshold: 1,
          passed: false,
        }),
        expect.objectContaining({
          name: "goalActivationPrecision",
          threshold: 0.9,
          passed: false,
        }),
      ]),
    );
  });

  it("supports both prompt trace arrays and persisted {segments} wrappers", () => {
    const execution = executionFixture();
    (
      execution.turns[0] as unknown as {
        promptSegmentTrace: unknown;
      }
    ).promptSegmentTrace = {
      segments: [
        {
          id: "care-cues",
          placement: "system",
          priority: 80,
          tokenBudget: 100,
          estimatedTokens: 21,
          required: true,
          included: true,
          truncated: false,
          cacheHit: true,
          reason: "cached",
          renderedText: "MUST_NOT_COPY_RENDERED_PROMPT",
        },
      ],
      droppedSegmentIds: ["autobiography"],
      systemPrompt: "MUST_NOT_COPY_SYSTEM_PROMPT",
    };

    const report = buildCompanionLongRunReport(
      toCompanionLongRunReportInput(execution),
    );
    const json = renderCompanionLongRunReportJson(report);

    expect(report.turns[0]?.promptSegmentTrace).toEqual([
      {
        id: "care-cues",
        placement: "system",
        priority: 80,
        tokenBudget: 100,
        estimatedTokens: 21,
        required: true,
        included: true,
        truncated: false,
        cacheHit: true,
        reason: "cached",
      },
    ]);
    expect(json).not.toContain("MUST_NOT_COPY_RENDERED_PROMPT");
    expect(json).not.toContain("MUST_NOT_COPY_SYSTEM_PROMPT");
    expect(json).not.toContain("droppedSegmentIds");
  });

  it("drops unknown raw fields and never leaks absolute database/log paths", () => {
    const execution = executionFixture({
      databaseLabel: "E:\\private\\runs\\run.sqlite",
      logPath: "E:\\private\\runs\\runner-safe.log",
    });
    const turn = execution.turns[0];
    if (turn === undefined) throw new Error("fixture turn missing");
    turn.turnObservation = {
      ...turn.turnObservation,
      rawProviderPayload: "RAW_PROVIDER_BODY",
      systemPrompt: "HIDDEN_SYSTEM_PROMPT",
    };
    turn.contextPlan = {
      ...turn.contextPlan,
      fullPrompt: "FULL_PROMPT_BODY",
    };
    turn.domainEvents[0] = {
      ...turn.domainEvents[0],
      payload: {
        ...asTestRecord(turn.domainEvents[0]?.["payload"]),
        secretProviderResponse: "SECRET_PROVIDER_RESPONSE",
      },
    };

    const input = toCompanionLongRunReportInput(execution);
    const report = buildCompanionLongRunReport(input);
    const json = renderCompanionLongRunReportJson(report, [
      "E:\\private\\runs",
    ]);

    expect(input.artifactLabels).toEqual({
      database: "run.sqlite",
      log: "runner-safe.log",
    });
    for (const unsafe of [
      "E:\\private\\runs",
      "RAW_PROVIDER_BODY",
      "HIDDEN_SYSTEM_PROMPT",
      "FULL_PROMPT_BODY",
      "SECRET_PROVIDER_RESPONSE",
      "DROP_LINEAGE_RAW_PAYLOAD",
      "rawProviderPayload",
      "systemPrompt",
      "fullPrompt",
      "rawPayload",
    ]) {
      expect(json).not.toContain(unsafe);
    }
  });

  it("derives partial logical turns from available evidence without stale-count blocking", () => {
    const turns = Array.from({ length: 10 }, (_, index) =>
      turnFixture({ sequence: index + 1, number: index * 3 + 1 }),
    );
    const execution = executionFixture({
      status: "PARTIAL",
      completionReason: "interval_checkpoint",
      requestedTurnCount: 30,
      logicalTurnCount: 0,
      turns,
      assertions: [],
    });
    const report = buildCompanionLongRunReport(
      toCompanionLongRunReportInput(execution, 1),
    );

    expect(report).toMatchObject({
      status: "PARTIAL",
      logicalTurnCount: 10,
      requestedTurnCount: 30,
      checkpoint: { lastCompletedTurn: 10, partialSequence: 1 },
      completionReason: "interval_checkpoint",
    });
    expect(report.turns.map((turn) => turn.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(report.turns.map((turn) => turn.manifestTurnNumber)).toEqual([
      1, 4, 7, 10, 13, 16, 19, 22, 25, 28,
    ]);
  });

  it("maps safe failures without copying raw errors", () => {
    const execution = Object.assign(
      executionFixture({
        status: "FAIL",
        completionReason: "runner_error",
        failure: {
          name: "CompanionLongRunRunnerError",
          code: "no_free_slot_within_horizon",
          stage: "pre_action_allocate_free_slot",
          message:
            "No free schedule slot was available within the configured horizon.",
          turnNumber: 40,
          retryable: false,
        },
      }),
      {
        rawError: {
          message: "RAW_ERROR_MESSAGE",
          stack: "RAW_STACK",
        },
      },
    );
    const report = buildCompanionLongRunReport(
      toCompanionLongRunReportInput(execution),
    );
    const json = renderCompanionLongRunReportJson(report);

    expect(report.failure).toEqual({
      code: "no_free_slot_within_horizon",
      stage: "pre_action_allocate_free_slot",
      message:
        "No free schedule slot was available within the configured horizon.",
      turnNumber: 40,
      retryable: false,
    });
    expect(report.completionReason).toBe("runner_error");
    expect(json).not.toContain("RAW_ERROR_MESSAGE");
    expect(json).not.toContain("RAW_STACK");
  });

  it("keeps setup 500 HTTP and partial exact-attempt audits consistent in JSON and Markdown", () => {
    const compileCall: CompanionLongRunExecution["llmCalls"][number] = {
      id: "setup-compile-call",
      purpose: "compile_character",
      provider: "openai-compatible",
      model: "deepseek-test",
      inputTokens: 120,
      outputTokens: 30,
      providerInputTokens: 100,
      providerOutputTokens: 25,
      usageSource: "provider",
      attemptCount: 1,
      failedAttemptCount: 0,
      providerInputUsageAttemptCount: 1,
      providerOutputUsageAttemptCount: 1,
      attemptTelemetrySource: "exact",
      latencyMs: 900,
      success: true,
      createdAtUtc: "2026-08-23T00:00:30.000Z",
    };
    const failedPlanCall = Object.assign(
      {
        id: "setup-plan-call",
        purpose: "plan_schedule",
        provider: "openai-compatible",
        model: "deepseek-test",
        inputTokens: 240,
        outputTokens: 0,
        providerInputTokens: 210,
        usageSource: "provider",
        attemptCount: 2,
        failedAttemptCount: 2,
        providerInputUsageAttemptCount: 2,
        providerOutputUsageAttemptCount: 0,
        attemptTelemetrySource: "exact" as const,
        latencyMs: 1_800,
        success: false,
        errorCode: "provider_timeout",
        createdAtUtc: "2026-08-23T00:01:00.000Z",
      },
      { rawProviderPayload: "DROP_SETUP_PROVIDER_PAYLOAD" },
    );
    const setup500 = Object.assign(
      {
        label: "compile_character",
        method: "POST",
        route: "/api/characters/generate?apiKey=DROP_QUERY_SECRET",
        status: 500,
        durationMs: 2_750,
        requestId: "setup-request-500",
      },
      {
        requestHeaders: { authorization: "DROP_AUTHORIZATION" },
        responseBody: "DROP_RESPONSE_BODY",
      },
    );
    const execution = executionFixture({
      status: "FAIL",
      completionReason: "runner_error",
      providerMode: "deepseek",
      provider: "openai-compatible",
      model: "deepseek-test",
      realNetwork: true,
      requestedTurnCount: 20,
      logicalTurnCount: 0,
      httpExchangeCount: 2,
      runHttp: [
        {
          label: "health",
          method: "GET",
          route: "/api/health",
          status: 200,
          durationMs: 4,
        },
        setup500,
      ],
      sessionCount: 0,
      turns: [],
      assertions: [],
      llmCalls: [compileCall, failedPlanCall],
      metrics: {},
      failure: {
        name: "LongRunHttpError",
        code: "http_500",
        stage: "setup_compile_character",
        message: "HTTP 500 (http_500).",
        retryable: true,
      },
    });
    const report = buildCompanionLongRunReport(
      toCompanionLongRunReportInput(execution),
    );
    const json = renderCompanionLongRunReportJson(report);
    const markdown = renderCompanionLongRunReportMarkdown(report);
    const parsed = JSON.parse(json) as typeof report;

    expect(parsed.runHttp).toEqual([
      {
        label: "health",
        method: "GET",
        route: "/api/health",
        status: 200,
        durationMs: 4,
      },
      {
        label: "compile_character",
        method: "POST",
        route: "/api/characters/generate",
        status: 500,
        durationMs: 2_750,
        requestId: "setup-request-500",
      },
    ]);
    expect(parsed.failure).toEqual({
      code: "http_500",
      stage: "setup_compile_character",
      message: "HTTP 500 (http_500).",
      retryable: true,
    });
    expect(parsed.runLlmCalls).toHaveLength(2);
    expect(parsed.llmUsageSummary).toMatchObject({
      calls: 2,
      successfulCalls: 1,
      failedCalls: 1,
      attemptCount: 3,
      failedAttemptCount: 2,
      exactAttemptTelemetryCalls: 2,
      providerInputUsageAttemptCount: 3,
      providerOutputUsageAttemptCount: 1,
      providerInputTokens: 310,
      providerOutputTokens: 25,
    });
    for (const expected of [
      "## Setup / run HTTP exchanges",
      "Recorded 2 allowlisted setup/run-scope exchange(s).",
      "compile_character",
      "/api/characters/generate",
      "setup-request-500",
      "physical attempts: 3 (2 failed)",
      '"stage":"setup_compile_character"',
    ]) {
      expect(markdown).toContain(expected);
    }
    for (const unsafe of [
      "DROP_QUERY_SECRET",
      "DROP_AUTHORIZATION",
      "DROP_RESPONSE_BODY",
      "DROP_SETUP_PROVIDER_PAYLOAD",
      "requestHeaders",
      "responseBody",
      "rawProviderPayload",
    ]) {
      expect(json).not.toContain(unsafe);
      expect(markdown).not.toContain(unsafe);
    }
  });

  it("makes budget-limited partial completion explicit without a raw error", () => {
    const execution = executionFixture({
      status: "PARTIAL",
      completionReason: "budget_limit",
      requestedTurnCount: 30,
    });
    const report = buildCompanionLongRunReport(
      toCompanionLongRunReportInput(execution),
    );

    expect(report).toMatchObject({
      status: "PARTIAL",
      completionReason: "budget_limit",
      failure: {
        code: "budget_limit",
        stage: "budget_limit",
        message: "Run stopped after reaching the configured token budget.",
      },
    });
  });

  it("uses only authoritative schedule-writer and dry-run fields", () => {
    const execution = executionFixture();
    const turn = execution.turns[0];
    if (turn === undefined) throw new Error("fixture turn missing");
    turn.validatedOutcome = {
      ...turn.validatedOutcome,
      scheduleWritesEnabled: true,
      dryRun: true,
      replyMutationAuthorization: "disabled",
    };
    const authoritative = buildCompanionLongRunReport(
      toCompanionLongRunReportInput(execution),
    ).turns[0]?.outcome;

    expect(authoritative).toMatchObject({
      scheduleWritesEnabled: true,
      scheduleWritesEnabledSource: "validated_outcome",
      dryRun: true,
      dryRunSource: "validated_outcome",
      replyMutationAuthorization: "disabled",
    });

    delete turn.validatedOutcome["scheduleWritesEnabled"];
    delete turn.validatedOutcome["dryRun"];
    delete turn.validatedOutcome["replyMutationAuthorization"];
    const missing = buildCompanionLongRunReport(
      toCompanionLongRunReportInput(execution),
    ).turns[0]?.outcome;
    expect(missing).toMatchObject({
      scheduleWritesEnabled: false,
      scheduleWritesEnabledSource: "missing",
      dryRun: false,
      dryRunSource: "missing",
      replyMutationAuthorization: "missing",
    });
  });
});

function executionFixture(
  overrides: Partial<CompanionLongRunExecution> = {},
): CompanionLongRunExecution {
  const turn = turnFixture();
  return {
    schemaVersion: 1,
    runId: "run-adapter-001",
    runIndex: 1,
    scenarioVersion: "companion-long-run-v1",
    repoHead: "abc1234",
    startedAtUtc: "2026-08-23T00:00:00.000Z",
    completedAtUtc: "2026-08-23T00:02:00.000Z",
    status: "PASS",
    completionReason: "completed",
    providerMode: "fixture",
    provider: "fixture-llm",
    model: "fixture-long-run-v1",
    realNetwork: false,
    clockMode: "fake",
    pipelineExpectation: "target",
    requestedTurnCount: 1,
    logicalTurnCount: 1,
    httpExchangeCount: 4,
    sessionCount: 1,
    restartCount: 0,
    databaseLabel: "E:\\private\\runs\\run.sqlite",
    reportDirectoryLabel: "tmp/companion-long-run/reports",
    turns: [turn],
    assertions: [
      {
        id: "run-complete",
        code: "RUN-COMPLETE",
        scope: "run",
        hard: true,
        passed: true,
        description: "All requested logical turns completed.",
        evidence: { requested: 1, completed: 1 },
      },
      ...turn.assertions,
    ],
    llmCalls: [
      {
        id: "llm-call-setup",
        purpose: "compile_character",
        provider: "fixture-llm",
        model: "fixture-long-run-v1",
        inputTokens: 120,
        outputTokens: 20,
        latencyMs: 40,
        success: true,
        createdAtUtc: "2026-08-23T00:00:00.000Z",
      },
      ...turn.llmCalls,
    ],
    metrics: {
      currentTurnRetrievalMappingRate: 1,
      hardAssertionPassRate: 1,
      memoryPoisonWriteCount: 0,
      nonScheduleScheduleInterferenceRate: 0,
      providerUsageAvailable: true,
      replyMutationDependenceRate: "not_measured_by_manifest_run",
    },
    logPath: "E:\\private\\runs\\runner-safe.log",
    ...overrides,
  };
}

function turnFixture(
  overrides: Partial<CompanionLongRunTurnExecution> = {},
): CompanionLongRunTurnExecution {
  return {
    sequence: 1,
    number: 42,
    phase: "explicit-memory",
    objective: "Recall only selected evidence.",
    sessionKey: "A",
    sessionId: "session-a",
    clientMessageId: "client-1",
    userText: "你还记得蓝色玻璃鲸吗？",
    actionsBefore: [{ kind: "send_message" }],
    preActionResults: [{ kind: "send_message", rawIgnored: "DROP_ME" }],
    expected: {
      route: "continuity",
      mainGoalActivated: false,
      goalExpectation: "suppressed",
      scheduleExpectation: "none",
      memoryExpectation: "recall_anchor",
      hardAssertionCodes: ["Q0"],
      softMetricTags: ["evidence_use"],
    },
    http: [
      {
        label: "send-message",
        method: "POST",
        route: "/api/sessions/session-a/messages?apiKey=DROP_QUERY",
        status: 201,
        durationMs: 18,
        requestId: "request-1",
      },
    ],
    actualRoute: "continuity",
    understandingOrigin: "deterministic",
    turnObservation: {
      schemaVersion: 1,
      origin: "deterministic",
      route: "continuity",
      scheduleIntentKind: "none",
      confidence: 0.91,
      evidenceCount: 1,
      topicKeys: ["memory.anchor"],
      routerReasonCodes: ["explicit_recall"],
      rejectedFields: [
        { field: "worldEffects", reasonCode: "ungrounded_quote" },
      ],
      rawOpaqueValue: "DROP_OBSERVATION_RAW",
    },
    validatedOutcome: {
      route: "continuity",
      scheduleOutcomeKind: "none",
      decisionPath: "full",
      worldEffectsMode: "enforced",
      worldEffectsWritesEnabled: true,
      acceptedEffectKinds: [
        "state_delta",
        "memory_candidate",
        "personal_intent_candidate",
      ],
      proposalRejectionCodes: ["continuity_duplicate"],
      replyMutationAuthorization: "disabled",
      rawOutcome: "DROP_OUTCOME_RAW",
    },
    contextPlan: {
      schemaVersion: 1,
      activatedTraitIds: ["trait-1"],
      activatedValueIds: ["value-1"],
      activatedContradictionIds: [],
      activatedGoalIds: ["goal-main"],
      activatedPreferenceIds: ["preference-1"],
      suppressedGoalIds: [],
      includeAutobiography: false,
      includeCalendar: false,
      includeFutureSchedule: false,
      includeRetrievedEvidence: true,
      trace: [{ raw: "DROP_CONTEXT_TRACE_RAW" }],
    },
    promptSegmentTrace: [
      {
        id: "retrieved-evidence",
        placement: "prompt",
        priority: 90,
        tokenBudget: 200,
        estimatedTokens: 40,
        required: false,
        included: true,
        truncated: false,
        cacheHit: false,
        renderedText: "DROP_RENDERED_TEXT",
      },
    ],
    selectedEvidenceIds: ["evidence-1"],
    retrievalRuns: [
      {
        id: "retrieval-1",
        sourceMessageId: "source-message-1",
        selectedEvidenceIds: ["evidence-1"],
        evidenceMappings: [
          {
            evidenceId: "evidence-1",
            memoryId: "memory-1",
            sourceType: "user_message",
            sourceId: "source-message-1",
            content: "DROP_EVIDENCE_CONTENT",
          },
        ],
        resultJson: "DROP_RESULT_JSON",
      },
    ],
    assistantText: "我记得那只蓝色玻璃鲸。",
    chunks: ["我记得", "那只蓝色玻璃鲸。"],
    replyAudit: {
      repairAttempted: true,
      usedFallback: false,
      issueCodes: ["anchor_repaired"],
      reasonCode: "full",
      rawReply: "DROP_RAW_REPLY",
    },
    before: snapshotFixture(false),
    after: snapshotFixture(true),
    changes: {
      stateChanged: true,
      memoryIdsAdded: ["memory-2"],
      careCueIdsAdded: ["care-1"],
      followUpIdsAdded: ["follow-1"],
      rawDiff: "DROP_RAW_DIFF",
    },
    domainEvents: [
      {
        id: "event-1",
        eventType: "conversation.turn_committed",
        streamType: "conversation",
        streamId: "session-a",
        recordedAtUtc: "2026-08-23T00:01:00.000Z",
        correlationId: "client-1",
        causationId: "user-message-1",
        payload: {
          userMessageId: "user-message-1",
          assistantMessageId: "assistant-message-1",
          memoryIds: ["memory-2"],
          reasonCode: "full",
          rawEventPayload: "DROP_EVENT_PAYLOAD",
        },
      },
    ],
    rejectedProposals: [
      {
        purpose: "memory_candidate",
        reasonCode: "memory_conflict",
        reasonSummary: "candidate conflicts with current evidence",
        raw: "DROP_REJECTED_RAW",
      },
    ],
    llmCalls: [
      {
        id: "llm-call-1",
        purpose: "reply_generation",
        provider: "fixture-llm",
        model: "fixture-long-run-v1",
        inputTokens: 100,
        outputTokens: 50,
        providerInputTokens: 80,
        providerOutputTokens: 30,
        usageSource: "provider",
        attemptCount: 2,
        failedAttemptCount: 1,
        providerInputUsageAttemptCount: 2,
        providerOutputUsageAttemptCount: 2,
        attemptTelemetrySource: "exact",
        latencyMs: 25,
        success: true,
        createdAtUtc: "2026-08-23T00:01:00.000Z",
      },
    ],
    assertions: [
      {
        id: "001-01-Q0",
        code: "Q0",
        scope: "turn",
        turnNumber: 1,
        hard: true,
        passed: true,
        description: "Reply is grounded and non-empty.",
        evidence: {
          anchorCount: 1,
          durationEquivalentAnchorValues: "45",
          durationEquivalentAnchorsMatched: 1,
          explicitDurationAnchorValues: "none",
          explicitDurationAnchorsMatched: 0,
          passed: true,
          requiredAnchorMatchMethods: "45:authoritative_schedule_duration",
        },
      },
    ],
    soft: {
      domain: "memory",
      domainConfidence: 0.9,
      mainGoalActivated: false,
      mainGoalMentioned: false,
      summaryStyleEnding: false,
      objectiveAligned: true,
    },
    ...overrides,
  };
}

function durableRecallTurn(
  sequence: number,
  manifestTurnNumber: number,
  assertionPassed: boolean,
  options: { mappingPassed?: boolean; promptTruncated?: boolean } = {},
): CompanionLongRunTurnExecution {
  const base = turnFixture();
  return {
    ...base,
    sequence,
    number: manifestTurnNumber,
    expected: {
      ...base.expected,
      hardAssertionCodes: ["M-RECALL-DURABLE"],
    },
    ...(options.promptTruncated === true
      ? {
          promptSegmentTrace: [
            {
              id: "13_retrieved_evidence",
              placement: "prompt",
              priority: 90,
              tokenBudget: 200,
              estimatedTokens: 12,
              required: false,
              included: true,
              truncated: true,
              cacheHit: false,
            },
          ],
        }
      : {}),
    assertions: [
      {
        id: `${String(sequence)}-M-RECALL-DURABLE`,
        code: "M-RECALL-DURABLE",
        scope: "turn",
        turnNumber: sequence,
        hard: true,
        passed: assertionPassed,
        description:
          "Durable recall requires mapping integrity and a correct answer.",
        evidence: {
          recallMappingPassed: options.mappingPassed ?? true,
          ...(options.promptTruncated === true
            ? {
                recallPromptSegmentIncluded: true,
                recallPromptSegmentTruncated: true,
                recallPromptSegmentEstimatedTokens: 12,
                recallPromptSegmentUsable: false,
              }
            : {}),
        },
      },
    ],
  };
}

function snapshotFixture(after: boolean): SafeRuntimeSnapshot {
  const memoryCount = after ? 2 : 1;
  const careCueCount = after ? 1 : 0;
  const followUpCount = after ? 1 : 0;
  const domainEventCount = after ? 4 : 3;
  return {
    capturedAtUtc: after
      ? "2026-08-23T00:01:00.000Z"
      : "2026-08-23T00:00:00.000Z",
    state: {
      agentId: "agent-1",
      asOfUtc: "2026-08-23T00:00:00.000Z",
      revision: after ? 2 : 1,
      moodValence: 0.1,
      moodArousal: 0.4,
      energy: 0.7,
      stress: 0.2,
      socialBattery: 0.6,
      focus: 0.8,
      sleepDebtMinutes: 0,
      relationship: {
        userId: "local-user",
        closeness: 0.4,
        trust: 0.5,
        familiarity: 0.3,
        recentInteractionValence: 0.1,
      },
      rawState: "DROP_RAW_STATE",
    },
    cursor: { rawCursor: "DROP_CURSOR" },
    schedule: [
      {
        id: "schedule-1",
        title: "上午工作",
        category: "work",
        startAtUtc: "2026-08-23T01:00:00.000Z",
        endAtUtc: "2026-08-23T02:00:00.000Z",
        status: "planned",
        revision: 1,
        rawSchedule: "DROP_SCHEDULE_RAW",
      },
    ],
    scheduleDigest: "digest-schedule",
    scheduleCommitLineage: after
      ? [
          {
            authorizedItemId: "schedule-1",
            scheduleCommandEventId: "event-schedule-command-1",
            negotiationId: "negotiation-1",
            offerVersion: 2,
            negotiationStatus: "committed",
            rawPayload: "DROP_LINEAGE_RAW_PAYLOAD",
          },
        ]
      : [],
    negotiations: [],
    memories: Array.from({ length: memoryCount }, (_, index) => ({
      id: `memory-${String(index + 1)}`,
    })),
    memoryEvidence: [],
    careCues: Array.from({ length: careCueCount }, (_, index) => ({
      id: `care-${String(index + 1)}`,
    })),
    followUps: Array.from({ length: followUpCount }, (_, index) => ({
      id: `follow-${String(index + 1)}`,
    })),
    activityEvents: [],
    counts: {
      memories: memoryCount,
      care_cues: careCueCount,
      follow_up_intents: followUpCount,
      domain_events: domainEventCount,
    },
    durableDigest: "digest-durable",
  };
}

function asTestRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}
