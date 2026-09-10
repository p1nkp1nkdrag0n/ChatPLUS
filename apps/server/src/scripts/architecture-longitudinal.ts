import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { readConfig, type ServerConfig } from "../config.js";
import type { LlmLogicalCallEvent } from "../services/llm-service.js";
import {
  ARCHITECTURE_CASE_VERSION,
  ARCHITECTURE_TRAJECTORIES,
} from "./architecture-evaluation-cases.js";
import {
  architectureConfig,
  architectureFixtureFetch,
} from "./architecture-evaluation-runtime.js";
import { buildArchitecturePersonaInput } from "./architecture-persona-cases.js";
import {
  architectureLongitudinalBranches,
  ARCHITECTURE_LONGITUDINAL_PERSONAS,
  runArchitectureLongitudinal,
} from "./architecture-longitudinal-experiment.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";
import { createContinuityMeteredFetch } from "./continuity-metered-fetch.js";
import {
  captureContinuityRunIdentity,
  CONTINUITY_WORKSPACE_ROOT,
} from "./continuity-run-identity.js";
import {
  readSteeringAttempts,
  resolveSteeringProfile,
  steeringAttemptAccounting,
  visibleEvidence,
} from "./reply-steering-runner.js";

export const ARCHITECTURE_LONGITUDINAL_BUDGET = {
  maxPhysicalRequests: 280,
  maxReservedTokenUnits: 20_000_000,
} as const;

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

/** Explicit source allowlist excludes credentials, user data and prior results. */
export function captureArchitectureLongitudinalSources(
  outputDirectory: string,
) {
  const listing = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps/server/src",
      "packages/contracts/src",
      "packages/features/src",
      "packages/kernel/src",
      "packages/providers/src",
      "package.json",
      "apps/server/package.json",
      "pnpm-lock.yaml",
      "tsconfig.base.json",
      "eslint.config.js",
    ],
    { cwd: CONTINUITY_WORKSPACE_ROOT, encoding: "utf8", windowsHide: true },
  );
  const files = [...new Set(listing.split(/\r?\n/u).filter(Boolean))].sort();
  const manifests: { path: string; sha256: string | null }[] = [];
  for (const path of files) {
    const source = resolve(CONTINUITY_WORKSPACE_ROOT, path);
    const inside = relative(CONTINUITY_WORKSPACE_ROOT, source);
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("Source snapshot path escaped workspace");
    if (!existsSync(source)) {
      manifests.push({ path, sha256: null });
      continue;
    }
    const bytes = readFileSync(source);
    const destination = join(outputDirectory, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    manifests.push({ path, sha256: hash(bytes) });
  }
  return { files: manifests, manifestSha256: hash(JSON.stringify(manifests)) };
}

export function architectureLongitudinalAccounting(
  ledgerPath: string,
  candidateIds: readonly string[],
) {
  const rows = candidateIds.map((id) => ({
    id,
    ...steeringAttemptAccounting(readSteeringAttempts(ledgerPath, id)),
  }));
  const dispatched = rows.filter((row) => row.physicalRequests > 0);
  const usageComplete =
    dispatched.length > 0 && dispatched.every((row) => row.usageComplete);
  return {
    candidates: rows,
    physicalRequests: rows.reduce((sum, row) => sum + row.physicalRequests, 0),
    retries: rows.reduce((sum, row) => sum + row.retries, 0),
    usageComplete,
    inputTokens: usageComplete
      ? dispatched.reduce((sum, row) => sum + row.inputTokens!, 0)
      : null,
    outputTokens: usageComplete
      ? dispatched.reduce((sum, row) => sum + row.outputTokens!, 0)
      : null,
  };
}

export async function runArchitectureLongitudinalCli(input: {
  output: string;
  fixture: boolean;
  profile?: "bigmodel" | "deepseek" | "qwen" | "gpt6-astra";
}) {
  if (!input.fixture && process.env.RUN_PAID_ARCHITECTURE_EVAL !== "1")
    throw new Error("Paid evaluation requires RUN_PAID_ARCHITECTURE_EVAL=1");
  const directory = resolve(input.output);
  const inside = relative(CONTINUITY_WORKSPACE_ROOT, directory);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Use a new ignored directory inside the workspace");
  execFileSync(
    "git",
    ["check-ignore", "--quiet", "--", join(directory, "manifest.json")],
    { cwd: CONTINUITY_WORKSPACE_ROOT, windowsHide: true },
  );
  if (existsSync(directory))
    throw new Error("Never overwrite or resample a longitudinal run");
  const base = readConfig();
  const llm: ServerConfig["llm"] = input.fixture
    ? {
        ...base.llm,
        provider: "openai-compatible",
        profileName: "offline-architecture-longitudinal",
        model: "offline-architecture-longitudinal",
        apiKey: "offline-fixture-key",
        baseUrl: "https://example.invalid",
        timeoutMs: 1000,
        maxRetries: 0,
      }
    : resolveSteeringProfile(input.profile ?? "bigmodel");
  const experimentDirectory = join(directory, "experiment");
  const branches = architectureLongitudinalBranches();
  const configs = branches.map((branch) => ({
    branchId: branch.branchId,
    config: architectureConfig(
      base,
      llm,
      join(experimentDirectory, branch.branchId),
    ),
  }));
  const secrets = [base.instanceSecret ?? "", llm.apiKey ?? ""];
  const identity = await captureContinuityRunIdentity({
    config: configs[0]!.config,
    experiment: {
      kind: "architecture-longitudinal-v1",
      scenarioVersion: ARCHITECTURE_CASE_VERSION,
      fixture: input.fixture,
      plannedCandidates: 144,
      budget: ARCHITECTURE_LONGITUDINAL_BUDGET,
      trajectories: ARCHITECTURE_TRAJECTORIES,
      branches,
      configs,
      authorInputs: ARCHITECTURE_LONGITUDINAL_PERSONAS.map((caseId) =>
        buildArchitecturePersonaInput(caseId),
      ),
    },
  });
  mkdirSync(directory, { recursive: true });
  const safe = (value: unknown) =>
    redactLongRunArtifact(visibleEvidence(value), secrets);
  const save = (name: string, value: unknown) =>
    writeFileSync(
      join(directory, name),
      `${JSON.stringify(safe(value), null, 2)}\n`,
    );
  const sources = captureArchitectureLongitudinalSources(
    join(directory, "source"),
  );
  save("source-manifest.json", sources);
  save("manifest.json", {
    kind: "architecture-longitudinal-cli-v1",
    startedAtUtc: new Date().toISOString(),
    identity,
    sources,
    physicalRequestBudget: ARCHITECTURE_LONGITUDINAL_BUDGET,
  });
  const ledgerPath = join(directory, "attempts.jsonl");
  let activeCandidateId: string | undefined;
  let activeCall:
    Extract<LlmLogicalCallEvent, { stage: "started" }> | undefined;
  const transport = createContinuityMeteredFetch({
    ledgerPath,
    budget: ARCHITECTURE_LONGITUDINAL_BUDGET,
    secrets,
    projectResponse: visibleEvidence,
    ...(input.fixture ? { fetch: architectureFixtureFetch } : {}),
    context: () => {
      if (!activeCandidateId || !activeCall)
        throw new Error("Unattributed longitudinal request blocked");
      return {
        id: activeCandidateId,
        logicalCallIndex: activeCall.index,
        purpose: activeCall.purpose,
      };
    },
  });
  let completed = 0;
  const results = await runArchitectureLongitudinal({
    directory: experimentDirectory,
    config: configs[0]!.config,
    transport,
    runIdentity: identity,
    authorInputs: Object.fromEntries(
      ARCHITECTURE_LONGITUDINAL_PERSONAS.map((id) => [
        id,
        buildArchitecturePersonaInput(id),
      ]),
    ),
    onBeforeTurn: ({ branchId, turnId }) => {
      activeCandidateId = `${branchId}_${turnId}`;
      activeCall = undefined;
    },
    onLogicalCall: (event) => {
      if (event.stage === "started") activeCall = event;
      appendFileSync(
        join(directory, "logical-calls.jsonl"),
        `${JSON.stringify(safe({ id: activeCandidateId, event }))}\n`,
      );
    },
    onAfterTurn: (record) => {
      completed += 1;
      const id = `${record.branchId}_${record.turnId}`;
      const accounting = steeringAttemptAccounting(
        readSteeringAttempts(ledgerPath, id),
      );
      appendFileSync(
        join(directory, "results.jsonl"),
        `${JSON.stringify(safe({ ...record, accounting }))}\n`,
      );
      console.log(
        `RESULT ${completed}/144 ${id} ${record.status} calls=${accounting.physicalRequests} ms=${record.elapsedMs}`,
      );
    },
  });
  const accounting = architectureLongitudinalAccounting(
    ledgerPath,
    results.records.map((record) => `${record.branchId}_${record.turnId}`),
  );
  const sourceChanges = sources.files
    .filter((file) => {
      const path = join(CONTINUITY_WORKSPACE_ROOT, file.path);
      return (
        (existsSync(path) ? hash(readFileSync(path)) : null) !== file.sha256
      );
    })
    .map((file) => file.path);
  save("summary.json", {
    fixture: input.fixture,
    ...results,
    accounting,
    sourceAudit: {
      sourceManifestSha256: sources.manifestSha256,
      changedAfterStart: sourceChanges,
    },
  });
  const rows = branches.map((branch) => {
    const records = results.records.filter(
      (record) => record.branchId === branch.branchId,
    );
    const usage = architectureLongitudinalAccounting(
      ledgerPath,
      records.map((record) => `${record.branchId}_${record.turnId}`),
    );
    return `| ${branch.personaId} | ${branch.trajectoryId} | ${branch.arm} | ${records.filter((record) => record.status === "success").length} | ${records.filter((record) => record.status === "failed").length} | ${records.filter((record) => record.status === "skipped").length} | ${usage.physicalRequests} | ${usage.inputTokens ?? "未知"} | ${usage.outputTokens ?? "未知"} |`;
  });
  writeFileSync(
    join(directory, "comparison.md"),
    [
      "# 纵向架构对照：完整系统、近期历史、滚动摘要",
      "",
      `运行类型：${input.fixture ? "离线协议 fixture；所有 token 为模拟用量，不是 GLM 质量证据" : "真实供应商调用"}。144 个预注册用户回合，${results.completedCandidates} 个成功、${results.failedCandidates} 个失败、${results.skippedCandidates} 个跳过。`,
      "",
      "两个固定 12 回合用户轨迹 × 两个相反社交人格 × 三个架构。每个分支持续使用自己的生成回复，不能将此结果与同历史的一因素提示消融混为一谈。新会话时，两个简洁基线仍能使用跨会话的最近八条消息，滚动摘要也继续保留；完整系统则使用产品原生记忆、自传和当前会话上下文。该设定有意采用更强的简单基线。",
      "",
      `物理请求 ${accounting.physicalRequests}，供应商重试 ${accounting.retries}，输入 token ${accounting.inputTokens ?? "未知"}，输出 token ${accounting.outputTokens ?? "未知"}；用量覆盖完整：${accounting.usageComplete}。统计直接读取每次请求账本，包含辅助摘要、checkpoint、重试和失败请求；预约 token 单位仅用于请求准入。`,
      "",
      "| 人格 | 轨迹 | 架构 | 成功 | 失败 | 跳过 | 物理请求 | 输入 token | 输出 token |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
      "源码和全部有效配置在运行前保存。实验使用强制压缩和跨月假时钟，属于保留与回忆压力测试；模型成功响应、表面字串命中和辅助模块执行成功均不等于语义质量合格。",
      "",
      "每回合原始请求、可见回复、逻辑调用、辅助调用错误及数据库快照均在证据目录中。盲审材料只隐藏架构标签；语义审阅和人格区分率尚需独立评判，不能把字数、温暖程度或格式直接作为胜负。",
      "",
      `运行后源码变化：${sourceChanges.length ? sourceChanges.join(", ") : "未发现已快照源码变化"}。`,
      "",
    ].join("\n"),
  );
  return { ...results, accounting, sourceChanges };
}

export async function architectureLongitudinalMain(
  args = process.argv.slice(2),
) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      output: { type: "string" },
      fixture: { type: "boolean", default: false },
      profile: { type: "string", default: "bigmodel" },
    },
  });
  if (!values.output)
    throw new Error("Use --output NEW_IGNORED_WORKSPACE_DIRECTORY [--fixture]");
  if (!["bigmodel", "deepseek", "qwen", "gpt6-astra"].includes(values.profile))
    throw new Error("Unsupported profile");
  const result = await runArchitectureLongitudinalCli({
    output: values.output,
    fixture: values.fixture,
    profile: values.profile as "bigmodel" | "deepseek" | "qwen" | "gpt6-astra",
  });
  console.log(
    `COMPLETE ${result.completedCandidates}/${result.plannedCandidates}; requests=${result.accounting.physicalRequests}; evidence=${resolve(values.output)}`,
  );
  if (
    result.failedCandidates ||
    result.skippedCandidates ||
    result.sourceChanges.length
  )
    process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  architectureLongitudinalMain().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
