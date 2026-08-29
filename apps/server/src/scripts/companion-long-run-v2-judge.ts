import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createOpenAiCompatibleLlmProvider } from "@personasim/providers";
import { z } from "zod";

import { readConfig } from "../config.js";
import {
  redactLongRunArtifact,
  writeJsonExclusive,
  writeTextExclusive,
} from "./companion-long-run-v2-artifacts.js";
import { canonicalJson } from "./companion-long-run-v2-baseline.js";
import {
  COMPANION_LONG_RUN_V2_PROFILE_ORDER,
  COMPANION_LONG_RUN_V2_RUBRIC,
  COMPANION_LONG_RUN_V2_SCORE_ANCHORS,
  companionLongRunV2StableHash,
  planCompanionLongRunV2ReviewAssignments,
  planCompanionLongRunV2ReviewBatches,
  type CompanionLongRunV2Profile,
  type CompanionLongRunV2RubricScores,
  type CompanionLongRunV2SemanticConclusion,
} from "./companion-long-run-v2-evaluation.js";
import {
  apiKeyEnvironmentForProfile,
  buildLongRunV2ChildEnvironment,
  evaluatePaidLongRunGuard,
} from "./companion-long-run-v2-profiles.js";
import {
  isLongRunV2Profile,
  type TurnEvidence,
} from "./companion-long-run-v2-run-types.js";

const RubricScoresSchema = z
  .object({
    persona: z.number().int().min(0).max(4),
    daily_relevance: z.number().int().min(0).max(4),
    emotion: z.number().int().min(0).max(4),
    memory_time: z.number().int().min(0).max(4),
    relationship_romance: z.number().int().min(0).max(4),
    independent_life_schedule: z.number().int().min(0).max(4),
    language_naturalness: z.number().int().min(0).max(4),
  })
  .strict()
  .transform((value) => value as CompanionLongRunV2RubricScores);

export const CompanionLongRunV2JudgeBatchResponseSchema = z
  .object({
    reviews: z
      .array(
        z
          .object({
            blindId: z.string().min(1).max(80),
            scores: RubricScoresSchema,
            conclusion: z.enum(["PASS", "PASS_WITH_WARNINGS", "FAIL_SEMANTIC"]),
            rationale: z.string().trim().min(1).max(4_000),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

export interface CompanionLongRunV2JudgeCandidate {
  itemId: string;
  profile: CompanionLongRunV2Profile;
  scenarioId: string;
  runId: string;
  repetition: 1 | 2 | 3;
  candidateNumber: number;
  evidence: {
    scenarioBlock: string;
    rubricTags: readonly string[];
    fakeTimeBeforeUtc: string;
    fakeTimeAfterUtc: string;
    userMessage: string;
    candidateResponse: string;
    assertionSummary: readonly string[];
    promptContext?: string;
    stateContext?: string;
  };
}

export interface CompanionLongRunV2BlindCandidate {
  blindId: string;
  evidence: CompanionLongRunV2JudgeCandidate["evidence"];
}

export interface CompanionLongRunV2JudgeBatchRequest {
  batchId: string;
  reviewerAlias: string;
  repetition: 1 | 2 | 3;
  candidates: readonly CompanionLongRunV2BlindCandidate[];
}

export type CompanionLongRunV2JudgeBatchResponse = z.infer<
  typeof CompanionLongRunV2JudgeBatchResponseSchema
>;

export interface CompanionLongRunV2JudgeTransport {
  judge(
    request: CompanionLongRunV2JudgeBatchRequest,
  ): Promise<CompanionLongRunV2JudgeBatchResponse>;
}

export interface CompanionLongRunV2JudgeMappingKey {
  schemaVersion: "companion-long-run-v2-judge-mapping-key-v1";
  seed: string;
  candidates: readonly {
    blindId: string;
    itemId: string;
    profile: CompanionLongRunV2Profile;
    scenarioId: string;
    runId: string;
    repetition: 1 | 2 | 3;
    candidateNumber: number;
  }[];
  reviewers: readonly {
    reviewerAlias: string;
    profile: CompanionLongRunV2Profile;
  }[];
}

export interface CompanionLongRunV2PublicJudgeReview {
  reviewId: string;
  batchId: string;
  blindId: string;
  reviewerAlias: string;
  scores: CompanionLongRunV2RubricScores;
  conclusion: CompanionLongRunV2SemanticConclusion;
  rationale: string;
}

export interface CompanionLongRunV2JudgeArtifact {
  schemaVersion: "companion-long-run-v2-judge-results-v1";
  seed: string;
  mappingKeySha256: string;
  createdAtUtc: string;
  candidateCount: number;
  batchCount: number;
  reviews: readonly CompanionLongRunV2PublicJudgeReview[];
}

interface PlannedPrivateBatch {
  reviewerProfile: CompanionLongRunV2Profile;
  request: CompanionLongRunV2JudgeBatchRequest;
}

export interface CompanionLongRunV2JudgePlan {
  seed: string;
  mappingKey: CompanionLongRunV2JudgeMappingKey;
  html: string;
  batches: readonly PlannedPrivateBatch[];
}

export type CompanionLongRunV2ProfileJudgeExecutor = (
  profile: CompanionLongRunV2Profile,
  requests: readonly CompanionLongRunV2JudgeBatchRequest[],
) => Promise<readonly CompanionLongRunV2JudgeBatchResponse[]>;

export interface CompanionLongRunV2JudgeCliArgs {
  mode: "orchestrator" | "worker";
  evidencePath?: string;
  outputDirectory?: string;
  seed: string;
  reviewerProfile?: CompanionLongRunV2Profile;
}

export function parseCompanionLongRunV2JudgeArgs(
  argv: readonly string[],
): CompanionLongRunV2JudgeCliArgs {
  let worker = false;
  let evidencePath: string | undefined;
  let outputDirectory: string | undefined;
  let seed = "companion-long-run-v2-judge";
  let reviewerProfile: CompanionLongRunV2Profile | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--worker") {
      worker = true;
      continue;
    }
    const [name, inline] = splitArgument(argument);
    if (name === "--evidence") {
      evidencePath = uniqueValue(
        evidencePath,
        inline ?? requiredValue(argv, ++index, name),
        name,
      );
      continue;
    }
    if (name === "--output-dir") {
      outputDirectory = uniqueValue(
        outputDirectory,
        inline ?? requiredValue(argv, ++index, name),
        name,
      );
      continue;
    }
    if (name === "--seed") {
      seed = inline ?? requiredValue(argv, ++index, name);
      if (seed.trim() === "") throw new TypeError("--seed must not be empty.");
      continue;
    }
    if (name === "--reviewer-profile") {
      const value = inline ?? requiredValue(argv, ++index, name);
      if (!isLongRunV2Profile(value)) {
        throw new TypeError(`Unknown reviewer profile: ${value}`);
      }
      reviewerProfile = uniqueValue(reviewerProfile, value, name);
      continue;
    }
    throw new TypeError(`Unknown judge argument: ${argument}`);
  }
  if (worker) {
    if (reviewerProfile === undefined) {
      throw new TypeError("--worker requires --reviewer-profile.");
    }
    return { mode: "worker", seed, reviewerProfile };
  }
  if (evidencePath === undefined || outputDirectory === undefined) {
    throw new TypeError(
      "Judge requires --evidence <file-or-directory> and --output-dir <directory>.",
    );
  }
  return { mode: "orchestrator", evidencePath, outputDirectory, seed };
}

export function companionLongRunV2JudgeCandidateFromEvidence(
  turn: TurnEvidence,
): CompanionLongRunV2JudgeCandidate {
  if (!isLongRunV2Profile(turn.profile)) {
    throw new TypeError("Fixture evidence cannot enter paid model judging.");
  }
  const promptContext = judgePromptContext(turn);
  return {
    itemId: `${turn.runId}:${turn.track}:${turn.branch}:${turn.turnId}`,
    profile: turn.profile,
    scenarioId: turn.matrixId,
    runId: turn.runId,
    repetition: turn.repetition,
    candidateNumber: turn.candidateOrdinal,
    evidence: {
      scenarioBlock: turn.scenarioBlock,
      rubricTags: [...turn.rubricTags],
      fakeTimeBeforeUtc: turn.fakeTimeBeforeUtc,
      fakeTimeAfterUtc: turn.fakeTimeAfterUtc,
      userMessage: truncate(turn.userMessage, 20_000),
      candidateResponse: truncate(extractCandidateResponse(turn), 30_000),
      assertionSummary: turn.assertions.map(
        (assertion) =>
          `${assertion.code}:${assertion.status}:${assertion.summary}`,
      ),
      ...(promptContext === "" ? {} : { promptContext }),
      stateContext: truncate(
        JSON.stringify({
          before: compactStateSnapshot(turn.before),
          after: compactStateSnapshot(turn.after),
        }),
        16_000,
      ),
    },
  };
}

export async function readCompanionLongRunV2JudgeCandidates(
  sourcePath: string,
): Promise<CompanionLongRunV2JudgeCandidate[]> {
  const files = await evidenceFiles(resolve(sourcePath));
  const turns: TurnEvidence[] = [];
  for (const file of files) {
    const lines = (await readFile(file, "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== "");
    for (const [index, line] of lines.entries()) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${file}:${String(index + 1)}.`, {
          cause: error,
        });
      }
      if (
        isRecord(value) &&
        value["schemaVersion"] === "companion-long-run-turn-evidence-v2"
      ) {
        turns.push(value as unknown as TurnEvidence);
      }
    }
  }
  const candidates = turns.map(companionLongRunV2JudgeCandidateFromEvidence);
  if (candidates.length === 0) {
    throw new Error(
      `No companion long-run v2 turn evidence found in ${sourcePath}.`,
    );
  }
  return candidates;
}

export function planCompanionLongRunV2Judge(
  rawCandidates: readonly CompanionLongRunV2JudgeCandidate[],
  seed: string,
): CompanionLongRunV2JudgePlan {
  if (seed.trim() === "") throw new TypeError("Judge seed must not be empty.");
  const candidates = stableCandidates(rawCandidates);
  const byItemId = new Map(
    candidates.map((candidate) => [candidate.itemId, candidate]),
  );
  if (byItemId.size !== candidates.length) {
    throw new Error("Judge candidates must have unique itemId values.");
  }
  const blindIds = new Map(
    candidates.map((candidate) => [
      candidate.itemId,
      `candidate-${companionLongRunV2StableHash(seed, "candidate", candidate.itemId)}`,
    ]),
  );
  if (new Set(blindIds.values()).size !== blindIds.size) {
    throw new Error("Blind candidate hash collision; choose a different seed.");
  }
  const reviewerAliases = new Map(
    COMPANION_LONG_RUN_V2_PROFILE_ORDER.map((profile) => [
      profile,
      `reviewer-${companionLongRunV2StableHash(seed, "reviewer", profile)}`,
    ]),
  );
  const assignments = planCompanionLongRunV2ReviewAssignments(
    candidates.map((candidate) => ({
      itemId: candidate.itemId,
      profile: candidate.profile,
      scenarioId: candidate.scenarioId,
      runId: candidate.runId,
      repetition: candidate.repetition,
    })),
  );
  const batches = planCompanionLongRunV2ReviewBatches(assignments).map(
    (batch) => {
      const reviewerAlias = reviewerAliases.get(batch.reviewerProfile);
      if (reviewerAlias === undefined)
        throw new Error("Reviewer alias is missing.");
      return {
        reviewerProfile: batch.reviewerProfile,
        request: {
          batchId: batch.batchId,
          reviewerAlias,
          repetition: batch.reviewRound,
          candidates: batch.assignments.map((assignment) => {
            if (assignment.reviewerProfile === assignment.profile) {
              throw new Error("Self-review reached the judge plan.");
            }
            const candidate = byItemId.get(assignment.itemId);
            const blindId = blindIds.get(assignment.itemId);
            if (candidate === undefined || blindId === undefined) {
              throw new Error(
                "Review assignment references an unknown candidate.",
              );
            }
            return { blindId, evidence: candidate.evidence };
          }),
        },
      } satisfies PlannedPrivateBatch;
    },
  );
  const mappingKey: CompanionLongRunV2JudgeMappingKey = {
    schemaVersion: "companion-long-run-v2-judge-mapping-key-v1",
    seed,
    candidates: candidates.map((candidate) => ({
      blindId: blindIds.get(candidate.itemId)!,
      itemId: candidate.itemId,
      profile: candidate.profile,
      scenarioId: candidate.scenarioId,
      runId: candidate.runId,
      repetition: candidate.repetition,
      candidateNumber: candidate.candidateNumber,
    })),
    reviewers: COMPANION_LONG_RUN_V2_PROFILE_ORDER.map((profile) => ({
      reviewerAlias: reviewerAliases.get(profile)!,
      profile,
    })),
  };
  return {
    seed,
    mappingKey,
    html: renderCompanionLongRunV2BlindReviewHtml(
      candidates.map((candidate) => ({
        blindId: blindIds.get(candidate.itemId)!,
        evidence: candidate.evidence,
      })),
    ),
    batches,
  };
}

export async function executeCompanionLongRunV2JudgePlan(input: {
  plan: CompanionLongRunV2JudgePlan;
  executeProfile: CompanionLongRunV2ProfileJudgeExecutor;
  createdAtUtc?: string;
}): Promise<CompanionLongRunV2JudgeArtifact> {
  const responses = new Map<string, CompanionLongRunV2JudgeBatchResponse>();
  for (const profile of COMPANION_LONG_RUN_V2_PROFILE_ORDER) {
    const profileBatches = input.plan.batches.filter(
      (batch) => batch.reviewerProfile === profile,
    );
    if (profileBatches.length === 0) continue;
    const profileResponses = await input.executeProfile(
      profile,
      profileBatches.map((batch) => batch.request),
    );
    if (profileResponses.length !== profileBatches.length) {
      throw new Error(`Reviewer ${profile} returned the wrong batch count.`);
    }
    profileBatches.forEach((batch, index) => {
      const response = CompanionLongRunV2JudgeBatchResponseSchema.parse(
        profileResponses[index],
      );
      assertBatchResponseMatches(batch.request, response);
      responses.set(batch.request.batchId, response);
    });
  }
  const reviews: CompanionLongRunV2PublicJudgeReview[] = [];
  for (const batch of input.plan.batches) {
    const response = responses.get(batch.request.batchId);
    if (response === undefined)
      throw new Error("A judge batch response is missing.");
    for (const result of response.reviews) {
      reviews.push({
        reviewId: `judge-${companionLongRunV2StableHash(
          input.plan.seed,
          batch.request.batchId,
          result.blindId,
          batch.request.reviewerAlias,
        )}`,
        batchId: batch.request.batchId,
        blindId: result.blindId,
        reviewerAlias: batch.request.reviewerAlias,
        scores: result.scores,
        conclusion: result.conclusion,
        rationale: result.rationale,
      });
    }
  }
  return {
    schemaVersion: "companion-long-run-v2-judge-results-v1",
    seed: input.plan.seed,
    mappingKeySha256: sha256Canonical(input.plan.mappingKey),
    createdAtUtc: input.createdAtUtc ?? new Date().toISOString(),
    candidateCount: input.plan.mappingKey.candidates.length,
    batchCount: input.plan.batches.length,
    reviews,
  };
}

export function createCurrentProfileCompanionLongRunV2JudgeTransport(
  expectedProfile: CompanionLongRunV2Profile,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): CompanionLongRunV2JudgeTransport {
  const guard = evaluatePaidLongRunGuard(environment);
  if (guard.status !== "READY") throw new Error(guard.reason);
  const config = readConfig();
  if (config.llm.provider !== "openai-compatible" || !config.llm.apiKey) {
    throw new TypeError(
      `Reviewer ${expectedProfile} has no live API credential.`,
    );
  }
  const resolvedProfile = config.llm.profileName ?? "deepseek";
  if (resolvedProfile !== expectedProfile) {
    throw new TypeError(
      `Judge worker expected ${expectedProfile}, but current profile is ${resolvedProfile}.`,
    );
  }
  const provider = createOpenAiCompatibleLlmProvider({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    timeoutMs: config.llm.timeoutMs,
    maxRetries: config.llm.maxRetries,
    ...(config.llm.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: config.llm.maxOutputTokens }),
    ...(config.llm.capabilities === undefined
      ? {}
      : { capabilities: config.llm.capabilities }),
  });
  return {
    async judge(request) {
      return provider.generateObject({
        purpose: "chat_turn",
        system: judgeSystemPrompt(),
        prompt: judgeBatchPrompt(request),
        schema: CompanionLongRunV2JudgeBatchResponseSchema,
        maxRetries: config.llm.maxRetries,
        temperature: 0,
        ...(config.llm.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: config.llm.maxOutputTokens }),
      });
    },
  };
}

export async function writeCompanionLongRunV2JudgeArtifactsExclusive(input: {
  outputDirectory: string;
  plan: CompanionLongRunV2JudgePlan;
  artifact: CompanionLongRunV2JudgeArtifact;
  environment?: Readonly<NodeJS.ProcessEnv>;
}): Promise<{ resultsPath: string; htmlPath: string; mappingKeyPath: string }> {
  const directory = resolve(input.outputDirectory);
  const resultsPath = join(directory, "judge-results.json");
  const htmlPath = join(directory, "blind-review.html");
  const mappingKeyPath = join(directory, "model-mapping-key.private.json");
  const secrets = environmentSecrets(input.environment ?? process.env);
  await writeJsonExclusive(
    mappingKeyPath,
    redactLongRunArtifact(input.plan.mappingKey, secrets),
  );
  await writeTextExclusive(htmlPath, input.plan.html);
  await writeJsonExclusive(
    resultsPath,
    redactLongRunArtifact(input.artifact, secrets),
  );
  return { resultsPath, htmlPath, mappingKeyPath };
}

export function renderCompanionLongRunV2BlindReviewHtml(
  candidates: readonly CompanionLongRunV2BlindCandidate[],
): string {
  const rubric = COMPANION_LONG_RUN_V2_RUBRIC.map(
    (dimension) =>
      `<li><code>${escapeHtml(dimension.key)}</code> (${String(
        dimension.weight * 100,
      )}%): ${escapeHtml(dimension.description)}</li>`,
  ).join("");
  const cards = [...candidates]
    .sort((left, right) => compareText(left.blindId, right.blindId))
    .map(
      (candidate) => `<article>
<h2>${escapeHtml(candidate.blindId)}</h2>
<p><b>Scenario:</b> ${escapeHtml(candidate.evidence.scenarioBlock)}</p>
<p><b>Time:</b> ${escapeHtml(candidate.evidence.fakeTimeBeforeUtc)} → ${escapeHtml(candidate.evidence.fakeTimeAfterUtc)}</p>
<h3>User</h3><pre>${escapeHtml(candidate.evidence.userMessage)}</pre>
<h3>Candidate</h3><pre>${escapeHtml(candidate.evidence.candidateResponse)}</pre>
${
  candidate.evidence.promptContext === undefined
    ? ""
    : `<h3>Prompt context</h3><pre>${escapeHtml(candidate.evidence.promptContext)}</pre>`
}
${
  candidate.evidence.stateContext === undefined
    ? ""
    : `<h3>State context</h3><pre>${escapeHtml(candidate.evidence.stateContext)}</pre>`
}
<p><b>Rubric tags:</b> ${escapeHtml(candidate.evidence.rubricTags.join(", "))}</p>
</article>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>ChatPLUS companion long-run v2 blind review</title>
<style>body{max-width:960px;margin:2rem auto;padding:0 1rem;font:16px/1.5 system-ui;color:#1d2433}article{border:1px solid #ccd3df;border-radius:10px;padding:1rem;margin:1.5rem 0}pre{white-space:pre-wrap;background:#f5f7fa;padding:.8rem;border-radius:6px}code{font-weight:700}</style></head>
<body><h1>Anonymous companion long-run review</h1>
<p>Score every dimension from 0 through 4. Candidate and reviewer model identities are intentionally absent.</p>
<ol>${rubric}</ol>
<p>Anchors: ${escapeHtml(
    Object.entries(COMPANION_LONG_RUN_V2_SCORE_ANCHORS)
      .map(([score, anchor]) => `${score}=${anchor}`)
      .join(" | "),
  )}</p>
${cards}</body></html>\n`;
}

export async function runCompanionLongRunV2JudgeCli(
  argv: readonly string[] = process.argv.slice(2),
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  executeProfile: CompanionLongRunV2ProfileJudgeExecutor = spawnCompanionLongRunV2JudgeWorker,
): Promise<number> {
  const args = parseCompanionLongRunV2JudgeArgs(argv);
  const guard = evaluatePaidLongRunGuard(environment);
  if (guard.status !== "READY") {
    process.stdout.write(`SKIP: ${guard.reason}\n`);
    return 0;
  }
  if (args.mode === "worker") {
    await runJudgeWorker(args.reviewerProfile!, environment);
    return 0;
  }
  const candidates = await readCompanionLongRunV2JudgeCandidates(
    args.evidencePath!,
  );
  const plan = planCompanionLongRunV2Judge(candidates, args.seed);
  assertReviewerCredentialsPresent(plan, environment);
  const artifact = await executeCompanionLongRunV2JudgePlan({
    plan,
    executeProfile,
  });
  const paths = await writeCompanionLongRunV2JudgeArtifactsExclusive({
    outputDirectory: args.outputDirectory!,
    plan,
    artifact,
    environment,
  });
  process.stdout.write(`${JSON.stringify(paths)}\n`);
  return 0;
}

export async function spawnCompanionLongRunV2JudgeWorker(
  profile: CompanionLongRunV2Profile,
  requests: readonly CompanionLongRunV2JudgeBatchRequest[],
): Promise<readonly CompanionLongRunV2JudgeBatchResponse[]> {
  const entry = process.argv[1];
  if (entry === undefined)
    throw new Error("Judge CLI entry point is unavailable.");
  const child = spawn(
    process.execPath,
    [...process.execArgv, entry, "--worker", "--reviewer-profile", profile],
    {
      env: buildLongRunV2ChildEnvironment(profile, process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(JSON.stringify({ requests }));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (exitCode !== 0) {
    const detail = String(
      redactLongRunArtifact(
        Buffer.concat(stderr).toString("utf8").slice(0, 8_000),
        environmentSecrets(process.env),
      ),
    );
    throw new Error(`Judge worker ${profile} failed: ${detail}`);
  }
  const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
    responses?: unknown;
  };
  if (!Array.isArray(parsed.responses)) {
    throw new Error(`Judge worker ${profile} returned an invalid envelope.`);
  }
  return parsed.responses.map((response) =>
    CompanionLongRunV2JudgeBatchResponseSchema.parse(response),
  );
}

async function runJudgeWorker(
  profile: CompanionLongRunV2Profile,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<void> {
  const input = JSON.parse(await readStandardInput()) as { requests?: unknown };
  if (!Array.isArray(input.requests)) {
    throw new TypeError("Judge worker input must contain requests[].");
  }
  const transport = createCurrentProfileCompanionLongRunV2JudgeTransport(
    profile,
    environment,
  );
  const responses: CompanionLongRunV2JudgeBatchResponse[] = [];
  for (const rawRequest of input.requests) {
    const request = rawRequest as CompanionLongRunV2JudgeBatchRequest;
    responses.push(
      CompanionLongRunV2JudgeBatchResponseSchema.parse(
        await transport.judge(request),
      ),
    );
  }
  process.stdout.write(JSON.stringify({ responses }));
}

function judgeSystemPrompt(): string {
  return [
    "You are an independent blinded evaluator for a long-horizon companion conversation test.",
    "Never infer or mention candidate or reviewer model identity.",
    "Score only observable evidence, from 0 through 4, using every rubric dimension.",
    "A fluent answer must still fail when it contradicts persona, memory/time, emotion, or relationship evidence.",
    "Return exactly the requested JSON object and one review per blindId.",
  ].join("\n");
}

function judgeBatchPrompt(
  request: CompanionLongRunV2JudgeBatchRequest,
): string {
  return [
    `BATCH_ID ${request.batchId}`,
    `RUBRIC ${JSON.stringify(COMPANION_LONG_RUN_V2_RUBRIC)}`,
    `SCORE_ANCHORS ${JSON.stringify(COMPANION_LONG_RUN_V2_SCORE_ANCHORS)}`,
    `ANONYMOUS_CANDIDATES ${JSON.stringify(request.candidates)}`,
    "Return reviews in the same blindId set. Do not add, omit, or duplicate candidates.",
  ].join("\n\n");
}

function assertBatchResponseMatches(
  request: CompanionLongRunV2JudgeBatchRequest,
  response: CompanionLongRunV2JudgeBatchResponse,
): void {
  const expected = request.candidates
    .map((candidate) => candidate.blindId)
    .sort();
  const actual = response.reviews.map((review) => review.blindId).sort();
  if (
    actual.length !== new Set(actual).size ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `Judge response blindId set does not match ${request.batchId}.`,
    );
  }
}

function stableCandidates(
  candidates: readonly CompanionLongRunV2JudgeCandidate[],
): CompanionLongRunV2JudgeCandidate[] {
  const profileIndex = new Map(
    COMPANION_LONG_RUN_V2_PROFILE_ORDER.map((profile, index) => [
      profile,
      index,
    ]),
  );
  return [...candidates].sort(
    (left, right) =>
      (profileIndex.get(left.profile) ?? 0) -
        (profileIndex.get(right.profile) ?? 0) ||
      left.repetition - right.repetition ||
      compareText(left.runId, right.runId) ||
      left.candidateNumber - right.candidateNumber ||
      compareText(left.itemId, right.itemId),
  );
}

async function evidenceFiles(path: string): Promise<string[]> {
  const details = await stat(path);
  if (details.isFile()) return [path];
  if (!details.isDirectory())
    throw new TypeError(`${path} is not a file or directory.`);
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const nested = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await evidenceFiles(nested)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl"))
      files.push(nested);
  }
  return files.sort(compareText);
}

function extractCandidateResponse(turn: TurnEvidence): string {
  for (const value of [
    turn.persistedAssistant,
    turn.applicationResponse,
    turn.parsedCandidateOutput,
    turn.rawCandidateOutput,
  ]) {
    const text = textFromUnknown(value, 0);
    if (text !== "") return text;
  }
  return "[NO_CANDIDATE_RESPONSE_CAPTURED]";
}

function judgePromptContext(turn: TurnEvidence): string {
  return truncate(
    turn.logicalCalls
      .slice(-2)
      .map(
        (call) =>
          `PURPOSE ${call.purpose}\nSYSTEM\n${call.system}\nPROMPT\n${call.prompt}`,
      )
      .join("\n\n"),
    20_000,
  );
}

function compactStateSnapshot(snapshot: TurnEvidence["before"]): unknown {
  return {
    capturedAtUtc: snapshot.capturedAtUtc,
    runtimeState: snapshot.runtimeState,
    cursor: snapshot.cursor,
    schedule: snapshot.schedule.slice(-8),
    scheduleNegotiations: snapshot.scheduleNegotiations.slice(-8),
    settlements: snapshot.settlements.slice(-8),
    memories: snapshot.memories.slice(-12),
    memoryEvidence: snapshot.memoryEvidence.slice(-12),
    messages: snapshot.messages.slice(-20),
    domainEvents: snapshot.domainEvents.slice(-12),
    proactiveCandidates: snapshot.proactiveCandidates.slice(-8),
  };
}

function assertReviewerCredentialsPresent(
  plan: CompanionLongRunV2JudgePlan,
  environment: Readonly<NodeJS.ProcessEnv>,
): void {
  const requiredProfiles = new Set(
    plan.batches.map((batch) => batch.reviewerProfile),
  );
  const missing = COMPANION_LONG_RUN_V2_PROFILE_ORDER.flatMap((profile) => {
    if (!requiredProfiles.has(profile)) return [];
    const key = apiKeyEnvironmentForProfile(profile);
    const value = Object.entries(environment).find(
      ([candidate]) => candidate.toUpperCase() === key,
    )?.[1];
    return value === undefined || value.trim() === ""
      ? [`${profile} (${key})`]
      : [];
  });
  if (missing.length > 0) {
    throw new Error(`Missing judge API credentials: ${missing.join(", ")}.`);
  }
}

function textFromUnknown(value: unknown, depth: number): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined || depth > 4) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromUnknown(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (!isRecord(value)) return "";
  for (const key of [
    "content",
    "text",
    "reply",
    "chunks",
    "assistantMessage",
  ]) {
    const nested = textFromUnknown(value[key], depth + 1);
    if (nested !== "") return nested;
  }
  return "";
}

function environmentSecrets(
  environment: Readonly<NodeJS.ProcessEnv>,
): string[] {
  return Object.entries(environment).flatMap(([key, value]) =>
    value !== undefined &&
    /(?:api.?key|authorization|credential|password|secret|token)/iu.test(key)
      ? [value]
      : [],
  );
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}\n[TRUNCATED]`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitArgument(
  argument: string,
): readonly [string, string | undefined] {
  const equals = argument.indexOf("=");
  return equals < 0
    ? [argument, undefined]
    : [argument.slice(0, equals), argument.slice(equals + 1)];
}

function requiredValue(
  argv: readonly string[],
  index: number,
  name: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value.`);
  }
  return value;
}

function uniqueValue<T>(current: T | undefined, next: T, name: string): T {
  if (current !== undefined)
    throw new TypeError(`${name} may be supplied only once.`);
  return next;
}

async function readStandardInput(): Promise<string> {
  return new Promise<string>((resolveInput, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      value += chunk;
    });
    process.stdin.once("end", () => resolveInput(value));
    process.stdin.once("error", reject);
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    pathToFileURL(resolve(entry)).href === import.meta.url
  );
}

if (isMainModule()) {
  runCompanionLongRunV2JudgeCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`companion-long-run-v2-judge: ${message}\n`);
    process.exitCode = 1;
  });
}
