import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  PersonaChatDecisionSchema,
  StrictPersonaTurnProviderEnvelopeSchema,
} from "@personasim/contracts";
import {
  createOpenAiCompatibleLlmProvider,
  type LlmCallMetric,
} from "@personasim/providers";
import { architectureFixtureFetch } from "./architecture-evaluation-runtime.js";
import {
  admitArchitectureOutput,
  architectureRunConfig,
} from "./architecture-run-admission.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";
import { createContinuityMeteredFetch } from "./continuity-metered-fetch.js";
import { captureContinuityRunIdentity } from "./continuity-run-identity.js";
import {
  readSteeringAttempts,
  steeringAttemptAccounting,
  visibleEvidence,
} from "./reply-steering-runner.js";
import {
  RUNTIME_STATE_AUDIT_CASES,
  RUNTIME_STATE_AUDIT_PERSONAS,
  RUNTIME_STATE_AUDIT_REVIEW_RUBRIC,
  RUNTIME_STATE_AUDIT_VERSION,
} from "./runtime-state-audit-cases.js";
import {
  buildRuntimeStateAuditCells,
  RUNTIME_STATE_AUDIT_ARMS,
  RUNTIME_STATE_AUDIT_LEGACY_COMMIT,
  runtimeStateAuditHash,
  type RuntimeStateAuditCell,
} from "./runtime-state-audit-prompts.js";

export const RUNTIME_STATE_AUDIT_BUDGET = {
  maxPhysicalRequests: 46,
  maxReservedTokenUnits: 4_000_000,
} as const;
export const RUNTIME_STATE_AUDIT_OUTPUT_CAP = 4096;
export interface RuntimeStateAuditResult {
  id: string;
  personaId: string;
  caseId: string;
  arm: RuntimeStateAuditCell["arm"];
  text: string;
  elapsedMs: number;
  metrics: LlmCallMetric[];
  raw?: unknown;
  error?: string;
  skipped?: string;
  accounting: ReturnType<typeof steeringAttemptAccounting>;
  proof: RuntimeStateAuditCell["proof"];
}

export async function runRuntimeStateAuditEvaluation(options: {
  output: string;
  fixture?: boolean;
  preflightOnly?: boolean;
}) {
  if (
    !options.fixture &&
    !options.preflightOnly &&
    process.env["RUN_PAID_ARCHITECTURE_EVAL"] !== "1"
  )
    throw new Error("Real calls require RUN_PAID_ARCHITECTURE_EVAL=1");
  const directory = admitArchitectureOutput(options.output);
  // Offline mode does not resolve private deployment profiles. The documented
  // PERSONASIM_LOAD_ENV=false startup additionally prevents config.ts dotenv IO.
  const { base, profile: configuredProfile } = architectureRunConfig(
    directory,
    options.fixture === true || options.preflightOnly === true,
  );
  const maxOutputTokens = Math.min(
    RUNTIME_STATE_AUDIT_OUTPUT_CAP,
    configuredProfile.capabilities?.maxOutputTokens ??
      RUNTIME_STATE_AUDIT_OUTPUT_CAP,
  );
  const profile = { ...configuredProfile, maxRetries: 0, maxOutputTokens };
  const secrets = [
    profile.apiKey ?? "",
    base.instanceSecret ?? "",
    base.llm.apiKey ?? "",
  ];
  const prepared = buildRuntimeStateAuditCells();
  if (
    prepared.cells.filter((cell) => !cell.skipped).length >
    RUNTIME_STATE_AUDIT_BUDGET.maxPhysicalRequests
  ) {
    throw new Error(
      "Registered candidates exceed the hard physical-request cap",
    );
  }
  mkdirSync(directory, { recursive: true });
  const save = (name: string, value: unknown) => {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(redactLongRunArtifact(visibleEvidence(value), secrets), null, 2)}\n`,
    );
  };
  const protocolPath = resolve("docs/evals/runtime-state-audit.md");
  const sources = [
    "apps/server/src/scripts/runtime-state-audit-evaluation.ts",
    "apps/server/src/scripts/runtime-state-audit-prompts.ts",
    "apps/server/src/scripts/runtime-state-audit-cases.ts",
    "packages/features/src/runtime-state-description.ts",
    "packages/features/src/prompt-assembler.ts",
    "packages/features/src/reply-strategy.ts",
    "apps/server/src/scripts/architecture-run-admission.ts",
    "apps/server/src/scripts/continuity-metered-fetch.ts",
    "packages/providers/src/openai-compatible-llm.ts",
  ];
  const sourceHashes: Record<string, string> = {};
  for (const name of sources) {
    const text = readFileSync(resolve(name), "utf8");
    sourceHashes[name] = runtimeStateAuditHash(text);
    const path = join(directory, "source", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  writeFileSync(
    join(directory, "source", "legacy-state-readout.ts"),
    prepared.legacy.source,
  );
  writeFileSync(join(directory, "protocol.md"), readFileSync(protocolPath));
  save("manifest.json", {
    version: RUNTIME_STATE_AUDIT_VERSION,
    startedAtUtc: new Date().toISOString(),
    protocolSha256: runtimeStateAuditHash(readFileSync(protocolPath, "utf8")),
    sourceHashes,
    legacySourceHashes: prepared.legacy.sourceHashes,
    identity: await captureContinuityRunIdentity({
      config: { ...base, llm: profile },
      explicitSecrets: secrets,
      experiment: {
        kind: "runtime-state-readout-audit",
        fixture: !!options.fixture,
        preflightOnly: !!options.preflightOnly,
        arms: RUNTIME_STATE_AUDIT_ARMS,
        personas: RUNTIME_STATE_AUDIT_PERSONAS,
        caseIds: RUNTIME_STATE_AUDIT_CASES.map((item) => item.id),
        candidates: prepared.cells.length,
        dispatchableCandidates: prepared.cells.filter((cell) => !cell.skipped)
          .length,
        samplesPerCell: 1,
        budget: RUNTIME_STATE_AUDIT_BUDGET,
        maxOutputTokens,
        maxRetries: 0,
        concurrency: 2,
        legacyCommit: RUNTIME_STATE_AUDIT_LEGACY_COMMIT,
        estimate:
          "Old state projection + old stateGuidance vs current projection, with the same persona/task NEUTRAL-state strategy frozen across all arms to remove indirect target-state delivery/length effects. Other current production segments byte-equal. Controlled readout evaluation, not raw production or the whole old system.",
        noRepair:
          "Direct provider main generation only. No production guard repair, schema retry, automatic retry, or old replyGrounding is invoked.",
        order:
          "Fixed SHA256 order within persona/case matched blocks; at most two physical calls in flight.",
        review:
          "No automatic semantic scoring or paid judge; anonymous candidate material is not user blind evaluation.",
      },
    }),
  });
  save("private-cases-and-rubric.json", {
    cases: RUNTIME_STATE_AUDIT_CASES,
    rubric: RUNTIME_STATE_AUDIT_REVIEW_RUBRIC,
  });
  save("production-assembler-captures.json", prepared.captures);
  save("legacy-sleep-projection-fixture.json", prepared.legacySleepFixture);
  save("prompt-cells.json", prepared.cells);
  if (options.preflightOnly) {
    const summary = {
      preflightOnly: true,
      candidates: prepared.cells.length,
      dispatchable: prepared.cells.filter((cell) => !cell.skipped).length,
      physicalRequests: 0,
    };
    save("summary.json", summary);
    return summary;
  }
  const results: RuntimeStateAuditResult[] = [];
  const ledgerPath = join(directory, "attempts.jsonl");
  const ordered: RuntimeStateAuditCell[] = [];
  for (const personaId of RUNTIME_STATE_AUDIT_PERSONAS)
    for (const probe of RUNTIME_STATE_AUDIT_CASES) {
      ordered.push(
        ...prepared.cells
          .filter(
            (cell) => cell.personaId === personaId && cell.caseId === probe.id,
          )
          .sort((left, right) =>
            runtimeStateAuditHash(
              `${RUNTIME_STATE_AUDIT_VERSION}/${left.id}`,
            ).localeCompare(
              runtimeStateAuditHash(
                `${RUNTIME_STATE_AUDIT_VERSION}/${right.id}`,
              ),
            ),
          ),
      );
    }
  const writeResults = () => {
    save(
      "results.json",
      [...results].sort((left, right) => left.id.localeCompare(right.id)),
    );
    const mapped = results.map((row) => ({
      candidateId: `C-${runtimeStateAuditHash(`anonymous/${row.id}`).slice(0, 16)}`,
      ...row,
    }));
    save(
      "anonymous-candidates.json",
      mapped
        .map((row) => ({
          candidateId: row.candidateId,
          pairingId: runtimeStateAuditHash(
            `${row.personaId}/${row.caseId}`,
          ).slice(0, 12),
          caseId: row.caseId,
          text: row.text,
          status: row.skipped
            ? "skipped"
            : row.error
              ? "generation_error"
              : "completed",
        }))
        .sort((left, right) =>
          left.candidateId.localeCompare(right.candidateId),
        ),
    );
    save(
      "private-anonymous-mapping.json",
      mapped.map((row) => ({
        candidateId: row.candidateId,
        id: row.id,
        personaId: row.personaId,
        caseId: row.caseId,
        arm: row.arm,
      })),
    );
  };
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (cursor < ordered.length) {
        const cell = ordered[cursor++]!;
        const metrics: LlmCallMetric[] = [];
        let text = "";
        let raw: unknown;
        let error: string | undefined;
        const started = performance.now();
        if (!cell.skipped) {
          const transport = createContinuityMeteredFetch({
            ledgerPath,
            budget: RUNTIME_STATE_AUDIT_BUDGET,
            secrets,
            projectResponse: visibleEvidence,
            ...(options.fixture ? { fetch: architectureFixtureFetch } : {}),
            context: () => ({
              id: cell.id,
              purpose: "chat_turn",
              logicalCallIndex: cell.id,
            }),
          });
          const provider = createOpenAiCompatibleLlmProvider({
            apiKey: profile.apiKey!,
            baseUrl: profile.baseUrl,
            model: profile.model,
            timeoutMs: profile.timeoutMs,
            maxRetries: 0,
            maxOutputTokens,
            ...(profile.capabilities
              ? { capabilities: profile.capabilities }
              : {}),
            fetch: transport,
            onMetric: (metric) => metrics.push(metric),
          });
          try {
            raw = await provider.generateObject({
              purpose: "chat_turn",
              system: cell.system,
              prompt: cell.prompt,
              schema: StrictPersonaTurnProviderEnvelopeSchema,
              maxRetries: 0,
              maxOutputTokens,
            });
            text = PersonaChatDecisionSchema.parse(
              (raw as { replyDecision: unknown }).replyDecision,
            ).text;
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
        }
        results.push({
          id: cell.id,
          personaId: cell.personaId,
          caseId: cell.caseId,
          arm: cell.arm,
          text,
          elapsedMs: Math.round(performance.now() - started),
          metrics,
          raw,
          ...(error ? { error } : {}),
          ...(cell.skipped ? { skipped: cell.skipped } : {}),
          proof: cell.proof,
          accounting: steeringAttemptAccounting(
            readSteeringAttempts(ledgerPath, cell.id),
          ),
        });
        writeResults();
        console.log(
          `STATE_AUDIT ${results.length}/${ordered.length} ${cell.id} ${cell.skipped ? "skipped" : error ? "error" : "completed"}`,
        );
      }
    }),
  );
  const summary = {
    fixture: !!options.fixture,
    completed: results.filter((row) => !row.error && !row.skipped).length,
    errors: results.filter((row) => row.error).length,
    skipped: results.filter((row) => row.skipped).length,
    physicalRequests: results.reduce(
      (sum, row) => sum + row.accounting.physicalRequests,
      0,
    ),
    usageComplete: results
      .filter((row) => !row.skipped)
      .every((row) => row.accounting.usageComplete),
    pairedInterpretation:
      "Inspect paired visible candidates and the frozen private rubric; no automatic quality verdict. Unknown usage stays unknown. Readout-only, single-sample exploratory evaluation.",
  };
  save("summary.json", summary);
  return summary;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      fixture: { type: "boolean" },
      "preflight-only": { type: "boolean" },
    },
  });
  if (!values.output) throw new Error("Use --output tmp/<fresh-run-name>");
  const summary = await runRuntimeStateAuditEvaluation({
    output: values.output,
    ...(values.fixture === undefined ? {} : { fixture: values.fixture }),
    ...(values["preflight-only"] === undefined
      ? {}
      : { preflightOnly: values["preflight-only"] }),
  });
  console.log(JSON.stringify(summary));
}
