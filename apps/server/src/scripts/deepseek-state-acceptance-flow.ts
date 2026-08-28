import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApiDomainEventSchema,
  CreateSessionResponseSchema,
  HealthResponseSchema,
  RuntimeStateSchema,
  SendMessageResponseSchema,
  type ApiDomainEvent,
  type CharacterSpec,
  type RuntimeState,
} from "@personasim/contracts";
import {
  assembleChatPrompt,
  type PromptAssemblyTrace,
} from "@personasim/features";
import { DateTime } from "luxon";
import { z } from "zod";

import { buildApp, type PersonaSimApp } from "../app.js";
import type { ServerConfig } from "../config.js";
import {
  toFeatureScheduleItems,
  toFeatureState,
} from "../domain/feature-adapters.js";
import type { GenerateObjectInput } from "../services/llm-service.js";
import { calculateLlmPromptTokenBudget } from "../services/llm-prompt-headroom.js";
import {
  AcceptanceHttpError,
  assertDeepSeekAcceptanceConfig,
  jsonPost,
  redactAcceptanceValue,
  requestJson,
  toSafeStructuredOutputDiagnostic,
  type HttpExchange,
  type SafeStructuredOutputDiagnostic,
} from "./deepseek-acceptance-flow.js";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const ACCEPTANCE_TIMEZONE = "Asia/Shanghai";
const MIN_CHAT_OUTPUT_TOKENS = 2_800;
const RUNTIME_FIELDS = [
  "moodValence",
  "moodArousal",
  "energy",
  "stress",
  "socialBattery",
  "focus",
] as const;
const RELATIONSHIP_FIELDS = [
  "closeness",
  "trust",
  "familiarity",
  "recentInteractionValence",
  "lastInteractionAtUtc",
] as const;

const AgentStateResponseSchema = z
  .object({
    agentId: z.string().min(1),
    state: RuntimeStateSchema,
  })
  .passthrough();
const DeveloperEventsResponseSchema = z.object({
  events: z.array(ApiDomainEventSchema).max(500),
});

export interface DeepSeekStateScenario {
  id: string;
  objective: string;
  userText: string;
  nextUserText: string;
  preState: Pick<
    RuntimeState,
    | "moodValence"
    | "moodArousal"
    | "energy"
    | "stress"
    | "socialBattery"
    | "focus"
  >;
}

/** Six deliberately small, single-intent prompts. Contrast pairs reuse text. */
export const DEEPSEEK_STATE_SCENARIOS: readonly DeepSeekStateScenario[] = [
  {
    id: "DS-ST-01",
    objective: "high energy / low stress reading",
    userText: "刚忙完一小段工作，你现在愿意陪我聊聊最近在剪的片子吗？",
    nextUserText: "那你现在最想从哪一小段聊起？",
    preState: {
      moodValence: 0.3,
      moodArousal: 0.55,
      energy: 0.92,
      stress: 0.08,
      socialBattery: 0.84,
      focus: 0.82,
    },
  },
  {
    id: "DS-ST-02",
    objective: "low energy / high stress reading with identical input",
    userText: "刚忙完一小段工作，你现在愿意陪我聊聊最近在剪的片子吗？",
    nextUserText: "那你现在最想从哪一小段聊起？",
    preState: {
      moodValence: -0.2,
      moodArousal: 0.58,
      energy: 0.12,
      stress: 0.91,
      socialBattery: 0.24,
      focus: 0.22,
    },
  },
  {
    id: "DS-ST-03",
    objective: "positive valence / low arousal reading",
    userText: "你此刻最想和我分享一件什么小事？",
    nextUserText: "听起来很安静，你还想多说一点吗？",
    preState: {
      moodValence: 0.78,
      moodArousal: 0.14,
      energy: 0.66,
      stress: 0.1,
      socialBattery: 0.7,
      focus: 0.62,
    },
  },
  {
    id: "DS-ST-04",
    objective: "negative valence / high arousal reading with identical input",
    userText: "你此刻最想和我分享一件什么小事？",
    nextUserText: "我在听，你想接着说吗？",
    preState: {
      moodValence: -0.78,
      moodArousal: 0.91,
      energy: 0.58,
      stress: 0.84,
      socialBattery: 0.42,
      focus: 0.48,
    },
  },
  {
    id: "DS-ST-05",
    objective: "low focus / low social battery reading",
    userText: "我刚看完一部很喜欢的纪录片，想听听你现在愿不愿意聊聊。",
    nextUserText: "如果只说一个画面，你想先听哪个？",
    preState: {
      moodValence: 0.05,
      moodArousal: 0.36,
      energy: 0.46,
      stress: 0.5,
      socialBattery: 0.1,
      focus: 0.08,
    },
  },
  {
    id: "DS-ST-06",
    objective: "causal proposal, commit, and next-round continuation",
    userText: "你刚才愿意认真听我说，我心里轻松了很多，谢谢你。",
    nextUserText: "我刚才说完谢谢以后，你现在感觉怎么样？",
    preState: {
      moodValence: 0.12,
      moodArousal: 0.4,
      energy: 0.62,
      stress: 0.38,
      socialBattery: 0.58,
      focus: 0.64,
    },
  },
] as const;

export interface ProviderHttpAttempt {
  url: string;
  status?: number;
  durationMs: number;
  requestBodyText?: string;
  responseBodyText?: string;
  rawModelOutput?: string;
  error?: { name: string; message: string };
}

export interface CapturedLlmCall {
  purpose: string;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  parsedOutput?: unknown;
  providerAttempts: ProviderHttpAttempt[];
  error?: { name: string; message: string };
}

export interface PromptStateSummary {
  systemStateGuidance: string[];
  runtimeState?: Record<string, unknown>;
  relationship?: Record<string, unknown>;
}

export interface NextRoundReadEvidence {
  userText: string;
  promptStateSummary: PromptStateSummary;
  segmentTrace: PromptAssemblyTrace;
  postStateMatchesPrompt: boolean;
}

export interface DeepSeekStateSceneResult {
  id: string;
  objective: string;
  userText: string;
  nextUserText: string;
  agentId: string;
  sessionId: string;
  clientMessageId: string;
  setup: {
    kind: "deterministic_local_character";
    schedulePolicyEnabled: false;
    providerCalls: 0;
  };
  exchanges: {
    createSession: HttpExchange;
    preState: HttpExchange;
    turn: HttpExchange;
    postState: HttpExchange;
    events: HttpExchange;
  };
  modelInput?: {
    system: string;
    prompt: string;
    maxOutputTokens?: number;
  };
  promptStateSummary?: PromptStateSummary;
  rawProviderAttempts: ProviderHttpAttempt[];
  parsedEnvelope?: unknown;
  auxiliaryLlmCalls: CapturedLlmCall[];
  assistantText: string;
  preState: RuntimeState;
  acceptedAndAppliedTrace?: unknown;
  appliedDelta?: unknown;
  postState: RuntimeState;
  nextRoundReadEvidence: NextRoundReadEvidence;
  worldEffectsEvent?: ApiDomainEvent;
}

export interface DeepSeekStateAcceptanceAssertion {
  id: string;
  description: string;
  passed: boolean;
  evidence: string;
}

export interface DeepSeekStateAcceptanceResult {
  runId: string;
  startedAtUtc: string;
  completedAtUtc: string;
  elapsedMs: number;
  passed: boolean;
  reportPath: string;
  evidencePath: string;
  databasePath: string;
  origin?: string;
  config: {
    provider: string;
    model: string;
    providerUrl: string;
    environmentVariable: "OPENAI_COMPATIBLE_API_KEY";
    hasApiKey: boolean;
    promptTokenBudget: number;
    configuredMaxOutputTokens: number;
    providerMaxRetries: 1;
    retryPolicy: string;
    liveWorldEffectsMode: "enforced";
  };
  setupMethod: "deterministic_local_character_per_scenario";
  setupExchanges: HttpExchange[];
  scenes: DeepSeekStateSceneResult[];
  structuredOutputDiagnostics: SafeStructuredOutputDiagnostic[];
  assertions: DeepSeekStateAcceptanceAssertion[];
  manualReviewQuestions: string[];
  failure?: { name: string; message: string; requestId?: string };
}

export interface RunDeepSeekStateAcceptanceOptions {
  reportPath?: string;
  evidencePath?: string;
  databasePath?: string;
  host?: string;
  now?: Date;
  runId?: string;
}

export interface DeepSeekStateAcceptancePaths {
  runId: string;
  reportPath: string;
  evidencePath: string;
  databasePath: string;
}

export function deepSeekStateAcceptancePathsFor(
  date: Date,
  root = workspaceRoot,
  requestedRunId?: string,
): DeepSeekStateAcceptancePaths {
  const generatedRunId =
    "deepseek-state-" +
    date.toISOString().replace(/[^0-9A-Za-z]/gu, "") +
    "-" +
    String(process.pid);
  const runId = sanitizeRunId(requestedRunId ?? generatedRunId);
  const timestamp = DateTime.fromJSDate(date)
    .setZone(ACCEPTANCE_TIMEZONE)
    .toFormat("yyyy-LL-dd_HHmmss_SSS");
  const stem = `ChatPLUS_DeepSeek_State_Acceptance_${timestamp}_${runId.slice(-12)}`;
  return {
    runId,
    reportPath: resolve(root, "docs", "reports", stem + ".md"),
    evidencePath: resolve(root, "docs", "reports", stem + ".json"),
    databasePath: resolve(
      root,
      "tmp",
      "real-network-state-acceptance",
      runId + ".sqlite",
    ),
  };
}

export function assertDeepSeekStateAcceptanceConfig(
  config: ServerConfig,
): void {
  assertDeepSeekAcceptanceConfig(config);
  const maximum =
    config.llm.capabilities?.maxOutputTokens ?? config.llm.maxOutputTokens;
  if (maximum === undefined || maximum < MIN_CHAT_OUTPUT_TOKENS) {
    throw new TypeError(
      `DeepSeek state acceptance requires at least ${MIN_CHAT_OUTPUT_TOKENS} configured output tokens.`,
    );
  }
}

export function createProviderCaptureFetch(
  originalFetch: typeof fetch,
  providerOrigin: string,
  sink: ProviderHttpAttempt[],
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (new URL(url).origin !== providerOrigin) {
      return originalFetch(input, init);
    }
    const started = Date.now();
    const requestBodyText =
      typeof init?.body === "string" ? init.body : undefined;
    try {
      const response = await originalFetch(input, init);
      const responseBodyText = await response.clone().text();
      const rawModelOutput = rawModelOutputFrom(responseBodyText);
      sink.push({
        url,
        status: response.status,
        durationMs: Math.max(0, Date.now() - started),
        ...(requestBodyText === undefined ? {} : { requestBodyText }),
        responseBodyText,
        ...(rawModelOutput === undefined ? {} : { rawModelOutput }),
      });
      return response;
    } catch (error) {
      sink.push({
        url,
        durationMs: Math.max(0, Date.now() - started),
        ...(requestBodyText === undefined ? {} : { requestBodyText }),
        error: errorIdentity(error),
      });
      throw error;
    }
  };
}

export function extractPromptStateSummary(
  system: string,
  prompt: string,
): PromptStateSummary {
  const runtimeState = labeledJson(prompt, "RUNTIME_STATE_JSON");
  const relationship = labeledJson(prompt, "RELATIONSHIP_JSON");
  return {
    systemStateGuidance: system
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter((line) =>
        /(?:runtime[ _-]?state|present.moment|mood|energy|stress|social.?battery|focus)/iu.test(
          line,
        ),
      )
      .slice(0, 20),
    ...(runtimeState === undefined ? {} : { runtimeState }),
    ...(relationship === undefined ? {} : { relationship }),
  };
}

export async function runDeepSeekStateAcceptance(
  inputConfig: ServerConfig,
  options: RunDeepSeekStateAcceptanceOptions = {},
): Promise<DeepSeekStateAcceptanceResult> {
  assertDeepSeekStateAcceptanceConfig(inputConfig);
  const startedAt = options.now ?? new Date();
  const paths = deepSeekStateAcceptancePathsFor(
    startedAt,
    workspaceRoot,
    options.runId,
  );
  const reportPath = options.reportPath ?? paths.reportPath;
  const evidencePath = options.evidencePath ?? paths.evidencePath;
  const databasePath = options.databasePath ?? paths.databasePath;
  await Promise.all([
    mkdir(dirname(reportPath), { recursive: true }),
    mkdir(dirname(evidencePath), { recursive: true }),
    mkdir(dirname(databasePath), { recursive: true }),
  ]);

  const config: ServerConfig = {
    ...inputConfig,
    nodeEnv: "test",
    profile: "deepseek-real-state-acceptance",
    databasePath,
    clockMode: "system",
    seedDemo: false,
    developerRoutes: true,
    chatEffectsMode: "off",
    scheduleNegotiationMode: "legacy",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "legacy",
    autobiographyMode: "off",
    llm: {
      ...inputConfig.llm,
      provider: "openai-compatible",
      maxRetries: 1,
    },
  };
  const promptTokenBudget = calculateLlmPromptTokenBudget(
    config.llm.capabilities!,
  );
  const redactionSecrets = [
    config.llm.apiKey ?? "",
    workspaceRoot,
    databasePath,
    reportPath,
    evidencePath,
  ];
  const startedAtMs = startedAt.getTime();
  const result: DeepSeekStateAcceptanceResult = {
    runId: paths.runId,
    startedAtUtc: startedAt.toISOString(),
    completedAtUtc: startedAt.toISOString(),
    elapsedMs: 0,
    passed: false,
    reportPath,
    evidencePath,
    databasePath: safeLocalPathLabel(databasePath),
    config: {
      provider: config.llm.provider,
      model: config.llm.model,
      providerUrl: config.llm.baseUrl,
      environmentVariable: "OPENAI_COMPATIBLE_API_KEY",
      hasApiKey: config.llm.apiKey !== undefined,
      promptTokenBudget,
      configuredMaxOutputTokens:
        config.llm.capabilities?.maxOutputTokens ??
        config.llm.maxOutputTokens ??
        0,
      providerMaxRetries: 1,
      retryPolicy:
        "one provider retry for retryable transport/timeout/structured JSON failures; no semantic resampling",
      liveWorldEffectsMode: "enforced",
    },
    setupMethod: "deterministic_local_character_per_scenario",
    setupExchanges: [],
    scenes: [],
    structuredOutputDiagnostics: [],
    assertions: [],
    manualReviewQuestions: [
      "模型是否正确理解角色当前状态？",
      "回复是否自然体现状态，而不是机械复述数值？",
      "proposal 是否与本轮对话有因果关系？",
      "服务端是否正确处理并持久化？",
      "下一轮 Prompt 是否延续已提交变化？",
    ],
  };

  let app: PersonaSimApp | undefined;
  let origin: string | undefined;
  const providerAttempts: ProviderHttpAttempt[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createProviderCaptureFetch(
    originalFetch,
    new URL(config.llm.baseUrl).origin,
    providerAttempts,
  );
  try {
    app = await buildApp({
      config,
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
    const capturedLlmCalls = instrumentLlm(app, providerAttempts);
    app.addHook("onError", (request, _reply, error, done) => {
      const diagnostic = toSafeStructuredOutputDiagnostic(
        error,
        {
          requestId: request.id,
          method: request.method,
          routePath: request.routeOptions.url ?? request.url,
        },
        redactionSecrets,
      );
      if (diagnostic !== undefined) {
        result.structuredOutputDiagnostics.push(diagnostic);
      }
      done();
    });
    origin = await app.listen({
      host: options.host ?? "127.0.0.1",
      port: 0,
    });
    result.origin = origin;
    const health = await requestJson(
      origin,
      "/api/health",
      HealthResponseSchema,
      undefined,
      "state acceptance HTTP server health",
    );
    result.setupExchanges.push(health.exchange);

    for (const [index, scenario] of DEEPSEEK_STATE_SCENARIOS.entries()) {
      const spec = prepareScenarioCharacter(app, scenario);
      const agentId = spec.id;
      const session = await requestJson(
        origin,
        `/api/agents/${encodeURIComponent(agentId)}/sessions`,
        CreateSessionResponseSchema,
        jsonPost({ title: `DeepSeek 状态验收 ${scenario.id}` }),
        `${scenario.id} create isolated session`,
      );
      const sessionId = session.data.session.id;
      const pre = await requestJson(
        origin,
        `/api/agents/${encodeURIComponent(agentId)}/state`,
        AgentStateResponseSchema,
        undefined,
        `${scenario.id} pre-state`,
      );
      const callStart = capturedLlmCalls.length;
      const clientMessageId = `${paths.runId}-${scenario.id.toLowerCase()}-${index + 1}`;
      const turn = await requestJson(
        origin,
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        SendMessageResponseSchema,
        jsonPost({
          agentId,
          clientMessageId,
          text: scenario.userText,
        }),
        `${scenario.id} single-intent chat turn`,
      );
      const post = await requestJson(
        origin,
        `/api/agents/${encodeURIComponent(agentId)}/state`,
        AgentStateResponseSchema,
        undefined,
        `${scenario.id} post-state`,
      );
      const events = await requestJson(
        origin,
        `/api/developer/events?agentId=${encodeURIComponent(agentId)}&limit=500`,
        DeveloperEventsResponseSchema,
        undefined,
        `${scenario.id} committed world-effect trace`,
      );
      const scenarioCalls = capturedLlmCalls.slice(callStart);
      const primaryCall = scenarioCalls.find(
        (call) => call.purpose === "chat_turn",
      );
      const worldEffectsEvent = events.data.events.find(
        (event) =>
          event.correlationId === clientMessageId &&
          (event.eventType === "conversation.world_effects_committed" ||
            event.eventType === "conversation.world_effects_shadow_evaluated"),
      );
      const trace = worldEffectsEvent?.payload;
      const nextRoundReadEvidence = assembleNextRoundReadEvidence({
        app,
        spec,
        sessionId,
        postState: post.data.state,
        userText: scenario.nextUserText,
        promptTokenBudget,
      });
      result.scenes.push({
        id: scenario.id,
        objective: scenario.objective,
        userText: scenario.userText,
        nextUserText: scenario.nextUserText,
        agentId,
        sessionId,
        clientMessageId,
        setup: {
          kind: "deterministic_local_character",
          schedulePolicyEnabled: false,
          providerCalls: 0,
        },
        exchanges: {
          createSession: session.exchange,
          preState: pre.exchange,
          turn: turn.exchange,
          postState: post.exchange,
          events: events.exchange,
        },
        ...(primaryCall === undefined
          ? {}
          : {
              modelInput: {
                system: primaryCall.system,
                prompt: primaryCall.prompt,
                ...(primaryCall.maxOutputTokens === undefined
                  ? {}
                  : { maxOutputTokens: primaryCall.maxOutputTokens }),
              },
              promptStateSummary: extractPromptStateSummary(
                primaryCall.system,
                primaryCall.prompt,
              ),
              ...(primaryCall.parsedOutput === undefined
                ? {}
                : { parsedEnvelope: primaryCall.parsedOutput }),
            }),
        rawProviderAttempts: primaryCall?.providerAttempts ?? [],
        auxiliaryLlmCalls: scenarioCalls.filter((call) => call !== primaryCall),
        assistantText: turn.data.assistantMessage.content,
        preState: pre.data.state,
        ...(trace === undefined
          ? {}
          : {
              acceptedAndAppliedTrace: trace,
              appliedDelta: nestedValue(trace, "applied"),
            }),
        postState: post.data.state,
        nextRoundReadEvidence,
        ...(worldEffectsEvent === undefined ? {} : { worldEffectsEvent }),
      });
    }
  } catch (error) {
    result.failure = failureSummary(error);
    if (error instanceof AcceptanceHttpError) {
      result.setupExchanges.push(error.exchange);
      if (error.exchange.requestId !== undefined) {
        result.failure.requestId = error.exchange.requestId;
      }
    }
  } finally {
    if (app !== undefined) {
      try {
        await app.close();
      } catch (error) {
        result.failure ??= failureSummary(error);
      }
    }
    globalThis.fetch = originalFetch;
  }

  const completedAt = new Date();
  result.completedAtUtc = completedAt.toISOString();
  result.elapsedMs = Math.max(0, completedAt.getTime() - startedAtMs);
  result.assertions = evaluateDeepSeekStateAcceptance(result);
  result.passed =
    result.failure === undefined &&
    result.assertions.length > 0 &&
    result.assertions.every((assertion) => assertion.passed);
  const safeResult = redactAcceptanceValue(
    result,
    redactionSecrets,
  ) as DeepSeekStateAcceptanceResult;
  await Promise.all([
    writeFile(evidencePath, JSON.stringify(safeResult, null, 2) + "\n", "utf8"),
    writeFile(
      reportPath,
      renderDeepSeekStateAcceptanceReport(result, redactionSecrets),
      "utf8",
    ),
  ]);
  return result;
}

export function evaluateDeepSeekStateAcceptance(
  result: DeepSeekStateAcceptanceResult,
): DeepSeekStateAcceptanceAssertion[] {
  const completeSceneCount = result.scenes.length;
  const primaryCalls = result.scenes.filter(
    (scene) => scene.modelInput !== undefined,
  );
  const rawAndParsed = result.scenes.filter(
    (scene) =>
      scene.rawProviderAttempts.some(
        (attempt) => attempt.responseBodyText !== undefined,
      ) && scene.parsedEnvelope !== undefined,
  );
  const committed = result.scenes.filter(
    (scene) =>
      scene.exchanges.turn.status === 201 &&
      scene.worldEffectsEvent?.eventType ===
        "conversation.world_effects_committed",
  );
  const promptReadbacks = result.scenes.filter(
    (scene) => scene.nextRoundReadEvidence.postStateMatchesPrompt,
  );
  const budgets = result.scenes.filter(
    (scene) =>
      (scene.modelInput?.maxOutputTokens ?? 0) >= MIN_CHAT_OUTPUT_TOKENS,
  );
  const prePromptMatches = result.scenes.filter((scene) =>
    promptSummaryMatchesTurnWindow(
      scene.promptStateSummary,
      scene.preState,
      scene.postState,
    ),
  );
  return [
    {
      id: "six_single_intent_scenarios",
      description: "Exactly six declared single-intent scenarios completed.",
      passed: DEEPSEEK_STATE_SCENARIOS.length === 6 && completeSceneCount === 6,
      evidence: `declared=${DEEPSEEK_STATE_SCENARIOS.length}; completed=${completeSceneCount}`,
    },
    {
      id: "complete_real_model_inputs",
      description:
        "Every scenario captured the complete chat system/prompt input.",
      passed: primaryCalls.length === 6 && prePromptMatches.length === 6,
      evidence: `inputs=${primaryCalls.length}; pre_state_prompt_matches=${prePromptMatches.length}`,
    },
    {
      id: "raw_and_parsed_envelopes",
      description:
        "Every scenario retained raw provider response and parsed envelope.",
      passed: rawAndParsed.length === 6,
      evidence: `complete=${rawAndParsed.length}/6`,
    },
    {
      id: "committed_world_effect_pipeline",
      description:
        "Each HTTP turn committed through the enforced world-effect path.",
      passed: committed.length === 6,
      evidence: `committed=${committed.length}/6`,
    },
    {
      id: "next_round_reads_post_state",
      description:
        "Offline next-round assembly reads the persisted post-state exactly.",
      passed: promptReadbacks.length === 6,
      evidence: `matching_readbacks=${promptReadbacks.length}/6`,
    },
    {
      id: "complete_envelope_budget",
      description:
        "Each chat request reserved the full structured-envelope budget.",
      passed: budgets.length === 6,
      evidence: `at_least_${MIN_CHAT_OUTPUT_TOKENS}_tokens=${budgets.length}/6`,
    },
  ];
}

export function renderDeepSeekStateAcceptanceReport(
  result: DeepSeekStateAcceptanceResult,
  secrets: readonly string[] = [],
): string {
  const safe = redactAcceptanceValue(
    result,
    secrets,
  ) as DeepSeekStateAcceptanceResult;
  const lines = [
    "# ChatPLUS DeepSeek State Acceptance",
    "",
    `- Result: **${safe.passed ? "PASS" : "FAIL"}**`,
    `- Run: \`${escapeInline(safe.runId)}\``,
    `- Started: \`${escapeInline(safe.startedAtUtc)}\``,
    `- Model: \`${escapeInline(safe.config.model)}\``,
    `- URL: \`${escapeInline(safe.config.providerUrl)}\``,
    `- Prompt token budget: \`${safe.config.promptTokenBudget}\``,
    `- Configured output tokens: \`${safe.config.configuredMaxOutputTokens}\``,
    `- Credential environment: \`${safe.config.environmentVariable}\` (${safe.config.hasApiKey ? "present" : "missing"})`,
    `- Retry policy: ${safe.config.retryPolicy}`,
    `- Full redacted evidence: \`${escapeInline(safe.evidencePath)}\``,
    "",
    "## Automated structural checks",
    "",
    "| Check | Result | Evidence |",
    "| --- | --- | --- |",
    ...safe.assertions.map(
      (assertion) =>
        `| ${escapeTable(assertion.id)} | ${assertion.passed ? "PASS" : "FAIL"} | ${escapeTable(assertion.evidence)} |`,
    ),
    "",
    "## Scenario summary",
    "",
    "| ID | Objective | HTTP | Revision | Raw attempts | Parsed | Next read |",
    "| --- | --- | ---: | --- | ---: | --- | --- |",
    ...safe.scenes.map(
      (scene) =>
        `| ${escapeTable(scene.id)} | ${escapeTable(scene.objective)} | ${scene.exchanges.turn.status} | ${scene.preState.revision} → ${scene.postState.revision} | ${scene.rawProviderAttempts.length} | ${scene.parsedEnvelope === undefined ? "no" : "yes"} | ${scene.nextRoundReadEvidence.postStateMatchesPrompt ? "match" : "mismatch"} |`,
    ),
    "",
  ];
  for (const scene of safe.scenes) {
    lines.push(
      `## ${scene.id}`,
      "",
      `Objective: ${scene.objective}`,
      "",
      "User input:",
      "",
      fenced(scene.userText),
      "",
      "Prompt state summary:",
      "",
      fencedJson(scene.promptStateSummary),
      "",
      "Parsed canonical envelope:",
      "",
      fencedJson(scene.parsedEnvelope),
      "",
      "Pre / applied / post:",
      "",
      fencedJson({
        pre: scene.preState,
        trace: scene.acceptedAndAppliedTrace,
        applied: scene.appliedDelta,
        post: scene.postState,
      }),
      "",
      "Next-round read evidence:",
      "",
      fencedJson(scene.nextRoundReadEvidence),
      "",
      "Raw provider attempts:",
      "",
      fencedJson(scene.rawProviderAttempts),
      "",
      "Assistant reply:",
      "",
      fenced(scene.assistantText),
      "",
      "The complete system and prompt strings are retained in the redacted JSON evidence artifact.",
      "",
    );
  }
  lines.push("## Manual semantic review", "");
  for (const question of safe.manualReviewQuestions)
    lines.push(`- ${question}`);
  if (safe.failure !== undefined) {
    lines.push("", "## Run failure", "", fencedJson(safe.failure));
  }
  return lines.join("\n") + "\n";
}

function prepareScenarioCharacter(
  app: PersonaSimApp,
  scenario: DeepSeekStateScenario,
): CharacterSpec {
  const created = app.personasim.characters.createDemoCharacter();
  const draft = app.personasim.characters.updateDraft(created.id, {
    expectedVersion: created.version,
    patch: {
      schedulePolicy: { enabled: false },
      proactivePolicy: { enabled: false },
    },
  });
  const published = app.personasim.characters.publish(draft.id, draft.version);
  const current = app.personasim.store.getRuntimeState(published.id);
  if (current === undefined) throw new Error("Scenario state was not created.");
  const atUtc = app.personasim.clock.nowUtc();
  const seeded = RuntimeStateSchema.parse({
    ...current,
    ...scenario.preState,
    asOfUtc: atUtc,
    revision: current.revision + 1,
  });
  if (
    !app.personasim.store.compareAndSetRuntimeState(seeded, current.revision)
  ) {
    throw new Error(`Could not seed ${scenario.id} runtime state.`);
  }
  return published;
}

export function instrumentLlm(
  app: PersonaSimApp,
  providerAttempts: ProviderHttpAttempt[],
): CapturedLlmCall[] {
  const calls: CapturedLlmCall[] = [];
  const llm = app.personasim.llm;
  const originalGenerateObject = llm.generateObject.bind(llm);
  llm.generateObject = async <T>(input: GenerateObjectInput<T>): Promise<T> => {
    const attemptStart = providerAttempts.length;
    try {
      const output = await originalGenerateObject(input);
      calls.push({
        purpose: input.purpose,
        system: input.system,
        prompt: input.prompt,
        ...(input.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: input.maxOutputTokens }),
        parsedOutput: output,
        providerAttempts: providerAttempts.slice(attemptStart),
      });
      return output;
    } catch (error) {
      calls.push({
        purpose: input.purpose,
        system: input.system,
        prompt: input.prompt,
        ...(input.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: input.maxOutputTokens }),
        providerAttempts: providerAttempts.slice(attemptStart),
        error: errorIdentity(error),
      });
      throw error;
    }
  };
  return calls;
}

function assembleNextRoundReadEvidence(input: {
  app: PersonaSimApp;
  spec: CharacterSpec;
  sessionId: string;
  postState: RuntimeState;
  userText: string;
  promptTokenBudget: number;
}): NextRoundReadEvidence {
  const nowUtc = input.app.personasim.clock.nowUtc();
  const recentMessages = input.app.personasim.store
    .listMessagesForContext(input.sessionId)
    .map((message) => ({
      role: message.role === "system" ? ("assistant" as const) : message.role,
      content: message.content,
      createdAtUtc: message.createdAtUtc,
    }));
  const assembled = assembleChatPrompt({
    character: input.spec,
    state: toFeatureState(input.postState),
    schedule: toFeatureScheduleItems(
      input.app.personasim.store.listSchedule(input.spec.id),
    ),
    memories: [],
    recentMessages,
    nowUtc,
    userMessage: input.userText,
    maxInputTokens: input.promptTokenBudget,
    decisionMode: "reply_only",
    liveWorldEffectsMode: "enforced",
  });
  const promptStateSummary = extractPromptStateSummary(
    assembled.system,
    assembled.prompt,
  );
  return {
    userText: input.userText,
    promptStateSummary,
    segmentTrace: assembled.segmentTrace,
    postStateMatchesPrompt: promptSummaryMatchesState(
      promptStateSummary,
      input.postState,
    ),
  };
}

function promptSummaryMatchesState(
  summary: PromptStateSummary | undefined,
  state: RuntimeState,
): boolean {
  return (
    promptSummaryMatchesStateValues(summary, state) &&
    summary?.runtimeState?.["asOfUtc"] === state.asOfUtc
  );
}

export function promptSummaryMatchesTurnWindow(
  summary: PromptStateSummary | undefined,
  preState: RuntimeState,
  postState: RuntimeState,
): boolean {
  if (!promptSummaryMatchesStateValues(summary, preState)) return false;
  const promptAsOf = summary?.runtimeState?.["asOfUtc"];
  if (typeof promptAsOf !== "string") return false;
  const promptTime = Date.parse(promptAsOf);
  const preTime = Date.parse(preState.asOfUtc);
  const postTime = Date.parse(postState.asOfUtc);
  return (
    Number.isFinite(promptTime) &&
    promptTime >= preTime &&
    promptTime <= postTime
  );
}

function promptSummaryMatchesStateValues(
  summary: PromptStateSummary | undefined,
  state: RuntimeState,
): boolean {
  if (summary?.runtimeState === undefined) return false;
  if (summary.runtimeState["revision"] !== state.revision) return false;
  for (const field of RUNTIME_FIELDS) {
    if (summary.runtimeState[field] !== state[field]) return false;
  }
  if (summary.runtimeState["sleepDebtMinutes"] !== state.sleepDebtMinutes) {
    return false;
  }
  if (summary.relationship === undefined) return false;
  for (const field of RELATIONSHIP_FIELDS) {
    const expected = state.relationship[field];
    if (expected === undefined) {
      if (summary.relationship[field] !== undefined) return false;
    } else if (summary.relationship[field] !== expected) return false;
  }
  return true;
}

function labeledJson(
  source: string,
  label: string,
): Record<string, unknown> | undefined {
  const lines = source.split(/\r?\n/gu);
  const index = lines.indexOf(label);
  if (index < 0) return undefined;
  const candidate = lines[index + 1];
  if (candidate === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rawModelOutputFrom(responseBodyText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(responseBodyText);
    if (!isRecord(parsed) || !Array.isArray(parsed["choices"]))
      return undefined;
    const choices: unknown[] = parsed["choices"];
    const choice: unknown = choices[0];
    if (!isRecord(choice) || !isRecord(choice["message"])) return undefined;
    const content = choice["message"]["content"];
    return typeof content === "string" ? content : undefined;
  } catch {
    return undefined;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function nestedValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function failureSummary(error: unknown): {
  name: string;
  message: string;
  requestId?: string;
} {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
}

function errorIdentity(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
}

function sanitizeRunId(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]/gu, "").slice(0, 120) || "run";
}

function safeLocalPathLabel(path: string): string {
  if (path === ":memory:") return "[in-memory]";
  const candidate = relative(workspaceRoot, path).replace(/\\/gu, "/");
  return candidate !== "" &&
    candidate !== ".." &&
    !candidate.startsWith("../") &&
    !isAbsolute(candidate)
    ? candidate
    : "[custom local database]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fenced(value: string): string {
  return "```text\n" + value.replace(/```/gu, "` ` `") + "\n```";
}

function fencedJson(value: unknown): string {
  return "```json\n" + JSON.stringify(value ?? null, null, 2) + "\n```";
}

function escapeInline(value: string): string {
  return value.replace(/`/gu, "'").replace(/\r?\n/gu, " ");
}

function escapeTable(value: unknown): string {
  return String(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}
