import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  writeJsonExclusive,
  writeTextExclusive,
} from "./companion-long-run-v2-artifacts.js";
import { canonicalJson } from "./companion-long-run-v2-baseline.js";
import {
  COMPANION_LONG_RUN_V2_PROFILE_ORDER,
  aggregateCompanionLongRunV2Evaluation,
  aggregateCompanionLongRunV2ItemReviews,
  evaluateCompanionLongRunV2HumanCalibration,
  scoreCompanionLongRunV2Rubric,
  type CompanionLongRunV2AggregateResult,
  type CompanionLongRunV2EvaluationItem,
  type CompanionLongRunV2HumanCalibrationResult,
  type CompanionLongRunV2Profile,
  type CompanionLongRunV2RubricScores,
  type CompanionLongRunV2SemanticReview,
} from "./companion-long-run-v2-evaluation.js";
import type {
  CompanionLongRunV2JudgeArtifact,
  CompanionLongRunV2JudgeMappingKey,
  CompanionLongRunV2PublicJudgeReview,
} from "./companion-long-run-v2-judge.js";
import { renderLongRunV2RunMarkdown } from "./companion-long-run-v2-report.js";
import {
  isLongRunV2Profile,
  type RunSummary,
} from "./companion-long-run-v2-run-types.js";

const HumanRubricScoresSchema = z
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

export const CompanionLongRunV2HumanReviewFileSchema = z
  .object({
    schemaVersion: z.literal("companion-long-run-v2-human-review-v1"),
    reviews: z.array(
      z
        .object({
          blindId: z.string().min(1).max(80),
          scores: HumanRubricScoresSchema,
          conclusion: z.enum(["PASS", "PASS_WITH_WARNINGS", "FAIL_SEMANTIC"]),
          notes: z.string().max(4_000).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type CompanionLongRunV2HumanReviewFile = z.infer<
  typeof CompanionLongRunV2HumanReviewFileSchema
>;

export interface CompanionLongRunV2FinalReport {
  schemaVersion: "companion-long-run-v2-final-report-v1";
  createdAtUtc: string;
  classification: CompanionLongRunV2AggregateResult["classification"];
  provisional: boolean;
  runSummaryCount: number;
  judge: {
    seed: string;
    candidateCount: number;
    batchCount: number;
    reviewCount: number;
    mappingKeySha256: string;
  };
  humanReviewCount: number;
  calibration: CompanionLongRunV2HumanCalibrationResult;
  evaluation: CompanionLongRunV2AggregateResult;
  runs: readonly {
    runId: string;
    profile: string;
    repetition: number;
    finalStatus: RunSummary["finalStatus"];
    completedTurns: number;
    repairRate: number;
    warnings: readonly string[];
  }[];
}

export interface CompanionLongRunV2ReportCliArgs {
  summariesPath: string;
  judgePath: string;
  mappingKeyPath: string;
  humanReviewPath?: string;
  outputDirectory: string;
}

export function parseCompanionLongRunV2ReportArgs(
  argv: readonly string[],
): CompanionLongRunV2ReportCliArgs {
  let summariesPath: string | undefined;
  let judgePath: string | undefined;
  let mappingKeyPath: string | undefined;
  let humanReviewPath: string | undefined;
  let outputDirectory: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const [name, inline] = splitArgument(argument);
    const value = inline ?? requiredValue(argv, ++index, name);
    switch (name) {
      case "--summaries":
        summariesPath = uniqueValue(summariesPath, value, name);
        break;
      case "--judge":
        judgePath = uniqueValue(judgePath, value, name);
        break;
      case "--mapping-key":
        mappingKeyPath = uniqueValue(mappingKeyPath, value, name);
        break;
      case "--human-review":
        humanReviewPath = uniqueValue(humanReviewPath, value, name);
        break;
      case "--output-dir":
        outputDirectory = uniqueValue(outputDirectory, value, name);
        break;
      default:
        throw new TypeError(`Unknown report argument: ${argument}`);
    }
  }
  if (
    summariesPath === undefined ||
    judgePath === undefined ||
    mappingKeyPath === undefined ||
    outputDirectory === undefined
  ) {
    throw new TypeError(
      "Report requires --summaries, --judge, --mapping-key and --output-dir.",
    );
  }
  return {
    summariesPath,
    judgePath,
    mappingKeyPath,
    ...(humanReviewPath === undefined ? {} : { humanReviewPath }),
    outputDirectory,
  };
}

export function buildCompanionLongRunV2FinalReport(input: {
  runSummaries: readonly RunSummary[];
  judgeArtifact: CompanionLongRunV2JudgeArtifact;
  mappingKey: CompanionLongRunV2JudgeMappingKey;
  humanReview?: CompanionLongRunV2HumanReviewFile;
  createdAtUtc?: string;
}): CompanionLongRunV2FinalReport {
  assertJudgeMapping(input.judgeArtifact, input.mappingKey);
  const summaries = stableRunSummaries(input.runSummaries);
  const summaryByRunId = new Map(
    summaries.map((summary) => [summary.manifest.runId, summary]),
  );
  if (summaryByRunId.size !== summaries.length) {
    throw new Error("Run summaries must have unique runId values.");
  }
  const candidateByBlindId = new Map(
    input.mappingKey.candidates.map((candidate) => [
      candidate.blindId,
      candidate,
    ]),
  );
  if (candidateByBlindId.size !== input.mappingKey.candidates.length) {
    throw new Error("Mapping key contains duplicate candidate blindId values.");
  }
  const reviewerByAlias = new Map(
    input.mappingKey.reviewers.map((reviewer) => [
      reviewer.reviewerAlias,
      reviewer.profile,
    ]),
  );
  if (reviewerByAlias.size !== input.mappingKey.reviewers.length) {
    throw new Error("Mapping key contains duplicate reviewer aliases.");
  }
  for (const review of input.judgeArtifact.reviews) {
    if (!candidateByBlindId.has(review.blindId)) {
      throw new Error(`Judge review references unknown ${review.blindId}.`);
    }
    if (!reviewerByAlias.has(review.reviewerAlias)) {
      throw new Error(
        `Judge review references unknown ${review.reviewerAlias}.`,
      );
    }
  }
  const publicReviewsByBlindId = groupPublicReviews(
    input.judgeArtifact.reviews,
  );
  const evaluationItems: CompanionLongRunV2EvaluationItem[] = [];
  const coveredRunIds = new Set<string>();
  for (const candidate of input.mappingKey.candidates) {
    const summary = summaryByRunId.get(candidate.runId);
    if (summary === undefined) {
      throw new Error(`No run summary matches ${candidate.runId}.`);
    }
    if (summary.manifest.profile !== candidate.profile) {
      throw new Error(`Mapping profile does not match run ${candidate.runId}.`);
    }
    coveredRunIds.add(candidate.runId);
    const reviews = (publicReviewsByBlindId.get(candidate.blindId) ?? []).map(
      (review) =>
        semanticReviewFromPublic(
          review,
          candidate.itemId,
          candidate.profile,
          reviewerByAlias,
        ),
    );
    if (reviews.length > 2) {
      throw new Error(
        `Candidate ${candidate.blindId} has more than two reviews.`,
      );
    }
    const executionStatus = executionStatusFromSummary(summary);
    evaluationItems.push({
      itemId: candidate.itemId,
      profile: candidate.profile,
      scenarioId: candidate.scenarioId,
      runId: candidate.runId,
      repetition: candidate.repetition,
      executionStatus,
      ...(summary.finalStatus === "FAIL_PRODUCT" ||
      summary.promptHashMismatches.length > 0
        ? {
            productFailureCodes: [
              ...(summary.finalStatus === "FAIL_PRODUCT"
                ? ["run_summary_fail_product"]
                : []),
              ...summary.promptHashMismatches.map(
                (mismatch) => `prompt_hash_mismatch:${mismatch}`,
              ),
            ],
          }
        : {}),
      ...(summary.warnings.length > 0 || summary.provider.repairedTurns > 0
        ? {
            repairWarningCodes: [
              ...summary.warnings,
              ...(summary.provider.repairedTurns > 0
                ? [`repaired_turns:${String(summary.provider.repairedTurns)}`]
                : []),
            ],
          }
        : {}),
      ...(executionStatus === "completed"
        ? {
            reviews: summary.finalStatus === "PARTIAL" ? [] : reviews,
          }
        : {}),
    });
  }
  for (const summary of summaries) {
    if (coveredRunIds.has(summary.manifest.runId)) continue;
    const profile = summary.manifest.profile;
    if (!isLongRunV2Profile(profile)) {
      throw new TypeError(
        "Fixture summaries cannot enter a paid final report.",
      );
    }
    evaluationItems.push({
      itemId: `run-summary-only:${summary.manifest.runId}`,
      profile,
      scenarioId: summary.manifest.matrixId,
      runId: summary.manifest.runId,
      repetition: summary.manifest.repetition,
      executionStatus: executionStatusFromSummary(summary),
      ...(summary.finalStatus === "FAIL_PRODUCT"
        ? { productFailureCodes: ["run_summary_fail_product"] }
        : {}),
      ...(summary.finalStatus === "PASS" ||
      summary.finalStatus === "PASS_WITH_WARNINGS" ||
      summary.finalStatus === "FAIL_SEMANTIC" ||
      summary.finalStatus === "PARTIAL"
        ? { reviews: [] }
        : {}),
    });
  }

  const humanReview = input.humanReview;
  const calibration = buildHumanCalibration({
    humanReview,
    candidateByBlindId,
    publicReviewsByBlindId,
    reviewerByAlias,
  });
  const evaluation = aggregateCompanionLongRunV2Evaluation({
    items: evaluationItems,
    calibration,
  });
  return {
    schemaVersion: "companion-long-run-v2-final-report-v1",
    createdAtUtc: input.createdAtUtc ?? new Date().toISOString(),
    classification: evaluation.classification,
    provisional: evaluation.provisional,
    runSummaryCount: summaries.length,
    judge: {
      seed: input.judgeArtifact.seed,
      candidateCount: input.judgeArtifact.candidateCount,
      batchCount: input.judgeArtifact.batchCount,
      reviewCount: input.judgeArtifact.reviews.length,
      mappingKeySha256: input.judgeArtifact.mappingKeySha256,
    },
    humanReviewCount: humanReview?.reviews.length ?? 0,
    calibration,
    evaluation,
    runs: summaries.map((summary) => ({
      runId: summary.manifest.runId,
      profile: summary.manifest.profile,
      repetition: summary.manifest.repetition,
      finalStatus: summary.finalStatus,
      completedTurns: summary.completed.total,
      repairRate: summary.provider.repairRate,
      warnings: summary.warnings,
    })),
  };
}

export function renderCompanionLongRunV2FinalReportMarkdown(input: {
  report: CompanionLongRunV2FinalReport;
  runSummaries: readonly RunSummary[];
}): string {
  const report = input.report;
  const lines = [
    "# ChatPLUS companion long-run v2 final report",
    "",
    `- Classification: **${report.classification}**`,
    `- Provisional: **${String(report.provisional)}**`,
    `- Runs: ${String(report.runSummaryCount)}`,
    `- Candidates: ${String(report.judge.candidateCount)}`,
    `- Model reviews: ${String(report.judge.reviewCount)}`,
    `- Human calibration samples: ${String(report.humanReviewCount)}`,
    `- Calibration MAE: ${formatNullable(report.calibration.meanAbsoluteError)}`,
    `- Conclusion agreement: ${formatPercentNullable(
      report.calibration.conclusionAgreementRate,
    )}`,
    "",
    "## Profile scores",
    "",
    ...COMPANION_LONG_RUN_V2_PROFILE_ORDER.flatMap((profile) => {
      const score = report.evaluation.profileScores[profile];
      return score === undefined
        ? []
        : [`- ${profile}: ${formatNullable(score)}`];
    }),
    "",
    "## Run scores",
    "",
    ...Object.entries(report.evaluation.runScores).map(
      ([runId, score]) => `- ${runId}: ${formatNullable(score)}`,
    ),
  ];
  if (report.evaluation.reasons.length > 0) {
    lines.push(
      "",
      "## Decision reasons",
      "",
      ...report.evaluation.reasons.map((reason) => `- ${reason}`),
    );
  }
  for (const summary of stableRunSummaries(input.runSummaries)) {
    lines.push(
      "",
      renderLongRunV2RunMarkdown(summary).replace(/^# /u, "## ").trimEnd(),
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeCompanionLongRunV2FinalReportExclusive(input: {
  outputDirectory: string;
  report: CompanionLongRunV2FinalReport;
  runSummaries: readonly RunSummary[];
}): Promise<{ jsonPath: string; markdownPath: string }> {
  const directory = resolve(input.outputDirectory);
  const jsonPath = join(directory, "final-report.json");
  const markdownPath = join(directory, "final-report.md");
  await writeJsonExclusive(jsonPath, input.report);
  await writeTextExclusive(
    markdownPath,
    renderCompanionLongRunV2FinalReportMarkdown(input),
  );
  return { jsonPath, markdownPath };
}

export async function readCompanionLongRunV2RunSummaries(
  sourcePath: string,
): Promise<RunSummary[]> {
  const files = await jsonFiles(resolve(sourcePath));
  const summaries: RunSummary[] = [];
  for (const file of files) {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (
        isRecord(candidate) &&
        candidate["schemaVersion"] === "companion-long-run-run-summary-v2"
      ) {
        summaries.push(candidate as unknown as RunSummary);
      }
    }
  }
  if (summaries.length === 0) {
    throw new Error(
      `No companion long-run v2 run summaries found in ${sourcePath}.`,
    );
  }
  return stableRunSummaries(summaries);
}

export async function runCompanionLongRunV2ReportCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const args = parseCompanionLongRunV2ReportArgs(argv);
  const [runSummaries, judgeArtifact, mappingKey, humanReview] =
    await Promise.all([
      readCompanionLongRunV2RunSummaries(args.summariesPath),
      readJson<CompanionLongRunV2JudgeArtifact>(args.judgePath),
      readJson<CompanionLongRunV2JudgeMappingKey>(args.mappingKeyPath),
      args.humanReviewPath === undefined
        ? Promise.resolve(undefined)
        : readJson<unknown>(args.humanReviewPath).then((value) =>
            CompanionLongRunV2HumanReviewFileSchema.parse(value),
          ),
    ]);
  const report = buildCompanionLongRunV2FinalReport({
    runSummaries,
    judgeArtifact,
    mappingKey,
    ...(humanReview === undefined ? {} : { humanReview }),
  });
  const paths = await writeCompanionLongRunV2FinalReportExclusive({
    outputDirectory: args.outputDirectory,
    report,
    runSummaries,
  });
  process.stdout.write(`${JSON.stringify(paths)}\n`);
  return 0;
}

function buildHumanCalibration(input: {
  humanReview: CompanionLongRunV2HumanReviewFile | undefined;
  candidateByBlindId: ReadonlyMap<
    string,
    CompanionLongRunV2JudgeMappingKey["candidates"][number]
  >;
  publicReviewsByBlindId: ReadonlyMap<
    string,
    readonly CompanionLongRunV2PublicJudgeReview[]
  >;
  reviewerByAlias: ReadonlyMap<string, CompanionLongRunV2Profile>;
}): CompanionLongRunV2HumanCalibrationResult {
  if (input.humanReview === undefined) {
    return evaluateCompanionLongRunV2HumanCalibration([]);
  }
  const seen = new Set<string>();
  const samples = input.humanReview.reviews.map((human) => {
    if (seen.has(human.blindId)) {
      throw new Error(`Duplicate human review: ${human.blindId}.`);
    }
    seen.add(human.blindId);
    const candidate = input.candidateByBlindId.get(human.blindId);
    if (candidate === undefined) {
      throw new Error(`Human review references unknown ${human.blindId}.`);
    }
    const publicReviews = input.publicReviewsByBlindId.get(human.blindId) ?? [];
    const semantic = publicReviews.map((review) =>
      semanticReviewFromPublic(
        review,
        candidate.itemId,
        candidate.profile,
        input.reviewerByAlias,
      ),
    );
    const automated = aggregateCompanionLongRunV2ItemReviews(
      {
        itemId: candidate.itemId,
        profile: candidate.profile,
        scenarioId: candidate.scenarioId,
        runId: candidate.runId,
        repetition: candidate.repetition,
      },
      semantic,
    );
    if (
      !automated.complete ||
      automated.weightedScore === null ||
      automated.conclusion === null
    ) {
      throw new Error(
        `Human calibration candidate ${human.blindId} lacks dual model reviews.`,
      );
    }
    return {
      sampleId: human.blindId,
      automatedScore: automated.weightedScore,
      humanScore: scoreCompanionLongRunV2Rubric(human.scores),
      automatedConclusion: automated.conclusion,
      humanConclusion: human.conclusion,
    };
  });
  return evaluateCompanionLongRunV2HumanCalibration(samples);
}

function semanticReviewFromPublic(
  review: CompanionLongRunV2PublicJudgeReview,
  itemId: string,
  subjectProfile: CompanionLongRunV2Profile,
  reviewerByAlias: ReadonlyMap<string, CompanionLongRunV2Profile>,
): CompanionLongRunV2SemanticReview {
  const reviewerProfile = reviewerByAlias.get(review.reviewerAlias);
  if (reviewerProfile === undefined) {
    throw new Error(`Unknown reviewer alias ${review.reviewerAlias}.`);
  }
  return {
    reviewId: review.reviewId,
    itemId,
    subjectProfile,
    reviewerProfile,
    scores: review.scores,
    conclusion: review.conclusion,
  };
}

function groupPublicReviews(
  reviews: readonly CompanionLongRunV2PublicJudgeReview[],
): Map<string, CompanionLongRunV2PublicJudgeReview[]> {
  const reviewIds = new Set<string>();
  const groups = new Map<string, CompanionLongRunV2PublicJudgeReview[]>();
  for (const review of reviews) {
    if (reviewIds.has(review.reviewId)) {
      throw new Error(`Duplicate public judge review ${review.reviewId}.`);
    }
    reviewIds.add(review.reviewId);
    const group = groups.get(review.blindId) ?? [];
    group.push(review);
    groups.set(review.blindId, group);
  }
  return groups;
}

function executionStatusFromSummary(
  summary: RunSummary,
): CompanionLongRunV2EvaluationItem["executionStatus"] {
  switch (summary.finalStatus) {
    case "FAIL_PRODUCT":
      return "product_failure";
    case "FAIL_PROVIDER":
      return "provider_failure";
    case "SKIPPED":
      return "skipped";
    case "PASS":
    case "PASS_WITH_WARNINGS":
    case "FAIL_SEMANTIC":
    case "PARTIAL":
      return "completed";
  }
}

function assertJudgeMapping(
  artifact: CompanionLongRunV2JudgeArtifact,
  mappingKey: CompanionLongRunV2JudgeMappingKey,
): void {
  if (artifact.schemaVersion !== "companion-long-run-v2-judge-results-v1") {
    throw new TypeError("Unsupported judge artifact schemaVersion.");
  }
  if (
    mappingKey.schemaVersion !== "companion-long-run-v2-judge-mapping-key-v1"
  ) {
    throw new TypeError("Unsupported judge mapping schemaVersion.");
  }
  if (artifact.seed !== mappingKey.seed) {
    throw new Error("Judge artifact and mapping key seeds differ.");
  }
  const actualSha256 = sha256Canonical(mappingKey);
  if (artifact.mappingKeySha256 !== actualSha256) {
    throw new Error("Judge mapping key SHA-256 verification failed.");
  }
  if (artifact.candidateCount !== mappingKey.candidates.length) {
    throw new Error("Judge candidate count does not match mapping key.");
  }
}

function stableRunSummaries(summaries: readonly RunSummary[]): RunSummary[] {
  const profileIndex = new Map(
    COMPANION_LONG_RUN_V2_PROFILE_ORDER.map((profile, index) => [
      profile,
      index,
    ]),
  );
  return [...summaries].sort(
    (left, right) =>
      (profileIndex.get(left.manifest.profile as CompanionLongRunV2Profile) ??
        99) -
        (profileIndex.get(
          right.manifest.profile as CompanionLongRunV2Profile,
        ) ?? 99) ||
      left.manifest.repetition - right.manifest.repetition ||
      compareText(left.manifest.runId, right.manifest.runId),
  );
}

async function jsonFiles(path: string): Promise<string[]> {
  const details = await stat(path);
  if (details.isFile()) return [path];
  if (!details.isDirectory())
    throw new TypeError(`${path} is not a file or directory.`);
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const nested = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await jsonFiles(nested)));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(nested);
  }
  return files.sort(compareText);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function formatNullable(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

function formatPercentNullable(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
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

function isMainModule(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    pathToFileURL(resolve(entry)).href === import.meta.url
  );
}

if (isMainModule()) {
  runCompanionLongRunV2ReportCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`companion-long-run-v2-report: ${message}\n`);
    process.exitCode = 1;
  });
}
