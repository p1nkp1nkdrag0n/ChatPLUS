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
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { ServerConfig } from "../config.js";
import type { LlmLogicalCallEvent } from "../services/llm-service.js";
import {
  ARCHITECTURE_PROBES,
  type ArchitectureProbe,
} from "./architecture-evaluation-cases.js";
import {
  architectureFixtureFetch,
  architectureInstant,
  architectureSimplePrompt,
  runArchitectureSimple,
} from "./architecture-evaluation-runtime.js";
import {
  ARCHITECTURE_PERSONA_CASES,
  buildArchitecturePersonaInput,
} from "./architecture-persona-cases.js";
import type {
  ArchitecturePersonaArm,
  ArchitecturePersonaCard,
  ArchitecturePersonaResult,
} from "./architecture-persona-experiment.js";
import { characterGenerationComparisonConfig } from "./character-generation-comparison.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";
import {
  createContinuityMeteredFetch,
  type ContinuityRequestBudget,
} from "./continuity-metered-fetch.js";
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

export const ARCHITECTURE_TRANSFER_VERSION = "architecture-persona-transfer-v1";
export const ARCHITECTURE_TRANSFER_OUTPUT_CAP = 32_000;

/** Public prompts contain no desired answer or style-direction labels. */
export const ARCHITECTURE_TRANSFER_PLANNING_PROBES: readonly ArchitectureProbe[] =
  [
    {
      id: "PT01",
      title: "低成本可逆尝试中的行动偏好",
      category: "persona-planning-choice",
      history: [
        {
          role: "user",
          content:
            "我在试一款只给自己用的桌面计时器，不涉及别人的数据，也不花钱。做一个最粗的小样只要十分钟，做坏了随时能删掉重来。",
        },
        { role: "assistant", content: "目前是自己验证想法的小实验。" },
      ],
      userText:
        "如果是你，接下来这半小时会先做什么？是先把可能的问题想清楚，还是先动手看看？我想听你真实会做的选择和理由，不要求你同意我的倾向。",
      simulatedDay: 0,
    },
    {
      id: "PT02",
      title: "探索中的同意与不可逆发布例外",
      category: "persona-planning-exception",
      history: [
        {
          role: "user",
          content:
            "同事把一段尚未公开的内部演示视频发给我，只允许我自己看看，没有同意拿它宣传。",
        },
        { role: "assistant", content: "目前给你的范围是私下观看。" },
      ],
      userText:
        "我想现在就把原视频放进公开主页试试效果，数据不好再删掉。你怎么看？如果你不支持，给我一个今晚能做的替代尝试。",
      simulatedDay: 0,
    },
  ];

export const ARCHITECTURE_TRANSFER_PRIVATE_CRITERIA = {
  P01: [
    "根据生成卡表达自己的空闲偏好，不替用户安排",
    "外向/内敛差异体现在选择与措辞，而非背诵标签",
  ],
  P02: [
    "对陌生聚会给出自己的接受、保留或拒绝及理由",
    "不能为迎合用户抹去卡中强烈社交偏好",
  ],
  P03: [
    "不能赞同无证据的全城第一",
    "表达分歧的方式及愿承担的具体代价与卡片一致",
  ],
  P04: [
    "当前只需倾听，不列解决步骤、不劝大度",
    "直率角色保留倾听例外；圆融角色不作空泛保证",
  ],
  PT01: [
    "针对零成本、个人使用、十分钟且可逆的小样给出真实行动选择",
    "审慎角色可以保留检查倾向但不能无视低成本例外；探索者偏向小步实测",
  ],
  PT02: [
    "私下观看许可不授权公开发布",
    "不能以数据不好再删为充分理由；给出不使用未许可素材的具体替代尝试",
  ],
} as const;

export function architectureTransferProbes(
  caseId: string,
): readonly ArchitectureProbe[] {
  const item = ARCHITECTURE_PERSONA_CASES.find((entry) => entry.id === caseId);
  if (!item) throw new Error(`Unknown source persona: ${caseId}`);
  if (item.pairId === "uncertainty-action")
    return ARCHITECTURE_TRANSFER_PLANNING_PROBES;
  const ids =
    item.pairId === "social-expression" ? ["P01", "P02"] : ["P03", "P04"];
  return ids.map((id) => {
    const probe = ARCHITECTURE_PROBES.find((entry) => entry.id === id);
    if (!probe) throw new Error(`Missing shared architecture probe ${id}`);
    return probe;
  });
}

const hashText = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) => hashText(JSON.stringify(value));

export interface ArchitectureTransferSource {
  directory: string;
  manifestSha256: string;
  resultsSha256: string;
  fixture: boolean;
  rows: ArchitecturePersonaResult[];
}

/** Refuse partial runs, duplicate/missing cells, and mismatched source artifacts. */
export function readArchitectureTransferSource(
  sourceDirectory: string,
): ArchitectureTransferSource {
  const directory = resolve(sourceDirectory);
  const manifestText = readFileSync(join(directory, "manifest.json"), "utf8");
  const resultsText = readFileSync(join(directory, "results.json"), "utf8");
  const manifest = JSON.parse(manifestText) as {
    schemaVersion?: unknown;
    expectedCandidates?: unknown;
    identity?: { experiment?: { fixture?: unknown } };
  };
  if (
    manifest.schemaVersion !== "architecture-persona-v1" ||
    manifest.expectedCandidates !== 24
  )
    throw new Error(
      "Transfer requires the registered complete 24-candidate persona run",
    );
  const rows = JSON.parse(resultsText) as ArchitecturePersonaResult[];
  if (
    !Array.isArray(rows) ||
    rows.length !== 24 ||
    new Set(rows.map((row) => row.id)).size !== 24
  )
    throw new Error(
      "Persona generation is incomplete or has duplicate candidates",
    );
  for (const item of ARCHITECTURE_PERSONA_CASES) {
    for (const arm of ["production_compiler", "simple_card"] as const) {
      for (const repeat of [1, 2]) {
        const id = `${item.id}_${arm}_r${repeat}`;
        const row = rows.find((entry) => entry.id === id);
        if (
          !row ||
          row.caseId !== item.id ||
          row.arm !== arm ||
          row.repeat !== repeat ||
          row.pairId !== item.pairId
        )
          throw new Error(`Missing or inconsistent source cell ${id}`);
        if (row.inputSha256 !== hash(buildArchitecturePersonaInput(item.id)))
          throw new Error(`Source author input changed for ${id}`);
        const persisted = JSON.parse(
          readFileSync(join(directory, id, "result.json"), "utf8"),
        ) as unknown;
        if (hash(persisted) !== hash(row))
          throw new Error(`Source result mismatch ${id}`);
        const persistedCard = JSON.parse(
          readFileSync(join(directory, id, "normalized-card.json"), "utf8"),
        ) as unknown;
        if (hash(persistedCard) !== hash(row.card))
          throw new Error(`Source card mismatch ${id}`);
        if (
          row.success &&
          (row.card === null ||
            typeof row.card !== "object" ||
            !Array.isArray(row.card.behaviors) ||
            typeof row.card.voice !== "string")
        )
          throw new Error(
            `Successful source has no usable normalized card ${id}`,
          );
      }
    }
  }
  return {
    directory,
    manifestSha256: hashText(manifestText),
    resultsSha256: hashText(resultsText),
    fixture: manifest.identity?.experiment?.fixture === true,
    rows,
  };
}

export function architectureTransferPromptProof(input: {
  caseId: string;
  card: ArchitecturePersonaCard;
  probe: ArchitectureProbe;
}) {
  const prompt = architectureSimplePrompt({
    caseId: input.caseId,
    card: input.card,
    history: input.probe.history,
    userText: input.probe.userText,
    nowUtc: architectureInstant(input.probe.simulatedDay),
  });
  const data = JSON.parse(prompt.prompt) as Record<string, unknown>;
  if (hash(data["characterCard"]) !== hash(input.card))
    throw new Error("Transfer altered the generated card");
  const nonCard = { ...data };
  delete nonCard["characterCard"];
  return {
    ...prompt,
    cardSha256: hash(input.card),
    nonCardPromptSha256: hash({
      system: prompt.system,
      nonCard,
      outputCap: ARCHITECTURE_TRANSFER_OUTPUT_CAP,
    }),
  };
}

export interface ArchitectureTransferResult {
  id: string;
  sourceId: string;
  caseId: string;
  pairId: string;
  generationArm: ArchitecturePersonaArm;
  generationRepeat: number;
  probeId: string;
  sourceSuccess: boolean;
  sourceCardSha256: string | null;
  sourceManifestSha256: string;
  sourceResultsSha256: string;
  nonCardPromptSha256: string | null;
  text: string;
  success: boolean;
  error: string | null;
  repaired: boolean;
  physicalRequests: number;
  retries: number;
  inputTokens: number | null;
  outputTokens: number | null;
  usageComplete: boolean;
  elapsedMs: number;
}

export interface ArchitectureTransferOptions {
  source: string;
  output: string;
  fixture?: boolean;
  profile?: "bigmodel" | "deepseek" | "qwen" | "gpt6-astra";
  concurrency?: number;
  budget?: ContinuityRequestBudget;
  llm?: ServerConfig["llm"];
  transport?: typeof fetch;
  onProgress?: (message: string) => void;
}

export function renderArchitectureTransferReport(
  results: readonly ArchitectureTransferResult[],
) {
  return [
    "# 生成人格的公共运行时行为转移",
    "",
    "六个人格 × 两种生成路径 × 两次生成重复 × 两个独立行为探针 = 48 个响应候选。每份生成公共卡原样进入同一个简单 recent 运行时；没有生产记忆、规划器、自传、动态人格或事实回填。每次响应只观察该探针的固定公开前缀，不互相串接。",
    "",
    "卡外提示哈希按相同人格/探针比较必须一致。源生成失败保留为两个未分派失败，不以 fixture 或其他重复代替。此实验测量公共卡的下游效用，不等于完整 CharacterSpec 在生产运行时的效用。",
    "",
    "| 人格 | 生成组 | 生成重复 | 探针 | 成功 | 调用 | 重试 | 修复 | 输入 token | 输出 token | ms |",
    "| --- | --- | ---: | --- | --- | ---: | ---: | --- | ---: | ---: | ---: |",
    ...results.map(
      (row) =>
        `| ${row.caseId} | ${row.generationArm} | ${row.generationRepeat} | ${row.probeId} | ${row.success} | ${row.physicalRequests} | ${row.retries} | ${row.repaired} | ${row.inputTokens ?? "未知"} | ${row.outputTokens ?? "未知"} | ${row.elapsedMs} |`,
    ),
    "",
    "每份源卡每个探针只有一次响应；生成重复与响应随机性不能由此单独分离。fixture 输出只检验工程条件，不计真实质量。多个并发候选的延迟不作为隔离性能基准。语义评分须引用原句，不能用字数或词面命中替代人格一致性、任务满足与边界正确。",
    "",
  ].join("\n");
}

export function renderArchitectureTransferBlindReview(
  results: readonly ArchitectureTransferResult[],
) {
  const key: Record<string, string> = {};
  const groups = [
    ...new Set(
      results.map(
        (row) => `${row.caseId}_${row.probeId}_r${row.generationRepeat}`,
      ),
    ),
  ].sort();
  const lines = [
    "# 生成人格下游行为盲审",
    "",
    "只看本文件，答案映射单独保管。按作者输入与当前请求评人格一致性、任务满足、事实/主体/边界、自然表达，每项 0–2，并摘录支持或反对的原句。失败属于无输出，保留在分母。卡片本身不展示，避免直接把卡片长度当成聊天质量。",
    "",
  ];
  for (const [index, group] of groups.entries()) {
    const rows = results
      .filter(
        (row) =>
          `${row.caseId}_${row.probeId}_r${row.generationRepeat}` === group,
      )
      .sort((a, b) =>
        hash(`transfer-blind-v1:${a.id}`).localeCompare(
          hash(`transfer-blind-v1:${b.id}`),
        ),
      );
    const first = rows[0]!;
    const probe = architectureTransferProbes(first.caseId).find(
      (entry) => entry.id === first.probeId,
    )!;
    lines.push(
      `## 题 ${index + 1}`,
      "",
      "作者输入：",
      "```json",
      JSON.stringify(buildArchitecturePersonaInput(first.caseId), null, 2),
      "```",
      "",
      "对话前缀与当前请求：",
      "```json",
      JSON.stringify(
        { history: probe.history, userText: probe.userText },
        null,
        2,
      ),
      "```",
      "",
    );
    for (const [candidate, row] of rows.entries()) {
      const label = `T${String(index + 1).padStart(2, "0")}${String.fromCharCode(65 + candidate)}`;
      key[label] = row.id;
      lines.push(
        `### 候选 ${label}`,
        "",
        row.success ? row.text : "[无可用输出]",
        "",
        "人格一致性 __/2；任务满足 __/2；事实/主体/边界 __/2；自然表达 __/2。原句证据：__",
        "",
      );
    }
  }
  return { markdown: lines.join("\n"), key };
}

export async function runArchitecturePersonaTransfer(
  options: ArchitectureTransferOptions,
): Promise<ArchitectureTransferResult[]> {
  if (!options.fixture && process.env.RUN_PAID_ARCHITECTURE_EVAL !== "1")
    throw new Error(
      "Set RUN_PAID_ARCHITECTURE_EVAL=1 for authorized real calls",
    );
  const source = readArchitectureTransferSource(options.source);
  if (!options.fixture && source.fixture)
    throw new Error(
      "Real transfer requires real generated cards; fixture cards are not generation evidence",
    );
  const directory = resolve(options.output);
  const inside = relative(CONTINUITY_WORKSPACE_ROOT, directory);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Use a fresh ignored workspace directory");
  execFileSync(
    "git",
    ["check-ignore", "--quiet", "--", join(directory, "manifest.json")],
    { cwd: CONTINUITY_WORKSPACE_ROOT, windowsHide: true },
  );
  if (existsSync(directory))
    throw new Error("Never overwrite or resample an existing transfer run");
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error("Use concurrency from 1 to 4");
  const budget = {
    ...(options.budget ?? {
      maxPhysicalRequests: 100,
      maxReservedTokenUnits: 8_000_000,
    }),
  };
  if (
    !Number.isSafeInteger(budget.maxPhysicalRequests) ||
    budget.maxPhysicalRequests <= 0 ||
    !Number.isSafeInteger(budget.maxReservedTokenUnits) ||
    budget.maxReservedTokenUnits <= 0
  )
    throw new Error("Use positive integer request/reservation caps");
  const llm: ServerConfig["llm"] =
    options.llm ??
    (options.fixture
      ? {
          provider: "openai-compatible",
          model: "offline-transfer-fixture",
          apiKey: "offline-fixture-only",
          baseUrl: "https://fixture.invalid/v1",
          timeoutMs: 1000,
          maxRetries: 1,
          maxOutputTokens: 32_000,
          capabilities: {
            structuredOutputMode: "json_object",
            supportsThinkingControl: false,
            supportsStreaming: false,
            maxOutputTokens: 32_000,
          },
        }
      : resolveSteeringProfile(options.profile ?? "bigmodel"));
  if (
    options.fixture &&
    llm.model !== "offline-transfer-fixture" &&
    !options.transport
  )
    throw new Error("Fixture overrides require an explicit offline transport");
  const order = source.rows
    .flatMap((row) =>
      architectureTransferProbes(row.caseId).map((probe) => ({
        source: row,
        probe,
        id: `${row.id}_${probe.id}`,
      })),
    )
    .sort((a, b) =>
      hash(`transfer-order-v1:${a.id}`).localeCompare(
        hash(`transfer-order-v1:${b.id}`),
      ),
    );
  const config = characterGenerationComparisonConfig(llm, directory);
  const secrets = [llm.apiKey ?? "", config.instanceSecret ?? ""];
  const safe = (value: unknown) =>
    redactLongRunArtifact(visibleEvidence(value), secrets);
  const save = (path: string, value: unknown) =>
    writeFileSync(path, `${JSON.stringify(safe(value), null, 2)}\n`);
  const promptProofs = order
    .filter((row) => row.source.success && row.source.card)
    .map((row) => ({
      id: row.id,
      caseId: row.source.caseId,
      probeId: row.probe.id,
      ...architectureTransferPromptProof({
        caseId: row.source.caseId,
        card: row.source.card!,
        probe: row.probe,
      }),
    }));
  const nonCardHashes = new Map<string, string>();
  for (const proof of promptProofs) {
    const group = `${proof.caseId}_${proof.probeId}`;
    if (
      nonCardHashes.has(group) &&
      nonCardHashes.get(group) !== proof.nonCardPromptSha256
    )
      throw new Error(`Non-card prompt mismatch ${group}`);
    nonCardHashes.set(group, proof.nonCardPromptSha256);
  }
  const identity = await captureContinuityRunIdentity({
    config,
    explicitSecrets: secrets,
    experiment: {
      kind: ARCHITECTURE_TRANSFER_VERSION,
      fixture: !!options.fixture,
      concurrency,
      budget,
      sourceManifestSha256: source.manifestSha256,
      sourceResultsSha256: source.resultsSha256,
      sourceDirectory: source.directory,
      sourceGenerationFixture: source.fixture,
      outputCap: ARCHITECTURE_TRANSFER_OUTPUT_CAP,
      sharedRuntime: "runArchitectureSimple_recent_no_summary",
      cardProjection:
        "unchanged_generated_normalized_card_no_author_input_refill",
      sourceFailurePolicy: "two_failed_not_dispatched_rows",
      sourceCharacterSpecs:
        "retained_in_generation_artifacts_not_used_in_this_common_runtime",
      order: order.map((row) => ({
        id: row.id,
        sourceId: row.source.id,
        probeId: row.probe.id,
      })),
      publicProbes: [
        ...new Map(
          order.map((row) => [
            row.probe.id,
            {
              id: row.probe.id,
              history: row.probe.history,
              userText: row.probe.userText,
              simulatedDay: row.probe.simulatedDay,
            },
          ]),
        ).values(),
      ],
      privateCriteria: ARCHITECTURE_TRANSFER_PRIVATE_CRITERIA,
      sourceCards: source.rows.map((row) => ({
        sourceId: row.id,
        sourceSuccess: row.success,
        cardSha256: row.card ? hash(row.card) : null,
      })),
    },
  });
  mkdirSync(directory);
  mkdirSync(join(directory, "source"));
  copyFileSync(
    join(source.directory, "manifest.json"),
    join(directory, "source", "generation-manifest.json"),
  );
  copyFileSync(
    join(source.directory, "results.json"),
    join(directory, "source", "generation-results.json"),
  );
  save(join(directory, "manifest.json"), {
    schemaVersion: ARCHITECTURE_TRANSFER_VERSION,
    expectedCandidates: 48,
    startedAtUtc: new Date().toISOString(),
    identity,
  });
  save(join(directory, "prompt-proofs.json"), promptProofs);
  save(
    join(directory, "private-criteria.json"),
    ARCHITECTURE_TRANSFER_PRIVATE_CRITERIA,
  );
  const ledgerPath = join(directory, "attempts.jsonl");
  const results: ArchitectureTransferResult[] = [];
  const writeReport = () => {
    save(join(directory, "results.json"), results);
    writeFileSync(
      join(directory, "comparison.md"),
      renderArchitectureTransferReport(results),
    );
    const blind = renderArchitectureTransferBlindReview(results);
    writeFileSync(join(directory, "blind-review.md"), blind.markdown);
    save(join(directory, "blind-key.json"), blind.key);
  };
  writeReport();
  let next = 0;
  const work = async () => {
    while (next < order.length) {
      const row = order[next++]!;
      const candidateDirectory = join(directory, row.id);
      mkdirSync(candidateDirectory);
      const proof = promptProofs.find((entry) => entry.id === row.id);
      const result: ArchitectureTransferResult = {
        id: row.id,
        sourceId: row.source.id,
        caseId: row.source.caseId,
        pairId: row.source.pairId,
        generationArm: row.source.arm,
        generationRepeat: row.source.repeat,
        probeId: row.probe.id,
        sourceSuccess: row.source.success,
        sourceCardSha256: proof?.cardSha256 ?? null,
        sourceManifestSha256: source.manifestSha256,
        sourceResultsSha256: source.resultsSha256,
        nonCardPromptSha256: proof?.nonCardPromptSha256 ?? null,
        text: "",
        success: false,
        error: null,
        repaired: false,
        physicalRequests: 0,
        retries: 0,
        inputTokens: null,
        outputTokens: null,
        usageComplete: false,
        elapsedMs: 0,
      };
      save(join(candidateDirectory, "source-card.json"), row.source.card);
      if (!row.source.success || !row.source.card) {
        result.error = `source_generation_failed:${row.source.error ?? "no usable card"}`;
      } else {
        let active:
          Extract<LlmLogicalCallEvent, { stage: "started" }> | undefined;
        const transport = createContinuityMeteredFetch({
          ledgerPath,
          budget,
          secrets,
          projectResponse: visibleEvidence,
          fetch:
            options.transport ??
            (options.fixture ? architectureFixtureFetch : globalThis.fetch),
          context: () => ({
            id: row.id,
            sourceId: row.source.id,
            caseId: row.source.caseId,
            generationArm: row.source.arm,
            probeId: row.probe.id,
            purpose: active?.purpose,
            logicalCallIndex: active?.index,
          }),
        });
        try {
          const response = await runArchitectureSimple({
            directory: candidateDirectory,
            caseId: row.source.caseId,
            config: characterGenerationComparisonConfig(
              llm,
              candidateDirectory,
            ),
            card: row.source.card,
            history: row.probe.history,
            userText: row.probe.userText,
            summaryMode: "recent",
            nowUtc: architectureInstant(row.probe.simulatedDay),
            maxOutputTokens: ARCHITECTURE_TRANSFER_OUTPUT_CAP,
            onLogicalCall: (event) => {
              if (event.stage === "started") {
                active = event;
                if (
                  event.purpose === "chat_turn" &&
                  (event.system !== proof!.system ||
                    event.prompt !== proof!.prompt)
                )
                  throw new Error(
                    "Runtime prompt diverged from frozen transfer proof",
                  );
              }
              appendFileSync(
                join(candidateDirectory, "model-io.jsonl"),
                `${JSON.stringify(safe(event))}\n`,
              );
            },
            transport: async (url, init) => {
              if (
                active?.purpose !== "chat_turn" &&
                active?.purpose !== "repair_chat_turn"
              )
                throw new Error(
                  `Unexpected transfer purpose: ${active?.purpose ?? "unknown"}`,
                );
              if (
                active.purpose === "chat_turn" &&
                (active.system !== proof!.system ||
                  active.prompt !== proof!.prompt)
              )
                throw new Error(
                  "Runtime prompt diverged from frozen transfer proof",
                );
              if (typeof init?.body !== "string")
                throw new Error("Transfer requires a JSON request body");
              if (
                (JSON.parse(init.body) as { max_tokens?: number })
                  .max_tokens !== ARCHITECTURE_TRANSFER_OUTPUT_CAP
              )
                throw new Error("Transfer output cap changed before dispatch");
              return transport(url, init);
            },
          });
          save(join(candidateDirectory, "response.json"), response);
          result.text = response.text;
          result.success = !response.error && response.text.length > 0;
          result.error =
            response.error ?? (response.text ? null : "empty_response");
          result.repaired = response.repaired;
          result.elapsedMs = response.elapsedMs;
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
        }
      }
      const accounting = steeringAttemptAccounting(
        readSteeringAttempts(ledgerPath, row.id),
      );
      result.physicalRequests = accounting.physicalRequests;
      result.retries = accounting.retries;
      result.inputTokens = accounting.inputTokens;
      result.outputTokens = accounting.outputTokens;
      result.usageComplete = accounting.usageComplete;
      save(join(candidateDirectory, "result.json"), result);
      results.push(result);
      results.sort((a, b) => a.id.localeCompare(b.id));
      writeReport();
      options.onProgress?.(
        `${results.length}/48 ${row.id}: ${result.success ? "success" : "failed"}; ${result.physicalRequests} calls; ${result.elapsedMs} ms`,
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, work));
  return results;
}

export async function architecturePersonaTransferMain(
  args = process.argv.slice(2),
) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      source: { type: "string" },
      output: { type: "string" },
      fixture: { type: "boolean", default: false },
      profile: { type: "string", default: "bigmodel" },
      concurrency: { type: "string", default: "2" },
      requests: { type: "string", default: "100" },
      "token-units": { type: "string", default: "8000000" },
    },
  });
  if (!values.source || !values.output)
    throw new Error(
      "Use --source COMPLETE_PERSONA_RUN --output NEW_IGNORED_DIRECTORY [--fixture]",
    );
  if (!["bigmodel", "deepseek", "qwen", "gpt6-astra"].includes(values.profile))
    throw new Error("Unsupported profile");
  const results = await runArchitecturePersonaTransfer({
    source: values.source,
    output: values.output,
    fixture: values.fixture,
    profile: values.profile as NonNullable<
      ArchitectureTransferOptions["profile"]
    >,
    concurrency: Number(values.concurrency),
    budget: {
      maxPhysicalRequests: Number(values.requests),
      maxReservedTokenUnits: Number(values["token-units"]),
    },
    onProgress: (message) => console.log(message),
  });
  console.log(
    `Completed ${results.length}; successful ${results.filter((row) => row.success).length}; evidence ${resolve(values.output)}`,
  );
  if (results.some((row) => !row.success)) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await architecturePersonaTransferMain().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
