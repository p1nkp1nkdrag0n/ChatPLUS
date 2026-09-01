import { resolve } from "node:path";

import {
  resolveLongRunV3ArtifactPaths,
  writeLongRunV3TextExclusive,
} from "./companion-long-run-v3-artifacts.js";
import type {
  LongRunV3ArtifactDigest,
  LongRunV3FinalStatus,
  LongRunV3RunManifest,
  LongRunV3TurnEvidence,
} from "./companion-long-run-v3-artifacts.js";

export const LONG_RUN_V3_HARD_GATES = [
  ["H01", "运行身份冻结"],
  ["H02", "120/120 完成"],
  ["H03", "真实证据链"],
  ["H04", "模型无越权写入"],
  ["H05", "模糊生活唯一"],
  ["H06", "精确日程退役"],
  ["H07", "因果阶段分离"],
  ["H08", "四种支持模式"],
  ["H09", "委托授权"],
  ["H10", "用户自主决定"],
  ["H11", "双向因果"],
  ["H12", "压力证据"],
  ["H13", "记忆忠实"],
  ["H14", "重启与 replay"],
  ["H15", "离线与主动消息停用"],
  ["H16", "A/B 隔离"],
  ["H17", "Prompt 有界"],
  ["H18", "前端迁移"],
  ["H19", "产物完整"],
] as const;

export type LongRunV3HardGateId = (typeof LONG_RUN_V3_HARD_GATES)[number][0];

export interface LongRunV3HardGateResult {
  id: LongRunV3HardGateId;
  name: string;
  status: "PASS" | "FAIL" | "SKIPPED" | "PENDING";
  evidence: string[];
  summary: string;
}

export const LONG_RUN_V3_SEMANTIC_DIMENSIONS = [
  {
    id: "emotional_understanding",
    label: "情绪理解与被倾听感",
    weight: 0.2,
    minimum: 2.8,
  },
  {
    id: "stress_and_clarity",
    label: "压力缓解与认知清晰",
    weight: 0.15,
    minimum: 2.8,
  },
  {
    id: "choice_analysis",
    label: "选择分析与价值冲突",
    weight: 0.2,
    minimum: 2.8,
  },
  {
    id: "recommendation_and_delegation",
    label: "明确建议及代为决定",
    weight: 0.1,
    minimum: 2.8,
  },
  {
    id: "long_term_causality",
    label: "长期因果与人生主线",
    weight: 0.15,
    minimum: 2.8,
  },
  {
    id: "mutual_influence",
    label: "双向影响与角色自主",
    weight: 0.1,
    minimum: 2.8,
  },
  {
    id: "relationship_accumulation",
    label: "关系积累",
    weight: 0.05,
    minimum: 2.6,
  },
  {
    id: "language_naturalness",
    label: "语言自然度与重复度",
    weight: 0.05,
    minimum: 2.6,
  },
] as const;

export type LongRunV3SemanticDimensionId =
  (typeof LONG_RUN_V3_SEMANTIC_DIMENSIONS)[number]["id"];

export interface LongRunV3SemanticDimensionScore {
  id: LongRunV3SemanticDimensionId;
  score: number;
  rationale: string;
  evidenceTurnIds: string[];
}

export interface LongRunV3StageScore {
  stage: string;
  score: number;
  minimum: number;
  evidenceTurnIds: string[];
}

export interface LongRunV3SemanticVeto {
  code: string;
  failed: boolean;
  summary: string;
  evidenceTurnIds: string[];
}

export interface LongRunV3SemanticEvaluation {
  dimensions: LongRunV3SemanticDimensionScore[];
  stageScores: LongRunV3StageScore[];
  vetoes: LongRunV3SemanticVeto[];
  judgedAtUtc: string;
  judge: string;
}

export interface LongRunV3ReportArtifactIndex {
  runManifest?: LongRunV3ArtifactDigest;
  baselineDatabase?: LongRunV3ArtifactDigest;
  runDatabase?: LongRunV3ArtifactDigest;
  conversation?: LongRunV3ArtifactDigest;
  modelIo?: LongRunV3ArtifactDigest;
  causalEvidence?: LongRunV3ArtifactDigest;
  turnEvidence?: LongRunV3ArtifactDigest;
  hardGates?: LongRunV3ArtifactDigest;
  semanticScores?: LongRunV3ArtifactDigest;
}

export interface LongRunV3RunSummary {
  schemaVersion: "companion-long-run-run-summary-v3";
  manifest: LongRunV3RunManifest;
  finalStatus: LongRunV3FinalStatus;
  completedCandidateTurns: number;
  branchTurns: {
    shared: number;
    stable: number;
    independent: number;
  };
  hardGates: {
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
    results: LongRunV3HardGateResult[];
    turnFailures: {
      turnIds: string[];
      assertions: string[];
    };
  };
  provider: {
    physicalAttempts: number;
    failedAttempts: number;
    repairedTurns: number;
    repairRate: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  semantic?: {
    weightedScore: number;
    dimensions: LongRunV3SemanticDimensionScore[];
    stageScores: LongRunV3StageScore[];
    vetoes: LongRunV3SemanticVeto[];
    judge: string;
    judgedAtUtc: string;
  };
  warnings: string[];
  artifacts: LongRunV3ReportArtifactIndex;
  completedAtUtc: string;
}

export function createLongRunV3HardGateSkeleton(): LongRunV3HardGateResult[] {
  return LONG_RUN_V3_HARD_GATES.map(([id, name]) => ({
    id,
    name,
    status: "PENDING",
    evidence: [],
    summary: "尚未评定",
  }));
}

export function summarizeLongRunV3Run(input: {
  manifest: LongRunV3RunManifest;
  evidence: readonly LongRunV3TurnEvidence[];
  hardGates?: readonly LongRunV3HardGateResult[];
  semantic?: LongRunV3SemanticEvaluation;
  artifacts?: LongRunV3ReportArtifactIndex;
  completedAtUtc?: string;
}): LongRunV3RunSummary {
  const hardGateResults = normalizeHardGates(input.hardGates ?? []);
  const attempts = input.evidence.flatMap((turn) => turn.providerAttempts);
  const repairedTurns = input.evidence.filter(
    (turn) => turn.repairAttempted,
  ).length;
  const repairRate =
    input.evidence.length === 0 ? 0 : repairedTurns / input.evidence.length;
  const providerFailures = input.evidence.filter(isProviderFailure);
  const finalStructureFailures = input.evidence.filter((turn) =>
    turn.assertions.some(
      (assertion) =>
        assertion.code === "response_contract_valid" &&
        assertion.status === "FAIL",
    ),
  );
  const failedTurnIds = input.evidence
    .filter((turn) => turn.status === "FAIL")
    .map((turn) => turn.turnId);
  const failedTurnAssertions = input.evidence.flatMap((turn) =>
    turn.assertions
      .filter((assertion) => assertion.status === "FAIL")
      .map((assertion) => `${turn.turnId}:${assertion.code}`),
  );
  const warnings: string[] = [];
  if (repairRate > 0.1 && repairRate <= 0.2) {
    warnings.push(
      `结构修复率 ${formatPercent(repairRate)} 位于 >10% 且 ≤20% 的警告区间。`,
    );
  }
  const recoveredAttempts = attempts.filter((attempt) => !attempt.success);
  if (
    recoveredAttempts.length > 0 &&
    providerFailures.length === 0 &&
    finalStructureFailures.length === 0
  ) {
    warnings.push(
      `${String(recoveredAttempts.length)} 次物理请求失败，但对应逻辑轮次最终恢复。`,
    );
  }
  if (input.manifest.identityCaveat !== undefined) {
    warnings.push(input.manifest.identityCaveat);
  }

  const semantic =
    input.semantic === undefined
      ? undefined
      : {
          weightedScore: calculateLongRunV3WeightedSemanticScore(
            input.semantic.dimensions,
          ),
          dimensions: input.semantic.dimensions,
          stageScores: input.semantic.stageScores,
          vetoes: input.semantic.vetoes,
          judge: input.semantic.judge,
          judgedAtUtc: input.semantic.judgedAtUtc,
        };
  const hardGateFailure = hardGateResults.some(
    (gate) => gate.status === "FAIL",
  );
  const hardGatePending = hardGateResults.some(
    (gate) => gate.status === "PENDING" || gate.status === "SKIPPED",
  );
  const semanticFailure =
    semantic !== undefined &&
    (semantic.weightedScore < 3 ||
      semantic.dimensions.some((score) => {
        const definition = LONG_RUN_V3_SEMANTIC_DIMENSIONS.find(
          (candidate) => candidate.id === score.id,
        );
        return definition === undefined || score.score < definition.minimum;
      }) ||
      semantic.stageScores.some((stage) => stage.score < stage.minimum) ||
      semantic.vetoes.some((veto) => veto.failed));

  let finalStatus: LongRunV3FinalStatus =
    warnings.length > 0 ? "PASS_WITH_WARNINGS" : "PASS";
  if (
    providerFailures.length > 0 ||
    finalStructureFailures.length > 0 ||
    repairRate > 0.2
  ) {
    finalStatus = "FAIL_PROVIDER";
  } else if (
    hardGateFailure ||
    failedTurnIds.length > 0 ||
    failedTurnAssertions.length > 0
  ) {
    finalStatus = "FAIL_PRODUCT";
  } else if (semanticFailure) {
    finalStatus = "FAIL_SEMANTIC";
  } else if (
    input.evidence.length !== input.manifest.plannedCandidateTurns ||
    hardGatePending ||
    semantic === undefined
  ) {
    finalStatus = "PARTIAL";
  }

  return {
    schemaVersion: "companion-long-run-run-summary-v3",
    manifest: input.manifest,
    finalStatus,
    completedCandidateTurns: input.evidence.length,
    branchTurns: {
      shared: input.evidence.filter((turn) => turn.branch === "shared").length,
      stable: input.evidence.filter((turn) => turn.branch === "stable").length,
      independent: input.evidence.filter(
        (turn) => turn.branch === "independent",
      ).length,
    },
    hardGates: {
      passed: hardGateResults.filter((gate) => gate.status === "PASS").length,
      failed: hardGateResults.filter((gate) => gate.status === "FAIL").length,
      skipped: hardGateResults.filter((gate) => gate.status === "SKIPPED")
        .length,
      pending: hardGateResults.filter((gate) => gate.status === "PENDING")
        .length,
      results: hardGateResults,
      turnFailures: {
        turnIds: failedTurnIds,
        assertions: failedTurnAssertions,
      },
    },
    provider: {
      physicalAttempts: attempts.length,
      failedAttempts: attempts.filter((attempt) => !attempt.success).length,
      repairedTurns,
      repairRate,
      ...(attempts.some((attempt) => attempt.inputTokens !== undefined)
        ? {
            inputTokens: attempts.reduce(
              (total, attempt) => total + (attempt.inputTokens ?? 0),
              0,
            ),
          }
        : {}),
      ...(attempts.some((attempt) => attempt.outputTokens !== undefined)
        ? {
            outputTokens: attempts.reduce(
              (total, attempt) => total + (attempt.outputTokens ?? 0),
              0,
            ),
          }
        : {}),
    },
    ...(semantic === undefined ? {} : { semantic }),
    warnings,
    artifacts: input.artifacts ?? {},
    completedAtUtc: input.completedAtUtc ?? new Date().toISOString(),
  };
}

export function calculateLongRunV3WeightedSemanticScore(
  scores: readonly LongRunV3SemanticDimensionScore[],
): number {
  const values = new Map(scores.map((score) => [score.id, score.score]));
  if (
    values.size !== LONG_RUN_V3_SEMANTIC_DIMENSIONS.length ||
    LONG_RUN_V3_SEMANTIC_DIMENSIONS.some(
      (dimension) => !values.has(dimension.id),
    )
  ) {
    throw new Error("Semantic evaluation must contain all eight dimensions.");
  }
  for (const [id, score] of values) {
    if (!Number.isFinite(score) || score < 0 || score > 4) {
      throw new Error(`Semantic score for ${id} must be between 0 and 4.`);
    }
  }
  return LONG_RUN_V3_SEMANTIC_DIMENSIONS.reduce(
    (total, dimension) =>
      total + (values.get(dimension.id) ?? 0) * dimension.weight,
    0,
  );
}

export function renderLongRunV3ReportMarkdown(
  summary: LongRunV3RunSummary,
): string {
  const lines = [
    `# ChatPLUS ${summary.manifest.profile} 纯模糊生活长程测试报告`,
    "",
    "## 结论",
    "",
    `- 最终状态：**${summary.finalStatus}**`,
    `- 候选轮次：${String(summary.completedCandidateTurns)}/${String(summary.manifest.plannedCandidateTurns)}`,
    `- 分支构成：共享 ${String(summary.branchTurns.shared)}，稳定方向 ${String(summary.branchTurns.stable)}，独立方向 ${String(summary.branchTurns.independent)}`,
    `- 工程硬门：${String(summary.hardGates.passed)} 通过 / ${String(summary.hardGates.failed)} 失败 / ${String(summary.hardGates.skipped)} 跳过 / ${String(summary.hardGates.pending)} 待评`,
    `- 失败轮次：${summary.hardGates.turnFailures.turnIds.join("、") || "无"}`,
    `- 失败断言：${summary.hardGates.turnFailures.assertions.join("、") || "无"}`,
    `- 物理请求：${String(summary.provider.physicalAttempts)} 次，失败 ${String(summary.provider.failedAttempts)} 次`,
    `- 结构修复率：${formatPercent(summary.provider.repairRate)}`,
    `- 语义总分：${summary.semantic === undefined ? "待评" : `${summary.semantic.weightedScore.toFixed(3)}/4`}`,
    "",
    "## 冻结输入",
    "",
    `- Run ID：\`${summary.manifest.runId}\``,
    `- Git revision：\`${summary.manifest.git.revision}\`${summary.manifest.git.dirty ? "（dirty）" : ""}`,
    `- 场景版本：\`${summary.manifest.scenario.version}\``,
    `- 场景 SHA-256：\`${summary.manifest.scenario.manifestSha256}\``,
    `- 基线 SQLite SHA-256：\`${summary.manifest.baseline.databaseSha256}\``,
    `- 角色 SHA-256：\`${summary.manifest.baseline.characterSpecSha256}\``,
    `- Profile：\`${summary.manifest.profile}\``,
    `- 请求模型：\`${summary.manifest.profileConfig.requestedModel}\``,
    `- 思考档位：\`${summary.manifest.profileConfig.reasoningEffort ?? "未配置"}\``,
    `- 超时：${String(summary.manifest.profileConfig.timeoutMs)} ms`,
    `- 最大输出：${summary.manifest.profileConfig.maxOutputTokens === undefined ? "未配置" : String(summary.manifest.profileConfig.maxOutputTokens)}`,
    `- 生活规划模式：\`${summary.manifest.featureFlags.lifePlanningMode}\``,
    "",
    "## 工程硬门",
    "",
    "| ID | 硬门 | 状态 | 依据 | 说明 |",
    "| --- | --- | --- | --- | --- |",
    ...summary.hardGates.results.map(
      (gate) =>
        `| ${gate.id} | ${escapeTable(gate.name)} | ${gate.status} | ${escapeTable(gate.evidence.join("；") || "—")} | ${escapeTable(gate.summary)} |`,
    ),
    "",
    "## 语义评分",
    "",
    "| 维度 | 权重 | 门槛 | 得分 | 证据轮次 | 说明 |",
    "| --- | ---: | ---: | ---: | --- | --- |",
    ...renderSemanticRows(summary.semantic),
    "",
    "### 阶段评分",
    "",
    ...renderStageScores(summary.semantic),
    "",
    "### 直接否决项",
    "",
    ...renderVetoes(summary.semantic),
    "",
    "## Provider 与结构化输出",
    "",
    `- 输入 Token：${summary.provider.inputTokens === undefined ? "不可用" : String(summary.provider.inputTokens)}`,
    `- 输出 Token：${summary.provider.outputTokens === undefined ? "不可用" : String(summary.provider.outputTokens)}`,
    `- 修复轮次：${String(summary.provider.repairedTurns)}`,
    `- 失败物理请求：${String(summary.provider.failedAttempts)}`,
    "",
    "## 证据产物",
    "",
    "| 产物 | 路径 | 字节 | SHA-256 |",
    "| --- | --- | ---: | --- |",
    ...renderArtifactRows(summary.artifacts),
  ];
  if (summary.warnings.length > 0) {
    lines.push(
      "",
      "## 警告",
      "",
      ...summary.warnings.map((warning) => `- ${warning}`),
    );
  }
  lines.push(
    "",
    "## 限制",
    "",
    "- 本报告只覆盖这一冻结版本的一次连续运行，不能单独证明随机稳定性。",
    "- 第三方网关能够调用配置的模型 ID，不等于独立证明实际上游模型身份。",
    "- `conversation.md` 只保留对话；完整但脱敏的动态输入、原始返回、结构修复、usage 与延迟以 `model-io.jsonl` 为准。",
    "",
  );
  return lines.join("\n");
}

export async function writeLongRunV3ReportExclusive(
  directory: string,
  summary: LongRunV3RunSummary,
): Promise<string> {
  const path = resolveLongRunV3ArtifactPaths(directory).report;
  await writeLongRunV3TextExclusive(
    path,
    renderLongRunV3ReportMarkdown(summary),
  );
  return path;
}

export function reportArtifactPath(
  runDirectory: string,
  relativePath: string,
): string {
  return resolve(runDirectory, relativePath);
}

function normalizeHardGates(
  provided: readonly LongRunV3HardGateResult[],
): LongRunV3HardGateResult[] {
  const byId = new Map<LongRunV3HardGateId, LongRunV3HardGateResult>();
  for (const gate of provided) {
    if (byId.has(gate.id)) {
      throw new Error(`Duplicate hard gate result: ${gate.id}`);
    }
    byId.set(gate.id, gate);
  }
  return LONG_RUN_V3_HARD_GATES.map(
    ([id, name]) =>
      byId.get(id) ?? {
        id,
        name,
        status: "PENDING",
        evidence: [],
        summary: "尚未评定",
      },
  );
}

function isProviderFailure(turn: LongRunV3TurnEvidence): boolean {
  if (
    [401, 403, 404, 408, 409, 429].includes(turn.http.status) ||
    turn.http.status >= 500
  ) {
    return true;
  }
  const hasFailedAttempt = turn.providerAttempts.some(
    (attempt) =>
      !attempt.success &&
      [
        "HTTP_ERROR",
        "TIMEOUT",
        "NETWORK_ERROR",
        "OUTPUT_TRUNCATED",
        "EMPTY_RESPONSE",
        "AUTH_ERROR",
        "MODEL_NOT_FOUND",
      ].includes(attempt.errorCode ?? ""),
  );
  const ultimatelySucceeded =
    turn.http.status >= 200 &&
    turn.http.status < 300 &&
    turn.assertions.some(
      (assertion) =>
        assertion.code === "response_contract_valid" &&
        assertion.status === "PASS",
    );
  return hasFailedAttempt && !ultimatelySucceeded;
}

function renderSemanticRows(
  semantic: LongRunV3RunSummary["semantic"],
): string[] {
  const scores = new Map(
    semantic?.dimensions.map((dimension) => [dimension.id, dimension]) ?? [],
  );
  return LONG_RUN_V3_SEMANTIC_DIMENSIONS.map((dimension) => {
    const score = scores.get(dimension.id);
    return `| ${dimension.label} | ${formatPercent(dimension.weight)} | ${dimension.minimum.toFixed(1)} | ${score === undefined ? "待评" : score.score.toFixed(2)} | ${score === undefined ? "—" : escapeTable(score.evidenceTurnIds.join(", ") || "—")} | ${score === undefined ? "—" : escapeTable(score.rationale)} |`;
  });
}

function renderStageScores(
  semantic: LongRunV3RunSummary["semantic"],
): string[] {
  if (semantic === undefined || semantic.stageScores.length === 0) {
    return ["- 待评"];
  }
  return semantic.stageScores.map(
    (stage) =>
      `- ${stage.stage}：${stage.score.toFixed(2)}/4（门槛 ${stage.minimum.toFixed(2)}；证据 ${stage.evidenceTurnIds.join(", ") || "—"}）`,
  );
}

function renderVetoes(semantic: LongRunV3RunSummary["semantic"]): string[] {
  if (semantic === undefined || semantic.vetoes.length === 0) {
    return ["- 待评"];
  }
  return semantic.vetoes.map(
    (veto) =>
      `- ${veto.failed ? "FAIL" : "PASS"} \`${veto.code}\`：${veto.summary}（${veto.evidenceTurnIds.join(", ") || "无对应轮次"}）`,
  );
}

function renderArtifactRows(artifacts: LongRunV3ReportArtifactIndex): string[] {
  const definitions: Array<[keyof LongRunV3ReportArtifactIndex, string]> = [
    ["runManifest", "运行 manifest"],
    ["baselineDatabase", "基线 SQLite"],
    ["runDatabase", "运行 SQLite"],
    ["conversation", "纯对话"],
    ["modelIo", "模型 I/O"],
    ["causalEvidence", "因果证据"],
    ["turnEvidence", "逐轮证据"],
    ["hardGates", "硬门结果"],
    ["semanticScores", "语义评分"],
  ];
  return definitions.map(([key, label]) => {
    const artifact = artifacts[key];
    return `| ${label} | ${artifact?.path ?? "待生成"} | ${artifact === undefined ? "—" : String(artifact.bytes)} | ${artifact?.sha256 ?? "—"} |`;
  });
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
