import { createHash } from "node:crypto";
import {
  REPLY_STEERING_REMOVED_FIELDS,
  type ReplySteeringMode,
} from "@personasim/features";

import {
  REPLY_STEERING_COMMON_SCENARIO_IDS,
  REPLY_STEERING_PERSONAS,
  REPLY_STEERING_PERSONA_CONTEXT,
  REPLY_STEERING_SCENARIOS,
} from "./reply-steering-scenarios.js";

export type { ReplySteeringMode };

export interface ReplySteeringResult {
  id: string;
  profile: string;
  model: string;
  personaId: string;
  scenarioId: string;
  repeat: number;
  mode: ReplySteeringMode;
  success: boolean;
  statusCode: number;
  finalText: string | null;
  rawVisibleReplies: string[];
  elapsedMs: number;
  logicalCalls: number;
  physicalRequests: number;
  retries: number;
  repairs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  usageComplete: boolean;
  error: string | null;
  promptSha256: string | null;
  nonTargetPromptSha256: string | null;
  /** Raw-to-final text difference, including delivery formatting, not repair attribution. */
  repairChanged: boolean;
  fallback: boolean;
}

export interface ReplySteeringUsageSummary {
  /** Null if any row lacks authoritative, complete usage. */
  total: number | null;
  /** Known subtotal; null if no row reported the metric, never fabricated zero. */
  knownTotal: number | null;
  reportedRows: number;
  missingRows: number;
}

export interface ReplySteeringSummary {
  profile: string;
  models: string[];
  personaId: string;
  mode: ReplySteeringMode;
  count: number;
  scenarioCount: number;
  successCount: number;
  failedCount: number;
  successRate: number;
  medianFinalCharacters: number | null;
  medianRawReplyCharacters: number | null;
  medianElapsedMs: number | null;
  medianSuccessfulElapsedMs: number | null;
  logicalCalls: number;
  physicalRequests: number;
  retries: number;
  repairs: number;
  repairChangedCount: number;
  fallbackCount: number;
  usageCompleteCount: number;
  inputTokens: ReplySteeringUsageSummary;
  outputTokens: ReplySteeringUsageSummary;
}

export function summarizeReplySteering(
  results: readonly ReplySteeringResult[],
): ReplySteeringSummary[] {
  return groupBy(results, (row) => [row.profile, row.personaId, row.mode]).map(
    (rows) => {
      const first = rows[0]!;
      const successes = rows.filter((row) => row.success);
      return {
        profile: first.profile,
        models: [...new Set(rows.map((row) => row.model))].sort(),
        personaId: first.personaId,
        mode: first.mode,
        count: rows.length,
        scenarioCount: new Set(rows.map((row) => row.scenarioId)).size,
        successCount: successes.length,
        failedCount: rows.length - successes.length,
        successRate: successes.length / rows.length,
        medianFinalCharacters: median(
          successes.flatMap((row) =>
            row.finalText === null ? [] : [characterCount(row.finalText)],
          ),
        ),
        medianRawReplyCharacters: median(
          rows.flatMap((row) => row.rawVisibleReplies.map(characterCount)),
        ),
        medianElapsedMs: median(rows.map((row) => row.elapsedMs)),
        medianSuccessfulElapsedMs: median(
          successes.map((row) => row.elapsedMs),
        ),
        logicalCalls: sum(rows.map((row) => row.logicalCalls)),
        physicalRequests: sum(rows.map((row) => row.physicalRequests)),
        retries: sum(rows.map((row) => row.retries)),
        repairs: sum(rows.map((row) => row.repairs)),
        repairChangedCount: rows.filter((row) => row.repairChanged).length,
        fallbackCount: rows.filter((row) => row.fallback).length,
        usageCompleteCount: rows.filter((row) => row.usageComplete).length,
        inputTokens: summarizeUsage(rows, "inputTokens"),
        outputTokens: summarizeUsage(rows, "outputTokens"),
      };
    },
  );
}

/** Compare model/personality differences only on the identical first-repeat six. */
export function commonReplySteeringResults(
  results: readonly ReplySteeringResult[],
): ReplySteeringResult[] {
  const common = new Set<string>(REPLY_STEERING_COMMON_SCENARIO_IDS);
  return results.filter(
    (row) => common.has(row.scenarioId) && row.repeat === 1,
  );
}

export function renderReplySteeringReport(
  results: readonly ReplySteeringResult[],
): string {
  const common = commonReplySteeringResults(results);
  const lines = [
    "# 回复引导、模型与性格比较：观测报告",
    "",
    "语义质量尚待盲审。成功返回、字数、延迟和 token 都是观测指标；更短、调用更少或 HTTP 成功不等于回复更好。详细求助必须检查信息是否保留，日常分享也必须检查是否具体接住用户。",
    "",
    "## 本次模式与干预边界",
    "",
    "历史 no_length_steering 同时移除长度、气泡数量与投递偏好，不能归因为单独的长度效应。各独立模式只移除下列字段；其余主提示、输出预算与服务器修复策略保持一致。",
    "",
    "| 模式 | 从主生成提示移除的字段 |",
    "| --- | --- |",
    ...[...new Set(results.map((row) => row.mode))]
      .sort()
      .map(
        (mode) =>
          `| ${mode} | ${REPLY_STEERING_REMOVED_FIELDS[mode].join(", ") || "无（基线）"} |`,
      ),
    "",
    "## 相同六场景、首次重复的比较集",
    "",
    `预先固定的共同场景：${REPLY_STEERING_COMMON_SCENARIO_IDS.map((id) => `\`${id}\``).join("、")}。所有模型与性格之间的横向比较以此集合为准；不能把预算不同的全量平均值直接排名。`,
    "",
    ...summaryTables(summarizeReplySteering(common)),
    "",
    "## 全部已执行样本",
    "",
    `共 ${results.length} 条记录；${results.filter((row) => row.success).length} 条成功，${results.filter((row) => !row.success).length} 条失败。这里包含不同采样预算，用来查看各组覆盖、配对稳定性与运行开销。`,
    "",
    ...summaryTables(summarizeReplySteering(results)),
    "",
    "## 解释与审阅要求",
    "",
    "- 成功率分母包含失败样本；失败保留在盲审材料中并标为不可评分，不将失败当作零字回复。",
    "- 最终字数只统计成功且有最终文本的样本，按 Unicode 字符计数；原始字数统计所有捕获的可见回复尝试，可能包含修复前内容。",
    "- 延迟为每个应用回合的实测耗时，包含重试和修复；成功回合中位数单独列出。串行小样本不能代表线上并发吞吐。",
    "- token 未提供时保留未知。‘已知小计’只汇总有数值的记录，不把缺失 token 当零，不以不完整用量推算成本。",
    "- 配对比较在同模型、同性格、同场景、同次重复内进行。跨模型与跨性格的盲审仅使用共同六场景的首次重复，候选顺序以种子确定。",
    "- 盲审分别记录自然度、帮助边界、信息完整、角色一致与篇幅适合度，并允许并列、无法区分和不可评分。规则或词频检查只能提供线索，不能替代语义判断。",
    "- 若共同集合缺少模型或性格，缺失覆盖必须先说明。当前报告不会推断未执行样本的表现，也不会生成未经审阅的质量分数或优胜排名。",
    "",
  ];
  return lines.join("\n");
}

type BlindComparisonKind = "paired-steering" | "cross-model" | "cross-persona";

export interface ReplySteeringBlindReviewKey {
  schemaVersion: "reply-steering-blind-review-v1";
  seedSha256: string;
  groups: {
    id: string;
    kind: BlindComparisonKind;
    scenarioId: string;
    candidates: {
      label: string;
      resultId: string;
      profile: string;
      model: string;
      personaId: string;
      mode: ReplySteeringMode;
      repeat: number;
    }[];
  }[];
}

/**
 * No scores are inferred. Save the key separately from markdown for reviewers.
 * Names/model identifiers within displayed text are masked; exact originals
 * remain in run records. Temperament descriptions remain so fidelity is judged
 * against the intended character, rather than treating all styles as one.
 */
export function buildBlindReview(
  results: readonly ReplySteeringResult[],
  seed: string | number,
): { markdown: string; key: ReplySteeringBlindReviewKey } {
  const normalizedSeed = String(seed);
  const comparisons: {
    kind: BlindComparisonKind;
    rows: ReplySteeringResult[];
  }[] = groupBy(results, (row) => [
    row.profile,
    row.personaId,
    row.scenarioId,
    row.repeat,
  ]).flatMap((rows) => {
    const baseline = rows.filter((row) => row.mode === "current");
    const ablations = rows.filter((row) => row.mode !== "current");
    // Each single-factor arm is reviewed against its own identical baseline,
    // never presented as an incomplete five-candidate historical pair.
    return ablations.length === 0
      ? [{ kind: "paired-steering" as const, rows }]
      : ablations.map((row) => ({
          kind: "paired-steering" as const,
          rows: [...baseline, row],
        }));
  });
  const common = commonReplySteeringResults(results);
  comparisons.push(
    ...groupBy(common, (row) => [row.personaId, row.scenarioId, row.mode])
      .filter((rows) => new Set(rows.map((row) => row.profile)).size > 1)
      .map((rows) => ({ kind: "cross-model" as const, rows })),
    ...groupBy(common, (row) => [row.profile, row.scenarioId, row.mode])
      .filter((rows) => new Set(rows.map((row) => row.personaId)).size > 1)
      .map((rows) => ({ kind: "cross-persona" as const, rows })),
  );
  const ordered = comparisons
    .map((comparison) => ({
      ...comparison,
      id: digest(
        JSON.stringify([
          normalizedSeed,
          comparison.kind,
          comparison.rows.map((row) => row.id).sort(),
        ]),
      ).slice(0, 16),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const key: ReplySteeringBlindReviewKey = {
    schemaVersion: "reply-steering-blind-review-v1",
    seedSha256: digest(normalizedSeed),
    groups: [],
  };
  const names = [
    ...REPLY_STEERING_PERSONAS.map((persona) => persona.name),
    ...results.flatMap((row) => [row.profile, row.model, row.personaId]),
  ].filter((value) => value.length > 0);
  const mask = (value: string) =>
    [...new Set(names)]
      .sort((left, right) => right.length - left.length)
      .reduce((text, name) => text.replaceAll(name, "[身份已隐去]"), value);
  const lines = [
    "# 回复盲审材料",
    "",
    "候选标签和顺序已按固定种子打散；模型、配置与角色姓名不显示。回答中的身份标识已遮盖，完整原文保存在运行证据中。性格描述用于评价是否符合各自设定。请独立完成审阅后再打开映射文件。",
    "",
    "先判断是否贴合当前用户意图，再检查帮助边界、信息完整、自然度、角色一致与篇幅适合度。没有越短越好的标准，也不要用技术指标代替内容判断。允许并列、无法区分和不可评分。不同性格可以有不同的合适表达。",
    "",
    `共享事实背景：\n\n${quote(mask(REPLY_STEERING_PERSONA_CONTEXT))}`,
    "",
  ];
  for (const comparison of ordered) {
    const candidates = [...comparison.rows].sort((left, right) =>
      digest(`${normalizedSeed}:${comparison.id}:${left.id}`).localeCompare(
        digest(`${normalizedSeed}:${comparison.id}:${right.id}`),
      ),
    );
    const scenarioId = candidates[0]!.scenarioId;
    const scenario = REPLY_STEERING_SCENARIOS.find(
      (item) => item.id === scenarioId,
    );
    const group = {
      id: `G-${comparison.id}`,
      kind: comparison.kind,
      scenarioId,
      candidates: candidates.map((row, index) => ({
        label: `候选 ${String.fromCharCode(65 + index)}`,
        resultId: row.id,
        profile: row.profile,
        model: row.model,
        personaId: row.personaId,
        mode: row.mode,
        repeat: row.repeat,
      })),
    };
    key.groups.push(group);
    lines.push(`## ${group.id}`, "");
    if (scenario === undefined) {
      lines.push("该记录未匹配到固定场景，缺少审阅上下文，整组不可评分。", "");
    } else {
      lines.push(`场景：${scenario.title}`, "", "固定历史：", "");
      for (const message of scenario.history) {
        lines.push(
          `**${message.role === "user" ? "用户" : "角色"}：**`,
          "",
          quote(mask(message.content)),
          "",
        );
      }
      lines.push(
        "**当前用户输入：**",
        "",
        quote(mask(scenario.userText)),
        "",
        `用户意图：${mask(scenario.rubric.intent)}`,
        "",
        "成功标准：",
        "",
        ...scenario.rubric.successCriteria.map((item) => `- ${mask(item)}`),
        "",
        "需要留意的失败方式：",
        "",
        ...scenario.rubric.failureModes.map((item) => `- ${mask(item)}`),
        "",
        `篇幅标准：${mask(scenario.rubric.lengthGuidance)}`,
        "",
      );
    }
    if (comparison.kind === "paired-steering" && candidates.length !== 2) {
      lines.push("配对覆盖不完整，无法据此判断两种配置孰优。", "");
    }
    for (const [index, row] of candidates.entries()) {
      const persona = REPLY_STEERING_PERSONAS.find(
        (item) => item.id === row.personaId,
      );
      lines.push(`### ${group.candidates[index]!.label}`, "");
      if (persona !== undefined)
        lines.push(`性格设定：${persona.description}`, "");
      if (
        !row.success ||
        row.finalText === null ||
        row.finalText.trim() === ""
      ) {
        lines.push(
          "本次未取得可评分的最终回复。标记为不可评分，不当作零分或极短回复。",
          "",
        );
      } else {
        lines.push(quote(mask(row.finalText)), "");
      }
    }
    lines.push(
      "审阅记录（待填写）：",
      "",
      "- 较合适的候选：____ / 并列 / 无法区分 / 不可评分",
      "- 自然度、帮助边界、信息完整、角色一致、篇幅适合度的逐项依据：____",
      "- 支持判断的原句与具体问题：____",
      "- 是否存在语气趋同或因缩短丢失信息：____",
      "",
    );
  }
  return { markdown: lines.join("\n"), key };
}

function summarizeUsage(
  rows: readonly ReplySteeringResult[],
  field: "inputTokens" | "outputTokens",
): ReplySteeringUsageSummary {
  const known = rows.flatMap((row) =>
    row[field] === null ? [] : [row[field]],
  );
  const knownTotal = known.length === 0 ? null : sum(known);
  return {
    total:
      known.length === rows.length && rows.every((row) => row.usageComplete)
        ? knownTotal
        : null,
    knownTotal,
    reportedRows: known.length,
    missingRows: rows.length - known.length,
  };
}

function summaryTables(summaries: readonly ReplySteeringSummary[]): string[] {
  if (summaries.length === 0) return ["暂无记录。"];
  return [
    "| 模型配置 | 性格 | 引导模式 | 成功 / 样本 | 场景 | 最终字数中位数 | 原始字数中位数 | 回合耗时中位数 ms | 成功耗时中位数 ms |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summaries.map(
      (row) =>
        `| ${cell(row.profile)} (${row.models.map(cell).join(", ")}) | ${cell(row.personaId)} | ${row.mode} | ${row.successCount} / ${row.count} | ${row.scenarioCount} | ${number(row.medianFinalCharacters)} | ${number(row.medianRawReplyCharacters)} | ${number(row.medianElapsedMs)} | ${number(row.medianSuccessfulElapsedMs)} |`,
    ),
    "",
    "| 模型配置 | 性格 | 引导模式 | 逻辑调用 | 物理请求 | 重试 | 修复 | 原始到最终文本变化 | 回退 | 输入 token | 输出 token | 完整用量行 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summaries.map(
      (row) =>
        `| ${cell(row.profile)} | ${cell(row.personaId)} | ${row.mode} | ${row.logicalCalls} | ${row.physicalRequests} | ${row.retries} | ${row.repairs} | ${row.repairChangedCount} | ${row.fallbackCount} | ${usage(row.inputTokens)} | ${usage(row.outputTokens)} | ${row.usageCompleteCount} / ${row.count} |`,
    ),
  ];
}

function groupBy<T>(rows: readonly T[], key: (row: T) => unknown[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const encoded = JSON.stringify(key(row));
    const group = groups.get(encoded) ?? [];
    group.push(row);
    groups.set(encoded, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function characterCount(value: string): number {
  return [...value].length;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function quote(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => `> ${line}`)
    .join("\n");
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/gu, " ");
}

function number(value: number | null): string {
  return value === null ? "未知" : String(Math.round(value * 10) / 10);
}

function usage(value: ReplySteeringUsageSummary): string {
  if (value.total !== null) return String(value.total);
  if (value.knownTotal === null) return "未知";
  return `已知小计 ${value.knownTotal}（${value.reportedRows}/${value.reportedRows + value.missingRows} 行；总量未知）`;
}
