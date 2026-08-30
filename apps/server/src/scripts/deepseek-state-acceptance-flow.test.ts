import type { RuntimeState } from "@personasim/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "../config.js";
import {
  DEEPSEEK_STATE_SCENARIOS,
  assertDeepSeekStateAcceptanceConfig,
  createProviderCaptureFetch,
  deepSeekStateAcceptancePathsFor,
  evaluateDeepSeekStateAcceptance,
  extractPromptStateSummary,
  promptSummaryMatchesTurnWindow,
  renderDeepSeekStateAcceptanceReport,
  type DeepSeekStateAcceptanceResult,
  type DeepSeekStateSceneResult,
} from "./deepseek-state-acceptance-flow.js";
import {
  deepSeekStateContinuationPathsFor,
  evaluateDeepSeekStateContinuation,
  type DeepSeekStateContinuationResult,
} from "./deepseek-state-continuation-flow.js";

describe("DeepSeek state acceptance flow", () => {
  it("defines exactly six compact single-intent state scenarios", () => {
    expect(DEEPSEEK_STATE_SCENARIOS).toHaveLength(6);
    expect(new Set(DEEPSEEK_STATE_SCENARIOS.map((item) => item.id)).size).toBe(
      6,
    );
    expect(DEEPSEEK_STATE_SCENARIOS[0]?.userText).toBe(
      DEEPSEEK_STATE_SCENARIOS[1]?.userText,
    );
    expect(DEEPSEEK_STATE_SCENARIOS[2]?.userText).toBe(
      DEEPSEEK_STATE_SCENARIOS[3]?.userText,
    );
    expect(
      DEEPSEEK_STATE_SCENARIOS.every(
        (item) =>
          item.userText.trim().length > 0 &&
          item.nextUserText.trim().length > 0,
      ),
    ).toBe(true);
  });

  it("keeps the real run behind DeepSeek and complete-envelope config gates", () => {
    expect(() => assertDeepSeekStateAcceptanceConfig(config())).not.toThrow();
    expect(() =>
      assertDeepSeekStateAcceptanceConfig(config({ maxOutputTokens: 24_575 })),
    ).toThrow(/at least 24576 configured output tokens/u);
    expect(() =>
      assertDeepSeekStateAcceptanceConfig(
        config(undefined, { baseUrl: "https://example.com/v1" }),
      ),
    ).toThrow(/deepseek\.com/u);
  });

  it("builds isolated, timestamped report, evidence, and database paths", () => {
    const paths = deepSeekStateAcceptancePathsFor(
      new Date("2026-08-28T12:34:56.789Z"),
      "E:/safe-root",
      "manual state/run",
    );

    expect(paths.runId).toBe("manualstaterun");
    expect(paths.reportPath).toMatch(
      /ChatPLUS_DeepSeek_State_Acceptance.*\.md$/u,
    );
    expect(paths.evidencePath).toMatch(
      /ChatPLUS_DeepSeek_State_Acceptance.*\.json$/u,
    );
    expect(paths.databasePath).toMatch(
      /real-network-state-acceptance.*manualstaterun\.sqlite$/u,
    );
  });

  it("extracts only the authoritative runtime and relationship prompt summaries", () => {
    const summary = extractPromptStateSummary(
      "Treat runtime state as present-moment context.\nDo not expose hidden data.",
      [
        "RUNTIME_STATE_JSON",
        '{"revision":9,"energy":0.2,"stress":0.8}',
        "RELATIONSHIP_JSON",
        '{"trust":0.3,"familiarity":0.11}',
      ].join("\n"),
    );

    expect(summary.systemStateGuidance).toEqual([
      "Treat runtime state as present-moment context.",
    ]);
    expect(summary.runtimeState).toEqual({
      revision: 9,
      energy: 0.2,
      stress: 0.8,
    });
    expect(summary.relationship).toEqual({ trust: 0.3, familiarity: 0.11 });
  });

  it("accepts the server clock advancing between the pre-state read and turn prompt", () => {
    const scene = completeScene("clock-window", 0);
    const summary = structuredClone(scene.promptStateSummary!);
    summary.runtimeState!["asOfUtc"] = "2026-08-28T00:00:00.010Z";
    const postState = {
      ...scene.postState,
      asOfUtc: "2026-08-28T00:00:00.020Z",
    };

    expect(
      promptSummaryMatchesTurnWindow(summary, scene.preState, postState),
    ).toBe(true);
    summary.runtimeState!["energy"] = scene.preState.energy - 0.1;
    expect(
      promptSummaryMatchesTurnWindow(summary, scene.preState, postState),
    ).toBe(false);
  });

  it("captures complete raw provider bodies only for the configured origin", async () => {
    const rawContent = '{"replyDecision":{"text":"你好"},"worldEffects":{}}';
    const originalFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: rawContent } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const attempts: Parameters<typeof createProviderCaptureFetch>[2] = [];
    const capturedFetch = createProviderCaptureFetch(
      originalFetch,
      "https://api.deepseek.com",
      attempts,
    );

    await capturedFetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: '{"model":"deepseek-chat"}',
    });
    await capturedFetch("http://127.0.0.1:3001/api/health");

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 200,
      requestBodyText: '{"model":"deepseek-chat"}',
      rawModelOutput: rawContent,
    });
    expect(attempts[0]?.responseBodyText).toContain("choices");
    expect(originalFetch).toHaveBeenCalledTimes(2);
  });

  it("evaluates structural evidence without pretending to grade semantics", () => {
    const result = completeResult();
    const assertions = evaluateDeepSeekStateAcceptance(result);

    expect(assertions).toHaveLength(6);
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(assertions.map((assertion) => assertion.id)).not.toContain(
      "natural_language_quality",
    );

    result.scenes[0]!.nextRoundReadEvidence.postStateMatchesPrompt = false;
    expect(
      evaluateDeepSeekStateAcceptance(result).find(
        (assertion) => assertion.id === "next_round_reads_post_state",
      ),
    ).toMatchObject({ passed: false });
  });

  it("renders compact manual-review output and redacts evidence", () => {
    const secret = ["sk", "state", "acceptance", "secret"].join("-");
    const result = completeResult();
    result.config.providerUrl = `https://api.deepseek.com/${secret}`;
    result.scenes[0]!.rawProviderAttempts[0]!.responseBodyText = secret;
    result.assertions = evaluateDeepSeekStateAcceptance(result);
    result.passed = true;

    const markdown = renderDeepSeekStateAcceptanceReport(result, [secret]);

    expect(markdown).toContain("# ChatPLUS DeepSeek State Acceptance");
    expect(markdown).toContain("## Manual semantic review");
    expect(markdown).toContain("Full redacted evidence");
    expect(markdown).toContain("[REDACTED]");
    expect(markdown).not.toContain(secret);
  });

  it("evaluates a real next-session turn and exact restart read separately", () => {
    const result = completeContinuationResult();
    const paths = deepSeekStateContinuationPathsFor(
      new Date("2026-08-28T12:34:56.789Z"),
      "E:/safe-root",
      "source/run-continuation",
    );

    expect(paths.runId).toBe("sourcerun-continuation");
    expect(paths.reportPath).toMatch(
      /ChatPLUS_DeepSeek_State_Continuation.*\.md$/u,
    );
    expect(
      evaluateDeepSeekStateContinuation(result).every(
        (assertion) => assertion.passed,
      ),
    ).toBe(true);

    result.restartedState = {
      ...result.restartedState!,
      energy: result.restartedState!.energy - 0.1,
    };
    expect(
      evaluateDeepSeekStateContinuation(result).find(
        (assertion) => assertion.id === "continuation_survives_restart",
      ),
    ).toMatchObject({ passed: false });
  });
});

function config(
  capabilities: { maxOutputTokens: number } | undefined = {
    maxOutputTokens: 32_768,
  },
  llmPatch: Partial<ServerConfig["llm"]> = {},
): ServerConfig {
  return {
    nodeEnv: "test",
    profile: "test",
    port: 3001,
    host: "127.0.0.1",
    webOrigin: "http://localhost:5173",
    databasePath: ":memory:",
    clockMode: "system",
    fakeClockStart: "2026-08-28T00:00:00.000Z",
    llm: {
      provider: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-placeholder-key",
      model: "deepseek-chat",
      timeoutMs: 1_000,
      maxRetries: 0,
      maxOutputTokens: capabilities?.maxOutputTokens ?? 32_768,
      capabilities: {
        structuredOutputMode: "json_object",
        supportsThinkingControl: true,
        supportsStreaming: false,
        ...(capabilities === undefined ? {} : capabilities),
      },
      ...llmPatch,
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
    chatEffectsMode: "off",
    lifePlanningMode: "legacy_exact",
    scheduleNegotiationMode: "legacy",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "legacy",
    autobiographyMode: "off",
  };
}

function completeResult(): DeepSeekStateAcceptanceResult {
  const scenes = DEEPSEEK_STATE_SCENARIOS.map((scenario, index) =>
    completeScene(scenario.id, index),
  );
  return {
    runId: "offline-state-test",
    startedAtUtc: "2026-08-28T00:00:00.000Z",
    completedAtUtc: "2026-08-28T00:00:01.000Z",
    elapsedMs: 1_000,
    passed: false,
    reportPath: "docs/reports/state.md",
    evidencePath: "docs/reports/state.json",
    databasePath: "tmp/state.sqlite",
    config: {
      provider: "openai-compatible",
      model: "deepseek-chat",
      providerUrl: "https://api.deepseek.com",
      environmentVariable: "OPENAI_COMPATIBLE_API_KEY",
      hasApiKey: true,
      promptTokenBudget: 24_000,
      configuredMaxOutputTokens: 32_768,
      providerMaxRetries: 1,
      retryPolicy: "one retry; no semantic resampling",
      liveWorldEffectsMode: "enforced",
    },
    setupMethod: "deterministic_local_character_per_scenario",
    setupExchanges: [],
    scenes,
    structuredOutputDiagnostics: [],
    assertions: [],
    manualReviewQuestions: ["模型是否正确理解角色当前状态？"],
  };
}

function completeScene(id: string, index: number): DeepSeekStateSceneResult {
  const state = runtimeState(index);
  const promptStateSummary = {
    systemStateGuidance: ["Runtime state is present-moment context."],
    runtimeState: {
      asOfUtc: state.asOfUtc,
      revision: state.revision,
      moodValence: state.moodValence,
      moodArousal: state.moodArousal,
      energy: state.energy,
      stress: state.stress,
      socialBattery: state.socialBattery,
      focus: state.focus,
      sleepDebtMinutes: state.sleepDebtMinutes,
    },
    relationship: {
      closeness: state.relationship.closeness,
      trust: state.relationship.trust,
      familiarity: state.relationship.familiarity,
      recentInteractionValence: state.relationship.recentInteractionValence,
      lastInteractionAtUtc: state.relationship.lastInteractionAtUtc,
    },
  };
  return {
    id,
    objective: "offline structural fixture",
    userText: "单一意图",
    nextUserText: "下一轮",
    agentId: `agent-${index}`,
    sessionId: `session-${index}`,
    clientMessageId: `client-${index}`,
    setup: {
      kind: "deterministic_local_character",
      schedulePolicyEnabled: false,
      providerCalls: 0,
    },
    exchanges: {
      createSession: exchange(201),
      preState: exchange(200),
      turn: exchange(201),
      postState: exchange(200),
      events: exchange(200),
    },
    modelInput: {
      system: "Runtime state is present-moment context.",
      prompt: "RUNTIME_STATE_JSON\n{}",
      maxOutputTokens: 24_576,
    },
    promptStateSummary,
    rawProviderAttempts: [
      {
        url: "https://api.deepseek.com/chat/completions",
        status: 200,
        durationMs: 1,
        responseBodyText: '{"choices":[]}',
        rawModelOutput: '{"replyDecision":{},"worldEffects":{}}',
      },
    ],
    parsedEnvelope: { replyDecision: { text: "自然回复" }, worldEffects: {} },
    auxiliaryLlmCalls: [],
    assistantText: "自然回复",
    preState: state,
    acceptedAndAppliedTrace: { applied: { stateDelta: {} } },
    appliedDelta: { stateDelta: {} },
    postState: state,
    nextRoundReadEvidence: {
      userText: "下一轮",
      promptStateSummary,
      segmentTrace: {
        segments: [],
        droppedSegmentIds: [],
        estimatedInputTokens: 1,
      },
      postStateMatchesPrompt: true,
    },
    worldEffectsEvent: {
      id: `event-${index}`,
      agentId: `agent-${index}`,
      streamType: "world_effects",
      streamId: `session-${index}`,
      streamVersion: state.revision,
      eventType: "conversation.world_effects_committed",
      recordedAtUtc: state.asOfUtc,
      effectiveAtUtc: state.asOfUtc,
      payload: { applied: { stateDelta: {} } },
      correlationId: `client-${index}`,
      causationId: `message-${index}`,
      idempotencyKey: `world-effects:${index}`,
    },
  };
}

function runtimeState(index: number): RuntimeState {
  return {
    agentId: `agent-${index}`,
    asOfUtc: "2026-08-28T00:00:00.000Z",
    moodValence: 0.1,
    moodArousal: 0.4,
    energy: 0.6,
    stress: 0.3,
    socialBattery: 0.5,
    focus: 0.7,
    sleepDebtMinutes: 0,
    relationship: {
      userId: "local-user",
      closeness: 0.2,
      trust: 0.25,
      familiarity: 0.1,
      recentInteractionValence: 0,
      lastInteractionAtUtc: "2026-08-28T00:00:00.000Z",
    },
    revision: index + 1,
  };
}

function exchange(status: number) {
  return {
    label: "offline",
    method: "GET",
    path: "/offline",
    status,
    durationMs: 1,
    responseBody: {},
  };
}

function completeContinuationResult(): DeepSeekStateContinuationResult {
  const preState = runtimeState(1);
  const postState: RuntimeState = {
    ...preState,
    asOfUtc: "2026-08-28T00:00:01.000Z",
    relationship: {
      ...preState.relationship,
      familiarity: preState.relationship.familiarity + 0.001,
      lastInteractionAtUtc: "2026-08-28T00:00:01.000Z",
    },
    revision: preState.revision + 1,
  };
  const promptStateSummary = completeScene(
    "continuation-prompt",
    1,
  ).promptStateSummary!;
  const worldEffectsEvent = {
    id: "event-continuation",
    agentId: preState.agentId,
    streamType: "world_effects",
    streamId: "session-continuation",
    streamVersion: postState.revision,
    eventType: "conversation.world_effects_committed" as const,
    recordedAtUtc: postState.asOfUtc,
    effectiveAtUtc: postState.asOfUtc,
    payload: { applied: { relationshipDelta: { familiarity: 0.001 } } },
    correlationId: "continuation-client",
    causationId: "continuation-message",
    idempotencyKey: "continuation-idempotency",
  };
  return {
    runId: "continuation-run",
    sourceRunId: "source-run",
    startedAtUtc: preState.asOfUtc,
    completedAtUtc: postState.asOfUtc,
    elapsedMs: 1_000,
    passed: false,
    reportPath: "docs/reports/continuation.md",
    evidencePath: "docs/reports/continuation.json",
    sourceDatabasePath: "tmp/source.sqlite",
    databasePath: "tmp/continuation.sqlite",
    agentId: preState.agentId,
    sessionId: "session-continuation",
    clientMessageId: "continuation-client",
    userText: "下一轮",
    config: {
      provider: "openai-compatible",
      model: "deepseek-chat",
      providerUrl: "https://api.deepseek.com",
      environmentVariable: "OPENAI_COMPATIBLE_API_KEY",
      hasApiKey: true,
      promptTokenBudget: 24_000,
      configuredMaxOutputTokens: 32_768,
      providerMaxRetries: 1,
      retryPolicy: "one retry; no semantic resampling",
      liveWorldEffectsMode: "enforced",
    },
    exchanges: {
      health: exchange(200),
      preState: exchange(200),
      createSession: exchange(201),
      turn: exchange(201),
      postState: exchange(200),
      events: exchange(200),
      restartState: exchange(200),
    },
    modelInput: {
      system: "Runtime state is present-moment context.",
      prompt: "RUNTIME_STATE_JSON\n{}",
      maxOutputTokens: 24_576,
    },
    promptStateSummary,
    rawProviderAttempts: [
      {
        url: "https://api.deepseek.com/chat/completions",
        status: 200,
        durationMs: 1,
        responseBodyText: '{"choices":[]}',
        rawModelOutput: '{"replyDecision":{},"worldEffects":{}}',
      },
    ],
    parsedEnvelope: { replyDecision: { text: "延续回复" }, worldEffects: {} },
    auxiliaryLlmCalls: [],
    assistantText: "延续回复",
    preState,
    acceptedAndAppliedTrace: worldEffectsEvent.payload,
    appliedDelta: worldEffectsEvent.payload.applied,
    postState,
    restartedState: structuredClone(postState),
    worldEffectsEvent,
    structuredOutputDiagnostics: [],
    assertions: [],
    manualReviewQuestions: ["是否延续？"],
  };
}
