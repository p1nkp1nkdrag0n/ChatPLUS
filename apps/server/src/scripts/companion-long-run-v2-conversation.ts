import type {
  LongRunV2Branch,
  LongRunV2Profile,
  TurnEvidence,
} from "./companion-long-run-v2-run-types.js";

export interface LongRunV2ProfileConversationRepetition {
  repetition: 1 | 2 | 3;
  status: "available" | "blocked" | "missing";
  evidence: readonly TurnEvidence[];
}

/**
 * Produces a deliberately narrow, human-readable transcript. The JSONL
 * evidence remains the audit artifact; this view includes only turn identity,
 * logical time and the two persisted dialogue roles.
 */
export function renderLongRunV2Conversation(
  evidence: readonly TurnEvidence[],
): string {
  const lines = ["# 长程对话", ""];
  appendConversation(lines, evidence, 2);
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Combines the independently executed repetitions for one paid profile while
 * preserving the same paired/branch boundaries as each run-level transcript.
 * Missing repetitions are represented only by a status note, never by
 * synthesized dialogue.
 */
export function renderLongRunV2ProfileConversation(input: {
  profile: LongRunV2Profile;
  repetitions: readonly LongRunV2ProfileConversationRepetition[];
}): string {
  const lines = [`# 长程对话 — \`${input.profile}\``, ""];
  for (const repetition of [...input.repetitions].sort(
    (left, right) => left.repetition - right.repetition,
  )) {
    lines.push(`## 第 ${String(repetition.repetition)} 次重复`, "");
    if (repetition.status === "available") {
      appendConversation(lines, repetition.evidence, 3);
      continue;
    }
    lines.push(
      `**状态：${repetition.status === "blocked" ? "已阻断" : "缺失"}**`,
      "",
      repetition.status === "blocked"
        ? repetition.repetition === 1
          ? "该模型在 Pilot 阶段被阻断，且本次重复没有可用的对话证据。"
          : "该次重复因模型在 Pilot 阶段被阻断而未运行，因此没有生成对话。"
        : "该次重复没有可用的对话证据，因此不展示任何对话。",
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function appendConversation(
  lines: string[],
  evidence: readonly TurnEvidence[],
  sectionLevel: 2 | 3,
): void {
  const ordered = [...evidence].sort(compareTurns);
  const paired = ordered.filter((item) => item.track === "paired");
  const shared = closedBranch(ordered, "shared");
  const date = closedBranch(ordered, "date");
  const friends = closedBranch(ordered, "friends");
  const section = "#".repeat(sectionLevel);
  const subsection = "#".repeat(sectionLevel + 1);

  if (paired.length > 0) {
    lines.push(
      `${section} 配对探针——独立对话`,
      "",
      "每个探针都从各自的冻结基线开始，本节条目不是同一段连续对话。",
      "",
    );
    appendTurns(lines, paired, sectionLevel + 1);
  }

  if (shared.length + date.length + friends.length > 0) {
    lines.push(`${section} 闭环对话`, "");
    if (shared.length > 0) {
      lines.push(`${subsection} 共享历史`, "");
      appendTurns(lines, shared, sectionLevel + 2);
    }
    if (date.length > 0) {
      lines.push(
        `${subsection} 分支 A——约会`,
        "",
        "该分支从共享历史的末尾继续。",
        "",
      );
      appendTurns(lines, date, sectionLevel + 2);
    }
    if (friends.length > 0) {
      lines.push(
        `${subsection} 分支 B——保持朋友`,
        "",
        "该分支从同一份共享历史快照独立继续，并不接续分支 A。",
        "",
      );
      appendTurns(lines, friends, sectionLevel + 2);
    }
  }

  if (ordered.length === 0) {
    lines.push("没有已完成的候选轮次。", "");
  }
}

function closedBranch(
  evidence: readonly TurnEvidence[],
  branch: LongRunV2Branch,
): TurnEvidence[] {
  return evidence.filter(
    (item) => item.track === "closed_loop" && item.branch === branch,
  );
}

function appendTurns(
  lines: string[],
  evidence: readonly TurnEvidence[],
  headingLevel: number,
): void {
  const heading = "#".repeat(headingLevel);
  for (const item of evidence) {
    lines.push(
      `${heading} 候选轮次 ${String(item.candidateOrdinal)} · 逻辑轮次 ${String(item.logicalOrdinal)} · \`${inlineCode(item.turnId)}\``,
      "",
      `- 轨道：\`${item.track}\``,
      `- 分支：\`${item.branch}\``,
      `- 模拟时间：\`${item.fakeTimeBeforeUtc}\` → \`${item.fakeTimeAfterUtc}\``,
      "",
      "**用户**",
      "",
      quote(item.userMessage),
      "",
    );
    const assistant = persistedAssistantContent(item.persistedAssistant);
    if (assistant !== undefined) {
      lines.push("**顾澜**", "", quote(assistant), "");
    }
  }
}

function persistedAssistantContent(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record["role"] !== undefined && record["role"] !== "assistant") {
    return undefined;
  }
  const content = record["content"];
  return typeof content === "string" && content.trim() !== ""
    ? content
    : undefined;
}

function quote(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function inlineCode(value: string): string {
  return value.replaceAll("`", "\\`");
}

function compareTurns(left: TurnEvidence, right: TurnEvidence): number {
  return (
    left.candidateOrdinal - right.candidateOrdinal ||
    left.logicalOrdinal - right.logicalOrdinal ||
    left.turnId.localeCompare(right.turnId)
  );
}
