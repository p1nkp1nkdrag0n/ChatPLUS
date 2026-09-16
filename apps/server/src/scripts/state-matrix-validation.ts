import { createHash } from "node:crypto";
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
  buildStateMatrixValidationPrompts,
  type StateMatrixFrozenBaseline,
} from "./state-matrix-validation-prompts.js";

export const STATE_MATRIX_REQUEST_LIMITS = {
  baseline: 56,
  candidate: 40,
} as const;
export const STATE_MATRIX_OUTPUT_CAP = 4096;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
type Prepared = ReturnType<typeof buildStateMatrixValidationPrompts>;
type Cell = Prepared["cells"][number];
type Phase = keyof typeof STATE_MATRIX_REQUEST_LIMITS;

/** Verify the provider sent exactly the prepared logical prompts and unchanged
 * model/schema/transport parameters. Semantic intervention proofs live in the
 * builder; this guard prevents provider additions from silently confounding it. */
export function stateMatrixWireProof(
  body: unknown,
  cell: Pick<Cell, "system" | "prompt">,
) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Expected a JSON request body");
  const normalized = structuredClone(body) as Record<string, unknown>;
  if (!Array.isArray(normalized["messages"]))
    throw new Error("Missing wire messages");
  for (const [role, content] of [
    ["system", cell.system],
    ["user", cell.prompt],
  ] as const) {
    const matches = (normalized["messages"] as unknown[]).filter(
      (message): message is Record<string, unknown> =>
        !!message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>)["role"] === role &&
        typeof (message as Record<string, unknown>)["content"] === "string" &&
        ((message as Record<string, unknown>)["content"] as string).includes(
          content,
        ),
    );
    if (matches.length !== 1 || !content)
      throw new Error(
        `Wire ${role} content differs: expected exactly one nonempty prepared prompt`,
      );
    const message = matches[0]!;
    const actual = message["content"];
    if (typeof actual !== "string" || actual.split(content).length !== 2)
      throw new Error(`Wire ${role} content differs from prepared prompt`);
    message["content"] = actual.replace(content, `[FROZEN_${role}_PROMPT]`);
  }
  return {
    requestSha256: hash(body),
    nonPromptRequestSha256: hash(normalized),
  };
}

interface Result {
  cellId: string;
  caseId: string;
  pairingId: string;
  personaId: string;
  condition: string;
  text: string;
  raw?: unknown;
  error?: string;
  elapsedMs: number;
  metrics: LlmCallMetric[];
  accounting: ReturnType<typeof steeringAttemptAccounting>;
}

export async function runStateMatrixValidation(options: {
  output: string;
  phase?: Phase;
  baseline?: string;
  fixture?: boolean;
  preflightOnly?: boolean;
}) {
  const phase = options.phase ?? "baseline";
  if (
    !options.fixture &&
    !options.preflightOnly &&
    process.env["RUN_PAID_ARCHITECTURE_EVAL"] !== "1"
  )
    throw new Error("Real calls require RUN_PAID_ARCHITECTURE_EVAL=1");
  if (phase === "candidate" && !options.baseline)
    throw new Error(
      "Candidate evaluation requires a frozen --baseline directory",
    );
  if (phase === "baseline" && options.baseline)
    throw new Error("Baseline phase cannot inherit a previous run");
  const directory = admitArchitectureOutput(options.output);
  const frozenBaseline = options.baseline
    ? (
        JSON.parse(
          readFileSync(
            join(resolve(options.baseline), "prompt-manifest.json"),
            "utf8",
          ),
        ) as { baseline: StateMatrixFrozenBaseline }
      ).baseline
    : undefined;
  const prepared =
    phase === "candidate"
      ? buildStateMatrixValidationPrompts({
          phase,
          frozenBaseline: frozenBaseline!,
        })
      : buildStateMatrixValidationPrompts({ phase });
  let baselineWireSha256: string | undefined;
  if (phase === "candidate" && !options.preflightOnly) {
    const previous = JSON.parse(
      readFileSync(join(resolve(options.baseline!), "summary.json"), "utf8"),
    ) as {
      phase?: string;
      fixture?: boolean;
      physicalRequests?: number;
    };
    if (
      previous.phase !== "baseline" ||
      previous.fixture !== !!options.fixture ||
      previous.physicalRequests !== STATE_MATRIX_REQUEST_LIMITS.baseline
    )
      throw new Error(
        "Candidate comparison requires the completed baseline in the same execution mode",
      );
    baselineWireSha256 = (
      JSON.parse(
        readFileSync(
          join(resolve(options.baseline!), "wire-proof.json"),
          "utf8",
        ),
      ) as {
        nonPromptRequestSha256?: string;
      }
    ).nonPromptRequestSha256;
    if (!baselineWireSha256) throw new Error("Missing baseline wire proof");
  }
  const maximum = STATE_MATRIX_REQUEST_LIMITS[phase];
  if (
    prepared.cells.length !== maximum ||
    new Set(prepared.cells.map((cell) => cell.cellId)).size !== maximum
  )
    throw new Error(
      "Frozen phase must contain exactly the admitted unique candidates",
    );
  const { base, profile: configuredProfile } = architectureRunConfig(
    directory,
    !!options.fixture || !!options.preflightOnly,
  );
  const maxOutputTokens = Math.min(
    STATE_MATRIX_OUTPUT_CAP,
    configuredProfile.capabilities?.maxOutputTokens ?? STATE_MATRIX_OUTPUT_CAP,
  );
  const profile = { ...configuredProfile, maxRetries: 0, maxOutputTokens };
  const secrets = [
    profile.apiKey ?? "",
    base.instanceSecret ?? "",
    base.llm.apiKey ?? "",
  ];
  mkdirSync(directory, { recursive: true });
  const save = (name: string, value: unknown) =>
    writeFileSync(
      join(directory, name),
      `${JSON.stringify(redactLongRunArtifact(visibleEvidence(value), secrets), null, 2)}\n`,
    );
  const sourcePaths = [
    "apps/server/src/scripts/state-matrix-validation.ts",
    "apps/server/src/scripts/state-matrix-validation-prompts.ts",
    "apps/server/src/scripts/state-matrix-validation-cases.ts",
    "apps/server/src/scripts/architecture-persona-cases.ts",
    "apps/server/src/scripts/architecture-prompt-ablation.ts",
    "apps/server/src/domain/defaults.ts",
    "packages/features/src/runtime-state-description.ts",
    "packages/features/src/reply-strategy.ts",
    "packages/features/src/prompt-assembler.ts",
    "packages/features/src/prompt-segments/default-segments.ts",
    "packages/features/src/prompt-segments/registry.ts",
    "packages/features/src/reply-task-grounding-policy.ts",
    "apps/server/src/scripts/architecture-run-admission.ts",
    "apps/server/src/scripts/continuity-metered-fetch.ts",
    "apps/server/src/scripts/reply-steering-runner.ts",
    "packages/providers/src/openai-compatible-llm.ts",
  ];
  const sourceHashes: Record<string, string> = {};
  for (const path of sourcePaths) {
    const source = readFileSync(resolve(path), "utf8");
    sourceHashes[path] = hash(source);
    const destination = join(directory, "source", path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  }
  const protocol = readFileSync(
    resolve("docs/evals/state-matrix-validation.md"),
    "utf8",
  );
  writeFileSync(join(directory, "protocol.md"), protocol);
  const budget = {
    maxPhysicalRequests: maximum,
    maxReservedTokenUnits: 6_000_000,
  };
  save("manifest.json", {
    version: "state-matrix-validation-v1",
    phase,
    startedAtUtc: new Date().toISOString(),
    protocolSha256: hash(protocol),
    sourceHashes,
    ...(frozenBaseline === undefined
      ? {}
      : { frozenBaselineSha256: hash(frozenBaseline) }),
    identity: await captureContinuityRunIdentity({
      config: { ...base, llm: profile },
      explicitSecrets: secrets,
      experiment: {
        phase,
        fixture: !!options.fixture,
        preflightOnly: !!options.preflightOnly,
        budget,
        maxOutputTokens,
        maxRetries: 0,
        concurrency: 2,
        candidates: prepared.cells.length,
        execution:
          "Direct provider main generation; no repair, paid judge, schema retry, failed-sample refill, or state commit. Continuity snapshots are authored probes, not model-driven rollouts.",
        order:
          "Pair-grouped, fixed SHA256 condition order, at most two physical calls in flight.",
      },
    }),
  });
  save("prompt-manifest.json", prepared.promptManifest);
  save("prompt-cells.json", prepared.cells);
  save("shared-review-context.json", prepared.sharedReviewContexts);
  if (options.preflightOnly) {
    const summary = {
      phase,
      preflightOnly: true,
      candidates: prepared.cells.length,
      physicalRequests: 0,
    };
    save("summary.json", summary);
    return summary;
  }
  const results: Result[] = [];
  const ledgerPath = join(directory, "attempts.jsonl");
  const ordered = [...prepared.cells].sort(
    (a, b) =>
      a.pairingId.localeCompare(b.pairingId) ||
      hash(`state-matrix-v1/${a.cellId}`).localeCompare(
        hash(`state-matrix-v1/${b.cellId}`),
      ),
  );
  const wireRequests: Array<{ cellId: string; requestSha256: string }> = [];
  let commonWireSha256: string | undefined = baselineWireSha256;
  const saveResults = () => {
    save(
      "results.json",
      [...results].sort((a, b) => a.cellId.localeCompare(b.cellId)),
    );
    const mapped = results.map((row) => ({
      ...row,
      candidateId: `C-${hash(`state-matrix/${phase}/${row.cellId}`).slice(0, 16)}`,
    }));
    save(
      "anonymous-candidates.json",
      mapped
        .map((row) => ({
          candidateId: row.candidateId,
          pairingId: row.pairingId,
          caseId: row.caseId,
          text: row.text,
          raw: row.raw,
          status: row.error ? "generation_error" : "completed",
        }))
        .sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
    );
    save(
      "private-anonymous-mapping.json",
      mapped.map((row) => ({
        candidateId: row.candidateId,
        cellId: row.cellId,
        caseId: row.caseId,
        condition: row.condition,
        personaId: row.personaId,
      })),
    );
  };
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (cursor < ordered.length) {
        const cell = ordered[cursor++]!;
        const metrics: LlmCallMetric[] = [];
        const started = performance.now();
        let text = "";
        let raw: unknown;
        let error: string | undefined;
        const metered = createContinuityMeteredFetch({
          ledgerPath,
          budget,
          secrets,
          projectResponse: visibleEvidence,
          ...(options.fixture ? { fetch: architectureFixtureFetch } : {}),
          context: () => ({
            id: cell.cellId,
            purpose: "chat_turn",
            logicalCallIndex: cell.cellId,
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
          fetch: (url, init) => {
            if (typeof init?.body !== "string")
              throw new Error("Missing wire body");
            const proof = stateMatrixWireProof(JSON.parse(init.body), cell);
            if (
              commonWireSha256 !== undefined &&
              commonWireSha256 !== proof.nonPromptRequestSha256
            )
              throw new Error(
                "Non-prompt model/schema/transport parameters changed within run",
              );
            if (wireRequests.some((row) => row.cellId === cell.cellId))
              throw new Error(
                "Each candidate may issue at most one physical request",
              );
            commonWireSha256 = proof.nonPromptRequestSha256;
            wireRequests.push({
              cellId: cell.cellId,
              requestSha256: proof.requestSha256,
            });
            save("wire-proof.json", {
              nonPromptRequestSha256: commonWireSha256,
              requests: wireRequests,
            });
            return metered(url, init);
          },
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
        results.push({
          cellId: cell.cellId,
          caseId: cell.caseId,
          pairingId: cell.pairingId,
          personaId: cell.personaId,
          condition: cell.condition,
          text,
          raw,
          ...(error ? { error } : {}),
          elapsedMs: Math.round(performance.now() - started),
          metrics,
          accounting: steeringAttemptAccounting(
            readSteeringAttempts(ledgerPath, cell.cellId),
          ),
        });
        saveResults();
        console.log(
          `STATE_MATRIX ${phase} ${results.length}/${ordered.length} ${cell.cellId} ${error ? "error" : "completed"}`,
        );
      }
    }),
  );
  const summary = {
    phase,
    fixture: !!options.fixture,
    completed: results.filter((row) => !row.error).length,
    errors: results.filter((row) => row.error).length,
    physicalRequests: results.reduce(
      (sum, row) => sum + row.accounting.physicalRequests,
      0,
    ),
    usageComplete: results.every((row) => row.accounting.usageComplete),
    interpretation:
      "Single-sample state matrix probes. Case-aware review is required; no automatic necessity or quality verdict.",
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
      phase: { type: "string", default: "baseline" },
      baseline: { type: "string" },
      fixture: { type: "boolean" },
      "preflight-only": { type: "boolean" },
    },
  });
  if (!values.output || !["baseline", "candidate"].includes(values.phase))
    throw new Error("Use --output tmp/<fresh-run> --phase baseline|candidate");
  console.log(
    JSON.stringify(
      await runStateMatrixValidation({
        output: values.output,
        phase: values.phase as Phase,
        ...(values.baseline === undefined ? {} : { baseline: values.baseline }),
        ...(values.fixture === undefined ? {} : { fixture: values.fixture }),
        ...(values["preflight-only"] === undefined
          ? {}
          : { preflightOnly: values["preflight-only"] }),
      }),
    ),
  );
}
