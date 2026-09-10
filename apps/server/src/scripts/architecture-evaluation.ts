import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONVERSATION_RETENTION_POLICY,
  PersonaChatDecisionSchema,
  StrictPersonaTurnProviderEnvelopeSchema,
} from "@personasim/contracts";
import type { PromptAssemblyTrace } from "@personasim/features";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import {
  LlmService,
  type LlmLogicalCallEvent,
} from "../services/llm-service.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";
import { createContinuityMeteredFetch } from "./continuity-metered-fetch.js";
import { captureContinuityRunIdentity } from "./continuity-run-identity.js";
import {
  ARCHITECTURE_CASE_VERSION,
  ARCHITECTURE_PROBES,
  ARCHITECTURE_PRIVATE_ORACLE,
  observeArchitectureSurfaceChecks,
  type ArchitectureProbe,
} from "./architecture-evaluation-cases.js";
import {
  architectureConfig,
  architectureInstant,
  architectureFixtureFetch,
  createArchitectureRuntime,
  runArchitectureFullTurn,
  runArchitectureSimple,
  ARCHITECTURE_RUNTIME_VERSION,
} from "./architecture-evaluation-runtime.js";
import {
  transformArchitecturePrompt,
  type ArchitecturePromptMode,
} from "./architecture-prompt-ablation.js";
import {
  visibleEvidence,
  steeringAttemptAccounting,
  readSteeringAttempts,
} from "./reply-steering-runner.js";
import {
  admitArchitectureOutput,
  architectureRunConfig,
} from "./architecture-run-admission.js";

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const PERSONAS = ["social-outward", "social-private"] as const;
const ARMS = ["full_native", "simple_recent", "simple_summary"] as const;
const DIAGNOSTIC_MODES: Readonly<Record<string, ArchitecturePromptMode>> = {
  P04: "no_planner_readout",
  P05: "no_planner_readout",
  P08: "no_memory_readout",
  P09: "no_memory_readout",
  P13: "no_dynamic_state_readout",
  P14: "no_dynamic_state_readout",
  P15: "no_autobiography_readout",
  P16: "no_persona_runtime_readout",
};
export const ARCHITECTURE_EXPERIMENT = {
  version: "architecture-experiment-v1",
  caseVersion: ARCHITECTURE_CASE_VERSION,
  runtimeVersion: ARCHITECTURE_RUNTIME_VERSION,
  personas: PERSONAS,
  arms: ARMS,
  fixedProbes: Array.from(
    { length: 15 },
    (_, i) => `P${String(i + 1).padStart(2, "0")}`,
  ),
  repeats: 2,
  primaryCandidates: 180,
  diagnosticModes: DIAGNOSTIC_MODES,
  diagnostics:
    "2 personas × 8 probes × 2 repeats × (raw full main + information-matched flat + one applicable readout removal) = up to 96; no-op removals not dispatched",
  ordering: "sha256 fixed seed sort within matched persona/probe/repeat blocks",
  seed: "architecture-eval-v1-frozen-september10",
  scope:
    "Supported synchronous conversation architecture. Fuzzy life context, memory, planner, persona runtime, state, autobiography and production reply repair. Proactive scheduling, correspondence and keepsakes are not part of this estimand.",
  history:
    "All arms observe the same authored history. Full fixed prefixes use deterministic source-grounded memory/practice ingestion; old raw turns are in a prior session, current session keeps the same recent window. Baseline summary reads the same old raw turns. P15 autobiography is a validated authored mechanism fixture, not a generated checkpoint.",
  diagnosis:
    "Post-admission prompt readout interventions, direct main generation only, with no production repair reinjection. Full native final replies are a separate outcome.",
  analysis:
    "Paired within persona/probe/repeat. Mechanical checks are literal observations, never semantic pass/fail. Report task and grounding rubric, character distinctiveness and exceptions, real usage, latency, errors, repairs and deterministic bypass. Small curated corpus: no universal architecture superiority claim.",
} as const;

type MainEvent = Extract<LlmLogicalCallEvent, { stage: "started" }>;
type Preflight = {
  personaId: string;
  probeId: string;
  main?: MainEvent;
  trace?: PromptAssemblyTrace;
  full: Awaited<ReturnType<typeof runArchitectureFullTurn>>;
  seeding: unknown[];
};

export async function runArchitectureEvaluation(options: {
  output: string;
  fixture?: boolean;
  preflightOnly?: boolean;
  repeats?: number;
  concurrency?: number;
  probeIds?: string[];
  diagnostics?: boolean;
  maxPhysicalRequests?: number;
  maxReservedTokenUnits?: number;
}) {
  if (
    !Number.isInteger(options.concurrency ?? 2) ||
    (options.concurrency ?? 2) < 1 ||
    (options.concurrency ?? 2) > 4
  )
    throw new Error("Concurrency must be 1 through 4");
  if (
    !options.fixture &&
    !options.preflightOnly &&
    process.env["RUN_PAID_ARCHITECTURE_EVAL"] !== "1"
  )
    throw new Error(
      "Set RUN_PAID_ARCHITECTURE_EVAL=1 for authorized real calls",
    );
  const directory = admitArchitectureOutput(options.output);
  const { base, profile } = architectureRunConfig(
    directory,
    options.fixture === true || options.preflightOnly === true,
  );
  mkdirSync(directory, { recursive: true });
  const secrets = [profile.apiKey ?? "", base.instanceSecret ?? ""];
  const save = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        redactLongRunArtifact(visibleEvidence(value), secrets),
        null,
        2,
      ) + "\n",
    );
  };
  const config = {
    ...architectureConfig(base, profile, directory),
    conversationRetention: DEFAULT_CONVERSATION_RETENTION_POLICY,
  };
  const repeats = options.repeats ?? 2;
  if (![1, 2].includes(repeats))
    throw new Error("Use one fixture repeat or two registered real repeats");
  const primary = ARCHITECTURE_PROBES.filter(
    (probe) =>
      ARCHITECTURE_EXPERIMENT.fixedProbes.includes(probe.id) &&
      (!options.probeIds || options.probeIds.includes(probe.id)),
  );
  const diagnostics = options.diagnostics !== false;
  const probes = ARCHITECTURE_PROBES.filter(
    (probe) =>
      primary.includes(probe) ||
      (diagnostics &&
        probe.id in DIAGNOSTIC_MODES &&
        (!options.probeIds || options.probeIds.includes(probe.id))),
  );
  const budget = {
    maxPhysicalRequests: options.maxPhysicalRequests ?? 450,
    maxReservedTokenUnits: options.maxReservedTokenUnits ?? 35000000,
  };
  const manifest = await captureContinuityRunIdentity({
    config,
    experiment: {
      ...ARCHITECTURE_EXPERIMENT,
      options,
      budget,
      repeats,
      fixture: !!options.fixture,
      preflightOnly: !!options.preflightOnly,
    },
    explicitSecrets: secrets,
  });
  const sourceDir = join(directory, "source");
  mkdirSync(sourceDir);
  const sourceHashes: Record<string, string> = {};
  const scripts = dirname(fileURLToPath(import.meta.url));
  for (const name of readdirSync(scripts).filter(
    (name) => name.startsWith("architecture-") && name.endsWith(".ts"),
  )) {
    copyFileSync(join(scripts, name), join(sourceDir, name));
    sourceHashes[name] = hash(readFileSync(join(scripts, name)));
  }
  writeFileSync(
    join(sourceDir, "tracked-code.patch"),
    execFileSync("git", ["diff", "--binary", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    }),
  );
  const untrackedCode = execFileSync(
    "git",
    [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "apps/server/src",
      "packages",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/u)
    .filter((path) => /\.tsx?$/u.test(path));
  for (const path of untrackedCode) {
    const target = join(sourceDir, "untracked", path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(path), target);
    sourceHashes[`untracked/${path}`] = hash(readFileSync(resolve(path)));
  }
  save(join(directory, "manifest.json"), {
    ...manifest,
    sourceHashes,
    startedAtUtc: new Date().toISOString(),
  });
  save(join(directory, "private-oracle.json"), ARCHITECTURE_PRIVATE_ORACLE);
  const preflight = new Map<string, Preflight>();
  for (const personaId of PERSONAS)
    for (const probe of probes) {
      const id = `${personaId}-${probe.id}`;
      const preDir = join(directory, "preflight", id);
      const runtime = await createArchitectureRuntime({
        directory: preDir,
        caseId: personaId,
        config: {
          ...architectureConfig(base, profile, preDir),
          conversationRetention: DEFAULT_CONVERSATION_RETENTION_POLICY,
        },
        transport: architectureFixtureFetch,
        history: probe.history,
        nowUtc: architectureInstant(probe.simulatedDay),
        ...(probe.recentHistoryLimit === undefined
          ? {}
          : { recentLimit: probe.recentHistoryLimit }),
        ...(probe.stateOverride === undefined
          ? {}
          : { stateOverride: probe.stateOverride }),
        ...(probe.autobiographySeed === undefined
          ? {}
          : { autobiographySeed: probe.autobiographySeed }),
      });
      try {
        const full = await runArchitectureFullTurn(
          runtime,
          probe.userText,
          `preflight-${id}`,
        );
        if (full.error)
          throw new Error(`${id}:${full.error}:${JSON.stringify(full.body)}`);
        const main = full.events.find(
          (event): event is MainEvent =>
            event.stage === "started" && event.purpose === "chat_turn",
        );
        const trace = full.metadata["promptSegmentTrace"] as
          PromptAssemblyTrace | undefined;
        const entry: Preflight = {
          personaId,
          probeId: probe.id,
          full,
          seeding: runtime.seeding,
          ...(main ? { main } : {}),
          ...(trace ? { trace } : {}),
        };
        if (main && probe.id in DIAGNOSTIC_MODES) {
          const transformations = [
            "full",
            "flat_information_matched",
            DIAGNOSTIC_MODES[probe.id]!,
          ].map((mode) =>
            transformArchitecturePrompt(
              {
                system: main.system,
                prompt: main.prompt,
                ...(trace ? { segmentTrace: trace } : {}),
              },
              mode as ArchitecturePromptMode,
            ),
          );
          save(join(preDir, "transformations.json"), transformations);
        }
        save(join(preDir, "result.json"), entry);
        preflight.set(id, entry);
      } finally {
        await runtime.close();
      }
    }
  console.log(`PREFLIGHT ${preflight.size} contexts captured`);
  if (options.preflightOnly) return { directory, preflight: preflight.size };
  for (const name of [
    "architecture-evaluation.ts",
    "architecture-evaluation-runtime.ts",
    "architecture-evaluation-cases.ts",
    "architecture-persona-cases.ts",
    "architecture-prompt-ablation.ts",
  ])
    if (sourceHashes[name] !== hash(readFileSync(join(scripts, name))))
      throw new Error(`Participating source changed during preflight: ${name}`);
  // No code changes or prompt tuning are permitted after this point for this run.
  const ledger = join(directory, "request-attempts.jsonl");
  const results: Record<string, unknown>[] = [];
  const tasks: Array<() => Promise<void>> = [];
  const writeResult = (row: Record<string, unknown>) => {
    const id = String(row["id"]);
    const attempts = readSteeringAttempts(ledger, id);
    const result = { ...row, accounting: steeringAttemptAccounting(attempts) };
    save(join(directory, "candidates", id, "result.json"), result);
    appendFileSync(
      join(directory, "results.jsonl"),
      JSON.stringify(redactLongRunArtifact(visibleEvidence(result), secrets)) +
        "\n",
    );
    results.push(result);
    console.log(
      `RESULT ${results.length} ${id} ${row["error"] ? "ERROR" : "ok"}`,
    );
  };
  const cellTransport = (id: string) => {
    let active: MainEvent | undefined;
    return {
      transport: createContinuityMeteredFetch({
        ledgerPath: ledger,
        budget,
        secrets,
        projectResponse: visibleEvidence,
        ...(options.fixture ? { fetch: architectureFixtureFetch } : {}),
        context: () => ({
          id,
          logicalCallIndex: active?.index,
          purpose: active?.purpose,
        }),
      }),
      onLogicalCall: (event: LlmLogicalCallEvent) => {
        if (event.stage === "started") active = event;
      },
    };
  };
  const blocks: Array<{
    personaId: string;
    probe: ArchitectureProbe;
    repeat: number;
  }> = [];
  for (const personaId of PERSONAS)
    for (const probe of probes)
      for (let repeat = 1; repeat <= repeats; repeat++)
        blocks.push({ personaId, probe, repeat });
  blocks.sort((a, b) =>
    hash(
      `${ARCHITECTURE_EXPERIMENT.seed}/${a.personaId}/${a.probe.id}/${a.repeat}`,
    ).localeCompare(
      hash(
        `${ARCHITECTURE_EXPERIMENT.seed}/${b.personaId}/${b.probe.id}/${b.repeat}`,
      ),
    ),
  );
  for (const { personaId, probe, repeat } of blocks) {
    const expected = preflight.get(`${personaId}-${probe.id}`)!;
    if (primary.includes(probe))
      for (const arm of [...ARMS].sort((a, b) =>
        hash(`${personaId}/${probe.id}/${repeat}/${a}`).localeCompare(
          hash(`${personaId}/${probe.id}/${repeat}/${b}`),
        ),
      )) {
        tasks.push(async () => {
          const id = `fixed-${personaId}-${probe.id}-r${repeat}-${arm}`;
          const cellDir = join(directory, "candidates", id);
          const meter = cellTransport(id);
          const shared = {
            directory: cellDir,
            caseId: personaId,
            config: {
              ...architectureConfig(base, profile, cellDir),
              conversationRetention: DEFAULT_CONVERSATION_RETENTION_POLICY,
            },
            ...meter,
            history: probe.history,
            nowUtc: architectureInstant(probe.simulatedDay),
            ...(probe.recentHistoryLimit === undefined
              ? {}
              : { recentLimit: probe.recentHistoryLimit }),
            ...(probe.stateOverride === undefined
              ? {}
              : { stateOverride: probe.stateOverride }),
          };
          let result: Record<string, unknown>;
          try {
            if (arm === "full_native") {
              const runtime = await createArchitectureRuntime({
                ...shared,
                ...(probe.autobiographySeed
                  ? { autobiographySeed: probe.autobiographySeed }
                  : {}),
              });
              try {
                result = await runArchitectureFullTurn(
                  runtime,
                  probe.userText,
                  id,
                );
              } finally {
                await runtime.close();
              }
            } else
              result = await runArchitectureSimple({
                ...shared,
                userText: probe.userText,
                summaryMode: arm === "simple_summary" ? "rolling" : "recent",
                ...(expected.main?.maxOutputTokens
                  ? { maxOutputTokens: expected.main.maxOutputTokens }
                  : {}),
              });
          } catch (cause) {
            result = {
              text: "",
              error: cause instanceof Error ? cause.message : String(cause),
            };
          }
          writeResult({
            id,
            series: "fixed",
            personaId,
            probeId: probe.id,
            repeat,
            arm,
            ...result,
            surfaceObservations: observeArchitectureSurfaceChecks(
              typeof result["text"] === "string" ? result["text"] : "",
              ARCHITECTURE_PRIVATE_ORACLE[probe.id]!,
            ),
          });
        });
      }
    if (diagnostics && probe.id in DIAGNOSTIC_MODES && expected.main) {
      const main = expected.main;
      const modes: ArchitecturePromptMode[] = [
        "full",
        "flat_information_matched",
        DIAGNOSTIC_MODES[probe.id]!,
      ];
      modes.sort((a, b) =>
        hash(`${personaId}/${probe.id}/${repeat}/readout/${a}`).localeCompare(
          hash(`${personaId}/${probe.id}/${repeat}/readout/${b}`),
        ),
      );
      for (const mode of modes)
        tasks.push(async () => {
          const id = `readout-${personaId}-${probe.id}-r${repeat}-${mode}`;
          const cellDir = join(directory, "candidates", id);
          mkdirSync(cellDir, { recursive: true });
          const changed = transformArchitecturePrompt(
            {
              system: main.system,
              prompt: main.prompt,
              ...(expected.trace ? { segmentTrace: expected.trace } : {}),
            },
            mode,
          );
          const substantiveTarget =
            mode === "no_memory_readout"
              ? main.prompt.includes("RETRIEVED_EVIDENCE_JSON\n") ||
                /"relevantMemories":\[\{/u.test(main.prompt)
              : mode === "no_persona_runtime_readout"
                ? /"relationshipPractices":\[\{/u.test(
                    main.system + main.prompt,
                  ) || /"applicablePractices":\[\{/u.test(main.prompt)
                : true;
          if (
            mode !== "full" &&
            (!changed.proof.interventionPresent || !substantiveTarget)
          ) {
            writeResult({
              id,
              series: "readout",
              personaId,
              probeId: probe.id,
              repeat,
              arm: mode,
              skipped: substantiveTarget
                ? "no-op intervention"
                : "empty target readout; not evidence of module value",
              text: "",
              proof: changed.proof,
            });
            return;
          }
          const meter = cellTransport(id);
          const database = openDatabase(join(cellDir, "direct.sqlite"));
          runMigrations(database);
          const events: LlmLogicalCallEvent[] = [];
          const llm = new LlmService(
            profile,
            new DatabaseStore(database),
            new FakeClock(architectureInstant(probe.simulatedDay)),
            {
              fetch: meter.transport,
              onLogicalCall: (event) => {
                events.push(event);
                meter.onLogicalCall(event);
              },
            },
          );
          let text = "";
          let error: string | undefined;
          let raw: unknown;
          const started = performance.now();
          try {
            raw = await llm.generateObject({
              purpose: "chat_turn",
              system: changed.system,
              prompt: changed.prompt,
              schema: StrictPersonaTurnProviderEnvelopeSchema,
              ...(main.maxOutputTokens
                ? { maxOutputTokens: main.maxOutputTokens }
                : {}),
            });
            text = PersonaChatDecisionSchema.parse(
              (raw as { replyDecision: unknown }).replyDecision,
            ).text;
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          } finally {
            database.close();
          }
          writeResult({
            id,
            series: "readout",
            personaId,
            probeId: probe.id,
            repeat,
            arm: mode,
            text,
            raw,
            events,
            elapsedMs: Math.round(performance.now() - started),
            proof: changed.proof,
            ...(error ? { error } : {}),
            surfaceObservations: observeArchitectureSurfaceChecks(
              text,
              ARCHITECTURE_PRIVATE_ORACLE[probe.id]!,
            ),
          });
        });
    }
  }
  let cursor = 0;
  await Promise.all(
    Array.from({ length: options.concurrency ?? 2 }, async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++]!;
        await task();
      }
    }),
  );
  save(join(directory, "summary.json"), {
    plannedTasks: tasks.length,
    completed: results.length,
    errors: results.filter((row) => row["error"]).length,
    skipped: results.filter((row) => row["skipped"]).length,
    completedAtUtc: new Date().toISOString(),
  });
  const blind = [...results]
    .sort((a, b) =>
      hash(`blind/${String(a["id"])}`).localeCompare(
        hash(`blind/${String(b["id"])}`),
      ),
    )
    .map((row, index) => ({
      blindId: `B${String(index + 1).padStart(3, "0")}`,
      personaId: row["personaId"],
      probeId: row["probeId"],
      text: row["text"],
      validCandidate: !row["error"] && !row["skipped"],
    }));
  save(join(directory, "blind-review.json"), blind);
  save(
    join(directory, "blind-key.json"),
    [...results]
      .sort((a, b) =>
        hash(`blind/${String(a["id"])}`).localeCompare(
          hash(`blind/${String(b["id"])}`),
        ),
      )
      .map((row, index) => ({
        blindId: `B${String(index + 1).padStart(3, "0")}`,
        id: row["id"],
      })),
  );
  return { directory, completed: results.length };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const value = (key: string, fallback: string) => {
    const index = args.indexOf(key);
    return index < 0 ? fallback : (args[index + 1] ?? fallback);
  };
  const probes = value("--probes", "");
  await runArchitectureEvaluation({
    output: value("--output", "tmp/architecture-evaluation"),
    fixture: args.includes("--fixture"),
    preflightOnly: args.includes("--preflight-only"),
    repeats: Number(value("--repeats", "2")),
    concurrency: Number(value("--concurrency", "2")),
    diagnostics: !args.includes("--no-diagnostics"),
    ...(probes ? { probeIds: probes.split(",") } : {}),
  });
}
