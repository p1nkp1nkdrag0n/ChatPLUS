import { readConfig } from "../config.js";
import { runDeepSeekAcceptance } from "./deepseek-acceptance-flow.js";

if (process.env["REAL_NETWORK_ACCEPTANCE"] !== "1") {
  process.stderr.write(
    [
      "SKIP: real DeepSeek acceptance is opt-in and was not run.",
      "Set REAL_NETWORK_ACCEPTANCE=1 together with the documented OpenAI-compatible DeepSeek environment variables, then run:",
      "  pnpm test:deepseek:acceptance",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

try {
  const result = await runDeepSeekAcceptance(readConfig(), {
    ...(process.env["REAL_ACCEPTANCE_REPORT_PATH"] === undefined
      ? {}
      : { reportPath: process.env["REAL_ACCEPTANCE_REPORT_PATH"] }),
    ...(process.env["REAL_ACCEPTANCE_DATABASE_PATH"] === undefined
      ? {}
      : { databasePath: process.env["REAL_ACCEPTANCE_DATABASE_PATH"] }),
  });
  process.stdout.write(
    [
      `DeepSeek real-network acceptance: ${result.passed ? "PASS" : "FAIL"}`,
      `Report: ${result.reportPath}`,
      `Turns: ${result.turns.length}; LLM calls: ${result.llmCalls.length}`,
      "",
    ].join("\n"),
  );
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    "DeepSeek real-network acceptance could not start: " +
      (error instanceof Error ? error.message : String(error)) +
      "\n",
  );
  process.exitCode = 1;
}
