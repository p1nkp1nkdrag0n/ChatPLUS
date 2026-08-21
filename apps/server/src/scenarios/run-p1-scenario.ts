import {
  P1_SCENARIO_NAMES,
  isP1ScenarioName,
  runP1Scenario,
  type P1ScenarioName,
  type P1ScenarioReport,
} from "./p1-scenario-harness.js";

async function main(): Promise<void> {
  const requested = process.argv[2] ?? "all";
  const scenarios: readonly P1ScenarioName[] =
    requested === "all"
      ? P1_SCENARIO_NAMES
      : isP1ScenarioName(requested)
        ? [requested]
        : invalidScenario(requested);
  const reports: P1ScenarioReport[] = [];
  for (const scenario of scenarios) {
    reports.push(await runP1Scenario(scenario));
  }
  process.stdout.write(
    JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2) + "\n",
  );
}

function invalidScenario(value: string): never {
  throw new TypeError(
    `Unknown P1 scenario "${value}". Expected one of: ${P1_SCENARIO_NAMES.join(", ")}, all.`,
  );
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : error;
  process.stderr.write(String(message) + "\n");
  process.exitCode = 1;
});
