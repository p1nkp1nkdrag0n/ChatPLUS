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
import { parseArchitecturePrompt } from "./architecture-prompt-ablation.js";
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
  REPLY_GROUNDING_EVALUATION_CASES,
  REPLY_GROUNDING_EVALUATION_RUBRIC,
  REPLY_GROUNDING_EVALUATION_VERSION,
} from "./reply-grounding-evaluation-cases.js";
import {
  buildReplyGroundingEvaluationCells,
  replyGroundingEvaluationHash as hash,
  replyGroundingWireProof,
  REPLY_GROUNDING_EVALUATION_ARMS,
  type ReplyGroundingEvaluationCell,
} from "./reply-grounding-evaluation-prompts.js";

export const REPLY_GROUNDING_EVALUATION_BUDGET = {
  maxPhysicalRequests: 32,
  maxReservedTokenUnits: 4_000_000,
} as const;
export const REPLY_GROUNDING_EVALUATION_OUTPUT_CAP = 4096;
interface CandidateResult {
  id: string;
  caseId: string;
  arm: ReplyGroundingEvaluationCell["arm"];
  text: string;
  raw?: unknown;
  error?: string;
  elapsedMs: number;
  metrics: LlmCallMetric[];
  accounting: ReturnType<typeof steeringAttemptAccounting>;
}

export async function runReplyGroundingEvaluation(options: {
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
  // The documented PERSONASIM_LOAD_ENV=false startup prevents dotenv import IO;
  // offline config below independently avoids private profile resolution.
  const { base, profile: configuredProfile } = architectureRunConfig(
    directory,
    !!options.fixture || !!options.preflightOnly,
  );
  const maxOutputTokens = Math.min(
    REPLY_GROUNDING_EVALUATION_OUTPUT_CAP,
    configuredProfile.capabilities?.maxOutputTokens ??
      REPLY_GROUNDING_EVALUATION_OUTPUT_CAP,
  );
  const profile = { ...configuredProfile, maxRetries: 0, maxOutputTokens };
  const secrets = [
    profile.apiKey ?? "",
    base.instanceSecret ?? "",
    base.llm.apiKey ?? "",
  ];
  const prepared = buildReplyGroundingEvaluationCells();
  if (
    prepared.cells.length >
    REPLY_GROUNDING_EVALUATION_BUDGET.maxPhysicalRequests
  )
    throw new Error(
      "Registered candidates exceed the hard physical-request cap",
    );
  mkdirSync(directory, { recursive: true });
  const save = (name: string, value: unknown) => {
    writeFileSync(
      join(directory, name),
      `${JSON.stringify(redactLongRunArtifact(visibleEvidence(value), secrets), null, 2)}\n`,
    );
  };
  const sourcePaths = [
    "apps/server/src/scripts/reply-grounding-evaluation.ts",
    "apps/server/src/scripts/reply-grounding-evaluation-prompts.ts",
    "apps/server/src/scripts/reply-grounding-evaluation-cases.ts",
    "apps/server/src/scripts/runtime-state-audit-cases.ts",
    "apps/server/src/scripts/architecture-persona-cases.ts",
    "apps/server/src/scripts/architecture-prompt-ablation.ts",
    "apps/server/src/domain/defaults.ts",
    "packages/features/src/reply-task-grounding-policy.ts",
    "packages/features/src/prompt-assembler.ts",
    "packages/features/src/prompt-segments/registry.ts",
    "packages/features/src/prompt-segments/default-segments.ts",
    "packages/features/src/reply-strategy.ts",
    "packages/features/src/runtime-state-description.ts",
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
    resolve("docs/evals/reply-grounding-completeness.md"),
    "utf8",
  );
  writeFileSync(join(directory, "protocol.md"), protocol);
  save("manifest.json", {
    version: REPLY_GROUNDING_EVALUATION_VERSION,
    startedAtUtc: new Date().toISOString(),
    protocolSha256: hash(protocol),
    sourceHashes,
    identity: await captureContinuityRunIdentity({
      config: { ...base, llm: profile },
      explicitSecrets: secrets,
      experiment: {
        kind: "reply-grounding-policy-main-generation",
        fixture: !!options.fixture,
        preflightOnly: !!options.preflightOnly,
        arms: REPLY_GROUNDING_EVALUATION_ARMS,
        candidates: prepared.cells.length,
        caseIds: REPLY_GROUNDING_EVALUATION_CASES.map((probe) => probe.id),
        samplesPerCaseArm: 1,
        budget: REPLY_GROUNDING_EVALUATION_BUDGET,
        maxOutputTokens,
        maxRetries: 0,
        concurrency: 2,
        intervention:
          "Only remove the exact newly admitted policy block. Current production state readout and derived strategy remain unchanged; no neutral replacement or budget refill. Not the complete old product.",
        execution:
          "Direct provider main generation only; no repair, schema retry, paid judge or replacement for failures. HTTP guard/repair integration is evaluated separately.",
        order:
          "Case-paired, fixed SHA256 arm order; at most two physical requests in flight.",
      },
    }),
  });
  save("production-assembler-captures.json", prepared.captures);
  save("prompt-cells.json", prepared.cells);
  save("shared-review-context.json", {
    rubric: REPLY_GROUNDING_EVALUATION_RUBRIC,
    cases: prepared.captures.map((capture) => {
      const probe = REPLY_GROUNDING_EVALUATION_CASES.find(
        (item) => item.id === capture.caseId,
      )!;
      return {
        pairingId: hash(capture.caseId).slice(0, 12),
        caseId: probe.id,
        title: probe.title,
        origin: probe.origin,
        inputCharacter: capture.input.character,
        admittedPersona: parseArchitecturePrompt(capture.assembled).filter(
          (segment) =>
            [
              "02_character_identity",
              "03_core_persona",
              "04_values_conflicts",
              "05_boundaries",
            ].includes(segment.id),
        ),
        personaReviewAuthority:
          "Judge persona continuity using admittedPersona; inputCharacter is provenance, including material that may not have entered the model.",
        state: capture.input.state,
        history: probe.history,
        userText: probe.userText,
        criteria: probe.criteria,
      };
    }),
  });
  if (options.preflightOnly) {
    const summary = {
      preflightOnly: true,
      candidates: prepared.cells.length,
      physicalRequests: 0,
    };
    save("summary.json", summary);
    return summary;
  }
  const results: CandidateResult[] = [];
  const ledgerPath = join(directory, "attempts.jsonl");
  const wirePairs = new Map<
    string,
    {
      nonPolicyRequestSha256: string;
      requests: Array<{ id: string; requestSha256: string }>;
    }
  >();
  const ordered = REPLY_GROUNDING_EVALUATION_CASES.flatMap((probe) =>
    prepared.cells
      .filter((cell) => cell.caseId === probe.id)
      .sort((a, b) =>
        hash(`${REPLY_GROUNDING_EVALUATION_VERSION}/${a.id}`).localeCompare(
          hash(`${REPLY_GROUNDING_EVALUATION_VERSION}/${b.id}`),
        ),
      ),
  );
  const saveResults = () => {
    save(
      "results.json",
      [...results].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const mapped = results.map((row) => ({
      ...row,
      candidateId: `C-${hash(`anonymous/${row.id}`).slice(0, 16)}`,
    }));
    save(
      "anonymous-candidates.json",
      mapped
        .map((row) => ({
          candidateId: row.candidateId,
          pairingId: hash(row.caseId).slice(0, 12),
          caseId: row.caseId,
          text: row.text,
          status: row.error ? "generation_error" : "completed",
        }))
        .sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
    );
    save(
      "private-anonymous-mapping.json",
      mapped.map((row) => ({
        candidateId: row.candidateId,
        id: row.id,
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
        const started = performance.now();
        let text = "";
        let raw: unknown;
        let error: string | undefined;
        const metered = createContinuityMeteredFetch({
          ledgerPath,
          budget: REPLY_GROUNDING_EVALUATION_BUDGET,
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
          fetch: (url, init) => {
            if (typeof init?.body !== "string")
              throw new Error("Missing wire body");
            const proof = replyGroundingWireProof(
              JSON.parse(init.body),
              cell.arm,
            );
            const pair = wirePairs.get(cell.caseId) ?? {
              nonPolicyRequestSha256: proof.nonPolicyRequestSha256,
              requests: [],
            };
            if (pair.nonPolicyRequestSha256 !== proof.nonPolicyRequestSha256)
              throw new Error(
                "Paired wire requests differ outside the new policy",
              );
            if (pair.requests.some((request) => request.id === cell.id))
              throw new Error(
                "A candidate cannot issue a second physical request",
              );
            pair.requests.push({
              id: cell.id,
              requestSha256: proof.requestSha256,
            });
            wirePairs.set(cell.caseId, pair);
            save("wire-pair-proof.json", Object.fromEntries(wirePairs));
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
          id: cell.id,
          caseId: cell.caseId,
          arm: cell.arm,
          text,
          raw,
          ...(error ? { error } : {}),
          elapsedMs: Math.round(performance.now() - started),
          metrics,
          accounting: steeringAttemptAccounting(
            readSteeringAttempts(ledgerPath, cell.id),
          ),
        });
        saveResults();
        console.log(
          `GROUNDING_EVAL ${results.length}/${ordered.length} ${cell.id} ${error ? "error" : "completed"}`,
        );
      }
    }),
  );
  const summary = {
    fixture: !!options.fixture,
    completed: results.filter((row) => !row.error).length,
    errors: results.filter((row) => row.error).length,
    physicalRequests: results.reduce(
      (sum, row) => sum + row.accounting.physicalRequests,
      0,
    ),
    usageComplete: results.every((row) => row.accounting.usageComplete),
    interpretation:
      "Single-sample paired main generations; visible evidence requires case-aware review. This report makes no automatic quality verdict.",
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
  console.log(
    JSON.stringify(
      await runReplyGroundingEvaluation({
        output: values.output,
        ...(values.fixture === undefined ? {} : { fixture: values.fixture }),
        ...(values["preflight-only"] === undefined
          ? {}
          : { preflightOnly: values["preflight-only"] }),
      }),
    ),
  );
}
