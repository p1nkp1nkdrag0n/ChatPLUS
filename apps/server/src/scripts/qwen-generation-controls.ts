import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  CharacterSpecSchema,
  OriginalCharacterInputSchema,
  type CharacterSpec,
} from "@personasim/contracts";
import { buildApp } from "../app.js";
import {
  readConfig,
  readLlmProfileConfig,
  type ServerConfig,
} from "../config.js";
import { openDatabase } from "../db/connection.js";
import { characterDraftSchema } from "../domain/schemas.js";
import { FakeClock } from "../runtime/clock.js";
import type { LlmLogicalCallEvent } from "../services/llm-service.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";
import { createContinuityMeteredFetch } from "./continuity-metered-fetch.js";
import {
  captureContinuityRunIdentity,
  continuityHash,
  freezeContinuityManifest,
} from "./continuity-run-identity.js";

const BUDGET = {
  maxPhysicalRequests: 2,
  maxReservedTokenUnits: 350_000,
} as const;
const AT = "2026-09-09T00:00:00.000Z";
const COMMON = {
  name: "沈禾",
  workOrRole: "独立设计师",
  worldSetting: "当代普通城市生活，没有需要推进的戏剧剧情。",
  coreTraits: ["重视自主判断", "说话直接但愿意听取不同看法"],
  initialRelationship: "刚认识，没有共同经历。",
  dialogueStyle: "自然中文，不设固定口头语。",
  characterBrief:
    "重视自主判断，但可以听取建议和接受安慰。没有作者指定的硬边界、核心矛盾、人生目标或成长路线。",
  tier: "high_fidelity",
  timezone: "Asia/Shanghai",
};
const CASES = [
  { id: "soft-autonomy", input: OriginalCharacterInputSchema.parse(COMMON) },
  {
    id: "explicit-authority",
    input: OriginalCharacterInputSchema.parse({
      ...COMMON,
      name: "沈舟",
      initialRelationship: "相识多年的朋友。",
      dialogueStyle: "自然中文；作者在结构化字段中明确指定语言规则和惯用表达。",
      characterBrief:
        "重视自主判断，也愿意听取建议和接受安慰。没有核心矛盾、人生目标或成长路线；语言规则以作者结构化声明为准。",
      authoring: {
        dialogueRules: [
          {
            id: "author-chinese-only",
            kind: "language",
            instruction: "每次只使用中文",
            enforcement: "hard",
            conditions: [],
            origin: "user_spec",
            sourceRefs: [],
          },
        ],
        frequentPhrases: ["好说"],
        sharedContext: "相识十年，曾共同经营一家旧书店。",
      },
    }),
  },
];

const { values } = parseArgs({
  strict: true,
  options: {
    fixture: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
if (!values.output)
  throw new Error(
    "Usage: tsx qwen-generation-controls.ts [--fixture] --output NEW_DIRECTORY",
  );
if (!values.fixture && process.env.RUN_PAID_CONTINUITY !== "1")
  throw new Error(
    "Real execution requires explicit user authorization and RUN_PAID_CONTINUITY=1",
  );
const directory = resolve(values.output);
if (existsSync(directory))
  throw new Error(
    "Output must be a new directory; runs cannot be resumed, overwritten or resampled.",
  );
const base = readConfig();
const llm = values.fixture
  ? {
      provider: "fixture" as const,
      model: "personasim-fixture-v1",
      baseUrl: "https://fixture.invalid",
      timeoutMs: 5_000,
      maxRetries: 0,
    }
  : { ...readLlmProfileConfig("qwen"), maxRetries: 0 };
if (!values.fixture && (!("apiKey" in llm) || !llm.apiKey))
  throw new Error("Missing credential for qwen profile");
mkdirSync(dirname(directory), { recursive: true });
mkdirSync(directory);
const configs: ServerConfig[] = CASES.map(({ id }) => ({
  ...base,
  llm,
  nodeEnv: "test",
  profile: "qwen-generation-controls-v1",
  host: "127.0.0.1",
  databasePath: join(directory, id, "personasim.sqlite"),
  clockMode: "fake",
  fakeClockStart: AT,
  seedDemo: false,
  serveWeb: false,
  selfHostedReverseProxy: false,
  lifePlanningMode: "fuzzy",
  scheduleNegotiationMode: "off",
  selfInitiatedPlanningMode: "off",
  liveWorldEffectsMode: "enforced",
  chatEffectsMode: "gated",
  companionContextMode: "enforced",
  personaRuntimeMode: "enforced",
  assetStoragePath: join(directory, id, "assets"),
  instanceSecret: randomBytes(32).toString("base64"),
}));
const secrets = configs.flatMap((config) => [
  config.llm.apiKey ?? "",
  config.instanceSecret ?? "",
]);
const safe = (value: unknown) => redactLongRunArtifact(value, secrets);
const json = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(safe(value), null, 2)}\n`, {
    flag: "wx",
  });
const identities = await Promise.all(
  configs.map((config) =>
    captureContinuityRunIdentity({
      config,
      experiment: { track: "C", cases: CASES, budget: BUDGET, retries: 0 },
      explicitSecrets: secrets,
    }),
  ),
);
await freezeContinuityManifest(
  join(directory, "manifest.json"),
  {
    schema: "qwen-generation-controls-v1",
    fixture: values.fixture,
    cases: CASES,
    budget: BUDGET,
    identities,
    fingerprint: continuityHash(identities),
  },
  false,
);
const results: unknown[] = [];
for (const [index, testCase] of CASES.entries()) {
  const config = configs[index]!;
  const caseDirectory = join(directory, testCase.id);
  mkdirSync(caseDirectory);
  const calls: LlmLogicalCallEvent[] = [];
  const append = (name: string, value: unknown) =>
    appendFileSync(
      join(caseDirectory, name),
      `${JSON.stringify(safe(value))}\n`,
    );
  const database = openDatabase(config.databasePath);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp({
      config,
      database,
      clock: new FakeClock(AT),
      seedDemo: false,
      startScheduler: false,
      logger: false,
      llmObservation: {
        fetch: createContinuityMeteredFetch({
          ledgerPath: join(directory, "attempts.jsonl"),
          budget: BUDGET,
          secrets,
          context: () => ({ caseId: testCase.id }),
        }),
        promptDiagnostics: true,
        onLogicalCall: (event) => {
          calls.push(structuredClone(event));
          append("model-io.jsonl", event);
        },
        onMetric: (event) => append("provider-metrics.jsonl", event),
      },
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const http = async (path: string, payload: unknown) => {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json();
      const result = { status: response.status, body };
      append("http.jsonl", { path, payload, ...result });
      return result;
    };
    const generated = await http("/api/characters/generate", testCase.input);
    const generatedSpec = CharacterSpecSchema.safeParse(
      record(generated.body)?.character,
    );
    const published = generatedSpec.success
      ? await http(`/api/characters/${generatedSpec.data.id}/publish`, {
          expectedVersion: generatedSpec.data.version,
        })
      : undefined;
    const finalSpec = CharacterSpecSchema.safeParse(
      record(published?.body)?.character,
    );
    const completed = calls.find(
      (event): event is Extract<LlmLogicalCallEvent, { stage: "completed" }> =>
        event.stage === "completed" && event.purpose === "compile_character",
    );
    const raw = characterDraftSchema.safeParse(
      record(completed?.parsedOutput)?.draft,
    );
    const effective = finalSpec.success ? finalSpec.data : undefined;
    const checks = publicationChecks(effective, testCase.id);
    const physicalRequestsForCase = existsSync(
      join(directory, "attempts.jsonl"),
    )
      ? readFileSync(join(directory, "attempts.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                stage: string;
                context?: { caseId?: string };
              },
          )
          .filter(
            (row) =>
              row.stage === "reserved" && row.context?.caseId === testCase.id,
          ).length
      : 0;
    const providerSucceeded =
      completed?.success === true &&
      (values.fixture
        ? physicalRequestsForCase === 0
        : physicalRequestsForCase === 1);
    const result = {
      caseId: testCase.id,
      input: testCase.input,
      fixture: values.fixture,
      generatedStatus: generated.status,
      publishedStatus: published?.status ?? null,
      logicalCompileCalls: calls.filter(
        (event) =>
          event.stage === "started" && event.purpose === "compile_character",
      ).length,
      rawProvider: {
        source: values.fixture
          ? "fixture_logical_output"
          : "parsed_provider_output; complete physical response in ../attempts.jsonl",
        successful: completed?.success ?? false,
        parsedOutput: completed?.parsedOutput ?? null,
      },
      rawChecks: raw.success
        ? {
            hardBoundaryCount: raw.data.persona.boundaries.filter(
              (rule) => rule.hard,
            ).length,
            hardDialogueRuleCount:
              raw.data.dialogue.rules?.filter(
                (rule) => rule.enforcement === "hard",
              ).length ?? 0,
            frequentPhrases: raw.data.dialogue.frequentPhrases,
            sharedContext: raw.data.userRelationship.sharedContext,
          }
        : { parseableDraft: false },
      generated: generatedSpec.success ? generatedSpec.data : generated.body,
      published: effective ?? published?.body ?? null,
      authorityAudit:
        effective?.authorityAudit ??
        (generatedSpec.success ? generatedSpec.data.authorityAudit : null),
      rawToPublishedDifferences:
        raw.success && effective ? differences(raw.data, effective) : null,
      checks,
      physicalRequestsForCase,
      providerSucceeded,
      safePublication:
        generated.status === 201 &&
        published?.status === 200 &&
        Object.values(checks).every(Boolean),
      providerFailureWasNotRetried:
        calls.filter((event) => event.stage === "started").length <= 1 &&
        physicalRequestsForCase <= 1,
    };
    json(join(caseDirectory, "result.json"), result);
    results.push({
      caseId: testCase.id,
      safePublication: result.safePublication,
      providerSucceeded,
      checks,
      rawChecks: result.rawChecks,
    });
    if (!result.safePublication || !providerSucceeded) process.exitCode = 1;
  } catch (error) {
    json(join(caseDirectory, "error.json"), {
      caseId: testCase.id,
      error: error instanceof Error ? error.message : String(error),
      noRetry: true,
    });
    results.push({
      caseId: testCase.id,
      safePublication: false,
      error: "See isolated error.json; this case was not retried.",
    });
    process.exitCode = 1;
  } finally {
    if (database.open) database.pragma("wal_checkpoint(TRUNCATE)");
    if (app) await app.close();
    else if (database.open) database.close();
  }
}
const ledger = existsSync(join(directory, "attempts.jsonl"))
  ? readFileSync(join(directory, "attempts.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { stage: string; reservedTokenUnits?: number },
      )
  : [];
const reservations = ledger.filter((row) => row.stage === "reserved");
json(join(directory, "summary.json"), {
  fixture: values.fixture,
  budget: BUDGET,
  physicalRequests: reservations.length,
  reservedTokenUnits: reservations.reduce(
    (sum, row) => sum + (row.reservedTokenUnits ?? 0),
    0,
  ),
  results,
  scope:
    "Two pre-registered generation/publish controls. Raw quality and safe publication are separate outcomes; pending candidates are not silently treated as model success.",
});
console.log(
  JSON.stringify(
    {
      directory,
      fixture: values.fixture,
      physicalRequests: reservations.length,
      results,
    },
    null,
    2,
  ),
);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function publicationChecks(
  spec: CharacterSpec | undefined,
  id: string,
): Record<string, boolean> {
  if (!spec) return { published: false };
  const common = {
    published: spec.status === "published",
    policyV3: spec.compilationPolicyVersion === "companion_character_v3",
    noInventedGoals: spec.persona.goals.length === 0,
    noInventedContradictions: spec.persona.contradictions.length === 0,
    authorityAuditPresent: spec.authorityAudit !== undefined,
  };
  if (id === "soft-autonomy")
    return {
      ...common,
      noHardBoundaries: spec.persona.boundaries.every((rule) => !rule.hard),
      noHardDialogueRules: (spec.dialogue.rules ?? []).every(
        (rule) => rule.enforcement !== "hard",
      ),
      noFixedPhrases: spec.dialogue.frequentPhrases.length === 0,
      noInventedSharedHistory:
        spec.userRelationship.sharedContext === COMMON.initialRelationship,
    };
  return {
    ...common,
    explicitHardLanguageRetained:
      spec.dialogue.rules?.some(
        (rule) =>
          rule.id === "author-chinese-only" &&
          rule.instruction === "每次只使用中文" &&
          rule.enforcement === "hard" &&
          rule.origin === "user_spec",
      ) ?? false,
    noUnrequestedHardBoundaries: spec.persona.boundaries.every(
      (rule) => !rule.hard,
    ),
    onlyRequestedHardDialogueRules: (spec.dialogue.rules ?? []).every(
      (rule) =>
        rule.enforcement !== "hard" || rule.id === "author-chinese-only",
    ),
    phrasesRetained:
      JSON.stringify(spec.dialogue.frequentPhrases) ===
        JSON.stringify(["好说"]) &&
      spec.dialogue.frequentPhrasesOrigin === "user_spec",
    sharedHistoryRetained:
      spec.userRelationship.sharedContext ===
      "相识十年，曾共同经营一家旧书店。",
    hardRuleHasAuthorEvidence:
      spec.authorityAudit?.candidates.some(
        (candidate) =>
          candidate.ruleId === "author-chinese-only" &&
          candidate.status === "accepted" &&
          candidate.source?.kind === "author_field" &&
          candidate.source.field === "authoring.dialogueRules",
      ) ?? false,
  };
}
function differences(
  raw: {
    persona: { boundaries: unknown };
    dialogue: { rules?: unknown; frequentPhrases: unknown };
    userRelationship: { sharedContext: unknown };
  },
  spec: CharacterSpec,
) {
  return [
    ["persona.boundaries", raw.persona.boundaries, spec.persona.boundaries],
    ["dialogue.rules", raw.dialogue.rules, spec.dialogue.rules],
    [
      "dialogue.frequentPhrases",
      raw.dialogue.frequentPhrases,
      spec.dialogue.frequentPhrases,
    ],
    [
      "userRelationship.sharedContext",
      raw.userRelationship.sharedContext,
      spec.userRelationship.sharedContext,
    ],
  ]
    .filter(
      ([, before, after]) => JSON.stringify(before) !== JSON.stringify(after),
    )
    .map(([path, before, after]) => ({ path, before, after }));
}
