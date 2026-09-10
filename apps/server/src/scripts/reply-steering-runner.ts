import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  REPLY_STEERING_REMOVED_FIELDS,
  type ReplySteeringMode,
} from "@personasim/features";
import type { LlmCallMetric } from "@personasim/providers";
import { buildApp } from "../app.js";
import {
  readConfig,
  readLlmProfileConfig,
  type ServerConfig,
} from "../config.js";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { LifeRepository } from "../repositories/life-repository.js";
import { FakeClock } from "../runtime/clock.js";
import { FuzzyLifeService } from "../services/fuzzy-life-service.js";
import type { LlmLogicalCallEvent } from "../services/llm-service.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";
import {
  buildGuLanV3InitialState,
  LONG_RUN_V3_AGENT_ID,
  LONG_RUN_V3_START_UTC,
} from "./companion-long-run-v3-baseline.js";
import { createContinuityMeteredFetch } from "./continuity-metered-fetch.js";
import {
  captureContinuityRunIdentity,
  CONTINUITY_WORKSPACE_ROOT,
} from "./continuity-run-identity.js";
import {
  buildReplySteeringCharacter,
  REPLY_STEERING_COMMON_SCENARIO_IDS,
  REPLY_STEERING_PERSONAS,
  REPLY_STEERING_SCENARIOS,
  type ReplySteeringPersonaId,
  type ReplySteeringScenario,
} from "./reply-steering-scenarios.js";
import {
  buildBlindReview,
  renderReplySteeringReport,
  type ReplySteeringResult,
} from "./reply-steering-report.js";

export const STEERING_FIELDS = REPLY_STEERING_REMOVED_FIELDS.no_length_steering;
const SESSION = "session_reply_steering";
const AT = LONG_RUN_V3_START_UTC;
export const DEFAULT_STEERING_MODES: readonly ReplySteeringMode[] = [
  "current",
  "no_length_steering",
];

export function resolveSteeringModes(
  modes: readonly string[] = DEFAULT_STEERING_MODES,
): ReplySteeringMode[] {
  if (
    modes.length < 2 ||
    !modes.includes("current") ||
    new Set(modes).size !== modes.length ||
    modes.some((mode) => !Object.hasOwn(REPLY_STEERING_REMOVED_FIELDS, mode))
  )
    throw new Error(
      `Use current and at least one distinct ablation from: ${Object.keys(REPLY_STEERING_REMOVED_FIELDS).join(",")}`,
    );
  return [...modes] as ReplySteeringMode[];
}
export const PROFILE_MODELS = {
  deepseek: "deepseek-v4-flash",
  bigmodel: "glm-5.3-flash",
  qwen: "qwen3.8-flash",
  claude: "claude-opus-4-6",
  "gpt6-astra": "gpt-6-astra",
} as const;
export type SteeringProfile = keyof typeof PROFILE_MODELS;
export interface ReplySteeringRunOptions {
  output: string;
  profiles: SteeringProfile[];
  modes?: ReplySteeringMode[];
  fixture?: boolean;
  commonOnly?: boolean;
  repeats?: number;
  personas?: ReplySteeringPersonaId[];
  scenarioIds?: string[];
  maxPhysicalRequests?: number;
  maxReservedTokenUnits?: number;
  onProgress?: (message: string) => void;
}
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function steeringModeOrder(
  modes: readonly ReplySteeringMode[],
  pairingKey: string,
): ReplySteeringMode[] {
  // Preserve historical two-arm ordering. With more arms, reversal alone
  // would keep the middle mode in the same position for every candidate set.
  if (modes.length === 2)
    return parseInt(hash(pairingKey).slice(0, 2), 16) % 2
      ? [...modes].reverse()
      : [...modes];
  return [...modes].sort((left, right) =>
    hash(`${pairingKey}/${left}`).localeCompare(hash(`${pairingKey}/${right}`)),
  );
}

/** Evidence contains visible outputs and usage, never hidden reasoning text. */
export function visibleEvidence(value: unknown): unknown {
  if (typeof value === "string") {
    // Structured provider content is sometimes nested inside a JSON string.
    if (["[", "{"].includes(value.trimStart()[0] ?? "")) {
      try {
        const parsed: unknown = JSON.parse(value);
        const projected = visibleEvidence(parsed);
        if (JSON.stringify(parsed) !== JSON.stringify(projected))
          return JSON.stringify(projected);
      } catch {
        /* Plain visible text is preserved byte-for-byte. */
      }
    }
    return value.replace(
      /<(?:think|thinking)>[\s\S]*?(?:<\/(?:think|thinking)>|$)/giu,
      "[omitted:hidden_reasoning]",
    );
  }
  if (Array.isArray(value)) return value.map(visibleEvidence);
  if (value === null || typeof value !== "object") return value;
  if (
    "type" in value &&
    typeof value.type === "string" &&
    /^(reasoning|reasoning_text|thinking|redacted_thinking|analysis)$/iu.test(
      value.type,
    )
  )
    return { type: value.type, omitted: true };
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/^(reasoning_content|reasoning_text|reasoning|thinking|signature|analysis|encrypted_content)$/iu.test(
            key,
          ),
      )
      .map(([key, nested]) => [key, visibleEvidence(nested)]),
  );
}

function admittedStrategy(prompt: string) {
  const lines = prompt.split("\n");
  const index = lines.indexOf("REPLY_STRATEGY_JSON");
  if (
    index < 0 ||
    !lines[index + 1] ||
    lines.lastIndexOf("REPLY_STRATEGY_JSON") !== index
  )
    throw new Error("Missing or ambiguous admitted reply strategy");
  const strategy = JSON.parse(lines[index + 1]!) as Record<string, unknown>;
  if (
    strategy === null ||
    typeof strategy !== "object" ||
    Array.isArray(strategy)
  )
    throw new Error("Invalid admitted reply strategy");
  return { lines, index, strategy };
}

export function withoutSteeringFields(
  prompt: string,
  mode: ReplySteeringMode,
): string {
  const { lines, index, strategy } = admittedStrategy(prompt);
  for (const field of REPLY_STEERING_REMOVED_FIELDS[mode])
    delete strategy[field];
  lines[index + 1] = JSON.stringify(strategy);
  return lines.join("\n");
}

/** Historical combined projection, retained for old artifact consumers. */
export function withoutLengthSteering(prompt: string): string {
  return withoutSteeringFields(prompt, "no_length_steering");
}

export function assertPromptPair(
  current: { system: string; prompt: string; maxOutputTokens?: number | null },
  experimental: {
    system: string;
    prompt: string;
    maxOutputTokens?: number | null;
  },
  mode: ReplySteeringMode = "no_length_steering",
): void {
  const { strategy } = admittedStrategy(current.prompt);
  if (!STEERING_FIELDS.every((field) => Object.hasOwn(strategy, field)))
    throw new Error("Baseline missing targeted steering fields");
  if (
    current.system !== experimental.system ||
    withoutSteeringFields(current.prompt, mode) !== experimental.prompt
  )
    throw new Error(
      `Prompt pair differs outside approved fields for ${mode}: ${REPLY_STEERING_REMOVED_FIELDS[mode].join(", ")}`,
    );
  if (
    (current.maxOutputTokens ?? null) !== (experimental.maxOutputTokens ?? null)
  )
    throw new Error("Output budgets differ");
}

export function resolveSteeringProfile(
  profile: SteeringProfile,
): ServerConfig["llm"] {
  let config: ServerConfig["llm"];
  if (profile === "deepseek") {
    const active = process.env.LLM_ACTIVE_PROFILE;
    try {
      process.env.LLM_ACTIVE_PROFILE = "";
      config = { ...readConfig().llm, provider: "openai-compatible" };
    } finally {
      if (active === undefined) delete process.env.LLM_ACTIVE_PROFILE;
      else process.env.LLM_ACTIVE_PROFILE = active;
    }
  } else
    config = readLlmProfileConfig(
      profile === "gpt6-astra" ? "gpt56-sol" : profile,
    );
  // Match the user's requested models, not a potentially drifted local alias.
  return { ...config, model: PROFILE_MODELS[profile], profileName: profile };
}

export function evaluationConfig(
  base: ServerConfig,
  llm: ServerConfig["llm"],
  directory: string,
): ServerConfig {
  // Resolve the deployment once. Preflight and real turns must never re-read
  // process.env after the manifest has frozen the evaluation policy.
  return {
    ...structuredClone(base),
    llm,
    nodeEnv: "test",
    profile: "reply-steering-eval-v1",
    databasePath: join(directory, "turn.sqlite"),
    host: "127.0.0.1",
    seedDemo: false,
    serveWeb: false,
    selfHostedReverseProxy: false,
    clockMode: "fake",
    fakeClockStart: AT,
    chatEffectsMode: "gated",
    lifePlanningMode: "fuzzy",
    liveWorldEffectsMode: "enforced",
    scheduleNegotiationMode: "off",
    selfInitiatedPlanningMode: "off",
    memoryRecallMode: "enforced",
    companionContextMode: "enforced",
    personaRuntimeMode: "enforced",
    autobiographyMode: "off",
    correspondenceMode: "off",
    keepsakeMode: "off",
    assetStoragePath: join(directory, "assets"),
  };
}

export function createSteeringSnapshot(
  path: string,
  persona: ReplySteeringPersonaId,
  scenario: ReplySteeringScenario,
): string {
  if (existsSync(path)) throw new Error("Snapshot must be new");
  const database = openDatabase(path);
  try {
    runMigrations(database);
    const store = new DatabaseStore(database);
    const spec = buildReplySteeringCharacter(persona);
    store.insertCharacter(spec);
    store.insertInitialState(buildGuLanV3InitialState(spec), AT);
    database
      .prepare(
        "INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc) VALUES (?, ?, ?, ?, ?)",
      )
      .run(SESSION, LONG_RUN_V3_AGENT_ID, scenario.title, AT, AT);
    scenario.history.forEach((message, index) =>
      store.insertMessage({
        id: `history_${index}`,
        sessionId: SESSION,
        agentId: LONG_RUN_V3_AGENT_ID,
        role: message.role,
        content: message.content,
        messageKind: message.role === "user" ? "user" : "assistant_reply",
        metadata: {},
        createdAtUtc: new Date(
          Date.parse(AT) - (scenario.history.length - index) * 60_000,
        ).toISOString(),
      }),
    );
    new FuzzyLifeService(
      store,
      new LifeRepository(database),
      new FakeClock(AT),
    ).ensureToday(LONG_RUN_V3_AGENT_ID, AT);
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.pragma("journal_mode = DELETE");
  } finally {
    database.close();
  }
  return hash(readFileSync(path));
}

export async function executeSteeringTurn(input: {
  directory: string;
  snapshot: string;
  snapshotHash: string;
  config: ServerConfig;
  mode: ReplySteeringMode;
  scenario: ReplySteeringScenario;
  transport: typeof fetch;
  expectedPrompt?: {
    system: string;
    prompt: string;
    maxOutputTokens?: number | null;
  };
  onLogicalCall?: (event: LlmLogicalCallEvent) => void;
}): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
  events: LlmLogicalCallEvent[];
  metrics: LlmCallMetric[];
  elapsedMs: number;
}> {
  const databaseRelative = relative(
    resolve(input.directory),
    resolve(input.config.databasePath),
  );
  if (
    !databaseRelative ||
    databaseRelative.startsWith("..") ||
    isAbsolute(databaseRelative) ||
    resolve(input.snapshot) === resolve(input.config.databasePath) ||
    existsSync(input.config.databasePath)
  )
    throw new Error(
      "Turn database must be a fresh file inside its isolated directory",
    );
  mkdirSync(input.directory);
  if (hash(readFileSync(input.snapshot)) !== input.snapshotHash)
    throw new Error("Baseline snapshot changed");
  copyFileSync(input.snapshot, input.config.databasePath);
  const events: LlmLogicalCallEvent[] = [];
  const metrics: LlmCallMetric[] = [];
  let active: Extract<LlmLogicalCallEvent, { stage: "started" }> | undefined;
  let promptMismatch = false;
  let mainPromptVerified = false;
  const app = await buildApp({
    config: input.config,
    clock: new FakeClock(AT),
    logger: false,
    seedDemo: false,
    startScheduler: false,
    replySteeringMode: input.mode,
    llmObservation: {
      promptDiagnostics: true,
      onLogicalCall: (event) => {
        events.push(event);
        if (event.stage === "started") active = event;
        input.onLogicalCall?.(event);
      },
      onMetric: (metric) => metrics.push(metric),
      fetch: async (url, init) => {
        if (input.expectedPrompt) {
          const mainMatches =
            active?.purpose === "chat_turn" &&
            active.system === input.expectedPrompt.system &&
            active.prompt === input.expectedPrompt.prompt &&
            (input.expectedPrompt.maxOutputTokens === undefined ||
              (active.maxOutputTokens ?? null) ===
                input.expectedPrompt.maxOutputTokens);
          const allowedRepair =
            mainPromptVerified && active?.purpose === "repair_chat_turn";
          if (promptMismatch || (!mainMatches && !allowedRepair)) {
            promptMismatch = true;
            throw new Error(
              "Actual prompt drifted from preflight; paid request blocked",
            );
          }
          if (mainMatches) mainPromptVerified = true;
        }
        return input.transport(url, init);
      },
    },
  });
  const start = performance.now();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION}/messages`,
      payload: {
        agentId: LONG_RUN_V3_AGENT_ID,
        clientMessageId: `eval_${input.scenario.id}`,
        text: input.scenario.userText,
      },
    });
    if (promptMismatch) throw new Error("Actual prompt drifted from preflight");
    return {
      statusCode: response.statusCode,
      body: response.json(),
      events,
      metrics,
      elapsedMs: Math.round(performance.now() - start),
    };
  } catch (error) {
    throw new SteeringTurnExecutionError(
      error instanceof Error ? error.message : String(error),
      { events, metrics, elapsedMs: Math.round(performance.now() - start) },
    );
  } finally {
    await app.close();
  }
}

export class SteeringTurnExecutionError extends Error {
  constructor(
    message: string,
    readonly evidence: {
      events: LlmLogicalCallEvent[];
      metrics: LlmCallMetric[];
      elapsedMs: number;
    },
  ) {
    super(message);
    this.name = "SteeringTurnExecutionError";
  }
}

export function readSteeringAttempts(
  ledgerPath: string,
  id: string,
): Record<string, unknown>[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => (row.context as { id?: string } | undefined)?.id === id);
}

/** Reservations count dispatches; locally rejected retries are not network calls. */
export function steeringAttemptAccounting(
  rows: readonly Record<string, unknown>[],
) {
  const reserved = rows.filter((row) => row.stage === "reserved");
  const responses = rows.filter((row) => row.stage === "responded");
  const perCall = new Map<unknown, number>();
  for (const row of reserved) {
    const call = (row.context as { logicalCallIndex?: number } | undefined)
      ?.logicalCallIndex;
    // Missing grouping information must not invent retries.
    const key = call ?? Symbol();
    perCall.set(key, (perCall.get(key) ?? 0) + 1);
  }
  const usage = reserved.map((reservation) => {
    const body = responses.find(
      (row) => row.attempt === reservation.attempt,
    )?.usage;
    if (body === null || typeof body !== "object") return undefined;
    const record = body as Record<string, unknown>;
    const inputTokens = record.prompt_tokens ?? record.input_tokens;
    const outputTokens = record.completion_tokens ?? record.output_tokens;
    if (
      typeof inputTokens !== "number" ||
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      typeof outputTokens !== "number" ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0
    )
      return undefined;
    return { inputTokens, outputTokens };
  });
  const usageComplete =
    reserved.length > 0 && usage.every((item) => item !== undefined);
  const rawVisibleReplies = responses
    .filter(
      (row) =>
        (row.context as { purpose?: string } | undefined)?.purpose ===
        "chat_turn",
    )
    .flatMap((row) => {
      const response = row.response as { choices?: unknown } | null | undefined;
      if (!Array.isArray(response?.choices)) return [];
      return response.choices.flatMap((choice: unknown) => {
        if (
          choice === null ||
          typeof choice !== "object" ||
          !("message" in choice)
        )
          return [];
        const message = choice.message;
        if (
          message === null ||
          typeof message !== "object" ||
          !("content" in message)
        )
          return [];
        const content = message.content;
        if (Array.isArray(content))
          return content.flatMap((block: unknown) =>
            block !== null &&
            typeof block === "object" &&
            "text" in block &&
            typeof block.text === "string"
              ? [block.text]
              : [],
          );
        if (typeof content !== "string") return [];
        try {
          const parsed = JSON.parse(content) as {
            replyDecision?: { text?: unknown };
            reply?: { text?: unknown };
            text?: unknown;
          };
          const text =
            parsed.replyDecision?.text ?? parsed.reply?.text ?? parsed.text;
          if (typeof text === "string") return [text];
        } catch {
          /* Keep visible text even when the provider schema rejected it. */
        }
        return [content];
      });
    });
  return {
    physicalRequests: reserved.length,
    retries: [...perCall.values()].reduce(
      (total, count) => total + count - 1,
      0,
    ),
    rawVisibleReplies,
    usageComplete,
    inputTokens: usageComplete
      ? usage.reduce((total, item) => total + item.inputTokens, 0)
      : null,
    outputTokens: usageComplete
      ? usage.reduce((total, item) => total + item.outputTokens, 0)
      : null,
  };
}

const fixtureResponse = () =>
  Response.json({
    model: "offline-contract-fixture",
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify({
            replyDecision: {
              text: "嗯，我在听。",
              deliveryMode: "single_block",
            },
            worldEffects: {},
          }),
        },
        finish_reason: "stop",
      },
    ],
  });
const mainPrompt = (events: LlmLogicalCallEvent[]) => {
  const found = events.find(
    (event): event is Extract<LlmLogicalCallEvent, { stage: "started" }> =>
      event.stage === "started" && event.purpose === "chat_turn",
  );
  if (!found)
    throw new Error("Scenario did not use the normal main generation path");
  return {
    system: found.system,
    prompt: found.prompt,
    maxOutputTokens: found.maxOutputTokens ?? null,
  };
};

export async function runReplySteering(
  options: ReplySteeringRunOptions,
): Promise<ReplySteeringResult[]> {
  if (!options.fixture && process.env.RUN_PAID_REPLY_STEERING !== "1")
    throw new Error("Paid evaluation requires RUN_PAID_REPLY_STEERING=1");
  const directory = resolve(options.output);
  const inside = relative(CONTINUITY_WORKSPACE_ROOT, directory);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Use a fresh ignored directory inside the workspace");
  execFileSync(
    "git",
    ["check-ignore", "--quiet", "--", join(directory, "manifest.json")],
    { windowsHide: true },
  );
  if (existsSync(directory))
    throw new Error("Never overwrite or silently resample an existing run");
  if (
    !options.profiles.length ||
    new Set(options.profiles).size !== options.profiles.length ||
    options.profiles.some((profile) => !Object.hasOwn(PROFILE_MODELS, profile))
  )
    throw new Error("Invalid profiles");
  const modes = resolveSteeringModes(options.modes);
  const personas =
    options.personas ?? REPLY_STEERING_PERSONAS.map((persona) => persona.id);
  if (
    !personas.length ||
    new Set(personas).size !== personas.length ||
    personas.some(
      (id) => !REPLY_STEERING_PERSONAS.some((persona) => persona.id === id),
    )
  )
    throw new Error("Invalid personas");
  const repeats = options.repeats ?? 2;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 2)
    throw new Error("Use 1 or 2 repeats");
  if (
    options.scenarioIds?.some(
      (id) => !REPLY_STEERING_SCENARIOS.some((scenario) => scenario.id === id),
    )
  )
    throw new Error("Unknown scenario");
  const baseDeploymentConfig = readConfig();
  const configs = new Map(
    options.profiles.map((profile) => [
      profile,
      options.fixture
        ? {
            provider: "openai-compatible" as const,
            profileName: profile,
            model: PROFILE_MODELS[profile],
            baseUrl: "https://fixture.invalid",
            apiKey: "fixture-only",
            timeoutMs: 1_000,
            maxRetries: 0,
            maxOutputTokens: 32768,
            capabilities: {
              structuredOutputMode: "json_object" as const,
              supportsThinkingControl: false,
              supportsStreaming: false,
              maxContextTokens: 131072,
              maxOutputTokens: 32768,
            },
          }
        : resolveSteeringProfile(profile),
    ]),
  );
  if ([...configs.values()].some((config) => !config.apiKey))
    throw new Error("Missing configured credential");
  const effectiveEvaluationConfigs = new Map(
    [...configs].map(([profile, llm]) => [
      profile,
      evaluationConfig(baseDeploymentConfig, llm, directory),
    ]),
  );
  const turnConfig = (
    profile: SteeringProfile,
    runDir: string,
    preflight = false,
  ): ServerConfig => {
    const frozen = structuredClone(effectiveEvaluationConfigs.get(profile)!);
    return {
      ...frozen,
      databasePath: join(runDir, "turn.sqlite"),
      assetStoragePath: join(runDir, "assets"),
      llm: preflight
        ? { ...frozen.llm, apiKey: "fixture-only", maxRetries: 0 }
        : frozen.llm,
    };
  };
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(directory, "snapshots"));
  const secrets = [
    baseDeploymentConfig.llm.apiKey ?? "",
    baseDeploymentConfig.instanceSecret ?? "",
    ...[...configs.values()].map((config) => config.apiKey ?? ""),
  ];
  const safe = (value: unknown) =>
    redactLongRunArtifact(visibleEvidence(value), secrets);
  const save = (name: string, value: unknown) =>
    writeFileSync(
      join(directory, name),
      `${JSON.stringify(safe(value), null, 2)}\n`,
    );
  const budget = {
    maxPhysicalRequests: options.maxPhysicalRequests ?? 900,
    maxReservedTokenUnits: options.maxReservedTokenUnits ?? 120_000_000,
  };
  save(
    "manifest.json",
    await captureContinuityRunIdentity({
      config: effectiveEvaluationConfigs.get(options.profiles[0]!)!,
      explicitSecrets: secrets,
      experiment: {
        kind: "reply_steering_ablation_model_personality_matrix",
        options: { ...options, modes },
        modeRemovedFields: Object.fromEntries(
          modes.map((mode) => [mode, REPLY_STEERING_REMOVED_FIELDS[mode]]),
        ),
        baseDeploymentConfig,
        effectiveEvaluationConfigs: Object.fromEntries(
          effectiveEvaluationConfigs,
        ),
        configPolicy:
          "Deployment settings are captured once before evaluation overrides. Effective configs are frozen for the whole run; each isolated turn only replaces database/assets paths, and offline preflight substitutes a fixture credential and disables retries. No config is re-read during turns.",
        budget,
        modelConfigs: Object.fromEntries(configs),
        scenarios: REPLY_STEERING_SCENARIOS,
        personas: personas.map((id) => ({
          id,
          spec: buildReplySteeringCharacter(id),
        })),
        repairPolicy:
          "Production repair is unchanged across arms; each mode removes only its declared main-prompt fields. The legacy no_length_steering arm combines length, chunk-count and delivery interventions.",
        interpretation:
          "Synthetic screening only; model identity is provider-reported; profile settings differ across models; no automatic quality ranking.",
      },
    }),
  );
  const results: ReplySteeringResult[] = [];
  const snapshots = new Map<string, { path: string; hash: string }>();
  for (const persona of personas)
    for (const scenario of REPLY_STEERING_SCENARIOS) {
      const path = join(
        directory,
        "snapshots",
        `${persona}_${scenario.id}.sqlite`,
      );
      snapshots.set(`${persona}_${scenario.id}`, {
        path,
        hash: createSteeringSnapshot(path, persona, scenario),
      });
    }
  save("snapshots.json", Object.fromEntries(snapshots));
  const writeReports = () => {
    save("results.json", results);
    const reportResults = safe(results) as ReplySteeringResult[];
    writeFileSync(
      join(directory, "comparison.md"),
      renderReplySteeringReport(reportResults),
    );
    const blind = buildBlindReview(reportResults, "reply-steering-20260908");
    writeFileSync(join(directory, "blind-review.md"), blind.markdown);
    save("blind-key.json", blind.key);
  };
  // Profiles run concurrently; each profile stays sequential to avoid burst limits.
  await Promise.all(
    options.profiles.map(async (profile) => {
      const llm = configs.get(profile)!;
      const shortProfile = profile === "claude";
      for (const persona of personas) {
        const short =
          options.commonOnly || shortProfile || persona !== "warm-observant";
        const scenarios = REPLY_STEERING_SCENARIOS.filter(
          (scenario) =>
            (!short ||
              new Set<string>(REPLY_STEERING_COMMON_SCENARIO_IDS).has(
                scenario.id,
              )) &&
            (!options.scenarioIds || options.scenarioIds.includes(scenario.id)),
        );
        for (const scenario of scenarios) {
          const snapshot = snapshots.get(`${persona}_${scenario.id}`)!;
          const preflight: Record<string, ReturnType<typeof mainPrompt>> = {};
          for (const mode of modes) {
            const runDir = join(
              directory,
              `${profile}_${persona}_${scenario.id}_preflight_${mode}`,
            );
            const config = turnConfig(profile, runDir, true);
            const run = await executeSteeringTurn({
              directory: runDir,
              snapshot: snapshot.path,
              snapshotHash: snapshot.hash,
              config,
              mode,
              scenario,
              transport: () => Promise.resolve(fixtureResponse()),
            });
            if (run.statusCode !== 201)
              throw new Error(
                `Offline preflight route failed: ${run.statusCode}`,
              );
            preflight[mode] = mainPrompt(run.events);
          }
          const proofs = modes
            .filter((mode) => mode !== "current")
            .map((mode) => {
              assertPromptPair(preflight.current!, preflight[mode]!, mode);
              return {
                baseline: "current",
                mode,
                removedFields: REPLY_STEERING_REMOVED_FIELDS[mode],
                nonTargetPromptSha256: hash(
                  preflight.current!.system +
                    withoutSteeringFields(preflight.current!.prompt, mode),
                ),
                outputCap: preflight[mode]!.maxOutputTokens,
              };
            });
          save(`${profile}_${persona}_${scenario.id}_prompt-pair.json`, {
            snapshotHash: snapshot.hash,
            ...preflight,
            modes,
            proofs,
            proof:
              "Each ablation is compared with current: exact system and non-target prompt equality, only declared fields omitted, identical output cap",
          });
          for (let repeat = 1; repeat <= (short ? 1 : repeats); repeat++) {
            const orderedModes = steeringModeOrder(
              modes,
              `${profile}/${persona}/${scenario.id}/${repeat}`,
            );
            for (const mode of orderedModes) {
              const id = `${profile}_${persona}_${scenario.id}_r${repeat}_${mode}`;
              const runDir = join(directory, id);
              const config = turnConfig(profile, runDir);
              let activeCall:
                Extract<LlmLogicalCallEvent, { stage: "started" }> | undefined;
              const ledgerPath = join(directory, "attempts.jsonl");
              const transport = createContinuityMeteredFetch({
                ledgerPath,
                budget,
                secrets,
                context: () => ({
                  id,
                  profile,
                  persona,
                  scenarioId: scenario.id,
                  repeat,
                  mode,
                  logicalCallIndex: activeCall?.index,
                  purpose: activeCall?.purpose,
                }),
                projectResponse: visibleEvidence,
                ...(options.fixture
                  ? { fetch: () => Promise.resolve(fixtureResponse()) }
                  : {}),
              });
              let row: ReplySteeringResult;
              let runEvidence:
                | {
                    events: LlmLogicalCallEvent[];
                    metrics: LlmCallMetric[];
                    elapsedMs: number;
                  }
                | undefined;
              try {
                const run = await executeSteeringTurn({
                  directory: runDir,
                  snapshot: snapshot.path,
                  snapshotHash: snapshot.hash,
                  config,
                  mode,
                  scenario,
                  transport,
                  expectedPrompt: preflight[mode]!,
                  onLogicalCall: (event) => {
                    if (event.stage === "started") activeCall = event;
                  },
                });
                runEvidence = run;
                save(`${id}/turn.json`, run);
                const body = run.body as {
                  assistantMessage?: {
                    content: string;
                    metadata: Record<string, unknown>;
                  };
                  error?: unknown;
                };
                const started = run.events.filter(
                  (event) => event.stage === "started",
                );
                const accounting = steeringAttemptAccounting(
                  readSteeringAttempts(ledgerPath, id),
                );
                const metadata = body.assistantMessage?.metadata ?? {};
                const finalText = body.assistantMessage?.content ?? null;
                row = {
                  id,
                  profile,
                  model: llm.model,
                  personaId: persona,
                  scenarioId: scenario.id,
                  repeat,
                  mode,
                  success: run.statusCode === 201 && finalText !== null,
                  statusCode: run.statusCode,
                  finalText,
                  ...accounting,
                  elapsedMs: run.elapsedMs,
                  logicalCalls: started.length,
                  repairs: started.filter(
                    (event) => event.purpose === "repair_chat_turn",
                  ).length,
                  error:
                    run.statusCode === 201
                      ? null
                      : JSON.stringify(body.error ?? run.body),
                  promptSha256: hash(
                    preflight[mode]!.system + preflight[mode]!.prompt,
                  ),
                  nonTargetPromptSha256: hash(
                    preflight[mode]!.system +
                      withoutLengthSteering(preflight[mode]!.prompt),
                  ),
                  repairChanged:
                    accounting.rawVisibleReplies.length > 0 &&
                    accounting.rawVisibleReplies[0] !== finalText,
                  fallback: metadata.decisionPath === "fallback",
                };
              } catch (error) {
                const evidence =
                  error instanceof SteeringTurnExecutionError
                    ? error.evidence
                    : runEvidence;
                const started =
                  evidence?.events.filter(
                    (event) => event.stage === "started",
                  ) ?? [];
                const accounting = steeringAttemptAccounting(
                  readSteeringAttempts(ledgerPath, id),
                );
                save(`${id}/failure.json`, {
                  error: error instanceof Error ? error.message : String(error),
                  ...evidence,
                  accounting,
                });
                row = {
                  id,
                  profile,
                  model: llm.model,
                  personaId: persona,
                  scenarioId: scenario.id,
                  repeat,
                  mode,
                  success: false,
                  statusCode: 0,
                  finalText: null,
                  ...accounting,
                  elapsedMs: evidence?.elapsedMs ?? 0,
                  logicalCalls: started.length,
                  repairs: started.filter(
                    (event) => event.purpose === "repair_chat_turn",
                  ).length,
                  error: error instanceof Error ? error.message : String(error),
                  promptSha256: null,
                  nonTargetPromptSha256: null,
                  repairChanged: false,
                  fallback: false,
                };
              }
              results.push(row);
              appendFileSync(
                join(directory, "results.jsonl"),
                `${JSON.stringify(safe(row))}\n`,
              );
              writeReports();
              options.onProgress?.(
                `${results.length}: ${id} status=${row.statusCode} calls=${row.physicalRequests} repairs=${row.repairs} ms=${row.elapsedMs}`,
              );
            }
          }
        }
      }
    }),
  );
  writeReports();
  return results;
}
