import { readConfig } from "../config.js";
import { calculateLlmPromptTokenBudget } from "../services/llm-prompt-headroom.js";
import { assertDeepSeekStateAcceptanceConfig } from "./deepseek-state-acceptance-flow.js";
import {
  deepSeekStateContinuationPathsFor,
  runDeepSeekStateContinuation,
} from "./deepseek-state-continuation-flow.js";

const OPT_IN_ENVIRONMENT = "REAL_DEEPSEEK_STATE_ACCEPTANCE";
const SOURCE_DATABASE_ENVIRONMENT =
  "REAL_DEEPSEEK_STATE_CONTINUATION_DATABASE_PATH";
const AGENT_ID_ENVIRONMENT = "REAL_DEEPSEEK_STATE_CONTINUATION_AGENT_ID";
const SOURCE_RUN_ENVIRONMENT = "REAL_DEEPSEEK_STATE_CONTINUATION_SOURCE_RUN_ID";

if (process.env[OPT_IN_ENVIRONMENT] !== "1") {
  process.stderr.write(
    [
      "SKIP: real DeepSeek state continuation is opt-in and was not run.",
      `Set ${OPT_IN_ENVIRONMENT}=1, ${SOURCE_DATABASE_ENVIRONMENT}, and ${AGENT_ID_ENVIRONMENT}, then run:`,
      "  pnpm test:state:real:deepseek:continuation",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const sourceDatabase = process.env[SOURCE_DATABASE_ENVIRONMENT]?.trim();
const agentId = process.env[AGENT_ID_ENVIRONMENT]?.trim();
const sourceRunId = process.env[SOURCE_RUN_ENVIRONMENT]?.trim();
if (!sourceDatabase || !agentId) {
  process.stderr.write(
    `Both ${SOURCE_DATABASE_ENVIRONMENT} and ${AGENT_ID_ENVIRONMENT} are required.\n`,
  );
  process.exit(2);
}

const startedAt = new Date();
const config = readConfig();
try {
  assertDeepSeekStateAcceptanceConfig(config);
  const paths = deepSeekStateContinuationPathsFor(startedAt);
  const promptTokenBudget = calculateLlmPromptTokenBudget(
    config.llm.capabilities!,
  );
  const configuredOutputTokens =
    config.llm.capabilities?.maxOutputTokens ??
    config.llm.maxOutputTokens ??
    "unknown";
  process.stdout.write(
    [
      "DeepSeek state continuation preflight (one network call will start):",
      `  Model: ${config.llm.model}`,
      `  URL: ${config.llm.baseUrl}`,
      `  Prompt token budget: ${promptTokenBudget}`,
      `  Configured output tokens: ${configuredOutputTokens}`,
      `  Credential environment: OPENAI_COMPATIBLE_API_KEY (${config.llm.apiKey === undefined ? "missing" : "present"})`,
      `  Source database: ${sourceDatabase}`,
      `  Source run: ${sourceRunId || "not supplied"}`,
      `  Agent: ${agentId}`,
      "  Provider retries: 1; no runner-level semantic resampling",
      `  Markdown report: ${paths.reportPath}`,
      `  Full redacted JSON evidence: ${paths.evidencePath}`,
      `  Isolated continuation database: ${paths.databasePath}`,
      "",
    ].join("\n"),
  );
  const result = await runDeepSeekStateContinuation(config, {
    sourceDatabasePath: sourceDatabase,
    agentId,
    ...(sourceRunId ? { sourceRunId } : {}),
    now: startedAt,
    runId: paths.runId,
    reportPath: paths.reportPath,
    evidencePath: paths.evidencePath,
    databasePath: paths.databasePath,
  });
  process.stdout.write(
    [
      `DeepSeek real state continuation: ${result.passed ? "PASS" : "FAIL"}`,
      `Source revision: ${result.preState?.revision ?? "missing"}`,
      `Committed revision: ${result.postState?.revision ?? "missing"}`,
      `Restarted revision: ${result.restartedState?.revision ?? "missing"}`,
      `Report: ${result.reportPath}`,
      `Evidence: ${result.evidencePath}`,
      "",
    ].join("\n"),
  );
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    "DeepSeek real state continuation could not start: " +
      (error instanceof Error ? error.message : String(error)) +
      "\n",
  );
  process.exitCode = 1;
}
