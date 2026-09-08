import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  CharacterSpecSchema,
  OriginalCharacterInputSchema,
  type CharacterSpec,
  type OriginalCharacterInput,
} from "@personasim/contracts";
import type { LlmCallMetric } from "@personasim/providers";

import { buildApp } from "../app.js";
import { readConfig, type ServerConfig } from "../config.js";
import { FakeClock } from "../runtime/clock.js";
import type { LlmLogicalCallEvent } from "../services/llm-service.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";
import {
  buildGuLanV3CharacterInput,
  LONG_RUN_V3_START_UTC,
} from "./companion-long-run-v3-baseline.js";
import {
  createContinuityMeteredFetch,
  type ContinuityRequestBudget,
} from "./continuity-metered-fetch.js";
import {
  captureContinuityRunIdentity,
  CONTINUITY_WORKSPACE_ROOT,
} from "./continuity-run-identity.js";
import {
  readSteeringAttempts,
  resolveSteeringProfile,
  steeringAttemptAccounting,
  visibleEvidence,
} from "./reply-steering-runner.js";
import {
  REPLY_STEERING_PERSONAS,
  REPLY_STEERING_PERSONA_CONTEXT,
  type ReplySteeringPersonaId,
} from "./reply-steering-scenarios.js";

export const CHARACTER_GENERATION_COMPARISON_PROFILES = [
  "deepseek",
  "bigmodel",
  "qwen",
  "gpt6-astra",
] as const;
type GenerationProfile =
  (typeof CHARACTER_GENERATION_COMPARISON_PROFILES)[number];
const DEFAULT_BUDGET: ContinuityRequestBudget = {
  maxPhysicalRequests: 72,
  maxReservedTokenUnits: 10_000_000,
};

export interface CharacterGenerationComparisonOptions {
  output: string;
  fixture?: boolean;
  profiles?: readonly GenerationProfile[];
  personas?: readonly ReplySteeringPersonaId[];
  budget?: ContinuityRequestBudget;
  onProgress?: (message: string) => void;
}

export interface AuthorPreservationDiagnostics {
  /** Mechanical observations only; these are not semantic quality scores. */
  nameMatches: boolean;
  workMatches: boolean;
  timezoneMatches: boolean;
  dialogueAuthorGuidanceMatches: boolean;
  explicitTraitNamesPresent: boolean;
  sourceBriefPreserved: boolean;
  personaTraits: CharacterSpec["persona"]["traits"];
  values: CharacterSpec["persona"]["values"];
  biography: NonNullable<CharacterSpec["persona"]["biography"]>;
  sourceRefs: CharacterSpec["sources"];
  frequentPhrases: string[];
  sharedContext: string;
  hardBoundaryCount: number;
  hardDialogueRuleCount: number;
  semanticReview: "pending_manual_review";
}

export interface CharacterGenerationComparisonResult {
  id: string;
  profile: string;
  model: string;
  personaId: ReplySteeringPersonaId;
  inputSha256: string;
  generatedStatus: number | null;
  publishedStatus: number | null;
  generated: CharacterSpec | null;
  published: CharacterSpec | null;
  sources: unknown[];
  authorityReview: unknown;
  authorPreservation: AuthorPreservationDiagnostics | null;
  rawParsedProposal: unknown;
  rawVisibleResponses: unknown[];
  logicalCalls: number;
  physicalRequests: number;
  retries: number;
  inputTokens: number | null;
  outputTokens: number | null;
  usageComplete: boolean;
  elapsedMs: number;
  success: boolean;
  error: string | null;
}

/** Frozen author inputs shared across models; generated specs never seed reply A/B. */
export function buildCharacterGenerationComparisonInput(
  personaId: ReplySteeringPersonaId,
): OriginalCharacterInput {
  const persona = REPLY_STEERING_PERSONAS.find((item) => item.id === personaId);
  if (!persona) throw new Error(`Unknown persona: ${String(personaId)}`);
  const base = buildGuLanV3CharacterInput();
  return OriginalCharacterInputSchema.parse({
    ...base,
    name: persona.name,
    worldSetting: base.worldSetting.replaceAll("顾澜", persona.name),
    coreTraits: [...persona.traits],
    dialogueStyle: persona.description,
    characterBrief: [
      REPLY_STEERING_PERSONA_CONTEXT.replaceAll("顾澜", persona.name),
      persona.description,
      "性格通过具体处境下的措辞、选择与例外体现。日常交流与严肃分歧仍然是同一个人。",
    ].join("\n\n"),
  });
}

export function characterGenerationComparisonConfig(
  llm: ServerConfig["llm"],
  directory: string,
): ServerConfig {
  return readConfig({
    llm,
    nodeEnv: "test",
    profile: "character-generation-comparison-v1",
    databasePath: join(directory, "character.sqlite"),
    host: "127.0.0.1",
    seedDemo: false,
    serveWeb: false,
    selfHostedReverseProxy: false,
    developerRoutes: false,
    clockMode: "fake",
    fakeClockStart: LONG_RUN_V3_START_UTC,
    lifePlanningMode: "fuzzy",
    scheduleNegotiationMode: "off",
    selfInitiatedPlanningMode: "off",
    autobiographyMode: "off",
    correspondenceMode: "off",
    keepsakeMode: "off",
    assetStoragePath: join(directory, "assets"),
  });
}

export async function runCharacterGenerationCandidate(input: {
  directory: string;
  config: ServerConfig;
  profile: string;
  personaId: ReplySteeringPersonaId;
  ledgerPath: string;
  budget: ContinuityRequestBudget;
  /** Required injection prevents accidentally falling through to native transport. */
  transport: typeof fetch;
  secrets?: readonly string[];
}): Promise<CharacterGenerationComparisonResult> {
  const directory = resolve(input.directory);
  const databaseRelative = relative(
    directory,
    resolve(input.config.databasePath),
  );
  if (
    !databaseRelative ||
    databaseRelative.startsWith("..") ||
    isAbsolute(databaseRelative)
  ) {
    throw new Error(
      "Character database must be inside its isolated candidate directory",
    );
  }
  mkdirSync(directory); // Exclusive: never reuse or overwrite a candidate database.
  const authorInput = buildCharacterGenerationComparisonInput(input.personaId);
  const id = `${input.profile}_${input.personaId}`;
  const secrets = [
    input.config.llm.apiKey ?? "",
    input.config.instanceSecret ?? "",
    ...(input.secrets ?? []),
  ];
  const safe = (value: unknown) =>
    redactLongRunArtifact(visibleEvidence(value), secrets);
  const append = (file: string, value: unknown) =>
    appendFileSync(join(directory, file), `${JSON.stringify(safe(value))}\n`);
  const events: LlmLogicalCallEvent[] = [];
  const metrics: LlmCallMetric[] = [];
  let active: Extract<LlmLogicalCallEvent, { stage: "started" }> | undefined;
  const result: CharacterGenerationComparisonResult = {
    id,
    profile: input.profile,
    model: input.config.llm.model,
    personaId: input.personaId,
    inputSha256: createHash("sha256")
      .update(JSON.stringify(authorInput))
      .digest("hex"),
    generatedStatus: null,
    publishedStatus: null,
    generated: null,
    published: null,
    sources: [],
    authorityReview: null,
    authorPreservation: null,
    rawParsedProposal: null,
    rawVisibleResponses: [],
    logicalCalls: 0,
    physicalRequests: 0,
    retries: 0,
    inputTokens: null,
    outputTokens: null,
    usageComplete: false,
    elapsedMs: 0,
    success: false,
    error: null,
  };
  writeFileSync(
    join(directory, "author-input.json"),
    `${JSON.stringify(authorInput, null, 2)}\n`,
    { flag: "wx" },
  );
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const started = performance.now();
  try {
    const meteredTransport = createContinuityMeteredFetch({
      ledgerPath: input.ledgerPath,
      budget: input.budget,
      fetch: input.transport,
      secrets,
      projectResponse: visibleEvidence,
      context: () => ({
        id,
        profile: input.profile,
        personaId: input.personaId,
        purpose: active?.purpose,
        logicalCallIndex: active?.index,
      }),
    });
    app = await buildApp({
      config: input.config,
      clock: new FakeClock(LONG_RUN_V3_START_UTC),
      logger: false,
      seedDemo: false,
      startScheduler: false,
      llmObservation: {
        promptDiagnostics: true,
        onLogicalCall: (event) => {
          events.push(structuredClone(event));
          if (event.stage === "started") active = event;
          append("model-io.jsonl", event);
        },
        onMetric: (metric) => {
          metrics.push(metric);
          append("provider-metrics.jsonl", metric);
        },
        fetch: async (url, init) => {
          if (active?.purpose !== "compile_character") {
            throw new Error(
              `Unexpected model purpose: ${active?.purpose ?? "unknown"}`,
            );
          }
          return meteredTransport(url, init);
        },
      },
    });
    const http = async (
      method: "GET" | "POST",
      url: string,
      payload?: unknown,
    ) => {
      const response = await app!.inject({
        method,
        url,
        ...(payload === undefined
          ? {}
          : {
              payload: JSON.stringify(payload),
              headers: { "content-type": "application/json" },
            }),
      });
      const body: unknown = response.json();
      append("http.jsonl", {
        method,
        url,
        payload,
        status: response.statusCode,
        body,
      });
      return { status: response.statusCode, body: record(body) };
    };
    const generation = await http(
      "POST",
      "/api/characters/generate",
      authorInput,
    );
    result.generatedStatus = generation.status;
    const generated = CharacterSpecSchema.safeParse(generation.body.character);
    if (generation.status !== 201 || !generated.success) {
      result.error = `Generation failed: HTTP ${generation.status}; ${JSON.stringify(generation.body)}`;
    } else {
      result.generated = generated.data;
      const publication = await http(
        "POST",
        `/api/characters/${encodeURIComponent(generated.data.id)}/publish`,
        { expectedVersion: generated.data.version },
      );
      result.publishedStatus = publication.status;
      const published = CharacterSpecSchema.safeParse(
        publication.body.character,
      );
      if (publication.status !== 200 || !published.success) {
        result.error = `Publication failed: HTTP ${publication.status}; ${JSON.stringify(publication.body)}`;
      } else {
        result.published = published.data;
        const detail = await http(
          "GET",
          `/api/characters/${encodeURIComponent(published.data.id)}`,
        );
        result.sources = Array.isArray(detail.body.sources)
          ? detail.body.sources
          : [];
        result.authorityReview = detail.body.authorityReview ?? null;
        result.authorPreservation = authorPreservation(
          authorInput,
          published.data,
          result.sources,
        );
        result.success =
          detail.status === 200 && published.data.status === "published";
        if (!result.success)
          result.error = "Published character could not be read back";
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await app?.close();
    result.elapsedMs = Math.round(performance.now() - started);
    result.logicalCalls = events.filter(
      (event) => event.stage === "started",
    ).length;
    const completed = events.find(
      (event) =>
        event.stage === "completed" && event.purpose === "compile_character",
    );
    result.rawParsedProposal =
      completed?.stage === "completed"
        ? safe(completed.parsedOutput ?? null)
        : null;
    const attempts = readSteeringAttempts(input.ledgerPath, id);
    const accounting = steeringAttemptAccounting(attempts);
    result.physicalRequests = accounting.physicalRequests;
    result.retries = accounting.retries;
    result.inputTokens = accounting.inputTokens;
    result.outputTokens = accounting.outputTokens;
    result.usageComplete = accounting.usageComplete;
    result.rawVisibleResponses = attempts
      .filter((row) => row.stage === "responded")
      .map((row) => row.response);
    const safeResult = safe(result) as CharacterGenerationComparisonResult;
    writeFileSync(
      join(directory, "result.json"),
      `${JSON.stringify(safeResult, null, 2)}\n`,
    );
    writeFileSync(
      join(directory, "provider-metrics.json"),
      `${JSON.stringify(safe(metrics), null, 2)}\n`,
    );
  }
  return safe(result) as CharacterGenerationComparisonResult;
}

export async function runCharacterGenerationComparison(
  options: CharacterGenerationComparisonOptions,
): Promise<CharacterGenerationComparisonResult[]> {
  if (!options.fixture && process.env.RUN_PAID_REPLY_STEERING !== "1") {
    throw new Error(
      "Paid generation comparison requires RUN_PAID_REPLY_STEERING=1",
    );
  }
  const profiles = [
    ...(options.profiles ?? CHARACTER_GENERATION_COMPARISON_PROFILES),
  ];
  const personas = [
    ...(options.personas ??
      REPLY_STEERING_PERSONAS.map((persona) => persona.id)),
  ];
  if (
    profiles.length === 0 ||
    new Set(profiles).size !== profiles.length ||
    profiles.some(
      (profile) =>
        !(
          CHARACTER_GENERATION_COMPARISON_PROFILES as readonly string[]
        ).includes(profile),
    )
  ) {
    throw new Error("Choose unique supported generation profiles");
  }
  if (
    personas.length === 0 ||
    new Set(personas).size !== personas.length ||
    personas.some(
      (id) => !REPLY_STEERING_PERSONAS.some((persona) => persona.id === id),
    )
  ) {
    throw new Error("Choose unique supported personalities");
  }
  const directory = resolve(options.output);
  const inside = relative(CONTINUITY_WORKSPACE_ROOT, directory);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error(
      "Use a fresh ignored output directory inside the workspace",
    );
  execFileSync(
    "git",
    ["check-ignore", "--quiet", "--", join(directory, "manifest.json")],
    { cwd: CONTINUITY_WORKSPACE_ROOT, windowsHide: true },
  );
  const budget = { ...(options.budget ?? DEFAULT_BUDGET) };
  if (
    !Number.isSafeInteger(budget.maxPhysicalRequests) ||
    budget.maxPhysicalRequests <= 0 ||
    !Number.isSafeInteger(budget.maxReservedTokenUnits) ||
    budget.maxReservedTokenUnits <= 0
  ) {
    throw new Error("Generation comparison requires positive integer budgets");
  }
  const models = profiles.map((profile) => ({
    profile,
    llm: options.fixture
      ? {
          provider: "fixture" as const,
          baseUrl: "http://127.0.0.1:9",
          model: "offline-character-compilation-fixture",
          timeoutMs: 1_000,
          maxRetries: 0,
        }
      : resolveSteeringProfile(profile),
  }));
  const secrets = models.map((model) => model.llm.apiKey ?? "");
  const safe = (value: unknown) =>
    redactLongRunArtifact(visibleEvidence(value), secrets);
  const identities = await Promise.all(
    models.map(({ profile, llm }) =>
      captureContinuityRunIdentity({
        config: characterGenerationComparisonConfig(
          llm,
          join(directory, `${profile}_${personas[0]!}`),
        ),
        explicitSecrets: secrets,
        experiment: {
          kind: "independent-character-generation-comparison-v1",
          fixture: Boolean(options.fixture),
          budget,
          profile,
          personas,
          inputs: personas.map((id) => ({
            id,
            input: buildCharacterGenerationComparisonInput(id),
          })),
          replyAblationSnapshots: "not_used_or_modified",
          compilerPolicy: "unchanged_production_32000_output_cap_and_one_retry",
        },
      }),
    ),
  );
  mkdirSync(directory); // No resume or replacement path is supported.
  const save = (name: string, value: unknown) =>
    writeFileSync(
      join(directory, name),
      `${JSON.stringify(safe(value), null, 2)}\n`,
    );
  save("manifest.json", {
    schemaVersion: "character-generation-comparison-v1",
    fixture: Boolean(options.fixture),
    startedAtUtc: new Date().toISOString(),
    budget,
    expectedCandidates: profiles.length * personas.length,
    inputs: personas.map((id) => ({
      id,
      input: buildCharacterGenerationComparisonInput(id),
    })),
    identities,
  });
  const results: CharacterGenerationComparisonResult[] = [];
  const writeReport = () => {
    save("results.json", results);
    writeFileSync(
      join(directory, "comparison.md"),
      renderCharacterGenerationComparison(results),
    );
  };
  writeReport();
  await Promise.all(
    models.map(async ({ profile, llm }) => {
      for (const personaId of personas) {
        const candidateDirectory = join(directory, `${profile}_${personaId}`);
        const result = await runCharacterGenerationCandidate({
          directory: candidateDirectory,
          config: characterGenerationComparisonConfig(llm, candidateDirectory),
          profile,
          personaId,
          ledgerPath: join(directory, "attempts.jsonl"),
          budget,
          transport: options.fixture
            ? () =>
                Promise.reject(
                  new Error("Fixture generation must never dispatch HTTP"),
                )
            : globalThis.fetch,
          secrets,
        });
        results.push(result);
        results.sort((left, right) => left.id.localeCompare(right.id));
        writeReport();
        options.onProgress?.(
          `${profile}/${personaId}: ${result.success ? "generated+published" : "failed"}; ${result.physicalRequests} physical requests`,
        );
      }
    }),
  );
  return results;
}

export function renderCharacterGenerationComparison(
  results: readonly CharacterGenerationComparisonResult[],
): string {
  return [
    "# 独立角色生成比较",
    "",
    "使用相同三份合成作者输入，分别经过实际角色生成、发布、读取接口。生成结果保存在独立数据库；不会替换回复引导消融实验的固定角色快照。生产编译提示、输出上限与重试策略保持原样。",
    "",
    "| 模型配置 | 实际模型 | 性格 | 生成 HTTP | 发布 HTTP | 成功 | 逻辑调用 | 物理请求 | 重试 | 输入 token | 输出 token | 总耗时 ms |",
    "| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map(
      (row) =>
        `| ${row.profile} | ${row.model} | ${row.personaId} | ${row.generatedStatus ?? "未执行"} | ${row.publishedStatus ?? "未执行"} | ${row.success ? "是" : "否"} | ${row.logicalCalls} | ${row.physicalRequests} | ${row.retries} | ${row.inputTokens ?? "未知"} | ${row.outputTokens ?? "未知"} | ${row.elapsedMs} |`,
    ),
    "",
    "作者保留诊断是可检查的事实与字段观测，不是质量评分。每个候选的 result.json 同时保留原始解析提案、服务端生成规格、发布规格、来源、权限审查、具体 traits/values/biography 和硬规则数量，便于辨认模型输出与服务端保留规则的作用。",
    "",
    "语义审阅待完成：分别检查具体经历与事实是否保留、性格是否体现在有触发条件和例外的行为中、三种语气是否发生趋同、是否编造过去或已完成结果，以及生成内容是否被无依据地升级为硬限制。自然表达与信息完整优先，不把字段多、角色文本长或短当作优胜标准。",
    "",
    "fixture 结果仅验证工程流程，不代表这些模型的真实生成表现。缺失 token 保持未知，所有已分派物理请求（包括失败和重试）都进入共享预算账本。每种模型和性格仅一次生成属于小样本筛查，不能据此宣称稳定质量排名。",
    "",
  ].join("\n");
}

function authorPreservation(
  input: OriginalCharacterInput,
  spec: CharacterSpec,
  sources: unknown[],
): AuthorPreservationDiagnostics {
  return {
    nameMatches: spec.identity.name === input.name,
    workMatches: spec.identity.workOrRole === input.workOrRole,
    timezoneMatches: spec.identity.timezone === input.timezone,
    dialogueAuthorGuidanceMatches:
      spec.dialogue.authorGuidance === input.dialogueStyle,
    explicitTraitNamesPresent: input.coreTraits.every((name) =>
      spec.persona.traits.some((trait) => trait.name === name),
    ),
    sourceBriefPreserved: sources.some(
      (source) => record(source).contentExcerpt === input.characterBrief,
    ),
    personaTraits: spec.persona.traits,
    values: spec.persona.values,
    biography: spec.persona.biography ?? [],
    sourceRefs: spec.sources,
    frequentPhrases: spec.dialogue.frequentPhrases,
    sharedContext: spec.userRelationship.sharedContext,
    hardBoundaryCount: spec.persona.boundaries.filter(
      (boundary) => boundary.hard,
    ).length,
    hardDialogueRuleCount:
      spec.dialogue.rules?.filter((rule) => rule.enforcement === "hard")
        .length ?? 0,
    semanticReview: "pending_manual_review",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function characterGenerationComparisonMain(
  args = process.argv.slice(2),
): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      fixture: { type: "boolean", default: false },
      output: { type: "string" },
      profiles: {
        type: "string",
        default: CHARACTER_GENERATION_COMPARISON_PROFILES.join(","),
      },
      personas: { type: "string" },
      requests: {
        type: "string",
        default: String(DEFAULT_BUDGET.maxPhysicalRequests),
      },
      "token-units": {
        type: "string",
        default: String(DEFAULT_BUDGET.maxReservedTokenUnits),
      },
    },
  });
  if (!values.output)
    throw new Error(
      "Use --output NEW_IGNORED_DIRECTORY [--fixture] [--profiles deepseek,bigmodel,qwen,gpt6-astra]",
    );
  const results = await runCharacterGenerationComparison({
    output: values.output,
    fixture: values.fixture,
    profiles: values.profiles.split(",") as GenerationProfile[],
    ...(values.personas
      ? { personas: values.personas.split(",") as ReplySteeringPersonaId[] }
      : {}),
    budget: {
      maxPhysicalRequests: Number(values.requests),
      maxReservedTokenUnits: Number(values["token-units"]),
    },
    onProgress: (message) => console.log(message),
  });
  console.log(
    `Generated and published ${results.filter((result) => result.success).length}/${results.length}; evidence: ${resolve(values.output)}`,
  );
  if (results.some((result) => !result.success)) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await characterGenerationComparisonMain().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
