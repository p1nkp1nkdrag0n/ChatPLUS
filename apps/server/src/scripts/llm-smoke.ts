import { readConfig } from "../config.js";
import { runLlmHttpSmoke } from "./llm-smoke-flow.js";

const config = readConfig();
if (!config.llm.apiKey) {
  const credentialEnvironment = config.llm.profileName
    ? `LLM_PROFILE_${config.llm.profileName.replaceAll("-", "_").toUpperCase()}_API_KEY`
    : "OPENAI_COMPATIBLE_API_KEY";
  process.stdout.write(`SKIP: ${credentialEnvironment} is not configured.\n`);
  process.exit(0);
}

const result = await runLlmHttpSmoke({
  ...config,
  llm: { ...config.llm, provider: "openai-compatible" },
});

process.stdout.write(
  "LLM HTTP smoke test passed (profile=" +
    result.profile +
    ", model=" +
    result.model +
    ", effort=" +
    (result.reasoningEffort ?? "not-configured") +
    "): " +
    result.assistantText +
    "\n",
);
process.stdout.write(
  "Production chat path persisted " +
    String(result.chunks.length) +
    " validated chunk(s); application LLM purposes: " +
    result.applicationLlmPurposes.join(", ") +
    ".\n",
);
