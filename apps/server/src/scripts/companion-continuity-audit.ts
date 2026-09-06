import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { providerMetricsReport } from "./provider-metrics-summary.js";
import type { ProfiledLlmCallMetric } from "./provider-metrics-summary.js";

async function jsonLines(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  return existsSync(path)
    ? (await readFile(path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}

/** An offline review worksheet, never a prompt builder or an automatic semantic
 * PASS. Raw attempts and product output have separate pending judgments.
 */
export async function writeContinuityAudit(directory: string): Promise<void> {
  const oracle = z
    .object({
      factLedger: z.array(z.unknown()),
      practiceLedger: z.array(z.unknown()),
      globalChecks: z.array(z.string()),
      probeChecks: z.array(
        z.object({ turn: z.number(), expectedBehavior: z.string() }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(join(directory, "oracle.private.json"), "utf8"),
      ),
    );
  const [turns, calls, checkpoints, features, metrics, attempts] =
    await Promise.all([
      jsonLines(join(directory, "turn-evidence.jsonl")),
      jsonLines(join(directory, "model-io.jsonl")),
      jsonLines(join(directory, "checkpoint-evidence.jsonl")),
      jsonLines(join(directory, "feature-evidence.jsonl")),
      jsonLines(join(directory, "provider-metrics.jsonl")),
      jsonLines(join(directory, "attempts.jsonl")),
    ]);
  const byTurn = new Map(turns.map((row) => [row.turn, row]));
  const checkpointIds = new Set<string>();
  for (const row of checkpoints)
    for (const cp of z
      .array(z.object({ id: z.string(), status: z.string() }))
      .parse(row.checkpoints))
      if (cp.status === "committed") checkpointIds.add(cp.id);
  const review = {
    schema: "continuity-review-worksheet-v1",
    overall: "PARTIAL",
    factLedger: oracle.factLedger,
    practiceLedger: oracle.practiceLedger,
    globalChecks: oracle.globalChecks,
    probes: oracle.probeChecks.map((probe) => ({
      ...probe,
      coverage: byTurn.has(probe.turn) ? "observed" : "not_covered",
      finalResponse: byTurn.get(probe.turn)?.response,
      // Logical parsed output is labeled separately from actual transport bodies.
      parsedModelCalls: calls.filter((call) => call.turn === probe.turn),
      rawAttemptReferences: attempts
        .filter(
          (attempt) =>
            (attempt.context as { turn?: unknown } | undefined)?.turn ===
            probe.turn,
        )
        .map((attempt) => ({
          attempt: attempt.attempt,
          stage: attempt.stage,
          file: "attempts.jsonl",
        })),
      rawModelJudgment: "pending",
      finalProductJudgment: "pending",
      humanExperienceJudgment: "pending",
    })),
    limitations: [
      "Fixture outputs cannot establish model quality",
      "Provider identity is configured/observed, not independently certified",
      "Known evidence, retrieved candidates, final prompt retention and model use require separate review",
      "Original supplied rubric remains unchanged",
    ],
  };
  // This worksheet is machine-generated. Human judgments belong in review.json,
  // which is created once after completion and never rewritten by the driver.
  await writeFile(
    join(directory, "review-worksheet.json"),
    `${JSON.stringify(review, null, 2)}\n`,
  );
  const journal = JSON.parse(
    await readFile(join(directory, "journal.json"), "utf8"),
  ) as { status: string };
  if (
    journal.status === "completed" &&
    !existsSync(join(directory, "review.json"))
  ) {
    await writeFile(
      join(directory, "review.json"),
      `${JSON.stringify(review, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  await writeFile(
    join(directory, "metrics.json"),
    `${JSON.stringify(
      {
        logicalTurns: byTurn.size,
        physicalReservations: attempts.filter((row) => row.stage === "reserved")
          .length,
        provider: providerMetricsReport(
          metrics as unknown as ProfiledLlmCallMetric[],
        ),
        conversationConsolidationCheckpoints: checkpointIds.size,
        sqliteRecoveryBackups: features.filter(
          (row) => row.kind === "sqlite_backup",
        ).length,
        distinctProcessRestartObserved: features.some(
          (row) => row.kind === "restart" && row.distinctProcess === true,
        ),
        semanticScores: {
          status: "pending",
          answerableAccuracy: null,
          unsupportedAssertionRate: null,
          unnecessaryAbstentionRate: null,
          naturalness: null,
        },
        billing: {
          cost: null,
          status: "requires_provider_usage_and_invoice_reconciliation",
        },
      },
      null,
      2,
    )}\n`,
  );
}
