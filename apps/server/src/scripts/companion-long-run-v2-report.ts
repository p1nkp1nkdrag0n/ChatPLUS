import type {
  RunManifest,
  RunSummary,
  TurnEvidence,
} from "./companion-long-run-v2-run-types.js";
import {
  providerAccountingMetric,
  providerMetricsReport,
} from "./provider-metrics-summary.js";

export interface PilotGateResult {
  status: "PASS" | "FAIL_PROVIDER" | "FAIL_PRODUCT" | "PARTIAL";
  eligibleForClosedLoop: boolean;
  reasons: string[];
  completed: number;
  repairRate: number;
  finalStructureSuccessRate: number;
}

export function evaluateLongRunV2PilotGate(
  evidence: readonly TurnEvidence[],
): PilotGateResult {
  const paired = evidence.filter((item) => item.track === "paired");
  const repaired = paired.filter((item) => item.repairAttempted).length;
  const structured = paired.filter((item) =>
    item.assertions.some(
      (assertion) =>
        assertion.code === "response_contract_valid" &&
        assertion.status === "PASS",
    ),
  ).length;
  const repairRate = paired.length === 0 ? 0 : repaired / paired.length;
  const finalStructureSuccessRate =
    paired.length === 0 ? 0 : structured / paired.length;
  const providerFailures = paired.filter(isProviderFailure);
  const productFailures = paired.flatMap((item) =>
    item.assertions.filter(
      (assertion) =>
        assertion.status === "FAIL" &&
        !["http_success", "response_contract_valid"].includes(assertion.code),
    ),
  );
  const reasons: string[] = [];
  let status: PilotGateResult["status"] = "PASS";
  if (paired.length !== 30) {
    status = "PARTIAL";
    reasons.push(`Pilot completed ${String(paired.length)}/30 paired probes.`);
  } else if (providerFailures.length > 0) {
    status = "FAIL_PROVIDER";
    reasons.push(
      `${String(providerFailures.length)} probe(s) had provider/auth/model failures.`,
    );
  } else if (finalStructureSuccessRate !== 1) {
    status = "FAIL_PROVIDER";
    reasons.push("Final structured-output success rate was below 100%.");
  } else if (repairRate > 0.2) {
    status = "FAIL_PROVIDER";
    reasons.push(`Repair rate ${formatPercent(repairRate)} exceeded 20%.`);
  } else if (productFailures.length > 0) {
    status = "FAIL_PRODUCT";
    reasons.push(
      `${String(productFailures.length)} deterministic product assertion(s) failed.`,
    );
  }
  return {
    status,
    eligibleForClosedLoop: status === "PASS",
    reasons,
    completed: paired.length,
    repairRate,
    finalStructureSuccessRate,
  };
}

export function summarizeLongRunV2Run(input: {
  manifest: RunManifest;
  evidence: readonly TurnEvidence[];
  evidencePath: string;
  databasePaths: string[];
  completedAtUtc?: string;
}): RunSummary {
  const hard = input.evidence.flatMap((item) => item.assertions);
  const passed = hard.filter((item) => item.status === "PASS").length;
  const failed = hard.filter((item) => item.status === "FAIL").length;
  const skipped = hard.filter((item) => item.status === "SKIPPED").length;
  const attempts = input.evidence.flatMap((item) => item.providerAttempts);
  const repairedTurns = input.evidence.filter(
    (item) => item.repairAttempted,
  ).length;
  const repairRate =
    input.evidence.length === 0 ? 0 : repairedTurns / input.evidence.length;
  const providerFailures = input.evidence.filter(isProviderFailure);
  const finalStructureFailures = input.evidence.filter((item) =>
    item.assertions.some(
      (assertion) =>
        assertion.code === "response_contract_valid" &&
        assertion.status === "FAIL",
    ),
  );
  const paired = input.evidence.filter(
    (item) => item.track === "paired",
  ).length;
  const closedLoop = input.evidence.filter(
    (item) => item.track === "closed_loop",
  ).length;
  const planned = input.manifest.plannedTracks.includes("closed_loop")
    ? 150
    : 30;
  const warnings: string[] = [];
  if (repairRate > 0.1 && repairRate <= 0.2) {
    warnings.push(
      `Repair rate ${formatPercent(repairRate)} is in the 10–20% warning band.`,
    );
  }
  if (input.manifest.identityCaveat)
    warnings.push(input.manifest.identityCaveat);

  let status: RunSummary["status"] = "PASS";
  let finalStatus: RunSummary["finalStatus"] =
    warnings.length > 0 ? "PASS_WITH_WARNINGS" : "PASS";
  if (input.evidence.length < planned) {
    status = "PARTIAL";
    finalStatus = "PARTIAL";
  } else if (
    providerFailures.length > 0 ||
    finalStructureFailures.length > 0 ||
    repairRate > 0.2
  ) {
    status = "FAIL";
    finalStatus = "FAIL_PROVIDER";
  } else if (failed > 0) {
    status = "FAIL";
    finalStatus = "FAIL_PRODUCT";
  }

  return {
    schemaVersion: "companion-long-run-run-summary-v2",
    manifest: input.manifest,
    status,
    finalStatus,
    completed: { paired, closedLoop, total: input.evidence.length },
    hardAssertions: { passed, failed, skipped },
    provider: {
      cacheAccounting: providerMetricsReport(
        attempts.map((attempt) => ({
          ...providerAccountingMetric(attempt),
          profile: input.manifest.profile,
        })),
      ),
      physicalAttempts: attempts.length,
      failedAttempts: attempts.filter((attempt) => !attempt.success).length,
      repairedTurns,
      repairRate,
      ...(attempts.some((attempt) => attempt.inputTokens !== undefined)
        ? {
            inputTokens: attempts.reduce(
              (total, attempt) => total + (attempt.inputTokens ?? 0),
              0,
            ),
          }
        : {}),
      ...(attempts.some((attempt) => attempt.outputTokens !== undefined)
        ? {
            outputTokens: attempts.reduce(
              (total, attempt) => total + (attempt.outputTokens ?? 0),
              0,
            ),
          }
        : {}),
    },
    promptHashMismatches: [],
    warnings,
    evidencePath: input.evidencePath,
    databasePaths: input.databasePaths,
    completedAtUtc: input.completedAtUtc ?? new Date().toISOString(),
  };
}

export function findPairedPromptHashMismatches(
  runs: readonly Pick<RunSummary, "manifest">[],
  evidence: readonly TurnEvidence[],
): string[] {
  const expectedProfilesByRepetition = new Map<number, Set<string>>();
  for (const run of runs) {
    if (!run.manifest.plannedTracks.includes("paired")) continue;
    const profiles =
      expectedProfilesByRepetition.get(run.manifest.repetition) ??
      new Set<string>();
    profiles.add(run.manifest.profile);
    expectedProfilesByRepetition.set(run.manifest.repetition, profiles);
  }
  const groups = new Map<
    string,
    { hashes: Map<string, string | undefined>; duplicateProfiles: Set<string> }
  >();
  for (const item of evidence.filter(
    (candidate) => candidate.track === "paired",
  )) {
    const key = `${String(item.repetition)}:${item.turnId}`;
    const group = groups.get(key) ?? {
      hashes: new Map<string, string | undefined>(),
      duplicateProfiles: new Set<string>(),
    };
    if (group.hashes.has(item.profile))
      group.duplicateProfiles.add(item.profile);
    group.hashes.set(item.profile, item.primaryPromptSha256);
    groups.set(key, group);
  }
  const mismatches: string[] = [];
  for (const [key, group] of groups) {
    const repetition = Number(key.slice(0, key.indexOf(":")));
    const expectedProfiles =
      expectedProfilesByRepetition.get(repetition) ??
      new Set(group.hashes.keys());
    const hashes = [...expectedProfiles].map((profile) =>
      group.hashes.get(profile),
    );
    if (
      group.duplicateProfiles.size > 0 ||
      hashes.some((hash) => hash === undefined) ||
      new Set(hashes).size !== 1
    ) {
      mismatches.push(key);
    }
  }
  return mismatches.sort();
}

export function renderLongRunV2RunMarkdown(summary: RunSummary): string {
  const lines = [
    `# ChatPLUS companion long-run v2 — ${summary.manifest.profile}`,
    "",
    `- Matrix: \`${summary.manifest.matrixId}\``,
    `- Run: \`${summary.manifest.runId}\``,
    `- Repetition: ${String(summary.manifest.repetition)}`,
    `- Status: **${summary.finalStatus}**`,
    `- Candidate turns: ${String(summary.completed.total)} (${String(summary.completed.paired)} paired + ${String(summary.completed.closedLoop)} closed-loop)`,
    `- Hard assertions: ${String(summary.hardAssertions.passed)} passed / ${String(summary.hardAssertions.failed)} failed / ${String(summary.hardAssertions.skipped)} skipped`,
    `- Physical attempts: ${String(summary.provider.physicalAttempts)}; failed ${String(summary.provider.failedAttempts)}`,
    `- Repair rate: ${formatPercent(summary.provider.repairRate)}`,
    "",
    "## Frozen inputs",
    "",
    `- Git: \`${summary.manifest.git.revision}\`${summary.manifest.git.dirty ? " (dirty pilot)" : ""}`,
    `- Scenario SHA-256: \`${summary.manifest.scenario.manifestSha256}\``,
    `- Baseline SQLite SHA-256: \`${summary.manifest.baseline.databaseSha256}\``,
    `- Character SHA-256: \`${summary.manifest.baseline.characterSpecSha256}\``,
    `- Requested model: \`${summary.manifest.profileConfig.requestedModel}\``,
    `- Reasoning: \`${summary.manifest.profileConfig.reasoningEffort ?? "not-configured"}\``,
  ];
  if (summary.warnings.length > 0) {
    lines.push(
      "",
      "## Warnings",
      "",
      ...summary.warnings.map((item) => `- ${item}`),
    );
  }
  lines.push(
    "",
    "The configured third-party gateway proving that a model ID is callable does not independently prove upstream model identity.",
    "",
  );
  return lines.join("\n");
}

function isProviderFailure(item: TurnEvidence): boolean {
  if (
    [401, 403, 404, 408, 409, 429].includes(item.http.status) ||
    item.http.status >= 500
  ) {
    return true;
  }
  return item.providerAttempts.some(
    (attempt) =>
      !attempt.success &&
      ["HTTP_ERROR", "TIMEOUT", "NETWORK_ERROR", "OUTPUT_TRUNCATED"].includes(
        attempt.errorCode ?? "",
      ),
  );
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
