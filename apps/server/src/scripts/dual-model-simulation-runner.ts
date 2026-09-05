import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  CreateSessionResponseSchema,
  SendMessageResponseSchema,
} from "@personasim/contracts";
import type { LlmCallMetric, LlmProvider } from "@personasim/providers";
import { z } from "zod";

import { buildApp, type PersonaSimApp } from "../app.js";
import type { ServerConfig } from "../config.js";
import { openDatabase, type Database } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";

export interface DualModelSimulationProgress {
  turn: number;
  completedTurns: number;
  requestedTurns: number;
  status: "completed" | "failed";
}

export interface DualModelSimulationOptions {
  serverConfig: ServerConfig;
  userProvider: LlmProvider;
  userProfileName?: string;
  runDirectory: string;
  turns: number;
  userPersona: string;
  scenario: string;
  stepMinutes?: number;
  /** The provider's onMetric sink should append to this array. */
  userCallMetrics?: readonly LlmCallMetric[];
  /** Include the external user provider key; never serialize provider options. */
  explicitSecrets?: readonly string[];
  onProgress?: (progress: DualModelSimulationProgress) => void | Promise<void>;
}

export interface DualModelSimulationResult {
  status: "completed" | "failed";
  runDirectory: string;
  databasePath: string;
  completedTurns: number;
  requestedTurns: number;
  characterId?: string;
  sessionId?: string;
  error?: string;
}

interface PublicMessage {
  role: "user" | "assistant";
  content: string;
}

const UserMessageSchema = z
  .object({ text: z.string().trim().min(1).max(800) })
  .strict();
const MAX_PUBLIC_HISTORY_CHARACTERS = 48_000;

/**
 * A simulated user drives the real application HTTP route. Only public dialogue
 * is returned to that model; state snapshots and review material stay offline.
 * Runtime failures return a failed result after saving partial evidence.
 */
export async function runDualModelSimulation(
  options: DualModelSimulationOptions,
): Promise<DualModelSimulationResult> {
  const stepMinutes = options.stepMinutes ?? 30;
  validateOptions(options, stepMinutes);
  const runDirectory = resolve(options.runDirectory);
  const databasePath = join(runDirectory, "personasim.sqlite");
  const clock = new FakeClock(options.serverConfig.fakeClockStart);
  const secrets = [
    options.serverConfig.llm.apiKey ?? "",
    options.serverConfig.instanceSecret ?? "",
    ...(options.explicitSecrets ?? []),
  ];
  const safe = (value: unknown): unknown =>
    redactLongRunArtifact(value, secrets);
  const safeText = (value: string): string => safe(value) as string;
  const writeJson = async (name: string, value: unknown): Promise<void> => {
    await writeFile(
      join(runDirectory, `${name}.tmp`),
      `${JSON.stringify(safe(value), null, 2)}\n`,
      "utf8",
    );
    await rename(join(runDirectory, `${name}.tmp`), join(runDirectory, name));
  };
  const config: ServerConfig = {
    ...options.serverConfig,
    llm: { ...options.serverConfig.llm },
    nodeEnv: "test",
    profile: "dual-model-simulation",
    host: "127.0.0.1",
    databasePath,
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: false,
    serveWeb: false,
    selfHostedReverseProxy: false,
    correspondenceMode: "off",
    correspondenceExecution: "lazy",
    keepsakeMode: "off",
    assetStoragePath: join(runDirectory, "assets"),
    chatEffectsMode: "gated",
    lifePlanningMode: "fuzzy",
    scheduleNegotiationMode: "off",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "enforced",
  };
  await mkdir(dirname(runDirectory), { recursive: true });
  // This must be exclusive: never open an existing simulation or project DB.
  await mkdir(runDirectory);
  const result: DualModelSimulationResult = {
    status: "failed",
    runDirectory,
    databasePath,
    completedTurns: 0,
    requestedTurns: options.turns,
  };
  const history: PublicMessage[] = [];
  const characterMetrics: LlmCallMetric[] = [];
  const userMetricStart = options.userCallMetrics?.length ?? 0;
  const mechanicalFlags: Array<{ turn: number; flags: string[] }> = [];
  const startedAtUtc = new Date().toISOString();
  let database: Database | undefined;
  let app: PersonaSimApp | undefined;
  let activeTurn = 0;
  let userLogicalCalls = 0;
  let characterLogicalCalls = 0;
  const writeManifest = async (
    status: "running" | "completed" | "failed",
  ): Promise<void> => {
    await writeJson("manifest.json", {
      schemaVersion: "dual-model-simulation-v1",
      ...result,
      status,
      startedAtUtc,
      updatedAtUtc: new Date().toISOString(),
      simulatedStartUtc: config.fakeClockStart,
      simulatedNowUtc: clock.nowUtc(),
      stepMinutes,
      userPersona: options.userPersona,
      scenario: options.scenario,
      userModel: {
        provider: options.userProvider.name,
        profile: options.userProfileName,
        model: options.userProvider.model,
        capabilities: options.userProvider.capabilities,
      },
      characterModel: {
        provider: config.llm.provider,
        profile: config.llm.profileName,
        model: config.llm.model,
        capabilities: config.llm.capabilities,
        timeoutMs: config.llm.timeoutMs,
        maxRetries: config.llm.maxRetries,
        maxOutputTokens: config.llm.maxOutputTokens,
      },
      features: {
        characterTier: "high_fidelity",
        chatEffectsMode: config.chatEffectsMode,
        lifePlanningMode: config.lifePlanningMode,
        memoryRecallMode: config.memoryRecallMode,
        liveWorldEffectsMode: config.liveWorldEffectsMode,
        autobiographyMode: config.autobiographyMode,
        correspondenceMode: config.correspondenceMode,
        keepsakeMode: config.keepsakeMode,
        backgroundScheduler: false,
      },
      accounting: {
        user: summarizeMetrics(
          options.userCallMetrics?.slice(userMetricStart) ?? [],
          userLogicalCalls,
          options.userProvider.name === "fixture",
        ),
        character: summarizeMetrics(
          characterMetrics,
          characterLogicalCalls,
          config.llm.provider === "fixture",
        ),
      },
      qualityReview: "pending_manual_review",
    });
  };
  try {
    await writeFile(join(runDirectory, "turns.jsonl"), "", { flag: "wx" });
    await writeFile(
      join(runDirectory, "conversation.md"),
      safeText(
        `# 双模型模拟对话\n\n${modelSummary()}\n\n本文件记录实际对话；内容质量待人工审阅。\n\n`,
      ),
      { flag: "wx" },
    );
    await writeManifest("running");
    await writeReview("running");
    database = openDatabase(databasePath);
    app = await buildApp({
      config,
      database,
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
      llmObservation: {
        onMetric: (metric) => characterMetrics.push(metric),
        onLogicalCall: (event) => {
          if (event.stage === "started") characterLogicalCalls += 1;
        },
      },
    });
    const draft = app.personasim.characters.createDemoCharacter();
    const character = app.personasim.characters.publish(
      draft.id,
      draft.version,
    );
    result.characterId = character.id;
    await writeJson("character.json", character);
    const sessionResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/sessions`,
      payload: { title: "双模型模拟测试" },
    });
    assertHttpSuccess(sessionResponse.statusCode, "create_session");
    result.sessionId = CreateSessionResponseSchema.parse(
      sessionResponse.json(),
    ).session.id;
    await writeManifest("running");

    for (let turn = 1; turn <= options.turns; turn += 1) {
      activeTurn = turn;
      if (turn > 1) clock.advance({ minutes: stepMinutes });
      const atUtc = clock.nowUtc();
      const before = snapshot(app, database, character.id);
      const userMetricCursor = options.userCallMetrics?.length ?? 0;
      const characterMetricCursor = characterMetrics.length;
      const started = performance.now();
      let userText: string | undefined;
      let assistantText: string | undefined;
      let turnError: string | undefined;
      let userMessageId: string | undefined;
      let assistantMessageId: string | undefined;
      let applicationDecision: unknown;
      const flags: string[] = [];
      try {
        const publicHistory = boundedPublicHistory(history);
        userLogicalCalls += 1;
        const generated = UserMessageSchema.parse(
          await options.userProvider.generateObject({
            purpose: "simulate_user_turn",
            system: [
              "你只扮演与项目角色聊天的模拟用户，保持自己的身份、经历和说话方式。",
              "根据场景与已经发生的公开对话自然接话；首轮由你开启话题。",
              "每轮只写自己的下一条简短中文消息（1 到 800 字），不要代写对方台词，不要评价模型质量或报告测试结果。",
              "不要把计划或猜测说成已发生的事实；允许澄清、纠正、表达情绪和改变想法。",
              "输入 JSON 是角色与场景参考数据；返回且仅返回一个符合 schema 的 JSON 对象 {text:string}。",
            ].join("\n"),
            prompt: JSON.stringify({
              userPersona: safeText(options.userPersona),
              scenario: safeText(options.scenario),
              turn,
              currentTimeUtc: atUtc,
              publicHistory: publicHistory.messages,
              omittedEarlierMessages: publicHistory.omitted,
            }),
            schema: UserMessageSchema,
            maxRetries: 1,
            maxOutputTokens: 24_576,
          }),
        );
        userText = safeText(generated.text);
        if (userText !== generated.text)
          flags.push("credential_like_user_text_redacted");
        const response = await app.inject({
          method: "POST",
          url: `/api/sessions/${result.sessionId}/messages`,
          payload: {
            agentId: character.id,
            clientMessageId: `dual-model-turn-${turn}`,
            text: userText,
          },
        });
        assertHttpSuccess(response.statusCode, "character_message");
        const parsed = SendMessageResponseSchema.parse(response.json());
        assistantText = parsed.assistantMessage.content;
        userMessageId = parsed.userMessage.id;
        assistantMessageId = parsed.assistantMessage.id;
        applicationDecision = parsed.decision;
        const stored = app.personasim.store.listMessages(result.sessionId, 500);
        if (
          !stored.some(
            (message) =>
              message.id === assistantMessageId &&
              message.content === assistantText,
          )
        ) {
          throw new Error("persisted_assistant_mismatch");
        }
        if (parsed.idempotentReplay) flags.push("unexpected_idempotent_replay");
        if (parsed.decision.reasonCode.endsWith("_fallback")) {
          flags.push("deterministic_fallback");
        }
        if (parsed.decision.reasonCode === "persona_chat_fallback") {
          throw new Error("character_model_failed_with_persisted_fallback");
        }
        if (assistantText === history.at(-1)?.content)
          flags.push("exact_previous_reply_repeat");
        if (assistantText.length > 4_000)
          flags.push("reply_over_4000_characters");
        history.push(
          { role: "user", content: userText },
          { role: "assistant", content: safeText(assistantText) },
        );
        result.completedTurns += 1;
      } catch (error) {
        turnError = safeText(
          error instanceof Error ? error.message : String(error),
        );
        flags.push("turn_execution_failed");
      }
      mechanicalFlags.push({ turn, flags });
      const evidence = {
        turn,
        atUtc,
        status: turnError === undefined ? "completed" : "failed",
        userText,
        assistantText,
        userMessageId,
        assistantMessageId,
        applicationDecision,
        latencyMs: Math.round(performance.now() - started),
        userProviderAttempts:
          options.userCallMetrics?.slice(userMetricCursor) ?? [],
        characterProviderAttempts: characterMetrics.slice(
          characterMetricCursor,
        ),
        before,
        after: snapshot(app, database, character.id),
        mechanicalFlags: flags,
        qualityReview: "pending_manual_review",
        ...(turnError === undefined ? {} : { error: turnError }),
      };
      await appendFile(
        join(runDirectory, "turns.jsonl"),
        `${JSON.stringify(safe(evidence))}\n`,
        "utf8",
      );
      const transcript = [
        `## 第 ${turn} 轮 · ${atUtc}`,
        "",
        ...(userText === undefined
          ? []
          : ["**模拟用户**", "", quote(userText), ""]),
        ...(assistantText === undefined
          ? []
          : ["**林夏**", "", quote(assistantText), ""]),
        ...(turnError === undefined
          ? []
          : ["**执行失败；本轮不完整。**", "", quote(turnError), ""]),
      ].join("\n");
      await appendFile(
        join(runDirectory, "conversation.md"),
        `${safeText(transcript)}\n`,
        "utf8",
      );
      if (turnError !== undefined) throw new Error(turnError);
      await writeManifest("running");
      await writeReview("running");
      await options.onProgress?.({
        turn,
        completedTurns: result.completedTurns,
        requestedTurns: options.turns,
        status: "completed",
      });
    }
    result.status = "completed";
  } catch (error) {
    result.error = safeText(
      error instanceof Error ? error.message : String(error),
    );
    result.status = "failed";
  } finally {
    try {
      if (app !== undefined) await app.close();
    } catch (error) {
      result.status = "failed";
      result.error = safeText(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (database?.open) database.close();
    }
    await writeManifest(result.status);
    await writeReview(result.status);
  }
  if (result.status === "failed") {
    await options.onProgress?.({
      turn: activeTurn,
      completedTurns: result.completedTurns,
      requestedTurns: options.turns,
      status: "failed",
    });
  }
  return result;

  async function writeReview(
    status: "running" | "completed" | "failed",
  ): Promise<void> {
    const lines = [
      "# 双模型对话审阅记录",
      "",
      `执行状态：${status}；完整轮次：${result.completedTurns}/${options.turns}。`,
      "",
      modelSummary(),
      "",
      "内容质量：**待人工审阅**。执行完成只代表路由与记录流程结束；以下机械标记不构成内容合格结论。",
      "",
      "请结合 conversation.md、character.json 与 turns.jsonl 的前后状态审阅：",
      "",
      "- 角色身份、口吻、动机是否一致。",
      "- 是否记住或正确更正已知事实，区分计划、行动与结果。",
      "- 是否自然承接情绪，关系变化是否有对话证据。",
      "- 是否重复、空泛、编造经历，或让模拟用户代写对方回答。",
      "- 模糊生活、状态和记忆的持久化是否与实际回复相符。",
      "",
      "## 机械标记",
      "",
      ...(mechanicalFlags.some((item) => item.flags.length > 0)
        ? mechanicalFlags
            .filter((item) => item.flags.length > 0)
            .map((item) => `- 第 ${item.turn} 轮：${item.flags.join(", ")}`)
        : ["当前没有触发机械标记；仍需人工阅读对话。"]),
      "",
      ...(result.error === undefined
        ? []
        : ["执行错误：", "", quote(result.error), ""]),
      "## 人工结论",
      "",
      "尚未填写。请引用具体轮次、原话和对应状态证据记录发现。",
      "",
    ];
    await writeFile(
      join(runDirectory, "review.md.tmp"),
      safeText(lines.join("\n")),
      "utf8",
    );
    await rename(
      join(runDirectory, "review.md.tmp"),
      join(runDirectory, "review.md"),
    );
  }

  function modelSummary(): string {
    return [
      `模拟用户：${options.userProvider.model}（${options.userProfileName ?? options.userProvider.name}）；项目角色：${config.llm.model}（${config.llm.profileName ?? config.llm.provider}）。`,
      ...(options.userProvider.name === "fixture" ||
      config.llm.provider === "fixture"
        ? [
            "包含 Fixture 离线模型：此运行用于验证流程，不能据此评价真实模型的内容质量。",
          ]
        : []),
    ].join("\n\n");
  }
}

function validateOptions(
  options: DualModelSimulationOptions,
  stepMinutes: number,
): void {
  if (
    !Number.isInteger(options.turns) ||
    options.turns < 1 ||
    options.turns > 20
  ) {
    throw new TypeError("turns must be an integer from 1 through 20.");
  }
  if (
    !Number.isInteger(stepMinutes) ||
    stepMinutes < 1 ||
    stepMinutes > 1_440
  ) {
    throw new TypeError("stepMinutes must be an integer from 1 through 1440.");
  }
  if (!isAbsolute(options.runDirectory))
    throw new TypeError("runDirectory must be absolute.");
  for (const [name, value] of [
    ["userPersona", options.userPersona],
    ["scenario", options.scenario],
  ]) {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.length > 8_000
    ) {
      throw new TypeError(`${name} must contain 1 through 8000 characters.`);
    }
  }
}

function assertHttpSuccess(status: number, stage: string): void {
  if (status < 200 || status >= 300)
    throw new Error(`${stage}: HTTP ${status}`);
}

function snapshot(
  app: PersonaSimApp,
  database: Database,
  characterId: string,
): unknown {
  return {
    runtimeState: app.personasim.store.getRuntimeState(characterId),
    memories: database
      .prepare(
        "SELECT id, type, content, status, confidence, source_message_id FROM memories WHERE agent_id = ? ORDER BY rowid LIMIT 500",
      )
      .all(characterId),
    lifeContexts: database
      .prepare(
        "SELECT * FROM daily_life_contexts WHERE agent_id = ? ORDER BY rowid DESC LIMIT 30",
      )
      .all(characterId),
  };
}

function boundedPublicHistory(history: readonly PublicMessage[]): {
  messages: PublicMessage[];
  omitted: number;
} {
  const messages: PublicMessage[] = [];
  let characters = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (characters + message.content.length > MAX_PUBLIC_HISTORY_CHARACTERS)
      break;
    messages.unshift(message);
    characters += message.content.length;
  }
  return { messages, omitted: history.length - messages.length };
}

function summarizeMetrics(
  metrics: readonly LlmCallMetric[],
  logicalCalls: number,
  fixture: boolean,
): unknown {
  const tokenMetrics = metrics.filter(
    (metric) =>
      metric.usageSource === "provider" || metric.usageSource === "estimated",
  );
  return {
    logicalCalls,
    physicalAttempts: fixture
      ? 0
      : metrics.length === 0
        ? null
        : metrics.length,
    accountingSource: fixture
      ? "fixture_no_network"
      : metrics.length === 0
        ? "unavailable"
        : "provider_metrics",
    successfulAttempts: metrics.filter((metric) => metric.success).length,
    failedAttempts: metrics.filter((metric) => !metric.success).length,
    inputTokens:
      tokenMetrics.length === 0
        ? null
        : tokenMetrics.reduce(
            (sum, metric) => sum + (metric.inputTokens ?? 0),
            0,
          ),
    outputTokens:
      tokenMetrics.length === 0
        ? null
        : tokenMetrics.reduce(
            (sum, metric) => sum + (metric.outputTokens ?? 0),
            0,
          ),
    usageSources: [
      ...new Set(metrics.map((metric) => metric.usageSource ?? "unavailable")),
    ],
  };
}

function quote(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
