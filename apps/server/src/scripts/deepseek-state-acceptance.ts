import { readConfig } from "../config.js";
import { calculateLlmPromptTokenBudget } from "../services/llm-prompt-headroom.js";
import {
  assertDeepSeekStateAcceptanceConfig,
  deepSeekStateAcceptancePathsFor,
  runDeepSeekStateAcceptance,
} from "./deepseek-state-acceptance-flow.js";

const OPT_IN_ENVIRONMENT = "REAL_DEEPSEEK_STATE_ACCEPTANCE";

if (process.env[OPT_IN_ENVIRONMENT] !== "1") {
  process.stderr.write(
    [
      "SKIP: real DeepSeek state acceptance is opt-in and was not run.",
      `Set ${OPT_IN_ENVIRONMENT}=1 together with the documented OpenAI-compatible DeepSeek environment variables, then run:`,
      "  pnpm test:state:real:deepseek",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const startedAt = new Date();
const config = readConfig();
try {
  assertDeepSeekStateAcceptanceConfig(config);
  const paths = deepSeekStateAcceptancePathsFor(startedAt);
  const promptTokenBudget = calculateLlmPromptTokenBudget(
    config.llm.capabilities!,
  );
  const configuredOutputTokens =
    config.llm.capabilities?.maxOutputTokens ??
    config.llm.maxOutputTokens ??
    "unknown";
  process.stdout.write(
    [
      "DeepSeek state acceptance preflight (network calls will start):",
      `  Model: ${config.llm.model}`,
      `  URL: ${config.llm.baseUrl}`,
      `  Prompt token budget: ${promptTokenBudget}`,
      `  Configured output tokens: ${configuredOutputTokens}`,
      `  Credential environment: OPENAI_COMPATIBLE_API_KEY (${config.llm.apiKey === undefined ? "missing" : "present"})`,
      "  Provider retries: 1; no runner-level semantic resampling",
      `  Markdown report: ${paths.reportPath}`,
      `  Full redacted JSON evidence: ${paths.evidencePath}`,
      `  Isolated database: ${paths.databasePath}`,
      "",
    ].join("\n"),
  );
  const result = await runDeepSeekStateAcceptance(config, {
    now: startedAt,
    runId: paths.runId,
    reportPath: paths.reportPath,
    evidencePath: paths.evidencePath,
    databasePath: paths.databasePath,
  });
  process.stdout.write(
    [
      `DeepSeek real state acceptance: ${result.passed ? "PASS" : "FAIL"}`,
      `Scenarios: ${result.scenes.length}/6`,
      `Report: ${result.reportPath}`,
      `Evidence: ${result.evidencePath}`,
      "",
    ].join("\n"),
  );
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    "DeepSeek real state acceptance could not start: " +
      (error instanceof Error ? error.message : String(error)) +
      "\n",
  );
  process.exitCode = 1;
}
