import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApiDomainEventSchema,
  CharacterMutationResponseSchema,
  CreateSessionResponseSchema,
  HealthResponseSchema,
  ListMessagesResponseSchema,
  MemoriesResponseSchema,
  PublishCharacterResponseSchema,
  SendMessageResponseSchema,
  type ApiDomainEvent,
  type ApiStoredMessage,
  type CharacterSpec,
  type ScheduleItem,
} from "@personasim/contracts";
import type { PromptAssemblyTrace } from "@personasim/features";
import { DateTime } from "luxon";
import { StructuredOutputError } from "@personasim/providers";
import { z, type ZodType } from "zod";

import { buildApp, type PersonaSimApp } from "../app.js";
import type { ServerConfig } from "../config.js";
import {
  RetrievalRunSchema,
  type RetrievalRun,
} from "../repositories/retrieval-run-repository.js";
import { calculateLlmPromptTokenBudget } from "../services/llm-prompt-headroom.js";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const ACCEPTANCE_TIMEZONE = "Asia/Shanghai";
const UNIQUE_FACT_CODE = "BGW-7419";
const UNIQUE_FACT_OBJECT = "蓝色玻璃鲸";
const UNIQUE_FACT_LOCATION = "左口袋";
const REQUIRED_SEGMENT_IDS = [
  "01_app_policy",
  "02_character_identity",
  "03_core_persona",
  "05_boundaries",
  "10_current_time",
  "15_reply_strategy",
  "16_user_message",
  "17_output_contract",
] as const;

const PromptSegmentTraceSchema = z
  .object({
    id: z.string().min(1),
    placement: z.enum(["system", "prompt"]),
    priority: z.number(),
    tokenBudget: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
    required: z.boolean(),
    included: z.boolean(),
    truncated: z.boolean(),
    cacheHit: z.boolean(),
    reason: z
      .enum([
        "empty",
        "segment_budget",
        "global_budget",
        "required_budget_too_small",
      ])
      .optional(),
  })
  .strict();

const PromptAssemblyTraceSchema = z
  .object({
    segments: z.array(PromptSegmentTraceSchema),
    droppedSegmentIds: z.array(z.string()),
    estimatedInputTokens: z.number().int().nonnegative(),
  })
  .strict();

const LlmCallSchema = z
  .object({
    id: z.string().min(1),
    agentId: z.string().nullable().optional(),
    purpose: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    success: z.boolean(),
    errorCode: z.string().nullable().optional(),
    createdAtUtc: z.string().min(1),
  })
  .passthrough();

const LlmCallsResponseSchema = z.object({
  calls: z.array(LlmCallSchema).max(500),
});
const DeveloperEventsResponseSchema = z.object({
  events: z.array(ApiDomainEventSchema).max(500),
});
const RetrievalRunsResponseSchema = z.object({
  runs: z.array(RetrievalRunSchema).max(500),
});
const RejectedProposalSchema = z
  .object({ id: z.string().min(1) })
  .passthrough();
const RejectedProposalsResponseSchema = z.object({
  proposals: z.array(RejectedProposalSchema).max(500),
});

export type LlmCallRecord = z.infer<typeof LlmCallSchema>;
export type RetrievalRunRecord = RetrievalRun;
export type RejectedProposalRecord = z.infer<typeof RejectedProposalSchema>;

export interface HttpExchange {
  label: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestBody?: unknown;
  responseBody: unknown;
  requestId?: string;
}

export interface PersistenceSnapshot {
  memories: unknown[];
  memoryEvidence: unknown[];
  careCues: unknown[];
  followUps: unknown[];
  scheduleNegotiations: unknown[];
  sharedScheduleItems: ScheduleItem[];
}

export interface AcceptanceTurn {
  number: number;
  objective: string;
  sessionId: string;
  startedNewSession: boolean;
  clientMessageId: string;
  userText: string;
  userMessageId: string;
  exchange: HttpExchange;
  assistantText: string;
  persistedAssistant: ApiStoredMessage;
  persistedContract: Record<string, unknown>;
  contractErrors: string[];
  promptSegmentTrace: PromptAssemblyTrace;
  memoryRecall?: unknown;
  scheduleChanges: ScheduleItem[];
  domainEvents: ApiDomainEvent[];
  retrievalRuns: RetrievalRunRecord[];
  rejectedProposals: RejectedProposalRecord[];
  llmCalls: LlmCallRecord[];
  persistence: PersistenceSnapshot;
}

export interface AcceptanceAssertion {
  id: string;
  description: string;
  passed: boolean;
  evidence: string;
}

export interface SafeStructuredOutputDiagnostic {
  requestId: string;
  method: string;
  routePath: string;
  name: "StructuredOutputError";
  code: "INVALID_STRUCTURED_OUTPUT";
  issueCount: number;
  issuesTruncated: boolean;
  issues: string[];
}

export interface DeepSeekAcceptanceResult {
  runId: string;
  acceptanceDate: string;
  startedAtUtc: string;
  completedAtUtc: string;
  elapsedMs: number;
  passed: boolean;
  reportPath: string;
  databasePath: string;
  origin?: string;
  config: {
    provider: string;
    model: string;
    providerOrigin: string;
    profile: string;
    clockMode: string;
    flags: {
      chatEffectsMode: string;
      scheduleNegotiationMode: string;
      selfInitiatedPlanningMode: string;
      liveWorldEffectsMode: string;
      memoryRecallMode: string;
      autobiographyMode: string;
    };
    promptTokenBudget: number;
  };
  health?: unknown;
  characterRequest: Record<string, unknown>;
  compiledCharacter?: CharacterSpec;
  sharedSlot?: {
    startAtUtc: string;
    endAtUtc: string;
    localLabel: string;
  };
  setupExchanges: HttpExchange[];
  turns: AcceptanceTurn[];
  llmCalls: LlmCallRecord[];
  structuredOutputDiagnostics: SafeStructuredOutputDiagnostic[];
  assertions: AcceptanceAssertion[];
  failure?: {
    name: string;
    message: string;
    requestId?: string;
  };
}

export interface RunDeepSeekAcceptanceOptions {
  reportPath?: string;
  databasePath?: string;
  host?: string;
  now?: Date;
}

type DeveloperSnapshot = {
  llmCalls: LlmCallRecord[];
  events: ApiDomainEvent[];
  retrievalRuns: RetrievalRunRecord[];
  rejectedProposals: RejectedProposalRecord[];
  memories: unknown[];
};

type TurnPlan = {
  objective: string;
  userText: string;
  startedNewSession?: boolean;
};

export class AcceptanceHttpError extends Error {
  constructor(readonly exchange: HttpExchange) {
    super(`HTTP ${exchange.status} for ${exchange.method} ${exchange.path}`);
    this.name = "AcceptanceHttpError";
  }
}

export function acceptanceDateFor(
  date: Date,
  timezone = ACCEPTANCE_TIMEZONE,
): string {
  return DateTime.fromJSDate(date).setZone(timezone).toFormat("yyyy-LL-dd");
}

export function acceptanceReportPathFor(
  date: Date,
  root = workspaceRoot,
  runId = "manual-" + String(process.pid),
): string {
  const timestamp = DateTime.fromJSDate(date)
    .setZone(ACCEPTANCE_TIMEZONE)
    .toFormat("yyyy-LL-dd_HHmmss_SSS");
  const sanitizedRunId = runId.replace(/[^0-9A-Za-z_-]/gu, "");
  const shortRunId = sanitizedRunId.slice(-12) || "run";
  return resolve(
    root,
    "docs",
    "reports",
    `ChatPLUS_Real_Network_Acceptance_${timestamp}_${shortRunId}.md`,
  );
}

export function assertDeepSeekAcceptanceConfig(config: ServerConfig): void {
  if (config.llm.provider !== "openai-compatible" || !config.llm.apiKey) {
    throw new TypeError(
      "DeepSeek acceptance requires LLM_PROVIDER=openai-compatible and OPENAI_COMPATIBLE_API_KEY.",
    );
  }
  const providerUrl = new URL(config.llm.baseUrl);
  const hostname = providerUrl.hostname.toLocaleLowerCase();
  if (
    providerUrl.protocol !== "https:" ||
    providerUrl.username !== "" ||
    providerUrl.password !== ""
  ) {
    throw new TypeError(
      "DeepSeek acceptance requires HTTPS and forbids URL credentials.",
    );
  }
  if (hostname !== "deepseek.com" && !hostname.endsWith(".deepseek.com")) {
    throw new TypeError(
      "DeepSeek acceptance requires a deepseek.com API endpoint; received " +
        providerUrl.origin +
        ".",
    );
  }
  if (!config.llm.model.toLocaleLowerCase().includes("deepseek")) {
    throw new TypeError(
      "DeepSeek acceptance requires an explicitly named DeepSeek model.",
    );
  }
}

export function redactAcceptanceValue(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  const secretValues = [
    ...new Set(
      secrets.flatMap((secret) => {
        const forward = secret.replaceAll("\\", "/");
        const backward = /^[A-Za-z]:\//u.test(forward)
          ? forward.replaceAll("/", "\\")
          : undefined;
        const fileUrl = /^[A-Za-z]:\//u.test(forward)
          ? "file:///" + forward
          : undefined;
        return [secret, forward, backward, fileUrl].filter(
          (item): item is string => item !== undefined,
        );
      }),
    ),
  ]
    .filter((secret) => secret.trim().length >= 4)
    .sort((left, right) => right.length - left.length);
  const redactString = (input: string): string => {
    let output = input
      .replace(/Bearer\s+[^\s"']+/giu, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "sk-[REDACTED]");
    for (const secret of secretValues) {
      output = output.split(secret).join("[REDACTED]");
    }
    return output;
  };
  const visit = (input: unknown): unknown => {
    if (typeof input === "string") return redactString(input);
    if (Array.isArray(input)) return input.map(visit);
    if (typeof input !== "object" || input === null) return input;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      const sensitiveKey =
        key.toLocaleLowerCase() !== "hasapikey" &&
        /api.?key|authorization|cookie|password|secret|credential|access.?token|refresh.?token/iu.test(
          key,
        );
      result[key] = sensitiveKey ? "[REDACTED]" : visit(item);
    }
    return result;
  };
  return visit(value);
}
export function toSafeStructuredOutputDiagnostic(
  error: unknown,
  request: {
    requestId: string;
    method: string;
    routePath: string;
  },
  secrets: readonly string[] = [],
): SafeStructuredOutputDiagnostic | undefined {
  if (!(error instanceof StructuredOutputError)) return undefined;
  const issueLimit = 8;
  const issueCharacterLimit = 300;
  const retainedIssues = error.issues.slice(0, issueLimit);
  const issuesTruncated =
    error.issues.length > issueLimit ||
    retainedIssues.some((issue) => issue.length > issueCharacterLimit);
  const issues = retainedIssues.map((issue) => {
    const normalized = safeDiagnosticText(issue, secrets, issueCharacterLimit);
    return /(?:raw[\s_-]*output|system[\s_-]*prompt)/iu.test(normalized)
      ? "[REDACTED_UNSAFE_ISSUE]"
      : normalized;
  });
  return {
    requestId: safeDiagnosticText(request.requestId, secrets, 128),
    method: safeDiagnosticText(request.method, secrets, 16).toUpperCase(),
    routePath: safeDiagnosticText(
      request.routePath.split("?")[0] ?? request.routePath,
      secrets,
      256,
    ),
    name: "StructuredOutputError",
    code: "INVALID_STRUCTURED_OUTPUT",
    issueCount: error.issues.length,
    issuesTruncated,
    issues,
  };
}

function safeDiagnosticText(
  value: string,
  secrets: readonly string[],
  limit: number,
): string {
  const redacted = String(redactAcceptanceValue(value, secrets));
  return redacted.replace(/\s+/gu, " ").trim().slice(0, limit) || "[empty]";
}

export async function runDeepSeekAcceptance(
  inputConfig: ServerConfig,
  options: RunDeepSeekAcceptanceOptions = {},
): Promise<DeepSeekAcceptanceResult> {
  assertDeepSeekAcceptanceConfig(inputConfig);
  const startedAt = options.now ?? new Date();
  const runId =
    "deepseek-" +
    startedAt.toISOString().replace(/[^0-9A-Za-z]/gu, "") +
    "-" +
    String(process.pid);
  const reportPath =
    options.reportPath ??
    acceptanceReportPathFor(startedAt, workspaceRoot, runId);
  const databasePath =
    options.databasePath ??
    resolve(workspaceRoot, "tmp", "real-network-acceptance", runId + ".sqlite");
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(databasePath), { recursive: true });

  const config: ServerConfig = {
    ...inputConfig,
    nodeEnv: "test",
    profile: "deepseek-real-network-acceptance",
    databasePath,
    clockMode: "system",
    seedDemo: false,
    developerRoutes: true,
    chatEffectsMode: "gated",
    scheduleNegotiationMode: "enforced",
    selfInitiatedPlanningMode: "enforced",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "enforced",
    llm: {
      ...inputConfig.llm,
      provider: "openai-compatible",
    },
  };
  const llmCapabilities = config.llm.capabilities;
  if (llmCapabilities === undefined) {
    throw new TypeError(
      "DeepSeek acceptance requires an explicit LLM capability profile.",
    );
  }
  const characterRequest = buildCharacterRequest();
  const relativeDatabasePath = relative(workspaceRoot, databasePath).replace(
    /\\/gu,
    "/",
  );
  const databaseLabel =
    databasePath === ":memory:"
      ? "[in-memory]"
      : relativeDatabasePath !== "" &&
          relativeDatabasePath !== ".." &&
          !relativeDatabasePath.startsWith("../") &&
          !isAbsolute(relativeDatabasePath)
        ? relativeDatabasePath
        : "[custom local database]";
  const redactionSecrets = [
    config.llm.apiKey ?? "",
    workspaceRoot,
    databasePath,
    dirname(databasePath),
    reportPath,
    dirname(reportPath),
  ];
  const startedAtMs = startedAt.getTime();
  const result: DeepSeekAcceptanceResult = {
    runId,
    acceptanceDate: acceptanceDateFor(startedAt),
    startedAtUtc: startedAt.toISOString(),
    completedAtUtc: startedAt.toISOString(),
    elapsedMs: 0,
    passed: false,
    reportPath,
    databasePath: databaseLabel,
    config: {
      provider: config.llm.provider,
      model: config.llm.model,
      providerOrigin: new URL(config.llm.baseUrl).origin,
      profile: config.profile,
      clockMode: config.clockMode,
      flags: {
        chatEffectsMode: config.chatEffectsMode,
        scheduleNegotiationMode: config.scheduleNegotiationMode,
        selfInitiatedPlanningMode: config.selfInitiatedPlanningMode,
        liveWorldEffectsMode: config.liveWorldEffectsMode,
        memoryRecallMode: config.memoryRecallMode,
        autobiographyMode: config.autobiographyMode,
      },
      promptTokenBudget: calculateLlmPromptTokenBudget(llmCapabilities),
    },
    characterRequest,
    setupExchanges: [],
    turns: [],
    llmCalls: [],
    structuredOutputDiagnostics: [],
    assertions: [],
  };

  let app: PersonaSimApp | undefined;
  let origin: string | undefined;
  let agentId: string | undefined;
  try {
    app = await buildApp({
      config,
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
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
      "HTTP server health",
    );
    result.health = health.data;
    result.setupExchanges.push(health.exchange);

    const generated = await requestJson(
      origin,
      "/api/characters/generate",
      CharacterMutationResponseSchema,
      jsonPost(characterRequest),
      "real compile_character over HTTP",
    );
    result.setupExchanges.push(generated.exchange);
    agentId = generated.data.character.id;

    const published = await requestJson(
      origin,
      `/api/characters/${encodeURIComponent(agentId)}/publish`,
      PublishCharacterResponseSchema,
      jsonPost({ expectedVersion: generated.data.character.version }),
      "publish high_fidelity character over HTTP",
    );
    result.setupExchanges.push(published.exchange);
    result.compiledCharacter = published.data.character;
    result.sharedSlot = selectSharedSlot(
      published.data.schedule,
      startedAt,
      ACCEPTANCE_TIMEZONE,
    );

    const firstSession = await createSession(
      origin,
      agentId,
      "DeepSeek 验收：事实、关怀与邀约",
    );
    result.setupExchanges.push(firstSession.exchange);
    let sessionId = firstSession.data.session.id;
    const plans = buildTurnPlans(result.sharedSlot);

    for (const [index, plan] of plans.entries()) {
      if (plan.startedNewSession) {
        const nextSession = await createSession(
          origin,
          agentId,
          "DeepSeek 验收：跨会话召回",
        );
        result.setupExchanges.push(nextSession.exchange);
        sessionId = nextSession.data.session.id;
      }
      const turnNumber = index + 1;
      const clientMessageId =
        "deepseek-acceptance-" +
        startedAt.getTime().toString(36) +
        "-turn-" +
        String(turnNumber);
      const before = await collectDeveloperSnapshot(origin, agentId);
      const turn = await requestJson(
        origin,
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        SendMessageResponseSchema,
        jsonPost({
          agentId,
          clientMessageId,
          text: plan.userText,
        }),
        `purposeful chat turn ${turnNumber}`,
      );
      const storedMessages = await requestJson(
        origin,
        `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`,
        ListMessagesResponseSchema,
        undefined,
        `persisted messages after turn ${turnNumber}`,
      );
      const persistedAssistant = storedMessages.data.messages.find(
        (message) => message.id === turn.data.assistantMessage.id,
      );
      if (persistedAssistant?.role !== "assistant") {
        throw new Error(
          `Turn ${turnNumber} assistant message was not persisted over HTTP.`,
        );
      }
      const inspected = inspectPersistedContract(
        turn.data,
        persistedAssistant,
        result.config.promptTokenBudget,
      );
      const after = await collectDeveloperSnapshot(origin, agentId);
      result.turns.push({
        number: turnNumber,
        objective: plan.objective,
        sessionId,
        startedNewSession: plan.startedNewSession === true,
        clientMessageId,
        userMessageId: turn.data.userMessage.id,
        userText: plan.userText,
        exchange: turn.exchange,
        assistantText: turn.data.assistantMessage.content,
        persistedAssistant,
        persistedContract: persistedAssistant.metadata,
        contractErrors: inspected.errors,
        promptSegmentTrace: inspected.trace,
        ...(turn.data.memoryRecall === undefined
          ? {}
          : { memoryRecall: turn.data.memoryRecall }),
        scheduleChanges: turn.data.scheduleChanges,
        domainEvents: after.events.filter(
          (event) => event.correlationId === clientMessageId,
        ),
        retrievalRuns: differenceById(
          after.retrievalRuns,
          before.retrievalRuns,
        ),
        rejectedProposals: differenceById(
          after.rejectedProposals,
          before.rejectedProposals,
        ),
        llmCalls: differenceById(after.llmCalls, before.llmCalls),
        persistence: persistenceSnapshot(app, agentId, after.memories),
      });
    }

    result.llmCalls = (
      await requestJson(
        origin,
        "/api/developer/llm-calls?limit=500",
        LlmCallsResponseSchema,
        undefined,
        "all application LLM calls",
      )
    ).data.calls;
  } catch (error) {
    result.failure = errorSummary(error);
    if (error instanceof AcceptanceHttpError) {
      result.setupExchanges.push(error.exchange);
      if (error.exchange.requestId !== undefined) {
        result.failure = {
          ...result.failure,
          requestId: error.exchange.requestId,
        };
      }
    }
    if (origin !== undefined) {
      try {
        result.llmCalls = (
          await requestJson(
            origin,
            "/api/developer/llm-calls?limit=500",
            LlmCallsResponseSchema,
            undefined,
            "LLM calls after failure",
          )
        ).data.calls;
      } catch {
        // Preserve the primary failure; observability is best-effort here.
      }
    }
  } finally {
    if (app !== undefined) {
      try {
        await app.close();
      } catch (error) {
        result.failure ??= errorSummary(error);
      }
    }
  }

  const completedAt = new Date();
  result.completedAtUtc = completedAt.toISOString();
  result.elapsedMs = Math.max(0, completedAt.getTime() - startedAtMs);
  result.assertions = evaluateDeepSeekAcceptance(result);
  result.passed =
    result.failure === undefined &&
    result.assertions.length > 0 &&
    result.assertions.every((assertion) => assertion.passed);
  await writeFile(
    reportPath,
    renderDeepSeekAcceptanceReport(result, redactionSecrets),
    "utf8",
  );
  return result;
}

function buildCharacterRequest(): Record<string, unknown> {
  return {
    name: "顾澜",
    worldSetting:
      "2026 年的上海。顾澜有独立生活、工作安排和朋友关系，不以用户为生活中心。",
    workOrRole: "独立纪录片剪辑师与社区夜校讲师",
    coreTraits: ["观察细致", "温和直接", "尊重边界"],
    coreContradiction: "既愿意照顾重要的人，也坚持不过度替别人做决定",
    mainGoal: "完成一部关于城市夜归人的纪录短片",
    initialRelationship: "认识多年、彼此信任但尊重各自节奏的朋友",
    dialogueStyle:
      "使用简体中文，自然、温暖、克制；不复述系统规则，不虚构已经完成的行动",
    tier: "high_fidelity",
    timezone: ACCEPTANCE_TIMEZONE,
  };
}

function buildTurnPlans(
  sharedSlot: DeepSeekAcceptanceResult["sharedSlot"],
): TurnPlan[] {
  if (sharedSlot === undefined) {
    throw new Error("A conflict-free shared schedule slot was not found.");
  }
  return [
    {
      objective: "写入唯一长期事实，并提出有证据的关怀偏好",
      userText:
        `我只告诉很信任的人一个习惯：每次重要演讲前，我都会把一枚${UNIQUE_FACT_OBJECT}放在${UNIQUE_FACT_LOCATION}，它的代号是 ${UNIQUE_FACT_CODE}。` +
        "最近想到博士资格面谈就有些紧张。另请记住我的关怀方式偏好：只要我谈到这场面谈，先问我现在更需要安慰还是建议，不要马上讲道理。",
    },
    {
      objective: "验证上一轮真实关怀上下文进入最终 Prompt",
      userText:
        "说回我刚才提到的博士资格面谈，我还是有点紧张。你能先回应我的感受，再陪我梳理一个十分钟准备步骤吗？",
    },
    {
      objective: "提出带完整时间、地点和活动的共同邀约",
      userText: `这是一个明确的共同邀约：我想在${sharedSlot.localLabel}和你一起去梧桐路 23 号的“北岸书店”喝茶，预计 45 分钟。你愿意吗？如果愿意，请先把它作为待我确认的共同安排，不要声称已经写入日程。`,
    },
    {
      objective: "确认上一轮待定邀约，并验证服务器生成严格日程变更",
      userText: "确认",
    },
    {
      objective: "在全新会话中召回唯一长期事实与已确认共同安排",
      startedNewSession: true,
      userText: `我们开了一个新会话。请告诉我：${UNIQUE_FACT_CODE} 是什么、我演讲前把它放在哪里？另外，我们刚确认的共同安排是什么？如果不确定就直说。`,
    },
  ];
}

export function selectSharedSlot(
  schedule: readonly ScheduleItem[],
  now: Date,
  timezone: string,
): {
  startAtUtc: string;
  endAtUtc: string;
  localLabel: string;
} {
  const localNow = DateTime.fromJSDate(now).setZone(timezone);
  const durationMinutes = 45;
  const horizonEnd = localNow.plus({ hours: 72 });
  const candidateHours = [
    ...Array.from({ length: 10 }, (_, index) => 11 + index),
    7,
    8,
    9,
    10,
    21,
  ];
  for (let dayOffset = 1; dayOffset <= 3; dayOffset += 1) {
    for (const hour of candidateHours) {
      const start = localNow
        .plus({ days: dayOffset })
        .set({ hour, minute: 30, second: 0, millisecond: 0 });
      const end = start.plus({ minutes: durationMinutes });
      if (start <= localNow || end > horizonEnd) continue;
      const overlaps = schedule.some((item) => {
        const itemStart = DateTime.fromISO(item.startAtUtc);
        const itemEnd = DateTime.fromISO(item.endAtUtc);
        return start.toUTC() < itemEnd && end.toUTC() > itemStart;
      });
      if (overlaps) continue;
      return {
        startAtUtc: start.toUTC().toISO()!,
        endAtUtc: end.toUTC().toISO()!,
        localLabel: start.toFormat("yyyy年LL月dd日 HH:mm"),
      };
    }
  }
  throw new Error(
    "No 45-minute 07:30-22:15 gap exists in the published 72h plan.",
  );
}

async function createSession(origin: string, agentId: string, title: string) {
  return requestJson(
    origin,
    `/api/agents/${encodeURIComponent(agentId)}/sessions`,
    CreateSessionResponseSchema,
    jsonPost({ title }),
    "create conversation session over HTTP",
  );
}

export function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function requestJson<T>(
  origin: string,
  path: string,
  schema: ZodType<T>,
  init: RequestInit | undefined,
  label: string,
): Promise<{ data: T; exchange: HttpExchange }> {
  const started = Date.now();
  const response = await fetch(new URL(path, origin), init);
  const text = await response.text();
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(text) as unknown;
  } catch {
    responseBody = { nonJsonBody: text.slice(0, 2_000) };
  }
  const requestId = responseRequestId(responseBody);
  const exchange: HttpExchange = {
    label,
    method: init?.method ?? "GET",
    path,
    status: response.status,
    durationMs: Math.max(0, Date.now() - started),
    ...(typeof init?.body === "string"
      ? { requestBody: JSON.parse(init.body) as unknown }
      : {}),
    responseBody,
    ...(requestId === undefined ? {} : { requestId }),
  };
  if (!response.ok) throw new AcceptanceHttpError(exchange);
  return { data: schema.parse(responseBody), exchange };
}

function responseRequestId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const nestedError = value["error"];
  const candidate =
    isRecord(nestedError) && typeof nestedError["requestId"] === "string"
      ? nestedError["requestId"]
      : typeof value["requestId"] === "string"
        ? value["requestId"]
        : undefined;
  const trimmed = candidate?.trim();
  return trimmed === undefined || trimmed.length === 0
    ? undefined
    : trimmed.slice(0, 128);
}
async function collectDeveloperSnapshot(
  origin: string,
  agentId: string,
): Promise<DeveloperSnapshot> {
  const encodedAgentId = encodeURIComponent(agentId);
  const [llmCalls, events, retrievalRuns, rejected, memories] =
    await Promise.all([
      requestJson(
        origin,
        "/api/developer/llm-calls?limit=500",
        LlmCallsResponseSchema,
        undefined,
        "developer LLM calls",
      ),
      requestJson(
        origin,
        `/api/developer/events?agentId=${encodedAgentId}&limit=500`,
        DeveloperEventsResponseSchema,
        undefined,
        "developer domain events",
      ),
      requestJson(
        origin,
        `/api/developer/agents/${encodedAgentId}/retrieval-runs?limit=500`,
        RetrievalRunsResponseSchema,
        undefined,
        "developer retrieval runs",
      ),
      requestJson(
        origin,
        `/api/developer/rejected-proposals?agentId=${encodedAgentId}&limit=500`,
        RejectedProposalsResponseSchema,
        undefined,
        "developer rejected proposals",
      ),
      requestJson(
        origin,
        `/api/agents/${encodedAgentId}/memories`,
        MemoriesResponseSchema,
        undefined,
        "persisted memories",
      ),
    ]);
  return {
    llmCalls: llmCalls.data.calls,
    events: events.data.events,
    retrievalRuns: retrievalRuns.data.runs,
    rejectedProposals: rejected.data.proposals,
    memories: memories.data.memories,
  };
}

function differenceById<T extends { id: string }>(
  after: readonly T[],
  before: readonly T[],
): T[] {
  const beforeIds = new Set(before.map((item) => item.id));
  return after.filter((item) => !beforeIds.has(item.id));
}

function persistenceSnapshot(
  app: PersonaSimApp,
  agentId: string,
  memories: unknown[],
): PersistenceSnapshot {
  const database = app.personasim.store.database;
  return {
    memories,
    memoryEvidence: database
      .prepare(
        `SELECT evidence.id, evidence.memory_id AS memoryId,
          evidence.source_type AS sourceType, evidence.source_id AS sourceId,
          evidence.quote, evidence.context_summary AS contextSummary,
          evidence.recorded_at_utc AS recordedAtUtc
         FROM memory_evidence AS evidence
         JOIN memories AS memory ON memory.id = evidence.memory_id
         WHERE memory.agent_id = ?
         ORDER BY evidence.recorded_at_utc, evidence.rowid`,
      )
      .all(agentId),
    careCues: database
      .prepare(
        `SELECT id, session_id AS sessionId, context_summary AS contextSummary,
          mention_guidance AS mentionGuidance,
          source_message_id AS sourceMessageId,
          earliest_at_utc AS earliestAtUtc, expires_at_utc AS expiresAtUtc,
          status, max_mentions AS maxMentions, mention_count AS mentionCount,
          last_mentioned_message_id AS lastMentionedMessageId,
          created_at_utc AS createdAtUtc, updated_at_utc AS updatedAtUtc
         FROM care_cues WHERE agent_id = ? ORDER BY created_at_utc, rowid`,
      )
      .all(agentId),
    followUps: database
      .prepare(
        `SELECT id, session_id AS sessionId, subject_type AS subjectType,
          context_summary AS contextSummary,
          expected_outcome_description AS expectedOutcomeDescription,
          source_message_id AS sourceMessageId,
          earliest_at_utc AS earliestAtUtc, expires_at_utc AS expiresAtUtc,
          status, attempt_count AS attemptCount,
          resolution_message_id AS resolutionMessageId,
          created_at_utc AS createdAtUtc, updated_at_utc AS updatedAtUtc
         FROM follow_up_intents
         WHERE agent_id = ? ORDER BY created_at_utc, rowid`,
      )
      .all(agentId),
    scheduleNegotiations: app.personasim.store.listScheduleNegotiations({
      agentId,
      limit: 100,
    }),
    sharedScheduleItems: app.personasim.store
      .listSchedule(agentId)
      .filter((item) => item.source === "user_invitation"),
  };
}

function inspectPersistedContract(
  response: z.infer<typeof SendMessageResponseSchema>,
  persisted: ApiStoredMessage,
  promptTokenBudget: number,
): { trace: PromptAssemblyTrace; errors: string[] } {
  const errors: string[] = [];
  const traceResult = PromptAssemblyTraceSchema.safeParse(
    persisted.metadata["promptSegmentTrace"],
  );
  const trace: PromptAssemblyTrace = traceResult.success
    ? (traceResult.data as PromptAssemblyTrace)
    : { segments: [], droppedSegmentIds: [], estimatedInputTokens: 0 };
  if (!traceResult.success) {
    errors.push("persisted metadata.promptSegmentTrace is missing or invalid");
  }
  const chunksResult = z
    .array(z.string().trim().min(1))
    .min(1)
    .safeParse(persisted.metadata["chunks"]);
  if (!chunksResult.success) {
    errors.push("persisted metadata.chunks is missing or invalid");
  } else {
    const materialized = chunksResult.data.join("\n");
    if (
      materialized !== persisted.content ||
      materialized !== response.assistantMessage.content ||
      materialized !== response.decision.chunks.join("\n")
    ) {
      errors.push("response/persistence strict chunks invariant did not hold");
    }
  }
  if (persisted.content !== response.assistantMessage.content) {
    errors.push("HTTP assistant text differs from persisted assistant text");
  }
  if (trace.estimatedInputTokens > promptTokenBudget) {
    errors.push("persisted prompt trace exceeded the provider prompt budget");
  }
  return { trace, errors };
}

function errorSummary(
  error: unknown,
): NonNullable<DeepSeekAcceptanceResult["failure"]> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { name: "UnknownError", message: String(error) };
}

export interface SelectedAnchorEvidenceMatch {
  matched: boolean;
  selectedEvidenceIds: string[];
  runId?: string;
  evidenceId?: string;
  memoryId?: string;
  reason: string;
}

export function matchSelectedAnchorEvidence(
  memoryRecall: unknown,
  runs: readonly RetrievalRunRecord[],
  sourceMessageId?: string,
): SelectedAnchorEvidenceMatch {
  const expectedIds = selectedEvidenceIds(memoryRecall);
  if (expectedIds.length === 0) {
    return {
      matched: false,
      selectedEvidenceIds: [],
      reason: "turn diagnostic selected no evidence",
    };
  }
  for (const run of runs) {
    if (
      sourceMessageId !== undefined &&
      run.sourceMessageId !== sourceMessageId
    ) {
      continue;
    }
    if (!sameStringSet(expectedIds, run.result.selectedEvidenceIds)) continue;
    if (run.result.abstained || run.evidenceBundle === undefined) continue;
    const selectedItems = run.evidenceBundle.evidence.filter((item) =>
      expectedIds.includes(item.evidence.id),
    );
    if (
      !sameStringSet(
        expectedIds,
        selectedItems.map((item) => item.evidence.id),
      )
    ) {
      continue;
    }
    const idsAlign = selectedItems.every((item) => {
      const snapshotEvidence = run.inputSnapshot.evidence.find(
        (evidence) => evidence.id === item.evidence.id,
      );
      const snapshotMemory = run.inputSnapshot.memories.find(
        (memory) => memory.id === item.memoryId,
      );
      return (
        snapshotEvidence?.memoryId === item.memoryId &&
        snapshotMemory?.id === item.memoryId
      );
    });
    if (idsAlign && containsCompleteAnchor(selectedItems)) {
      return {
        matched: true,
        selectedEvidenceIds: expectedIds,
        runId: run.id,
        evidenceId: selectedItems.map((item) => item.evidence.id).join(","),
        memoryId: [...new Set(selectedItems.map((item) => item.memoryId))].join(
          ",",
        ),
        reason:
          "selected ids map to one current-turn EvidenceBundle containing the complete anchor",
      };
    }
  }
  return {
    matched: false,
    selectedEvidenceIds: expectedIds,
    reason:
      "no current-turn run mapped every selected id to one complete anchored EvidenceBundle",
  };
}

function anchoredMemoryPersistence(turn: AcceptanceTurn | undefined): {
  matched: boolean;
  memoryId?: string;
} {
  if (turn === undefined) return { matched: false };
  const sourceMemories = turn.persistence.memories.filter(
    (item) =>
      isRecord(item) &&
      typeof item["id"] === "string" &&
      item["sourceMessageId"] === turn.userMessageId,
  );
  const sourceMemoryIds = new Set(
    sourceMemories.flatMap((item) =>
      isRecord(item) && typeof item["id"] === "string" ? [item["id"]] : [],
    ),
  );
  const sourceEvidence = turn.persistence.memoryEvidence.filter(
    (item) =>
      isRecord(item) &&
      typeof item["memoryId"] === "string" &&
      sourceMemoryIds.has(item["memoryId"]) &&
      item["sourceType"] === "message" &&
      item["sourceId"] === turn.userMessageId,
  );
  const groundedMemoryIds = new Set(
    sourceEvidence.flatMap((item) =>
      isRecord(item) && typeof item["memoryId"] === "string"
        ? [item["memoryId"]]
        : [],
    ),
  );
  const groundedMemories = sourceMemories.filter(
    (item) =>
      isRecord(item) &&
      typeof item["id"] === "string" &&
      groundedMemoryIds.has(item["id"]),
  );
  if (
    groundedMemories.length === 0 ||
    !containsCompleteAnchor({
      memories: groundedMemories,
      evidence: sourceEvidence,
    })
  ) {
    return { matched: false };
  }
  return {
    matched: true,
    memoryId: [...groundedMemoryIds].join(","),
  };
}

function acceptedAnchorWorldEffect(turn: AcceptanceTurn | undefined): boolean {
  if (turn === undefined) return false;
  return turn.domainEvents.some((event) => {
    if (
      event.eventType !== "conversation.world_effects_committed" ||
      event.correlationId !== turn.clientMessageId ||
      !isRecord(event.payload)
    ) {
      return false;
    }
    const accepted = event.payload["accepted"];
    return (
      event.payload["mode"] === "enforced" &&
      isRecord(accepted) &&
      typeof accepted["memoryCandidateCount"] === "number" &&
      accepted["memoryCandidateCount"] >= 1
    );
  });
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

function scheduleActionAuditLabel(
  value: Record<string, unknown> | undefined,
): string {
  const origin =
    typeof value?.["origin"] === "string" ? value["origin"] : "missing";
  const kind = typeof value?.["kind"] === "string" ? value["kind"] : "missing";
  return `${origin}:${kind}`;
}

export function containsCompleteAnchor(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const contradictsIdentity =
    /BGW-7419.{0,16}(?:不是|并非|不叫).{0,12}蓝色玻璃鲸/u.test(text) ||
    /蓝色玻璃鲸.{0,16}(?:不是|并非).{0,12}BGW-7419/u.test(text);
  const contradictsLocation =
    /(?:没有|没|并未|不曾|从未|不会).{0,8}(?:放|装|带).{0,8}左口袋/u.test(
      text,
    ) || /(?:不在|并非在).{0,8}左口袋/u.test(text);
  const questionsAnchor =
    /BGW-7419.{0,20}(?:是否|是不是|蓝色玻璃鲸吗)/u.test(text) ||
    /(?:是否|是不是).{0,20}(?:放|装|带).{0,8}左口袋/u.test(text) ||
    /(?:放|装|带).{0,8}左口袋吗/u.test(text);
  return (
    text.includes(UNIQUE_FACT_CODE) &&
    text.includes(UNIQUE_FACT_OBJECT) &&
    text.includes(UNIQUE_FACT_LOCATION) &&
    !contradictsIdentity &&
    !contradictsLocation &&
    !questionsAnchor
  );
}

export function containsCommittedScheduleRecall(
  value: unknown,
  item: ScheduleItem | undefined,
  referenceUtc?: string,
): boolean {
  if (item === undefined) return false;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const start = DateTime.fromISO(item.startAtUtc).setZone(item.timezone);
  if (!start.isValid) return false;
  const hour = String(start.hour);
  const minute = String(start.minute).padStart(2, "0");
  const explicitChineseDates = [
    ...text.matchAll(/(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})[日号]/g),
  ];
  const explicitDateAligned = explicitChineseDates.some(
    (match) =>
      (match[1] === undefined || Number(match[1]) === start.year) &&
      Number(match[2]) === start.month &&
      Number(match[3]) === start.day,
  );
  const hasConflictingExplicitDate = explicitChineseDates.some(
    (match) =>
      (match[1] !== undefined && Number(match[1]) !== start.year) ||
      Number(match[2]) !== start.month ||
      Number(match[3]) !== start.day,
  );
  const reference =
    referenceUtc === undefined
      ? undefined
      : DateTime.fromISO(referenceUtc).setZone(item.timezone);
  const relativeDay =
    reference !== undefined && reference.isValid
      ? Math.round(
          start.startOf("day").diff(reference.startOf("day"), "days").days,
        )
      : undefined;
  const mentionedRelativeDays = [
    { offset: 0, labels: ["今天", "今日"] },
    { offset: 1, labels: ["明天", "明日"] },
    { offset: 2, labels: ["后天"] },
  ]
    .filter(({ labels }) => labels.some((label) => text.includes(label)))
    .map(({ offset }) => offset);
  const relativeDateAligned =
    relativeDay !== undefined && mentionedRelativeDays.includes(relativeDay);
  const hasConflictingRelativeDate = mentionedRelativeDays.some(
    (offset) => offset !== relativeDay,
  );
  const dateAligned =
    !hasConflictingExplicitDate &&
    !hasConflictingRelativeDate &&
    (explicitDateAligned || relativeDateAligned);
  const times = [
    hour + ":" + minute,
    hour.padStart(2, "0") + ":" + minute,
    hour + "：" + minute,
    hour.padStart(2, "0") + "：" + minute,
    ...(start.minute === 30 ? [hour + "点半"] : []),
  ];
  const semantics = item.title + " " + item.description;
  const semanticAnchors = ["北岸书店", "茶"].filter((anchor) =>
    semantics.includes(anchor),
  );
  const contradictsCommittedSchedule =
    /(?:没有|没|并未|尚未|还未|未曾|从未).{0,12}(?:确认|约|约定|说好|安排|计划)/u.test(
      text,
    ) ||
    /(?:不是|并非|不在).{0,16}(?:北岸书店|\d{1,2}月\d{1,2}[日号]|\d{1,2}[:：]\d{2})/u.test(
      text,
    ) ||
    /(?:北岸书店|\d{1,2}月\d{1,2}[日号]|\d{1,2}[:：]\d{2}).{0,12}(?:不对|有误|错了|并非)/u.test(
      text,
    ) ||
    /(?:不去|不会去|不能去|去不了|不打算去).{0,12}(?:北岸书店|喝茶)/u.test(
      text,
    ) ||
    /(?:北岸书店|喝茶).{0,12}(?:不去|不会去|不能去|去不了|不打算去)/u.test(
      text,
    ) ||
    /(?:不确定|不记得|想不起来|无法确认).{0,16}(?:是否|是不是|有没有|安排|约|北岸书店)/u.test(
      text,
    ) ||
    /(?:你是(?:在)?问|是否|是不是|有没有).{0,40}(?:北岸书店|\d{1,2}月\d{1,2}[日号]|\d{1,2}[:：]\d{2}).{0,24}(?:吗)?[?？]/u.test(
      text,
    ) ||
    /(?:北岸书店|\d{1,2}月\d{1,2}[日号]|\d{1,2}[:：]\d{2}).{0,40}(?:是否|是不是|有没有).{0,24}(?:吗)?[?？]/u.test(
      text,
    ) ||
    /(?:已经|已|被)(?:取消|撤销|删除)(?:了|掉)?/u.test(text) ||
    /(?:安排|约定|日程)(?:已经|已|被)?(?:取消|撤销|删除)(?:了|掉)?/u.test(text);
  return (
    semanticAnchors.length === 2 &&
    semanticAnchors.every((anchor) => text.includes(anchor)) &&
    dateAligned &&
    times.some((time) => text.includes(time)) &&
    !contradictsCommittedSchedule
  );
}

export function evaluateDeepSeekAcceptance(
  result: DeepSeekAcceptanceResult,
): AcceptanceAssertion[] {
  const turns = result.turns;
  const finalTurn = turns.at(-1);
  const firstTurn = turns[0];
  const careTurn = turns[1];
  const invitationTurn = turns[2];
  const confirmationTurn = turns[3];
  const allPrimaryExchanges = [
    ...result.setupExchanges,
    ...turns.map((turn) => turn.exchange),
  ];
  const compiledByModel = result.llmCalls.some(
    (call) => call.purpose === "compile_character" && call.success,
  );
  const chatCalls = result.llmCalls.filter(
    (call) => call.purpose === "chat_turn",
  );
  const anchorPersistence = anchoredMemoryPersistence(firstTurn);
  const worldEffectAccepted = acceptedAnchorWorldEffect(firstTurn);
  const persistedCareCueIds =
    firstTurn === undefined
      ? []
      : firstTurn.persistence.careCues.flatMap((item) =>
          isRecord(item) &&
          item["sourceMessageId"] === firstTurn.userMessageId &&
          typeof item["id"] === "string"
            ? [item["id"]]
            : [],
        );
  const promptCareCueIds =
    careTurn === undefined
      ? []
      : stringArray(careTurn.persistedContract["continuityPromptCueIds"]);
  const careCuePersisted = persistedCareCueIds.length > 0;
  const carePromptInjected =
    careTurn !== undefined &&
    traceIncludes(careTurn.promptSegmentTrace, "07z_followup_context") &&
    persistedCareCueIds.some((id) => promptCareCueIds.includes(id));
  const invitationScheduleAuditValue =
    invitationTurn?.persistedContract["scheduleActionAudit"];
  const invitationScheduleAudit = isRecord(invitationScheduleAuditValue)
    ? invitationScheduleAuditValue
    : undefined;
  const invitationModelContractAligned =
    invitationScheduleAudit?.["origin"] === "model_explicit_valid" &&
    invitationScheduleAudit["kind"] === "accept_user_offer";
  const pendingNegotiation =
    invitationTurn?.persistence.scheduleNegotiations.find(
      (item) =>
        isRecord(item) &&
        item["sessionId"] === invitationTurn.sessionId &&
        item["status"] === "awaiting_confirmation",
    );
  const pendingRecord =
    isRecord(pendingNegotiation) && isRecord(pendingNegotiation["record"])
      ? pendingNegotiation["record"]
      : undefined;
  const pendingState = isRecord(pendingRecord?.["negotiation"])
    ? pendingRecord["negotiation"]
    : undefined;
  const pendingOffer = isRecord(pendingState?.["offer"])
    ? pendingState["offer"]
    : undefined;
  const pendingEvidenceIds = stringArray(pendingOffer?.["evidenceIds"]);
  const sharedSlot = result.sharedSlot;
  const pendingOfferAligned =
    invitationTurn !== undefined &&
    sharedSlot !== undefined &&
    isRecord(pendingNegotiation) &&
    isRecord(pendingState) &&
    isRecord(pendingOffer) &&
    pendingState?.["id"] === pendingNegotiation["id"] &&
    pendingState["status"] === "awaiting_confirmation" &&
    pendingOffer?.["version"] === pendingNegotiation["offerVersion"] &&
    pendingOffer["category"] === "social" &&
    pendingOffer["startAtUtc"] === sharedSlot.startAtUtc &&
    pendingOffer["durationMinutes"] === 45 &&
    pendingOffer["timezone"] === ACCEPTANCE_TIMEZONE &&
    typeof pendingOffer["activity"] === "string" &&
    pendingOffer["activity"].includes("北岸书店") &&
    pendingOffer["activity"].includes("茶") &&
    pendingEvidenceIds.includes(invitationTurn.userMessageId);
  const invitationOfferEvents =
    invitationTurn?.domainEvents.filter(
      (event) => event.eventType === "schedule.negotiation_offer_presented",
    ) ?? [];
  const invitationCommandEvents =
    invitationTurn?.domainEvents.filter(
      (event) => event.eventType === "schedule.command_committed",
    ) ?? [];
  const offerPresentationPayload = isRecord(invitationOfferEvents[0]?.payload)
    ? invitationOfferEvents[0].payload
    : undefined;
  const offerPresentationAligned =
    invitationTurn !== undefined &&
    isRecord(pendingNegotiation) &&
    invitationOfferEvents.length === 1 &&
    invitationOfferEvents[0]?.correlationId ===
      invitationTurn.clientMessageId &&
    invitationOfferEvents[0]?.causationId === invitationTurn.userMessageId &&
    offerPresentationPayload?.["actionKind"] === "accept_user_offer" &&
    offerPresentationPayload["negotiationId"] === pendingNegotiation["id"] &&
    offerPresentationPayload["offerVersion"] ===
      pendingNegotiation["offerVersion"];
  const priorSharedScheduleItems =
    careTurn?.persistence.sharedScheduleItems ?? [];
  const invitationSharedScheduleItems =
    invitationTurn?.persistence.sharedScheduleItems ?? [];
  const invitationHasNoScheduleWrite =
    invitationTurn !== undefined &&
    invitationTurn.scheduleChanges.length === 0 &&
    invitationCommandEvents.length === 0 &&
    JSON.stringify(invitationSharedScheduleItems) ===
      JSON.stringify(priorSharedScheduleItems);
  const committedNegotiation =
    confirmationTurn?.persistence.scheduleNegotiations.find(
      (item) =>
        isRecord(item) &&
        isRecord(pendingNegotiation) &&
        item["id"] === pendingNegotiation["id"] &&
        item["sessionId"] === confirmationTurn.sessionId &&
        item["status"] === "committed",
    );
  const confirmationScheduleAuditValue =
    confirmationTurn?.persistedContract["scheduleActionAudit"];
  const confirmationScheduleAudit = isRecord(confirmationScheduleAuditValue)
    ? confirmationScheduleAuditValue
    : undefined;
  const confirmationModelContractAligned =
    confirmationScheduleAudit?.["origin"] === "model_explicit_valid" &&
    confirmationScheduleAudit["kind"] === "accept_pending_offer";
  const scheduleCommandEvents =
    confirmationTurn?.domainEvents.filter(
      (event) =>
        event.eventType === "schedule.command_committed" &&
        event.correlationId === confirmationTurn.clientMessageId,
    ) ?? [];
  const scheduleCommandEvent = scheduleCommandEvents[0];
  const schedulePayload =
    scheduleCommandEvent !== undefined && isRecord(scheduleCommandEvent.payload)
      ? scheduleCommandEvent.payload
      : undefined;
  const changedItemIds =
    schedulePayload !== undefined &&
    Array.isArray(schedulePayload["changedItemIds"])
      ? schedulePayload["changedItemIds"].filter(
          (item): item is string => typeof item === "string",
        )
      : [];
  const responseScheduleIds =
    confirmationTurn?.scheduleChanges.map((item) => item.id) ?? [];
  const invitationSharedIds = new Set(
    invitationSharedScheduleItems.map((item) => item.id),
  );
  const confirmationSharedScheduleItems =
    confirmationTurn?.persistence.sharedScheduleItems ?? [];
  const newSharedScheduleItems = confirmationSharedScheduleItems.filter(
    (item) => !invitationSharedIds.has(item.id),
  );
  const scheduleCommandAligned =
    scheduleCommandEvents.length === 1 &&
    schedulePayload?.["operation"] === "create" &&
    isRecord(committedNegotiation) &&
    schedulePayload["negotiationId"] === committedNegotiation["id"] &&
    changedItemIds.length === 1 &&
    responseScheduleIds.length === 1 &&
    newSharedScheduleItems.length === 1 &&
    sameStringSet(changedItemIds, responseScheduleIds);
  const matchedScheduleItem =
    sharedSlot === undefined
      ? undefined
      : newSharedScheduleItems.find((item) => {
          const semantics = item.title + " " + item.description;
          return (
            item.source === "user_invitation" &&
            item.category === "social" &&
            item.status === "planned" &&
            item.timezone === ACCEPTANCE_TIMEZONE &&
            item.startAtUtc === sharedSlot.startAtUtc &&
            item.endAtUtc === sharedSlot.endAtUtc &&
            semantics.includes("北岸书店") &&
            semantics.includes("茶")
          );
        });
  const confirmationAtomicWrite =
    confirmationTurn !== undefined &&
    confirmationTurn.scheduleChanges.length === 1 &&
    newSharedScheduleItems.length === 1 &&
    matchedScheduleItem !== undefined &&
    confirmationTurn.scheduleChanges[0]?.id === matchedScheduleItem.id;
  const scheduledSlotAligned =
    matchedScheduleItem !== undefined &&
    responseScheduleIds.includes(matchedScheduleItem.id) &&
    changedItemIds.includes(matchedScheduleItem.id);
  const recallIds = selectedEvidenceIds(finalTurn?.memoryRecall);
  const recallEvidence = matchSelectedAnchorEvidence(
    finalTurn?.memoryRecall,
    finalTurn?.retrievalRuns ?? [],
    finalTurn?.userMessageId,
  );
  const crossSessionReply = containsCompleteAnchor(
    finalTurn?.assistantText ?? "",
  );
  const crossSessionScheduleReply = containsCommittedScheduleRecall(
    finalTurn?.assistantText ?? "",
    matchedScheduleItem,
    result.startedAtUtc,
  );
  const assertions: AcceptanceAssertion[] = [
    {
      id: "real_http",
      description: "所有主流程经 app.listen 暴露的真实 HTTP 端口完成",
      passed:
        result.origin?.startsWith("http://") === true &&
        allPrimaryExchanges.length >= 9 &&
        allPrimaryExchanges.every(
          (exchange) => exchange.status >= 200 && exchange.status < 300,
        ),
      evidence: `${allPrimaryExchanges.length} HTTP exchanges at ${result.origin ?? "no origin"}`,
    },
    {
      id: "deepseek_compile",
      description: "通过真实 compile_character 生成并发布 high_fidelity 角色",
      passed:
        result.compiledCharacter?.tier === "high_fidelity" &&
        result.compiledCharacter.status === "published" &&
        compiledByModel,
      evidence: `tier=${result.compiledCharacter?.tier ?? "missing"}, status=${result.compiledCharacter?.status ?? "missing"}, compile_call=${String(compiledByModel)}`,
    },
    {
      id: "purposeful_turns",
      description: "完成至少五轮有目的对话并切换到全新会话",
      passed:
        turns.length >= 5 &&
        new Set(turns.map((turn) => turn.sessionId)).size >= 2 &&
        finalTurn?.startedNewSession === true,
      evidence: `turns=${turns.length}, sessions=${new Set(turns.map((turn) => turn.sessionId)).size}`,
    },
    {
      id: "persisted_contract",
      description: "每轮响应、chunks 与持久化 assistant 契约一致",
      passed:
        turns.length >= 5 &&
        turns.every((turn) => turn.contractErrors.length === 0),
      evidence:
        turns
          .flatMap((turn) =>
            turn.contractErrors.map((error) => `turn ${turn.number}: ${error}`),
          )
          .join("; ") || "all turn contracts matched",
    },
    {
      id: "prompt_trace",
      description: "每轮持久化最终 promptSegmentTrace，必要段完整且预算稳定",
      passed:
        turns.length >= 5 &&
        turns.every(
          (turn) =>
            turn.promptSegmentTrace.estimatedInputTokens > 0 &&
            turn.promptSegmentTrace.estimatedInputTokens <=
              result.config.promptTokenBudget &&
            REQUIRED_SEGMENT_IDS.every((id) =>
              traceIncludes(turn.promptSegmentTrace, id, true),
            ),
        ),
      evidence:
        turns
          .map(
            (turn) =>
              `t${turn.number}=${turn.promptSegmentTrace.estimatedInputTokens}`,
          )
          .join(", ") + `; budget=${result.config.promptTokenBudget}`,
    },
    {
      id: "memory_world_effect",
      description: "唯一长期事实经 world effects 验证后带证据持久化",
      passed: anchorPersistence.matched && worldEffectAccepted,
      evidence: `anchor=${UNIQUE_FACT_CODE}, memory_id=${anchorPersistence.memoryId ?? "none"}, correlated_enforced_effect=${String(worldEffectAccepted)}`,
    },
    {
      id: "care_followup",
      description:
        "有证据的关怀线索被持久化，并在相关下一轮真实注入最终 Prompt",
      passed: careCuePersisted && carePromptInjected,
      evidence: `care_cues=${firstTurn?.persistence.careCues.length ?? 0}, follow_ups=${firstTurn?.persistence.followUps.length ?? 0}, prompt_cue_ids=${promptCareCueIds.length}, prompt_injected=${String(carePromptInjected)}`,
    },
    {
      id: "shared_schedule",
      description:
        "模型显式输出两阶段日程契约；邀请轮零写入，确认轮由服务器恰好提交一项",
      passed:
        invitationModelContractAligned &&
        confirmationModelContractAligned &&
        pendingOfferAligned &&
        offerPresentationAligned &&
        invitationHasNoScheduleWrite &&
        isRecord(committedNegotiation) &&
        scheduleCommandAligned &&
        confirmationAtomicWrite &&
        scheduledSlotAligned,
      evidence: `invitation_action=${scheduleActionAuditLabel(invitationScheduleAudit)}, confirmation_action=${scheduleActionAuditLabel(confirmationScheduleAudit)}, negotiation_id=${isRecord(committedNegotiation) ? String(committedNegotiation["id"]) : "none"}, pending_offer_aligned=${String(pendingOfferAligned)}, offer_event_aligned=${String(offerPresentationAligned)}, invitation_zero_write=${String(invitationHasNoScheduleWrite)}, command_ids_aligned=${String(scheduleCommandAligned)}, confirmation_exactly_one=${String(confirmationAtomicWrite)}, item_id=${matchedScheduleItem?.id ?? "none"}, title=${matchedScheduleItem?.title ?? "none"}, exact_slot_and_semantics=${String(scheduledSlotAligned)}`,
    },
    {
      id: "cross_session_recall",
      description:
        "新会话实际选择并注入唯一事实证据，回复正确召回事实与已提交安排",
      passed:
        finalTurn?.startedNewSession === true &&
        recallIds.length > 0 &&
        traceIncludes(finalTurn.promptSegmentTrace, "13_retrieved_evidence") &&
        recallEvidence.matched &&
        crossSessionReply &&
        crossSessionScheduleReply,
      evidence: `selected_evidence=${recallIds.length}, mapped_run=${recallEvidence.runId ?? "none"}, mapped_evidence=${recallEvidence.evidenceId ?? "none"}, trace_injected=${String(finalTurn === undefined ? false : traceIncludes(finalTurn.promptSegmentTrace, "13_retrieved_evidence"))}, reply_anchor=${String(crossSessionReply)}, reply_schedule=${String(crossSessionScheduleReply)}, mapping=${recallEvidence.reason}`,
    },
    {
      id: "llm_calls",
      description: "真实 DeepSeek LLM 调用可审计且全部成功",
      passed:
        compiledByModel &&
        chatCalls.length >= 5 &&
        result.llmCalls.length > 0 &&
        result.llmCalls.every(
          (call) =>
            call.success &&
            call.provider === "openai-compatible" &&
            call.model === result.config.model,
        ),
      evidence: `total=${result.llmCalls.length}, chat_turn=${chatCalls.length}, failures=${result.llmCalls.filter((call) => !call.success).length}`,
    },
  ];
  return assertions;
}

export function renderDeepSeekAcceptanceReport(
  result: DeepSeekAcceptanceResult,
  secrets: readonly string[] = [],
): string {
  const compileExchange = result.setupExchanges.find(
    (exchange) => exchange.label === "real compile_character over HTTP",
  );
  const compileDiagnostics = result.structuredOutputDiagnostics.filter(
    (diagnostic) =>
      compileExchange?.requestId !== undefined &&
      diagnostic.requestId === compileExchange.requestId,
  );
  const failureDiagnostics = result.structuredOutputDiagnostics.filter(
    (diagnostic) =>
      result.failure?.requestId !== undefined &&
      diagnostic.requestId === result.failure.requestId,
  );
  const lines: string[] = [
    `# ChatPLUS Real Network Acceptance — ${result.acceptanceDate}`,
    "",
    "> 本报告由可复用验收 runner 自动生成。角色与用户事实均为合成测试数据；API key、Authorization、token、工作区绝对路径会被脱敏。",
    "> 主流程使用 app.listen + fetch，不使用 app.inject。deterministic provider 未参与本次运行。",
    "",
    "## 结论",
    "",
    `- 总体：**${result.passed ? "PASS" : "FAIL"}**`,
    `- Run ID：${escapeInline(result.runId)}`,
    `- 开始：${escapeInline(result.startedAtUtc)}`,
    `- 结束：${escapeInline(result.completedAtUtc)}`,
    `- 耗时：${result.elapsedMs} ms`,
    `- 本地 HTTP origin：${escapeInline(result.origin ?? "未启动")}`,
    `- 本地数据库：${escapeInline(result.databasePath)}`,
    "",
    "### 验收断言",
    "",
    "| 状态 | ID | 目标 | 证据 |",
    "| --- | --- | --- | --- |",
    ...result.assertions.map(
      (assertion) =>
        `| ${assertion.passed ? "PASS" : "FAIL"} | ${escapeTable(assertion.id)} | ${escapeTable(assertion.description)} | ${escapeTable(assertion.evidence)} |`,
    ),
    "",
    "## 运行配置",
    "",
    "| 项目 | 值 |",
    "| --- | --- |",
    `| Provider | ${escapeTable(result.config.provider)} |`,
    `| Model | ${escapeTable(result.config.model)} |`,
    `| Provider origin | ${escapeTable(result.config.providerOrigin)} |`,
    `| Profile | ${escapeTable(result.config.profile)} |`,
    `| Clock | ${escapeTable(result.config.clockMode)} |`,
    `| Prompt token budget | ${result.config.promptTokenBudget} |`,
    ...Object.entries(result.config.flags).map(
      ([flag, value]) => `| ${escapeTable(flag)} | ${escapeTable(value)} |`,
    ),
    "",
    "## 角色创建与发布",
    "",
    jsonDetails("HTTP 角色请求", result.characterRequest, secrets),
    "",
    jsonDetails(
      "compile_character safe structured-output diagnostics",
      {
        exchange:
          compileExchange === undefined
            ? null
            : {
                label: compileExchange.label,
                status: compileExchange.status,
                requestId: compileExchange.requestId,
              },
        diagnostics: compileDiagnostics,
      },
      secrets,
    ),
    "",
    jsonDetails(
      "真实 compile_character 后发布的 high_fidelity CharacterSpec",
      result.compiledCharacter ?? null,
      secrets,
    ),
    "",
    jsonDetails("选定的无冲突共同邀约时段", result.sharedSlot ?? null, secrets),
    "",
    "### Setup HTTP exchanges",
    "",
    ...result.setupExchanges.flatMap((exchange) => [
      renderExchangeSummary(exchange),
      jsonDetails(`${exchange.label} request/response`, exchange, secrets),
      "",
    ]),
    "## 全部应用侧 LLM calls",
    "",
    ...renderLlmCallTable(result.llmCalls),
    "",
  ];

  for (const turn of result.turns) {
    lines.push(
      `## 第 ${turn.number} 轮：${turn.objective}`,
      "",
      `- Session：${escapeInline(turn.sessionId)}${turn.startedNewSession ? "（新会话）" : ""}`,
      `- Client message ID：${escapeInline(turn.clientMessageId)}`,
      `- HTTP：${turn.exchange.method} ${turn.exchange.path} → ${turn.exchange.status}，${turn.exchange.durationMs} ms`,
      "",
      "### 用户请求",
      "",
      fencedText(turn.userText, secrets),
      "",
      "### 模型回复 / 服务器持久化回复",
      "",
      fencedText(turn.assistantText, secrets),
      "",
      jsonDetails("HTTP turn response", turn.exchange.responseBody, secrets),
      "",
      jsonDetails(
        "Persisted assistant contract / metadata",
        {
          message: turn.persistedAssistant,
          contractErrors: turn.contractErrors,
        },
        secrets,
      ),
      "",
      "### Persisted promptSegmentTrace",
      "",
      ...renderPromptTrace(turn.promptSegmentTrace),
      "",
      jsonDetails(
        "Memory recall diagnostic",
        turn.memoryRecall ?? null,
        secrets,
      ),
      "",
      jsonDetails(
        "Retrieval runs created by this turn",
        turn.retrievalRuns,
        secrets,
      ),
      "",
      jsonDetails("World/effect/domain events", turn.domainEvents, secrets),
      "",
      jsonDetails(
        "Continuity persistence (care cues / follow-ups)",
        {
          careCues: turn.persistence.careCues,
          followUps: turn.persistence.followUps,
        },
        secrets,
      ),
      "",
      jsonDetails(
        "Memory persistence and evidence",
        {
          memories: turn.persistence.memories,
          evidence: turn.persistence.memoryEvidence,
        },
        secrets,
      ),
      "",
      jsonDetails(
        "Schedule negotiation and committed changes",
        {
          negotiations: turn.persistence.scheduleNegotiations,
          sharedScheduleItems: turn.persistence.sharedScheduleItems,
          scheduleChanges: turn.scheduleChanges,
        },
        secrets,
      ),
      "",
      jsonDetails("Rejected model proposals", turn.rejectedProposals, secrets),
      "",
      "### 本轮 LLM calls",
      "",
      ...renderLlmCallTable(turn.llmCalls),
      "",
    );
  }

  const crossSessionTurn = result.turns.find((turn) => turn.startedNewSession);
  lines.push(
    "## 跨新会话证据摘要",
    "",
    crossSessionTurn === undefined
      ? "未创建新会话，验收失败。"
      : [
          `- 新 session：${escapeInline(crossSessionTurn.sessionId)}`,
          `- selected evidence：${selectedEvidenceIds(crossSessionTurn.memoryRecall).length}`,
          `- 13_retrieved_evidence 已注入：${String(traceIncludes(crossSessionTurn.promptSegmentTrace, "13_retrieved_evidence"))}`,
          `- 回复完整包含代号、物件与位置：${String(containsCompleteAnchor(crossSessionTurn.assistantText))}`,
          "- 回复对齐已提交活动、地点与时间：" +
            String(
              containsCommittedScheduleRecall(
                crossSessionTurn.assistantText,
                result.turns[3]?.persistence.sharedScheduleItems[0],
                result.startedAtUtc,
              ),
            ),
        ].join("\n"),
    "",
  );

  if (result.failure !== undefined) {
    lines.push(
      "## 运行失败",
      "",
      jsonDetails(
        "Failure and correlated safe structured-output diagnostics",
        {
          failure: result.failure,
          diagnostics: failureDiagnostics,
        },
        secrets,
      ),
      "",
    );
  }
  lines.push(
    "## 说明",
    "",
    "- 报告只记录应用侧 LLM call 元数据（purpose、tokens、latency、success），不会记录 API key 或 Authorization。",
    "- Prompt 只保留 promptSegmentTrace 的段 ID、预算和大小；不会把完整系统 Prompt 写入报告。",
    "- StructuredOutputError 只保留固定 name/code、截断后的 schema issues 与 requestId 路由关联；不保存 raw output、system prompt、secret、cause 或 stack。",
    "- worldEffects、continuity 和 schedule 结论来自服务器验证后的持久化记录、domain events 与严格 response contract，不以自然语言回复自行推断。",
    "",
  );
  return lines.join("\n");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
function selectedEvidenceIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value["selectedEvidenceIds"])) {
    return [];
  }
  return value["selectedEvidenceIds"].filter(
    (item): item is string => typeof item === "string",
  );
}

function traceIncludes(
  trace: PromptAssemblyTrace,
  id: string,
  required?: boolean,
): boolean {
  return trace.segments.some(
    (segment) =>
      segment.id === id &&
      segment.included &&
      (required === undefined || segment.required === required),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderExchangeSummary(exchange: HttpExchange): string {
  return `- **${escapeTable(exchange.label)}** — ${exchange.method} ${exchange.path} → ${exchange.status} (${exchange.durationMs} ms)`;
}

function renderPromptTrace(trace: PromptAssemblyTrace): string[] {
  return [
    `Estimated input tokens: **${trace.estimatedInputTokens}**; dropped: ${trace.droppedSegmentIds.length === 0 ? "none" : trace.droppedSegmentIds.join(", ")}`,
    "",
    "| Segment | Placement | Required | Included | Tokens / budget | Truncated | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...trace.segments.map(
      (segment) =>
        `| ${escapeTable(segment.id)} | ${segment.placement} | ${String(segment.required)} | ${String(segment.included)} | ${segment.estimatedTokens} / ${segment.tokenBudget} | ${String(segment.truncated)} | ${escapeTable(segment.reason ?? "")} |`,
    ),
  ];
}

function renderLlmCallTable(calls: readonly LlmCallRecord[]): string[] {
  if (calls.length === 0) return ["_No LLM calls recorded._"];
  return [
    "| Time | Purpose | Provider / model | Tokens in / out | Latency | Success | Error |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...[...calls]
      .sort((left, right) =>
        left.createdAtUtc.localeCompare(right.createdAtUtc),
      )
      .map(
        (call) =>
          `| ${escapeTable(call.createdAtUtc)} | ${escapeTable(call.purpose)} | ${escapeTable(call.provider)} / ${escapeTable(call.model)} | ${call.inputTokens} / ${call.outputTokens} | ${call.latencyMs} ms | ${String(call.success)} | ${escapeTable(call.errorCode ?? "")} |`,
      ),
  ];
}

function jsonDetails(
  title: string,
  value: unknown,
  secrets: readonly string[],
): string {
  return [
    "<details>",
    `<summary>${escapeTable(title)}</summary>`,
    "",
    "~~~json",
    safeJson(value, secrets),
    "~~~",
    "</details>",
  ].join("\n");
}

function fencedText(value: string, secrets: readonly string[]): string {
  const redacted = redactAcceptanceValue(value, secrets);
  return ["~~~text", String(redacted).replace(/~~~/gu, "~ ~ ~"), "~~~"].join(
    "\n",
  );
}

function safeJson(value: unknown, secrets: readonly string[]): string {
  const redacted = redactAcceptanceValue(value, secrets);
  return (JSON.stringify(redacted, null, 2) ?? "null").replace(
    /~~~/gu,
    "~ ~ ~",
  );
}

function escapeInline(value: string): string {
  return value.replace(/`/gu, "ˋ").replace(/\r?\n/gu, " ");
}

function escapeTable(value: unknown): string {
  return String(value)
    .replace(/\|/gu, "\\|")
    .replace(/\r?\n/gu, "<br>")
    .replace(/`/gu, "ˋ");
}
