import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApiDomainEventSchema,
  CreateSessionResponseSchema,
  HealthResponseSchema,
  RuntimeStateSchema,
  SendMessageResponseSchema,
  type ApiDomainEvent,
  type RuntimeState,
} from "@personasim/contracts";
import { DateTime } from "luxon";
import { z } from "zod";

import { buildApp, type PersonaSimApp } from "../app.js";
import type { ServerConfig } from "../config.js";
import { calculateLlmPromptTokenBudget } from "../services/llm-prompt-headroom.js";
import {
  AcceptanceHttpError,
  jsonPost,
  redactAcceptanceValue,
  requestJson,
  toSafeStructuredOutputDiagnostic,
  type HttpExchange,
  type SafeStructuredOutputDiagnostic,
} from "./deepseek-acceptance-flow.js";
import {
  assertDeepSeekStateAcceptanceConfig,
  createProviderCaptureFetch,
  extractPromptStateSummary,
  instrumentLlm,
  promptSummaryMatchesTurnWindow,
  type CapturedLlmCall,
  type DeepSeekStateAcceptanceAssertion,
  type PromptStateSummary,
  type ProviderHttpAttempt,
} from "./deepseek-state-acceptance-flow.js";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const ACCEPTANCE_TIMEZONE = "Asia/Shanghai";

const AgentStateResponseSchema = z
  .object({
    agentId: z.string().min(1),
    state: RuntimeStateSchema,
  })
  .passthrough();
const DeveloperEventsResponseSchema = z.object({
  events: z.array(ApiDomainEventSchema).max(500),
});

export const DEEPSEEK_STATE_CONTINUATION_USER_TEXT =
  "我刚才说完谢谢以后，你现在感觉怎么样？";

export interface DeepSeekStateContinuationPaths {
  runId: string;
  reportPath: string;
  evidencePath: string;
  databasePath: string;
}

export interface RunDeepSeekStateContinuationOptions {
  sourceDatabasePath: string;
  agentId: string;
  sourceRunId?: string;
  userText?: string;
  reportPath?: string;
  evidencePath?: string;
  databasePath?: string;
  host?: string;
  now?: Date;
  runId?: string;
}

export interface DeepSeekStateContinuationResult {
  runId: string;
  sourceRunId?: string;
  startedAtUtc: string;
  completedAtUtc: string;
  elapsedMs: number;
  passed: boolean;
  reportPath: string;
  evidencePath: string;
  sourceDatabasePath: string;
  databasePath: string;
  agentId: string;
  sessionId?: string;
  clientMessageId: string;
  userText: string;
  origin?: string;
  restartOrigin?: string;
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
  exchanges: Partial<{
    health: HttpExchange;
    preState: HttpExchange;
    createSession: HttpExchange;
    turn: HttpExchange;
    postState: HttpExchange;
    events: HttpExchange;
    restartState: HttpExchange;
  }>;
  modelInput?: {
    system: string;
    prompt: string;
    maxOutputTokens?: number;
  };
  promptStateSummary?: PromptStateSummary;
  rawProviderAttempts: ProviderHttpAttempt[];
  parsedEnvelope?: unknown;
  auxiliaryLlmCalls: CapturedLlmCall[];
  assistantText?: string;
  preState?: RuntimeState;
  acceptedAndAppliedTrace?: unknown;
  appliedDelta?: unknown;
  postState?: RuntimeState;
  restartedState?: RuntimeState;
  worldEffectsEvent?: ApiDomainEvent;
  structuredOutputDiagnostics: SafeStructuredOutputDiagnostic[];
  assertions: DeepSeekStateAcceptanceAssertion[];
  manualReviewQuestions: string[];
  failure?: { name: string; message: string; requestId?: string };
}

export function deepSeekStateContinuationPathsFor(
  date: Date,
  root = workspaceRoot,
  requestedRunId?: string,
): DeepSeekStateContinuationPaths {
  const generatedRunId =
    "deepseek-state-continuation-" +
    date.toISOString().replace(/[^0-9A-Za-z]/gu, "") +
    "-" +
    String(process.pid);
  const runId = sanitizeRunId(requestedRunId ?? generatedRunId);
  const timestamp = DateTime.fromJSDate(date)
    .setZone(ACCEPTANCE_TIMEZONE)
    .toFormat("yyyy-LL-dd_HHmmss_SSS");
  const stem = `ChatPLUS_DeepSeek_State_Continuation_${timestamp}_${runId.slice(-12)}`;
  return {
    runId,
    reportPath: resolve(root, "docs", "reports", stem + ".md"),
    evidencePath: resolve(root, "docs", "reports", stem + ".json"),
    databasePath: resolve(
      root,
      "tmp",
      "real-network-state-continuation",
      runId + ".sqlite",
    ),
  };
}

export async function runDeepSeekStateContinuation(
  inputConfig: ServerConfig,
  options: RunDeepSeekStateContinuationOptions,
): Promise<DeepSeekStateContinuationResult> {
  assertDeepSeekStateAcceptanceConfig(inputConfig);
  const startedAt = options.now ?? new Date();
  const paths = deepSeekStateContinuationPathsFor(
    startedAt,
    workspaceRoot,
    options.runId,
  );
  const reportPath = options.reportPath ?? paths.reportPath;
  const evidencePath = options.evidencePath ?? paths.evidencePath;
  const databasePath = resolve(options.databasePath ?? paths.databasePath);
  const sourceDatabasePath = isAbsolute(options.sourceDatabasePath)
    ? resolve(options.sourceDatabasePath)
    : resolve(workspaceRoot, options.sourceDatabasePath);
  if (databasePath === sourceDatabasePath) {
    throw new TypeError(
      "Continuation acceptance must copy the source database to an isolated path.",
    );
  }
  await Promise.all([
    mkdir(dirname(reportPath), { recursive: true }),
    mkdir(dirname(evidencePath), { recursive: true }),
    mkdir(dirname(databasePath), { recursive: true }),
  ]);
  await copyFile(sourceDatabasePath, databasePath, fsConstants.COPYFILE_EXCL);

  const config: ServerConfig = {
    ...inputConfig,
    nodeEnv: "test",
    profile: "deepseek-real-state-continuation",
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
    sourceDatabasePath,
    databasePath,
    reportPath,
    evidencePath,
  ];
  const clientMessageId = `${paths.runId}-continuation`;
  const startedAtMs = startedAt.getTime();
  const result: DeepSeekStateContinuationResult = {
    runId: paths.runId,
    ...(options.sourceRunId === undefined
      ? {}
      : { sourceRunId: options.sourceRunId }),
    startedAtUtc: startedAt.toISOString(),
    completedAtUtc: startedAt.toISOString(),
    elapsedMs: 0,
    passed: false,
    reportPath,
    evidencePath,
    sourceDatabasePath: safeLocalPathLabel(sourceDatabasePath),
    databasePath: safeLocalPathLabel(databasePath),
    agentId: options.agentId,
    clientMessageId,
    userText: options.userText ?? DEEPSEEK_STATE_CONTINUATION_USER_TEXT,
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
    exchanges: {},
    rawProviderAttempts: [],
    auxiliaryLlmCalls: [],
    structuredOutputDiagnostics: [],
    assertions: [],
    manualReviewQuestions: [
      "回复是否自然承接上一轮的感谢与已提交关系变化？",
      "回复是否使用当前关系状态，而不是机械复述数值？",
      "本轮 proposal 是否只描述这条新消息造成的变化？",
      "提交后的状态是否在应用重启后逐字段一致？",
    ],
  };

  let app: PersonaSimApp | undefined;
  let restartedApp: PersonaSimApp | undefined;
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
    const origin = await app.listen({
      host: options.host ?? "127.0.0.1",
      port: 0,
    });
    result.origin = origin;
    const health = await requestJson(
      origin,
      "/api/health",
      HealthResponseSchema,
      undefined,
      "continuation HTTP server health",
    );
    result.exchanges.health = health.exchange;
    const pre = await requestJson(
      origin,
      `/api/agents/${encodeURIComponent(options.agentId)}/state`,
      AgentStateResponseSchema,
      undefined,
      "load source post-state after application start",
    );
    result.preState = pre.data.state;
    result.exchanges.preState = pre.exchange;
    const session = await requestJson(
      origin,
      `/api/agents/${encodeURIComponent(options.agentId)}/sessions`,
      CreateSessionResponseSchema,
      jsonPost({ title: "DeepSeek 状态延续验收" }),
      "create a new cross-session continuation chat",
    );
    result.sessionId = session.data.session.id;
    result.exchanges.createSession = session.exchange;
    const callStart = capturedLlmCalls.length;
    const turn = await requestJson(
      origin,
      `/api/sessions/${encodeURIComponent(session.data.session.id)}/messages`,
      SendMessageResponseSchema,
      jsonPost({
        agentId: options.agentId,
        clientMessageId,
        text: result.userText,
      }),
      "send one real cross-session continuation turn",
    );
    result.exchanges.turn = turn.exchange;
    result.assistantText = turn.data.assistantMessage.content;
    const post = await requestJson(
      origin,
      `/api/agents/${encodeURIComponent(options.agentId)}/state`,
      AgentStateResponseSchema,
      undefined,
      "read continuation post-state",
    );
    result.postState = post.data.state;
    result.exchanges.postState = post.exchange;
    const events = await requestJson(
      origin,
      `/api/developer/events?agentId=${encodeURIComponent(options.agentId)}&limit=500`,
      DeveloperEventsResponseSchema,
      undefined,
      "read committed continuation trace",
    );
    result.exchanges.events = events.exchange;
    const scenarioCalls = capturedLlmCalls.slice(callStart);
    const primaryCall = scenarioCalls.find(
      (call) => call.purpose === "chat_turn",
    );
    result.rawProviderAttempts = primaryCall?.providerAttempts ?? [];
    result.auxiliaryLlmCalls = scenarioCalls.filter(
      (call) => call !== primaryCall,
    );
    if (primaryCall !== undefined) {
      result.modelInput = {
        system: primaryCall.system,
        prompt: primaryCall.prompt,
        ...(primaryCall.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: primaryCall.maxOutputTokens }),
      };
      result.promptStateSummary = extractPromptStateSummary(
        primaryCall.system,
        primaryCall.prompt,
      );
      if (primaryCall.parsedOutput !== undefined) {
        result.parsedEnvelope = primaryCall.parsedOutput;
      }
    }
    const worldEffectsEvent = events.data.events.find(
      (event) =>
        event.correlationId === clientMessageId &&
        event.eventType === "conversation.world_effects_committed",
    );
    if (worldEffectsEvent !== undefined) {
      result.worldEffectsEvent = worldEffectsEvent;
      result.acceptedAndAppliedTrace = worldEffectsEvent.payload;
      result.appliedDelta = nestedValue(worldEffectsEvent.payload, "applied");
    }

    await app.close();
    app = undefined;
    restartedApp = await buildApp({
      config,
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
    const restartOrigin = await restartedApp.listen({
      host: options.host ?? "127.0.0.1",
      port: 0,
    });
    result.restartOrigin = restartOrigin;
    const restartedState = await requestJson(
      restartOrigin,
      `/api/agents/${encodeURIComponent(options.agentId)}/state`,
      AgentStateResponseSchema,
      undefined,
      "read continuation post-state after application restart",
    );
    result.restartedState = restartedState.data.state;
    result.exchanges.restartState = restartedState.exchange;
  } catch (error) {
    result.failure = failureSummary(error);
    if (
      error instanceof AcceptanceHttpError &&
      error.exchange.requestId !== undefined
    ) {
      result.failure.requestId = error.exchange.requestId;
    }
  } finally {
    if (app !== undefined) {
      await app.close().catch((error: unknown) => {
        result.failure ??= failureSummary(error);
      });
    }
    if (restartedApp !== undefined) {
      await restartedApp.close().catch((error: unknown) => {
        result.failure ??= failureSummary(error);
      });
    }
    globalThis.fetch = originalFetch;
  }

  const completedAt = new Date();
  result.completedAtUtc = completedAt.toISOString();
  result.elapsedMs = Math.max(0, completedAt.getTime() - startedAtMs);
  result.assertions = evaluateDeepSeekStateContinuation(result);
  result.passed =
    result.failure === undefined &&
    result.assertions.length > 0 &&
    result.assertions.every((assertion) => assertion.passed);
  const safeResult = redactAcceptanceValue(
    result,
    redactionSecrets,
  ) as DeepSeekStateContinuationResult;
  await Promise.all([
    writeFile(evidencePath, JSON.stringify(safeResult, null, 2) + "\n", "utf8"),
    writeFile(
      reportPath,
      renderDeepSeekStateContinuationReport(result, redactionSecrets),
      "utf8",
    ),
  ]);
  return result;
}

export function evaluateDeepSeekStateContinuation(
  result: DeepSeekStateContinuationResult,
): DeepSeekStateAcceptanceAssertion[] {
  const promptReadsSourceState =
    result.promptStateSummary !== undefined &&
    result.preState !== undefined &&
    result.postState !== undefined &&
    promptSummaryMatchesTurnWindow(
      result.promptStateSummary,
      result.preState,
      result.postState,
    );
  const restartMatches =
    result.postState !== undefined &&
    result.restartedState !== undefined &&
    JSON.stringify(result.postState) === JSON.stringify(result.restartedState);
  const committed =
    result.worldEffectsEvent?.eventType ===
      "conversation.world_effects_committed" &&
    result.worldEffectsEvent.correlationId === result.clientMessageId &&
    result.preState !== undefined &&
    result.postState !== undefined &&
    result.postState.revision > result.preState.revision;
  const providerEvidence =
    result.modelInput !== undefined &&
    result.parsedEnvelope !== undefined &&
    result.rawProviderAttempts.some(
      (attempt) =>
        attempt.responseBodyText !== undefined &&
        attempt.rawModelOutput !== undefined,
    );
  return [
    {
      id: "source_post_state_loaded",
      description:
        "The copied acceptance database loads the source run's committed post-state.",
      passed: result.preState !== undefined,
      evidence:
        result.preState === undefined
          ? "No source state was loaded."
          : `revision=${result.preState.revision}; relationship=${JSON.stringify(result.preState.relationship)}`,
    },
    {
      id: "continuation_prompt_reads_source_post_state",
      description:
        "The real continuation prompt reads the persisted source post-state within the server clock window.",
      passed: promptReadsSourceState,
      evidence: `prompt/pre/post match=${String(promptReadsSourceState)}`,
    },
    {
      id: "continuation_provider_evidence_complete",
      description:
        "The continuation captures complete model input, raw provider output, and parsed envelope.",
      passed: providerEvidence,
      evidence: `raw attempts=${result.rawProviderAttempts.length}; auxiliary calls=${result.auxiliaryLlmCalls.length}`,
    },
    {
      id: "continuation_turn_completed",
      description: "The new-session continuation returns a non-empty reply.",
      passed: (result.assistantText?.trim().length ?? 0) > 0,
      evidence: `assistant characters=${result.assistantText?.length ?? 0}`,
    },
    {
      id: "continuation_trace_committed",
      description:
        "The continuation commits one enforced world-effect trace and advances state revision.",
      passed: committed,
      evidence: `pre revision=${result.preState?.revision ?? "missing"}; post revision=${result.postState?.revision ?? "missing"}`,
    },
    {
      id: "continuation_survives_restart",
      description:
        "A fresh application instance reads the exact continuation post-state.",
      passed: restartMatches,
      evidence: `post/restart exact match=${String(restartMatches)}`,
    },
  ];
}

export function renderDeepSeekStateContinuationReport(
  result: DeepSeekStateContinuationResult,
  secrets: readonly string[] = [],
): string {
  const safe = redactAcceptanceValue(
    result,
    secrets,
  ) as DeepSeekStateContinuationResult;
  const lines = [
    "# ChatPLUS DeepSeek State Continuation Acceptance",
    "",
    `- Result: **${safe.passed ? "PASS" : "FAIL"}**`,
    `- Source run: \`${safe.sourceRunId ?? "not supplied"}\``,
    `- Model: \`${safe.config.model}\``,
    `- Provider URL: \`${safe.config.providerUrl}\``,
    `- Prompt token budget: ${safe.config.promptTokenBudget}`,
    `- Provider retries: ${safe.config.providerMaxRetries}; no semantic resampling`,
    `- Source database: \`${safe.sourceDatabasePath}\``,
    `- Isolated continuation database: \`${safe.databasePath}\``,
    "",
    "## Structural assertions",
    "",
    "| Assertion | Result | Evidence |",
    "| --- | --- | --- |",
    ...safe.assertions.map(
      (assertion) =>
        `| ${escapeTable(assertion.id)} | ${assertion.passed ? "PASS" : "FAIL"} | ${escapeTable(assertion.evidence)} |`,
    ),
    "",
    "## Manual semantic review",
    "",
    `- User: ${safe.userText}`,
    `- Assistant: ${safe.assistantText ?? "[missing]"}`,
    `- Source revision: ${safe.preState?.revision ?? "missing"}`,
    `- Committed revision: ${safe.postState?.revision ?? "missing"}`,
    `- Restarted revision: ${safe.restartedState?.revision ?? "missing"}`,
    "",
    ...safe.manualReviewQuestions.map((question) => `- ${question}`),
    "",
    "## Full redacted evidence",
    "",
    fencedJson(safe),
  ];
  return lines.join("\n") + "\n";
}

function nestedValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function failureSummary(error: unknown): {
  name: string;
  message: string;
} {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
}

function sanitizeRunId(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]/gu, "") || "run";
}

function safeLocalPathLabel(path: string): string {
  const absolutePath = resolve(path);
  const relativePath = relative(workspaceRoot, absolutePath);
  if (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  ) {
    return relativePath.replaceAll("\\", "/");
  }
  return "[external-local-path]/" + absolutePath.split(/[\\/]/u).at(-1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fencedJson(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

function escapeTable(value: unknown): string {
  return String(value).replaceAll("|", "\\|").replace(/\r?\n/gu, " ");
}
