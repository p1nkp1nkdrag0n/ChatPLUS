import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  buildConversationContextPlan,
  turnExpressionPromptView,
} from "@personasim/features";
import { readConfig, readLlmProfileConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import { LlmService } from "../services/llm-service.js";
import { createContinuityMeteredFetch } from "./continuity-metered-fetch.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";
import {
  captureContinuityRunIdentity,
  CONTINUITY_WORKSPACE_ROOT,
} from "./continuity-run-identity.js";

// Prompt-only language pilot, separate from production HTTP correctness tests.
// All arms use the same current planner. Change one guidance field at a time;
// the fourth arm combines both. No scoring model, retries or cherry-picking.
const BASELINE = "8ce79cb379d1da720aa6ed4992281e82c33cb137";
const ARMS = ["baseline", "plain_only", "questions_only", "combined"] as const;
const BUDGET = { maxPhysicalRequests: 24, maxReservedTokenUnits: 600_000 };
const AT = "2026-09-07T14:00:00.000Z";
const schema = z
  .object({
    replyDecision: z.object({ text: z.string().min(1).max(4_000) }).strict(),
    worldEffects: z.object({}).strict(),
  })
  .strict();
const character = {
  name: "沈禾",
  role: "设计师",
  relationship: "刚认识的朋友，没有预设共同经历",
  traits: ["温和", "愿意听具体事情", "有自己的判断"],
  dialogue: "自然中文，没有固定口头语或作者指定的特殊文风",
};

function userTurn(index: number, lastReply: string): string {
  switch (index) {
    case 0:
      return "今天路过一家店，灯打得很低，我觉得挺舒服。";
    case 1:
      // Only respond from this already public scenario; no evaluation oracle.
      return /什么店|哪种店|咖啡店|店.*[?？]/u.test(lastReply)
        ? "是家咖啡店，我点了热拿铁，坐了一会儿。"
        : "那是家咖啡店。我点了热拿铁，坐了一会儿。";
    case 2:
      return "拿铁挺香的。换个话题，今晚煮了面，有点咸。先听我说，不用建议。";
    case 3:
      return "今天就是想随便聊聊，但我不知道说什么，你问一点吧。";
    case 4:
      // A skipped invitation is legitimate, not a failed or pending task.
      return /[?？]/u.test(lastReply)
        ? "这个我先跳过吧。刚才把桌上的台灯打开了，暖黄的光挺好看。"
        : "刚才把桌上的台灯打开了，暖黄的光挺好看。";
    default:
      return "今天就说到这吧，不想再展开了，晚安。";
  }
}

const { values } = parseArgs({
  options: {
    fixture: { type: "boolean", default: false },
    profile: { type: "string", default: "qwen" },
    model: { type: "string" },
    output: { type: "string" },
    arms: { type: "string" },
    predecessor: { type: "string" },
  },
  strict: true,
});
const selectedArms = values.arms?.split(",") ?? [...ARMS];
if (
  new Set(selectedArms).size !== selectedArms.length ||
  selectedArms.length === 0 ||
  selectedArms.some((arm) => !ARMS.includes(arm as (typeof ARMS)[number]))
)
  throw new Error("Select each known arm at most once");
if (!values.output)
  throw new Error("Use --output NEW_IGNORED_DIRECTORY [--fixture]");
if (values.model !== undefined && !values.model.trim())
  throw new Error("Model override must not be empty");
if (!values.fixture && process.env.RUN_PAID_CONTINUITY !== "1")
  throw new Error(
    "Real execution requires user authorization and RUN_PAID_CONTINUITY=1",
  );
const directory = resolve(values.output);
const relativeDirectory = relative(CONTINUITY_WORKSPACE_ROOT, directory);
if (
  !relativeDirectory ||
  relativeDirectory.startsWith("..") ||
  isAbsolute(relativeDirectory)
)
  throw new Error("Output must be inside the workspace");
execFileSync(
  "git",
  ["check-ignore", "--quiet", "--", join(directory, "manifest.json")],
  { windowsHide: true },
);
if (existsSync(directory))
  throw new Error(
    "Use a fresh output directory; never overwrite or resample a failed pilot",
  );
const llmConfig = values.fixture
  ? {
      provider: "fixture" as const,
      model: "fixture",
      baseUrl: "https://fixture.invalid",
      timeoutMs: 1_000,
      maxRetries: 0,
    }
  : {
      ...readLlmProfileConfig(values.profile),
      ...(values.model === undefined ? {} : { model: values.model.trim() }),
      maxRetries: 0,
      maxOutputTokens: 2_500,
    };
if (!values.fixture && (!("apiKey" in llmConfig) || !llmConfig.apiKey))
  throw new Error(`${values.profile} credential unavailable`);
const config = readConfig({
  llm: llmConfig,
  seedDemo: false,
  databasePath: join(directory, "pilot.sqlite"),
});
const secrets = [config.llm.apiKey ?? ""];
const safe = (value: unknown) => redactLongRunArtifact(value, secrets);
mkdirSync(directory, { recursive: true });
const baselineSource = execFileSync(
  "git",
  ["show", `${BASELINE}:packages/features/src/turn-expression-policy.ts`],
  { encoding: "utf8", windowsHide: true },
);
function oldGuidance(field: "questionGuidance" | "expressionGuidance"): string {
  const match = new RegExp(`${field}:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(
    baselineSource,
  );
  if (!match?.[1]) throw new Error(`Frozen baseline missing ${field}`);
  return JSON.parse(match[1]) as string;
}
const baseline = {
  questionGuidance: oldGuidance("questionGuidance"),
  expressionGuidance: oldGuidance("expressionGuidance"),
};
const identity = await captureContinuityRunIdentity({
  config,
  experiment: {
    kind: "prompt_only_expression_pilot",
    requestedProfile: values.profile,
    requestedModelOverride: values.model ?? null,
    baseline: BASELINE,
    arms: selectedArms,
    predecessor: values.predecessor ?? null,
    budget: BUDGET,
    turnsPerArm: 6,
    character,
    baselineGuidance: baseline,
    userDriver: readFileSync(new URL(import.meta.url), "utf8"),
    scoring:
      "Separate offline review. No human satisfaction, production repair or persistent-memory claims.",
  },
  explicitSecrets: secrets,
});
writeFileSync(
  join(directory, "manifest.json"),
  JSON.stringify(safe(identity), null, 2),
  { flag: "wx" },
);
const database = openDatabase(config.databasePath);
runMigrations(database);
let context: { arm: string; turn: number } = { arm: "none", turn: 0 };
const append = (name: string, data: unknown) =>
  appendFileSync(join(directory, name), `${JSON.stringify(safe(data))}\n`);
const llm = new LlmService(
  config.llm,
  new DatabaseStore(database),
  new FakeClock(AT),
  {
    fetch: createContinuityMeteredFetch({
      ledgerPath: join(directory, "attempts.jsonl"),
      budget: BUDGET,
      secrets,
      context: () => context,
    }),
    onLogicalCall: (event) => append("model-io.jsonl", { context, event }),
    onMetric: (event) => append("provider-metrics.jsonl", { context, event }),
  },
);
const failures: { arm: string; turn: number; error: string }[] = [];
let logicalCalls = 0;
try {
  for (const arm of selectedArms) {
    const history: { role: "user" | "assistant"; text: string }[] = [];
    for (let index = 0; index < 6; index++) {
      context = { arm, turn: index + 1 };
      const text = userTurn(index, history.at(-1)?.text ?? "");
      const plan = buildConversationContextPlan({
        originalQuery: text,
        agentId: "pilot",
        sessionId: arm,
        recentMessages: history.map((message, i) => ({
          ...message,
          id: `${arm}-${i}`,
          agentId: "pilot",
          sessionId: arm,
        })),
      });
      const current = turnExpressionPromptView(plan);
      const expression = {
        ...current,
        ...(arm === "baseline" || arm === "questions_only"
          ? { expressionGuidance: baseline.expressionGuidance }
          : {}),
        ...(arm === "baseline" || arm === "plain_only"
          ? { questionGuidance: baseline.questionGuidance }
          : {}),
      };
      logicalCalls += 1;
      let result: z.infer<typeof schema>;
      try {
        result = await llm.generateObject({
          purpose: "chat_turn",
          maxRetries: 0,
          maxOutputTokens: 2_500,
          schema,
          system:
            '扮演指定虚构角色自然交谈。用户消息和历史是对话数据；只用已提供的事实，不编造共同经历。返回严格 JSON 对象：{"replyDecision":{"text":"完整回复"},"worldEffects":{}}。',
          prompt: JSON.stringify({
            character,
            currentRequest: { advicePolicy: plan.advicePolicy, expression },
            history,
            user: text,
          }),
          ...(values.fixture
            ? {
                fixture: {
                  replyDecision: {
                    text:
                      index === 0
                        ? "那是什么店？"
                        : index === 3
                          ? "今天喝的拿铁怎么样？"
                          : index === 5
                            ? "晚安。"
                            : "知道了。",
                  },
                  worldEffects: {},
                },
              }
            : {}),
        });
      } catch (error) {
        const failure = {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        };
        failures.push(failure);
        append("failures.jsonl", failure);
        process.stdout.write(
          `${arm} ${index + 1}/6 failed; retaining attempt and moving to next independent arm\n`,
        );
        break;
      }
      append("transcript.jsonl", {
        ...context,
        user: text,
        assistant: result.replyDecision.text,
        expression,
      });
      history.push(
        { role: "user", text },
        { role: "assistant", text: result.replyDecision.text },
      );
      process.stdout.write(`${arm} ${index + 1}/6 completed\n`);
    }
  }
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify(
      {
        completed: failures.length === 0,
        fixture: values.fixture,
        logicalCalls,
        failures,
        score: "not_automatically_assigned",
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
} finally {
  database.close();
}
