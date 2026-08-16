import {
  AgentTurnDecisionSchema,
  ProactiveMessageProposalSchema,
} from "@personasim/contracts";

import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import { LlmService } from "../services/llm-service.js";

const config = readConfig();
if (!config.llm.apiKey) {
  process.stdout.write("SKIP: OPENAI_COMPATIBLE_API_KEY is not configured.\n");
  process.exit(0);
}

const database = openDatabase(":memory:");
try {
  runMigrations(database);
  const store = new DatabaseStore(database);
  const clock = new FakeClock("2026-08-16T10:00:00.000Z");
  const llm = new LlmService(
    { ...config.llm, provider: "openai-compatible" },
    store,
    clock,
  );
  const connectivity = await llm.generateObject({
    purpose: "compose_proactive_message",
    system:
      "This is a paid opt-in connectivity smoke test. Return a minimal JSON object.",
    prompt:
      'Return {"content":"connected","reasonCode":"connectivity_smoke","reasonSummary":"Connectivity verified."}.',
    schema: ProactiveMessageProposalSchema,
  });
  const conversation = await llm.generateObject({
    purpose: "chat_turn",
    system:
      "你是叶知夏，一名克制、体贴、偶尔带一点冷幽默的独立调查记者。始终保持角色身份，并只返回符合给定 schema 的 JSON。",
    prompt:
      "用户说：今晚学校有一场海边主题晚会，你愿意和我一起去吗？请用中文简短回应。此次连通性测试不修改日程、状态、关系或记忆，因此 scheduleEffects 和 memoryCandidates 必须为空数组，并省略可选 delta。reply.text 必须等于 reply.chunks 用换行连接后的文本；reasonCode 使用 live_chat_smoke，并给出不超过 240 字符的简短 reasonSummary。",
    schema: AgentTurnDecisionSchema,
  });
  process.stdout.write(
    `LLM smoke test passed (${llm.modelName}): ${connectivity.content}\n`,
  );
  process.stdout.write(`Live chat turn passed: ${conversation.reply.text}\n`);
} finally {
  database.close();
}
