import { mkdirSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PersonaChatDecisionSchema,
  MemoryCandidateSchema,
  ConversationCheckpointSchema,
  StrictPersonaTurnProviderEnvelopeSchema,
  type CharacterSpec,
} from "@personasim/contracts";
import {
  canonicalCheckpointSource,
  estimatePromptTokens,
} from "@personasim/features";
import type { LlmCallMetric } from "@personasim/providers";
import { buildApp } from "../app.js";
import type { ServerConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { initialRuntimeState } from "../domain/defaults.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";
import { FakeClock } from "../runtime/clock.js";
import { messageEvidence } from "../services/autobiography-service.js";
import { ContinuityRepository } from "../services/continuity-repository.js";
import {
  LlmService,
  type LlmLogicalCallEvent,
} from "../services/llm-service.js";
import { validateMergeAndPersistMemories } from "../services/memory-service.js";
import { PersonaRuntimeService } from "../services/persona-runtime-service.js";
import {
  ARCHITECTURE_START_UTC,
  type ArchitectureMessage,
  type ArchitectureProbe,
} from "./architecture-evaluation-cases.js";
import {
  buildArchitecturePersonaFixtureCharacter,
  buildArchitecturePersonaInput,
} from "./architecture-persona-cases.js";
import { evaluationConfig } from "./reply-steering-runner.js";

export const ARCHITECTURE_RUNTIME_VERSION = "architecture-runtime-v1";
export const ARCHITECTURE_SESSION = "architecture-session";
export const ARCHITECTURE_RECENT_LIMIT = 8;
export const ARCHITECTURE_CHAT_CAP = 32768;
export const ARCHITECTURE_RETENTION = {
  fullVerbatimHours: 0,
  softTokenLimit: 1024,
  hardTokenLimit: 2048,
  minimumTailTokens: 256,
  minimumRecentTurns: 2,
};

function recentWindowLimit(value = ARCHITECTURE_RECENT_LIMIT): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Recent history limit must be a non-negative integer");
  return value;
}

export function architectureConfig(
  base: ServerConfig,
  llm: ServerConfig["llm"],
  directory: string,
): ServerConfig {
  return {
    ...evaluationConfig(base, llm, directory),
    profile: "architecture-eval-v1",
    fakeClockStart: ARCHITECTURE_START_UTC,
    autobiographyMode: "enforced",
    conversationRetention: ARCHITECTURE_RETENTION,
  };
}

export function architectureInstant(day = 0, minute = 0): string {
  return new Date(
    Date.parse(ARCHITECTURE_START_UTC) + day * 86400000 + minute * 60000,
  ).toISOString();
}

export function insertArchitectureSession(
  store: DatabaseStore,
  agentId: string,
  id: string,
  nowUtc: string,
): void {
  store.database
    .prepare(
      "INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, agentId, "Architecture experiment", nowUtc, nowUtc);
}

export async function createArchitectureRuntime(input: {
  directory: string;
  caseId: string;
  config: ServerConfig;
  transport: typeof fetch;
  history?: readonly ArchitectureMessage[];
  recentLimit?: number;
  stateOverride?: ArchitectureProbe["stateOverride"];
  autobiographySeed?: ArchitectureProbe["autobiographySeed"];
  nowUtc?: string;
  character?: CharacterSpec;
  onLogicalCall?: (event: LlmLogicalCallEvent) => void;
}) {
  mkdirSync(input.directory, { recursive: true });
  const databaseRelative = relative(
    resolve(input.directory),
    resolve(input.config.databasePath),
  );
  if (
    !databaseRelative ||
    databaseRelative.startsWith("..") ||
    isAbsolute(databaseRelative)
  )
    throw new Error("Runtime database must stay inside its isolated directory");
  if (existsSync(input.config.databasePath))
    throw new Error("Runtime database must be fresh");
  const now = input.nowUtc ?? ARCHITECTURE_START_UTC;
  const authored = buildArchitecturePersonaFixtureCharacter(input.caseId);
  // These contemporary runtime controls share the experiment's FakeClock with
  // the simple arms. A raw draft's year-only January 1 story placeholder is
  // normally materialized by CharacterService and is not an authored fact.
  // Generated characters supplied explicitly retain their own temporal frame.
  const spec = input.character ?? {
    ...authored,
    identity: {
      ...authored.identity,
      temporalFrame: {
        mode: "realtime" as const,
        eraLabel: "2026 年的上海，实验统一民用时间",
      },
    },
  };
  const database = openDatabase(input.config.databasePath);
  let createdApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    runMigrations(database);
    const store = new DatabaseStore(database);
    store.insertCharacter(spec);
    store.insertInitialState(
      { ...initialRuntimeState(spec.id, now, spec), ...input.stateOverride },
      now,
    );
    insertArchitectureSession(store, spec.id, ARCHITECTURE_SESSION, now);
    const history = input.history ?? [];
    const recentLimit = recentWindowLimit(input.recentLimit);
    const oldSession = `${ARCHITECTURE_SESSION}-previous`;
    if (history.length > recentLimit)
      insertArchitectureSession(store, spec.id, oldSession, now);
    const clock = new FakeClock(now);
    const events: LlmLogicalCallEvent[] = [];
    const metrics: LlmCallMetric[] = [];
    const app = await buildApp({
      config: input.config,
      database,
      clock,
      logger: false,
      seedDemo: false,
      startScheduler: false,
      llmObservation: {
        fetch: input.transport,
        promptDiagnostics: true,
        onLogicalCall: (event) => {
          events.push(event);
          input.onLogicalCall?.(event);
        },
        onMetric: (metric) => {
          metrics.push(metric);
        },
      },
    });
    observeEvaluationTurns(app);
    createdApp = app;
    const seeding: unknown[] = [];
    const persona = new PersonaRuntimeService(
      store,
      new MemoryValidityRepository(store),
    );
    history.forEach((message, index) => {
      const at = new Date(
        Date.parse(now) - (history.length - index) * 60000,
      ).toISOString();
      const id = `architecture-history-${index}`;
      store.insertMessage({
        id,
        agentId: spec.id,
        sessionId:
          index < history.length - recentLimit
            ? oldSession
            : ARCHITECTURE_SESSION,
        role: message.role,
        content: message.content,
        messageKind: message.role === "user" ? "user" : "assistant_reply",
        metadata: {},
        createdAtUtc: at,
      });
      if (message.role === "user") {
        const memories = validateMergeAndPersistMemories({
          store,
          agentId: spec.id,
          candidates: [
            MemoryCandidateSchema.parse({
              kind: "episodic",
              content: `用户在对话中说过：「${message.content.trim()}」`,
              namespace: "user_model",
              certainty: "explicit",
              attribution: "user_explicit",
              stability: "one_off",
              importance: 0.6,
              confidence: 1,
              tags: ["source_report"],
              sourceMessageIds: [id],
              sourceActivityEventIds: [],
              origin: "model_inference",
              temporalMetadata: {
                recordedAtUtc: at,
                temporalCertainty: "unknown",
                temporalStatus: "unknown",
              },
              evidence: [
                {
                  sourceType: "message",
                  sourceId: id,
                  quote: message.content,
                  recordedAtUtc: at,
                },
              ],
              reasonCode: "architecture_prefix_source_report",
              reasonSummary:
                "Prepared-prefix fixture selects each complete original user utterance without an interpretation or oracle answer.",
            }),
          ],
          nowUtc: at,
          maxCandidates: 20,
          authoritativeMessageId: id,
        });
        clock.setUtc(at);
        const reconciliation =
          app.personasim.memoryLifecycle.reconcileNewMemories(
            spec.id,
            memories.map((memory) => memory.id),
          );
        const practice = persona.captureExplicitPractice({
          baseSpec: spec,
          sourceMessageId: id,
          nowUtc: at,
          mode: "enforced",
        });
        seeding.push({
          mode: "prepared-prefix-source-report-fixture-not-generated",
          sourceMessageId: id,
          memoryIds: memories.map((memory) => memory.id),
          reconciliation,
          practice,
        });
      }
    });
    clock.setUtc(now);
    const repository = new ContinuityRepository(store);
    repository.rebuildMessageArchive(spec.id, now);
    if (input.autobiographySeed) {
      const checkpointSession =
        history.length > recentLimit ? oldSession : ARCHITECTURE_SESSION;
      const sourceMessages = repository.listArchivedMessages(checkpointSession);
      if (sourceMessages.length === 0)
        throw new Error(
          "Autobiography fixture requires archived source messages",
        );
      const evidenceCatalog = sourceMessages.map(messageEvidence);
      const prepared = app.personasim.autobiographies.prepareRevision({
        agentId: spec.id,
        checkpointId: "architecture-prepared-checkpoint",
        sourceMessages,
        evidenceCatalog,
        nowUtc: now,
        proposal: {
          summaryFirstPerson: input.autobiographySeed.summaryFirstPerson,
          entries: input.autobiographySeed.entries.map((entry) => {
            const evidence = evidenceCatalog.find(
              (item) =>
                item.sourceId ===
                `architecture-history-${entry.sourceHistoryIndex}`,
            );
            if (!evidence)
              throw new Error("Autobiography fixture source missing");
            const reference = {
              id: evidence.id,
              sourceType: evidence.sourceType,
              sourceId: evidence.sourceId,
              reliability: evidence.reliability,
              recordedAtUtc: evidence.recordedAtUtc,
              ...(evidence.quote === undefined
                ? {}
                : { quote: evidence.quote }),
              ...(evidence.contextSummary === undefined
                ? {}
                : { contextSummary: evidence.contextSummary }),
              ...(evidence.temporalStatus === undefined
                ? {}
                : { temporalStatus: evidence.temporalStatus }),
            };
            return {
              entryKind: entry.entryKind,
              content: entry.content,
              temporalStatus: entry.temporalStatus,
              evidence: [reference],
            };
          }),
        },
      });
      if (!prepared.accepted)
        throw new Error(
          `Autobiography fixture rejected: ${JSON.stringify(prepared.issues)}`,
        );
      store.transaction(() => {
        repository.beginCheckpoint(
          ConversationCheckpointSchema.parse({
            id: "architecture-prepared-checkpoint",
            agentId: spec.id,
            sessionId: checkpointSession,
            fromMessageId: sourceMessages[0]!.id,
            throughMessageId: sourceMessages.at(-1)!.id,
            sourceHash: createHash("sha256")
              .update(canonicalCheckpointSource(sourceMessages))
              .digest("hex"),
            sourceRevision:
              repository.getSessionRevision(checkpointSession)!.revision,
            sourceMessageCount: sourceMessages.length,
            sourceTokenEstimate: Math.max(
              1,
              estimatePromptTokens(
                sourceMessages.map((message) => message.content).join("\n"),
              ),
            ),
            status: "pending",
            createdAtUtc: now,
            updatedAtUtc: now,
          }),
        );
        if (!app.personasim.autobiographies.persistPrepared(prepared, now))
          throw new Error("Autobiography fixture stale");
        if (
          !repository.commitCheckpoint({
            checkpointId: "architecture-prepared-checkpoint",
            autobiographySnapshotId: prepared.bundle.snapshot.id,
            artifact: { source: "authored-mechanism-fixture-not-generated" },
            committedAtUtc: now,
          })
        )
          throw new Error("Autobiography fixture checkpoint did not commit");
      });
      seeding.push({
        preparedAutobiography: prepared.bundle,
        source: "authored-mechanism-fixture-not-generated",
      });
    }
    app.personasim.life.ensureToday(spec.id, now);
    return {
      app,
      spec,
      clock,
      store,
      events,
      metrics,
      seeding,
      close: async () => {
        await app.close();
        if (database.open) database.close();
      },
    };
  } catch (error) {
    await createdApp?.close();
    if (database.open) database.close();
    throw error;
  }
}

export async function runArchitectureFullTurn(
  runtime: Awaited<ReturnType<typeof createArchitectureRuntime>>,
  userText: string,
  clientMessageId: string,
  sessionId = ARCHITECTURE_SESSION,
) {
  const eventStart = runtime.events.length;
  const metricStart = runtime.metrics.length;
  const started = performance.now();
  const response = await runtime.app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/messages`,
    payload: { agentId: runtime.spec.id, text: userText, clientMessageId },
  });
  const body = response.json<Record<string, unknown>>();
  const assistant = body["assistantMessage"] as
    { content?: string; metadata?: Record<string, unknown> } | undefined;
  return {
    text: assistant?.content ?? "",
    metadata:
      response.statusCode < 400
        ? readEvaluationTurn(runtime.app, body).assistantMessage.metadata
        : {},
    statusCode: response.statusCode,
    body,
    events: runtime.events.slice(eventStart),
    metrics: runtime.metrics.slice(metricStart),
    elapsedMs: Math.round(performance.now() - started),
    ...(response.statusCode >= 400
      ? { error: `HTTP ${response.statusCode}` }
      : {}),
  };
}

const SIMPLE_SYSTEM = `你正在扮演角色卡中的成年人。保持作者写明的个性、表达差异和例外。自然用中文回应当前用户，不把角色卡朗读出来。
角色、用户和第三人的事实必须分清；只把给定证据支持的事情当作事实。未知就明确未知，建议、愿望、计划和已完成事件要分开。后来的更正与撤回优先。按用户当前请求选择倾听、分析或直接完成任务；既保持个性，也给足明确任务要求的信息。不可替用户发消息、公开发布或声称已经执行动作。
只返回 JSON 对象：{"replyDecision":{"text":"完整、可独立阅读的最终回复","deliveryMode":"single_block"},"worldEffects":{}}。text 必须包含整个答案，不能把必要信息藏在其他字段。`;

export function architectureSimplePrompt(input: {
  caseId: string;
  history: readonly ArchitectureMessage[];
  userText: string;
  nowUtc: string;
  recentLimit?: number;
  summary?: string;
  stateOverride?: ArchitectureProbe["stateOverride"];
  card?: unknown;
}) {
  const recentLimit = recentWindowLimit(input.recentLimit);
  return {
    system: SIMPLE_SYSTEM,
    prompt: JSON.stringify({
      characterCard: input.card ?? buildArchitecturePersonaInput(input.caseId),
      currentTimeUtc: input.nowUtc,
      ...(input.stateOverride
        ? { currentCharacterState: input.stateOverride }
        : {}),
      ...(input.summary ? { priorConversationSummary: input.summary } : {}),
      recentMessages:
        recentLimit === 0 ? [] : input.history.slice(-recentLimit),
      userMessage: input.userText,
    }),
  };
}

const SummarySchema = z
  .object({ summary: z.string().min(1).max(10000) })
  .strict();
export interface ArchitectureSummaryState {
  text: string;
  throughIndex: number;
}

export async function runArchitectureSimple(input: {
  directory: string;
  caseId: string;
  config: ServerConfig;
  transport: typeof fetch;
  history: readonly ArchitectureMessage[];
  userText: string;
  summaryMode: "recent" | "rolling";
  nowUtc?: string;
  recentLimit?: number;
  stateOverride?: ArchitectureProbe["stateOverride"];
  card?: unknown;
  summaryState?: ArchitectureSummaryState;
  maxOutputTokens?: number;
  onLogicalCall?: (event: LlmLogicalCallEvent) => void;
}) {
  mkdirSync(input.directory, { recursive: true });
  const simplePath = join(input.directory, "simple.sqlite");
  if (existsSync(simplePath))
    throw new Error("Simple runtime database must be fresh");
  const database = openDatabase(simplePath);
  runMigrations(database);
  const store = new DatabaseStore(database);
  const events: LlmLogicalCallEvent[] = [];
  const metrics: LlmCallMetric[] = [];
  const now = input.nowUtc ?? ARCHITECTURE_START_UTC;
  const llm = new LlmService(input.config.llm, store, new FakeClock(now), {
    fetch: input.transport,
    promptDiagnostics: true,
    onLogicalCall: (event) => {
      events.push(event);
      input.onLogicalCall?.(event);
    },
    onMetric: (metric) => {
      metrics.push(metric);
    },
  });
  let summaryState = input.summaryState ?? { text: "", throughIndex: 0 };
  const oldEnd = Math.max(
    0,
    input.history.length - recentWindowLimit(input.recentLimit),
  );
  const started = performance.now();
  let text = "";
  let error: string | undefined;
  let rawReply: unknown;
  let repaired = false;
  let summaryError: string | undefined;
  try {
    if (input.summaryMode === "rolling" && oldEnd > summaryState.throughIndex) {
      try {
        const result = await llm.generateObject({
          purpose: "checkpoint_autobiography",
          schema: SummarySchema,
          maxOutputTokens: 4096,
          system:
            '把旧摘要和新对话合并成不超过1200个汉字的滚动摘要。准确保留人物归属、编号、时间、用户偏好与尚未完成的承诺；清楚区分计划和已发生事实。后来的更正替换旧版本，撤回的信息不再保留内容。不要补造事实。输出JSON：{"summary":"..."}。',
          prompt: JSON.stringify({
            previousSummary: summaryState.text,
            newMessages: input.history.slice(summaryState.throughIndex, oldEnd),
          }),
        });
        summaryState = { text: result.summary, throughIndex: oldEnd };
      } catch (cause) {
        summaryError = cause instanceof Error ? cause.message : String(cause);
      }
    }
    const prompt = architectureSimplePrompt({
      caseId: input.caseId,
      history: input.history,
      userText: input.userText,
      nowUtc: now,
      ...(input.recentLimit === undefined
        ? {}
        : { recentLimit: input.recentLimit }),
      ...(input.stateOverride === undefined
        ? {}
        : { stateOverride: input.stateOverride }),
      ...(input.card === undefined ? {} : { card: input.card }),
      ...(summaryState.text ? { summary: summaryState.text } : {}),
    });
    rawReply = await llm.generateObject({
      purpose: "chat_turn",
      ...prompt,
      schema: StrictPersonaTurnProviderEnvelopeSchema,
      maxOutputTokens: input.maxOutputTokens ?? ARCHITECTURE_CHAT_CAP,
    });
    let parsed = PersonaChatDecisionSchema.safeParse(
      (rawReply as { replyDecision: unknown }).replyDecision,
    );
    if (!parsed.success) {
      repaired = true;
      const repair = await llm.generateObject({
        purpose: "repair_chat_turn",
        system: prompt.system,
        prompt: JSON.stringify({
          originalPrompt: prompt.prompt,
          invalidReply: rawReply,
          validationIssues: parsed.error.issues,
          instruction: "修复JSON结构并给出完整text，不要改变证据支持的事实。",
        }),
        schema: StrictPersonaTurnProviderEnvelopeSchema,
        maxRetries: 0,
        maxOutputTokens: input.maxOutputTokens ?? ARCHITECTURE_CHAT_CAP,
      });
      parsed = PersonaChatDecisionSchema.safeParse(repair.replyDecision);
    }
    if (!parsed.success)
      throw new Error(`canonical_reply_invalid:${parsed.error.message}`);
    text = parsed.data.text;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    database.close();
  }
  return {
    text,
    events,
    metrics,
    elapsedMs: Math.round(performance.now() - started),
    rawReply,
    repaired,
    summaryState,
    ...(summaryError === undefined ? {} : { summaryError }),
    ...(error === undefined ? {} : { error }),
  };
}

/** No network transport used by preflight. Auxiliary summary/checkpoint failures remain visible. */
export const architectureFixtureFetch: typeof fetch = () =>
  Promise.resolve(
    Response.json({
      model: "offline-contract-fixture",
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              replyDecision: {
                text: "我在听，你可以继续说。",
                deliveryMode: "single_block",
              },
              worldEffects: {},
            }),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
import {
  observeEvaluationTurns,
  readEvaluationTurn,
} from "./evaluation-turn-evidence.js";
