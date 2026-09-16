import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const AUDITED_STATE_FIELDS = [
  "moodValence",
  "moodArousal",
  "energy",
  "stress",
  "socialBattery",
  "focus",
  "sleepDebtMinutes",
] as const;

const Unit = z.number().finite().min(0).max(1).optional();
const Snapshot = z.object({
  moodValence: z.number().finite().min(-1).max(1).optional(),
  moodArousal: Unit,
  energy: Unit,
  stress: Unit,
  socialBattery: Unit,
  focus: Unit,
  sleepDebtMinutes: z.number().int().min(0).max(720).optional(),
});

const Corpus = z.object({
  rows: z.array(
    z.object({
      branchId: z.string().min(1),
      turnId: z.string().min(1),
      actualPrompt: z.object({ runtime: Snapshot.nullable().optional() }),
      commitEvent: z.object({
        recordedAtUtc: z.string().datetime({ offset: true }),
        before: Snapshot,
        after: Snapshot,
      }),
    }),
  ),
});

/** Inspect exported actual prompts and committed states without opening an app,
 * database, deployment configuration or model connection. Missing is not zero. */
export function auditRuntimeStateLifecycle(input: unknown) {
  const { rows } = Corpus.parse(input);
  const keys = new Set<string>();
  const branches = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = JSON.stringify([row.branchId, row.turnId]);
    if (keys.has(key)) throw new Error("Duplicate branch/turn in state audit");
    keys.add(key);
    const branch = branches.get(row.branchId) ?? [];
    const previous = branch.at(-1);
    if (
      previous &&
      Date.parse(row.commitEvent.recordedAtUtc) <
        Date.parse(previous.commitEvent.recordedAtUtc)
    )
      throw new Error(
        "State audit turns must be chronological within a branch",
      );
    branch.push(row);
    branches.set(row.branchId, branch);
  }

  const fields = Object.fromEntries(
    AUDITED_STATE_FIELDS.map((field) => {
      const values = rows.flatMap((row) => {
        const value = row.actualPrompt.runtime?.[field];
        return value === undefined ? [] : [value];
      });
      let comparableCommits = 0;
      let changedCommits = 0;
      let comparablePromptSnapshots = 0;
      let promptBeforeDifferences = 0;
      let comparableNextTurns = 0;
      let nextTurnDifferences = 0;
      let promptObservationsAtBranchInitialValue = 0;
      let unchangedAcrossDayOrLonger = 0;
      let maximumGapHoursWithoutValueChange: number | null = null;
      for (const branch of branches.values()) {
        const initial = branch[0]?.commitEvent.before[field];
        for (const [index, row] of branch.entries()) {
          const before = row.commitEvent.before[field];
          const after = row.commitEvent.after[field];
          const prompt = row.actualPrompt.runtime?.[field];
          if (before !== undefined && after !== undefined) {
            comparableCommits++;
            if (before !== after) changedCommits++;
          }
          if (prompt !== undefined && before !== undefined) {
            comparablePromptSnapshots++;
            if (prompt !== before) promptBeforeDifferences++;
          }
          if (initial !== undefined && prompt === initial)
            promptObservationsAtBranchInitialValue++;
          const previous = branch[index - 1];
          const previousAfter = previous?.commitEvent.after[field];
          if (previous && previousAfter !== undefined && prompt !== undefined) {
            comparableNextTurns++;
            if (prompt !== previousAfter) nextTurnDifferences++;
            else {
              const hours =
                (Date.parse(row.commitEvent.recordedAtUtc) -
                  Date.parse(previous.commitEvent.recordedAtUtc)) /
                3_600_000;
              maximumGapHoursWithoutValueChange = Math.max(
                maximumGapHoursWithoutValueChange ?? 0,
                hours,
              );
              if (hours >= 24) unchangedAcrossDayOrLonger++;
            }
          }
        }
      }
      const minimum = field === "moodValence" ? -1 : 0;
      const maximum = field === "sleepDebtMinutes" ? 720 : 1;
      return [
        field,
        {
          promptObservations: values.length,
          missingPromptObservations: rows.length - values.length,
          uniquePromptValues: new Set(values).size,
          minimum: values.length ? Math.min(...values) : null,
          maximum: values.length ? Math.max(...values) : null,
          boundaryObservations: values.filter(
            (value) => value === minimum || value === maximum,
          ).length,
          promptObservationsAtBranchInitialValue,
          comparableCommits,
          changedCommits,
          comparablePromptSnapshots,
          promptBeforeDifferences,
          comparableNextTurns,
          nextTurnDifferences,
          unchangedAcrossDayOrLonger,
          maximumGapHoursWithoutValueChange,
        },
      ];
    }),
  );
  return {
    version: "runtime-state-lifecycle-audit-v1",
    turns: rows.length,
    branches: branches.size,
    fields,
    limitations: [
      "Describes only the supplied corpus; fixed or rarely changed values do not prove a parameter unnecessary.",
      "Missing snapshots and fields are reported as missing, never inferred as zero or unchanged.",
      "Recorded-time gaps measure this corpus's simulation clock, not physiological recovery or real elapsed study time.",
      "A next-turn difference can come from another valid intervening event; this report does not assign a cause.",
      "Matching persisted state and prompts proves data delivery, not improved reply quality or valid psychological attribution.",
    ],
  };
}

async function main() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length)
    throw new Error(
      "Usage: pnpm exec tsx apps/server/src/scripts/runtime-state-lifecycle-audit.ts evidence.json new-report.json",
    );
  const source = await readFile(resolve(input), "utf8");
  const report = {
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    ...auditRuntimeStateLifecycle(JSON.parse(source)),
  };
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  process.stdout.write(
    `Audited ${report.turns} turns in ${report.branches} branches.\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
