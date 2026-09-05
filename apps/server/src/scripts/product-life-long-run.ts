import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  CreateSessionResponseSchema,
  SendMessageResponseSchema,
  characterSpecSchema,
} from "@personasim/contracts";
import {
  createOpenAiCompatibleLlmProvider,
  type LlmCallMetric,
  type LlmProvider,
  type GenerateObjectInput,
} from "@personasim/providers";
import { z } from "zod";

import { buildApp, type PersonaSimApp } from "../app.js";
import {
  readConfig,
  readLlmProfileConfig,
  type ServerConfig,
} from "../config.js";
import { openDatabase, type Database } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";
import { buildGuLanV3CharacterInput } from "./companion-long-run-v3-baseline.js";
import {
  FixtureSimulationUser,
  assertPaidDualModelEnabled,
} from "./dual-model-simulation.js";
import {
  dispatchProductLifeLetter,
  inspectProductLifeArtifacts,
  inspectProductLifeCorrespondence,
  type ProductLifeFeatureResult,
} from "./product-life-long-run-features.js";
import {
  PRODUCT_LIFE_PLAN,
  PRODUCT_LIFE_USER_PERSONA,
} from "./product-life-long-run-plan.js";
import { auditProductLifeDatabase } from "./product-life-long-run-audit.js";

const START = "2026-09-05T01:00:00.000Z";
const TextSchema = z
  .object({ text: z.string().trim().min(1).max(800) })
  .strict();
const LetterSchema = z
  .object({
    subject: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(2400),
  })
  .strict();
type PublicMessage = {
  role: "user" | "assistant";
  content: string;
  channel?: string;
};
interface Journal {
  steps: Record<string, unknown>;
  completedTurns: number;
  nowUtc: string;
  status: string;
  error?: string;
}
export interface ProductLifeLongRunOptions {
  runDirectory: string;
  config: ServerConfig;
  userProvider: LlmProvider;
  userMetrics: LlmCallMetric[];
  explicitSecrets?: string[];
  resume?: boolean;
  onProgress?: (text: string) => void;
}

/** A bounded synthetic-user experiment. Domain writes use normal product HTTP APIs. */
export async function runProductLifeLongRun(
  options: ProductLifeLongRunOptions,
): Promise<Journal> {
  const directory = resolve(options.runDirectory);
  await mkdir(dirname(directory), { recursive: true });
  if (!options.resume) await mkdir(directory);
  const secretPath = join(directory, ".instance-secret");
  const instanceSecret = options.resume
    ? await readFile(secretPath, "utf8")
    : randomBytes(32).toString("base64");
  if (!options.resume)
    await writeFile(secretPath, instanceSecret, { flag: "wx", mode: 0o600 });
  const secrets = [
    instanceSecret,
    options.config.llm.apiKey ?? "",
    ...(options.explicitSecrets ?? []),
  ];
  const safe = (value: unknown): unknown =>
    redactLongRunArtifact(value, secrets);
  const json = async (name: string, value: unknown): Promise<void> => {
    await writeFile(
      join(directory, `${name}.tmp`),
      `${JSON.stringify(safe(value), null, 2)}\n`,
    );
    await rename(join(directory, `${name}.tmp`), join(directory, name));
  };
  const append = (name: string, value: unknown): void =>
    appendFileSync(join(directory, name), `${JSON.stringify(safe(value))}\n`);
  const journal: Journal = options.resume
    ? (JSON.parse(
        await readFile(join(directory, "journal.json"), "utf8"),
      ) as Journal)
    : { steps: {}, completedTurns: 0, nowUtc: START, status: "running" };
  const config: ServerConfig = {
    ...options.config,
    nodeEnv: "test",
    profile: "product-life-long-run",
    host: "127.0.0.1",
    databasePath: join(directory, "personasim.sqlite"),
    clockMode: "fake",
    fakeClockStart: START,
    developerRoutes: true,
    seedDemo: false,
    serveWeb: false,
    selfHostedReverseProxy: false,
    chatEffectsMode: "gated",
    lifePlanningMode: "fuzzy",
    scheduleNegotiationMode: "off",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "enforced",
    correspondenceMode: "enforced",
    correspondenceExecution: "lazy",
    keepsakeMode: "enforced",
    assetStoragePath: join(directory, "assets"),
    instanceSecret,
    conversationRetention: {
      fullVerbatimHours: 24,
      softTokenLimit: 2400,
      hardTokenLimit: 4800,
      minimumTailTokens: 1200,
      minimumRecentTurns: 6,
    },
  };
  const currentPlan = {
    persona: PRODUCT_LIFE_USER_PERSONA,
    turns: PRODUCT_LIFE_PLAN,
  };
  const resumeIdentity: unknown = JSON.parse(
    JSON.stringify({
      character: {
        provider: config.llm.provider,
        profile: config.llm.profileName,
        model: config.llm.model,
        capabilities: config.llm.capabilities,
        timeoutMs: config.llm.timeoutMs,
        maxRetries: config.llm.maxRetries,
        maxOutputTokens: config.llm.maxOutputTokens,
      },
      user: {
        provider: options.userProvider.name,
        model: options.userProvider.model,
        capabilities: options.userProvider.capabilities,
      },
      conversationRetention: config.conversationRetention,
      simulatedStartUtc: START,
    }),
  );
  if (options.resume) {
    const savedManifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    ) as { resumeIdentity?: unknown };
    const savedPlan: unknown = JSON.parse(
      await readFile(join(directory, "plan.json"), "utf8"),
    );
    if (
      !isDeepStrictEqual(savedManifest.resumeIdentity, resumeIdentity) ||
      !isDeepStrictEqual(savedPlan, currentPlan)
    ) {
      throw new Error(
        "Resume configuration or scenario differs from this run; start a new run instead.",
      );
    }
  }
  const characterMetrics: LlmCallMetric[] = existsSync(
    join(directory, "character-metrics.jsonl"),
  )
    ? readFileSync(join(directory, "character-metrics.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LlmCallMetric)
    : [];
  const oldUserMetrics: LlmCallMetric[] =
    options.resume && existsSync(join(directory, "user-metrics.json"))
      ? (JSON.parse(
          await readFile(join(directory, "user-metrics.json"), "utf8"),
        ) as LlmCallMetric[])
      : [];
  const clock = new FakeClock(journal.nowUtc);
  let app: PersonaSimApp;
  let database!: Database;
  let active = false;
  let activeStep = "initialization";
  const history: PublicMessage[] = [];
  let userMetricCursor = 0;
  async function open(
    path = config.databasePath,
    beforeStartup?: (openedDatabase: Database) => void,
  ): Promise<void> {
    database = openDatabase(path);
    beforeStartup?.(database);
    app = await buildApp({
      config: { ...config, databasePath: path },
      database,
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
      llmObservation: {
        onMetric: (metric) => {
          characterMetrics.push(metric);
          append("character-metrics.jsonl", metric);
        },
        onLogicalCall: (event) =>
          append("model-io.jsonl", {
            simulatedAtUtc: clock.nowUtc(),
            step: activeStep,
            actor: "character",
            ...event,
          }),
      },
    });
    active = true;
  }
  async function close(): Promise<void> {
    if (active) {
      await app.close();
      active = false;
    }
    if (database?.open) database.close();
  }
  async function save(): Promise<void> {
    journal.nowUtc = clock.nowUtc();
    await json("journal.json", journal);
    await json("user-metrics.json", [
      ...oldUserMetrics,
      ...options.userMetrics,
    ]);
    await json("manifest.json", {
      schema: "product-life-long-run-v1",
      status: journal.status,
      completedTurns: journal.completedTurns,
      plannedTurns: PRODUCT_LIFE_PLAN.length,
      simulatedStartUtc: START,
      simulatedNowUtc: clock.nowUtc(),
      updatedAtUtc: new Date().toISOString(),
      characterModel: config.llm.model,
      characterCapabilities: config.llm.capabilities,
      userModel: options.userProvider.model,
      userCapabilities: options.userProvider.capabilities,
      resumeIdentity,
      physicalCharacterAttempts: characterMetrics.length,
      physicalUserAttempts: oldUserMetrics.length + options.userMetrics.length,
      experimentConfiguration: {
        conversationRetention: config.conversationRetention,
        correspondence: "enforced/lazy/fixed_5d_v1",
        keepsakes:
          "enforced; default fixture image provider for non-template assets",
        scheduler: false,
        life: "fuzzy",
        memoryRecall: "enforced",
        autobiography: "enforced",
      },
      limitations: [
        "Simulated elapsed time, not 45 real days",
        "Synthetic user self-reports are scenario facts, not real human outcomes",
        "Reduced configurable retention thresholds exercise checkpoints",
        "Control only compares lazy life progression; one trajectory cannot estimate causal treatment effect",
        "No normal product creator for character-subject formal dilemmas",
        "Quality review is a separate human/agent artifact",
      ],
      error: journal.error,
    });
  }
  async function step<T>(id: string, work: () => Promise<T>): Promise<T> {
    activeStep = id;
    if (Object.hasOwn(journal.steps, id)) return journal.steps[id] as T;
    if (
      characterMetrics.length +
        oldUserMetrics.length +
        options.userMetrics.length >=
      200
    )
      throw new Error("physical_request_budget_reached");
    const value = await work();
    journal.steps[id] = safe(value);
    await save();
    return value;
  }
  async function http(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
    const body: unknown = response.json();
    append("http.jsonl", {
      step: activeStep,
      atUtc: clock.nowUtc(),
      method,
      url,
      statusCode: response.statusCode,
      body,
    });
    if (response.statusCode >= 400)
      throw new Error(`${method} ${url}: HTTP ${response.statusCode}`);
    return body;
  }
  async function generate<T>(
    schema: z.ZodType<T>,
    brief: string,
    purpose: string,
  ): Promise<T> {
    const bounded = [...history];
    while (bounded.reduce((n, m) => n + m.content.length, 0) > 48000)
      bounded.shift();
    const input = {
      purpose,
      schema,
      maxOutputTokens: 24576,
      maxRetries: 1,
      system:
        "你只扮演模拟用户林舟。根据给定生活情境与公开对话自然接话，只写自己说的内容，不代写顾澜的台词。保持人的口吻，通常80到220字，可以更短，不长篇说教。不报告测试、不评分、不提内部指导。情境是模拟外部生活事实，不是已发生对话；只能把公开对话中自己已经明确选择的计划作为后续执行前提。对方没有回答的内容不能当作已知。输出符合schema的JSON。",
      prompt: JSON.stringify({
        persona: PRODUCT_LIFE_USER_PERSONA,
        currentTimeUtc: clock.nowUtc(),
        scene: brief,
        publicHistory: bounded,
        omittedEarlierMessages: history.length - bounded.length,
      }),
    };
    append("model-io.jsonl", {
      actor: "user",
      step: activeStep,
      system: input.system,
      prompt: input.prompt,
      stage: "started",
    });
    const output = schema.parse(
      await options.userProvider.generateObject(input),
    );
    append("model-io.jsonl", {
      actor: "user",
      step: activeStep,
      stage: "completed",
      output,
      metrics: options.userMetrics.slice(userMetricCursor),
    });
    userMetricCursor = options.userMetrics.length;
    return output;
  }
  async function feature(
    id: string,
    work: () => Promise<ProductLifeFeatureResult>,
  ): Promise<ProductLifeFeatureResult> {
    const result = await step(id, work);
    history.push(...result.publicMessages);
    await json(`${id}.json`, result);
    return result;
  }
  try {
    journal.status = "running";
    delete journal.error;
    await json("plan.json", currentPlan);
    await open();
    const character = await step("character", async () => {
      const generated = z
        .object({ character: characterSpecSchema })
        .parse(
          await http(
            "POST",
            "/api/characters/generate",
            buildGuLanV3CharacterInput(),
          ),
        );
      const draft = generated.character;
      const updated = z.object({ character: characterSpecSchema }).parse(
        await http("PATCH", `/api/characters/${draft.id}`, {
          expectedVersion: draft.version,
          patch: { tier: "lightweight" },
        }),
      );
      const restored = z
        .object({ character: characterSpecSchema })
        .parse(
          await http(
            "POST",
            `/api/characters/${draft.id}/versions/${draft.version}/restore`,
            {},
          ),
        );
      const versions = await http(
        "GET",
        `/api/characters/${draft.id}/versions`,
      );
      await json("character-editing.json", {
        original: draft,
        temporarilyUpdated: updated.character,
        restored: restored.character,
        versions,
      });
      const published = z.object({ character: characterSpecSchema }).parse(
        await http("POST", `/api/characters/${draft.id}/publish`, {
          expectedVersion: restored.character.version,
        }),
      );
      await http("POST", `/api/agents/${draft.id}/activate`, {});
      await database.backup(join(directory, "control.sqlite"));
      return published.character;
    });
    await json("character.json", character);
    let sessionId = "";
    let letterId: string | undefined;
    let replyLetterId: string | undefined;
    const turns: unknown[] = [];
    for (const [index, planned] of PRODUCT_LIFE_PLAN.entries()) {
      const turn = index + 1;
      const phaseStart = index % 7 === 0;
      const phaseIndex = Math.floor(index / 7);
      const atUtc = new Date(
        Date.parse(START) + planned.day * 86400000 + (index % 7) * 30 * 60000,
      ).toISOString();
      if (!Object.hasOwn(journal.steps, `turn-${turn}`)) {
        if (phaseStart && [3, 5].includes(phaseIndex)) {
          const beforeCloseAtUtc = clock.nowUtc();
          const beforeClose = auditProductLifeDatabase(database, character.id);
          await close();
          clock.setUtc(atUtc);
          await open();
          append("lifecycle.jsonl", {
            event: "reopened_same_database_after_absence",
            phaseIndex,
            atUtc,
            beforeCloseAtUtc,
            beforeClose,
            afterStartup: auditProductLifeDatabase(database, character.id),
          });
        } else clock.setUtc(atUtc);
      }
      if (phaseStart) {
        if ([0, 3, 5].includes(phaseIndex)) {
          sessionId = await step(
            `session-${phaseIndex}`,
            async () =>
              CreateSessionResponseSchema.parse(
                await http("POST", `/api/agents/${character.id}/sessions`, {
                  title: `长程·${planned.phase}`,
                }),
              ).session.id,
          );
        }
        await step(`phase-${phaseIndex}-arrival`, async () => {
          const before = auditProductLifeDatabase(database, character.id);
          const overview = await http(
            "POST",
            `/api/agents/${character.id}/activate`,
            {},
          );
          const after = auditProductLifeDatabase(database, character.id);
          await http("POST", `/api/agents/${character.id}/activate`, {});
          const repeated = auditProductLifeDatabase(database, character.id);
          const evidence = {
            atUtc: clock.nowUtc(),
            before,
            overview,
            after,
            repeated,
          };
          await json(`phase-${phaseIndex}-arrival.json`, evidence);
          return { captured: true };
        });
        if (letterId && phaseIndex >= 3) {
          const letters = await feature(`phase-${phaseIndex}-letters`, () =>
            inspectProductLifeCorrespondence(app, character.id, {
              incomingLetterId: letterId!,
              probeEarlyOpen: phaseIndex === 3,
              openReply: phaseIndex >= 4,
            }),
          );
          replyLetterId = letters.replyLetterId ?? replyLetterId;
        }
      }
      const user = await step(`user-${turn}`, () =>
        generate(TextSchema, planned.brief, "simulate_product_life_user"),
      );
      const evidence = await step(`turn-${turn}`, async () => {
        const before = auditProductLifeDatabase(database, character.id);
        const response = SendMessageResponseSchema.parse(
          await http("POST", `/api/sessions/${sessionId}/messages`, {
            agentId: character.id,
            clientMessageId: `product-life-turn-${turn}`,
            text: user.text,
          }),
        );
        const after = auditProductLifeDatabase(database, character.id);
        const result = {
          turn,
          phase: planned.phase,
          day: planned.day,
          atUtc: clock.nowUtc(),
          response,
          before,
          after,
        };
        await json(`turn-${String(turn).padStart(2, "0")}.json`, result);
        if (response.decision.reasonCode === "persona_chat_fallback")
          throw new Error(`turn_${turn}_persisted_model_fallback`);
        journal.completedTurns = turn;
        return result;
      });
      history.push(
        { role: "user", content: evidence.response.userMessage.content },
        {
          role: "assistant",
          content: evidence.response.assistantMessage.content,
        },
      );
      turns.push(evidence);
      await json("turns.json", turns);
      await writeFile(
        join(directory, "conversation.md"),
        `# 45个模拟日的双模型对话\n\nQwen：林舟；GLM：顾澜。场景引导见plan.json，公开书信单独标明。\n\n${history.map((message) => `**${message.role === "user" ? "林舟" : "顾澜"}${message.channel ? ` · ${message.channel}` : ""}**\n\n${message.content}\n`).join("\n")}\n`,
      );
      if (turn === 1) {
        await step("message-idempotence", async () => {
          const response = SendMessageResponseSchema.parse(
            await http("POST", `/api/sessions/${sessionId}/messages`, {
              agentId: character.id,
              clientMessageId: "product-life-turn-1",
              text: user.text,
            }),
          );
          return {
            passed:
              response.idempotentReplay &&
              response.assistantMessage.id ===
                evidence.response.assistantMessage.id,
            response,
          };
        });
      }
      options.onProgress?.(
        `Turn ${turn}/42; day ${planned.day}; ${planned.phase}; character attempts ${characterMetrics.length}`,
      );
      if (index % 7 === 6) {
        if (phaseIndex === 2) {
          const letter = await step("user-letter", () =>
            generate(
              LetterSchema,
              "你将有几天不来聊天。写一封真实具体的信，回应此前顾澜公开说过的生活近况，讲清你自己已经做出的选择以及尚未发生的事，不预演回信。可以写一点对关系的感受，不要求制造纪念品。",
              "simulate_product_life_letter",
            ),
          );
          const sent = await feature("letter-dispatch", () =>
            dispatchProductLifeLetter(app, character.id, {
              requestId: "product-life-letter-1",
              ...letter,
            }),
          );
          letterId = sent.letterId;
        }
        await step(`phase-${phaseIndex}-end`, async () => {
          const overview = await http(
            "GET",
            `/api/agents/${character.id}/overview`,
          );
          const timeline = await http(
            "GET",
            `/api/agents/${character.id}/timeline?limit=500`,
          );
          const memories = await http(
            "GET",
            `/api/agents/${character.id}/memories`,
          );
          const audit = auditProductLifeDatabase(database, character.id);
          await json(`phase-${phaseIndex}-end.json`, {
            overview,
            timeline,
            memories,
            audit,
          });
          await database.backup(
            join(directory, `checkpoint-phase-${phaseIndex}.sqlite`),
          );
          return { captured: true };
        });
      }
    }
    await feature("final-artifacts", () =>
      inspectProductLifeArtifacts(app, character.id, {
        ...(replyLetterId ? { letterId: replyLetterId } : {}),
        recapFromUtc: START,
      }),
    );
    await json(
      "final-audit.json",
      auditProductLifeDatabase(database, character.id),
    );
    await step("control-final", async () => {
      await close();
      let before!: ReturnType<typeof auditProductLifeDatabase>;
      await open(join(directory, "control.sqlite"), (openedDatabase) => {
        before = auditProductLifeDatabase(openedDatabase, character.id);
      });
      const afterStartup = auditProductLifeDatabase(database, character.id);
      const overview = await http(
        "POST",
        `/api/agents/${character.id}/activate`,
        {},
      );
      const after = auditProductLifeDatabase(database, character.id);
      await http("POST", `/api/agents/${character.id}/activate`, {});
      const repeated = auditProductLifeDatabase(database, character.id);
      await json("control-final.json", {
        before,
        afterStartup,
        overview,
        after,
        repeated,
      });
      return { captured: true };
    });
    journal.status = "completed";
  } catch (error) {
    journal.status = "failed";
    journal.error = String(
      safe(error instanceof Error ? error.message : String(error)),
    );
    options.onProgress?.(`Stopped at ${activeStep}: ${journal.error}`);
  } finally {
    await close();
    await save();
  }
  return journal;
}

class FixtureProductLifeUser extends FixtureSimulationUser {
  override generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
    if (input.purpose === "simulate_product_life_letter")
      return Promise.resolve(
        input.schema.parse({
          subject: "离开几天前",
          body: "顾澜，这几天我会忙自己的事。谢谢你愿意听我说，等回来再聊各自的生活。",
        }),
      );
    return super.generateObject(input);
  }
}

export async function productLifeLongRunMain(
  args = process.argv.slice(2),
): Promise<void> {
  const [command, runId] = args;
  if (
    !["run", "resume", "fixture"].includes(command ?? "") ||
    !runId ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u.test(runId) ||
    args.length !== 2
  )
    throw new Error(
      "Usage: product-life-long-run.ts run|resume|fixture RUN_ID",
    );
  if (command !== "fixture") assertPaidDualModelEnabled();
  const userMetrics: LlmCallMetric[] = [];
  const base = readConfig();
  const userConfig =
    command === "fixture" ? undefined : readLlmProfileConfig("qwen");
  const characterConfig: ServerConfig["llm"] =
    command === "fixture"
      ? {
          provider: "fixture",
          baseUrl: "https://fixture.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 5000,
          maxRetries: 0,
        }
      : readLlmProfileConfig("bigmodel");
  if (command !== "fixture" && (!userConfig?.apiKey || !characterConfig.apiKey))
    throw new Error(
      "Qwen and BigModel named-profile credentials are required.",
    );
  const userProvider = userConfig
    ? createOpenAiCompatibleLlmProvider({
        ...userConfig,
        apiKey: userConfig.apiKey!,
        onMetric: (metric) => userMetrics.push(metric),
      })
    : new FixtureProductLifeUser();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const runDirectory = join(root, "tmp", "product-life-long-run", runId);
  console.log(`Artifacts: ${runDirectory}`);
  const result = await runProductLifeLongRun({
    runDirectory,
    config: { ...base, llm: characterConfig },
    userProvider,
    userMetrics,
    explicitSecrets: [userConfig?.apiKey ?? ""],
    resume: command === "resume",
    onProgress: console.log,
  });
  console.log(
    `${result.status}: ${result.completedTurns}/42 turns. Content evaluation is recorded separately.`,
  );
  if (result.status !== "completed") process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await productLifeLongRunMain();
