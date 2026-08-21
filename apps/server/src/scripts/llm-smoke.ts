import { readConfig } from "../config.js";
import { runLlmHttpSmoke } from "./llm-smoke-flow.js";

const config = readConfig();
if (!config.llm.apiKey) {
  process.stdout.write("SKIP: OPENAI_COMPATIBLE_API_KEY is not configured.\n");
  process.exit(0);
}

const result = await runLlmHttpSmoke({
  ...config,
  llm: { ...config.llm, provider: "openai-compatible" },
});

process.stdout.write(
  "LLM HTTP smoke test passed (" +
    result.model +
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
