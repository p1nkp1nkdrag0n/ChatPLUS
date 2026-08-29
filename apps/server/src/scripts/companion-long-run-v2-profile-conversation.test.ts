import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeLongRunV2ProfileConversations } from "./companion-long-run-v2-profile-conversation.js";
import type {
  LongRunStateSnapshot,
  TurnEvidence,
} from "./companion-long-run-v2-run-types.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("paid long-run profile conversation artifacts", () => {
  it("aggregates run evidence by repetition and marks Pilot-blocked gaps", async () => {
    const matrixDirectory = await mkdtemp(
      join(tmpdir(), "chatplus-profile-conversation-"),
    );
    cleanup.push(matrixDirectory);
    await writeEvidence(matrixDirectory, "deepseek", 1, turn(1, 1));
    await writeJson(
      join(matrixDirectory, "runs", "deepseek-r1", "pilot-gate.json"),
      { eligibleForClosedLoop: false },
    );
    const sibling = join(
      matrixDirectory,
      "profiles",
      "deepseek",
      "model-io.jsonl",
    );
    await writeText(sibling, '{"recordType":"logical_call"}\n');

    const paths = await writeLongRunV2ProfileConversations({
      matrixDirectory,
      profiles: ["deepseek", "grok"],
      repetitions: [1, 2, 3],
      approvedRuns: [approvedRun(matrixDirectory, "deepseek", 1)],
    });

    expect(paths).toEqual([
      join(matrixDirectory, "profiles", "deepseek", "conversation.md"),
    ]);
    const first = await readFile(paths[0]!, "utf8");
    expect(first).toContain("# 长程对话 — `deepseek`");
    expect(first).toContain("## 第 1 次重复");
    expect(first).toContain("`turn-1`");
    expect(first).toContain("> user-1");
    expect(first).toContain("> assistant-1");
    expect(first).toMatch(/## 第 2 次重复[\s\S]*\*\*状态：已阻断\*\*/u);
    expect(first).toMatch(/## 第 3 次重复[\s\S]*\*\*状态：已阻断\*\*/u);
    expect(first).not.toContain("user-2");
    expect(await readFile(sibling, "utf8")).toBe(
      '{"recordType":"logical_call"}\n',
    );

    await writeEvidence(matrixDirectory, "deepseek", 2, turn(2, 2));
    await writeLongRunV2ProfileConversations({
      matrixDirectory,
      profiles: ["deepseek"],
      repetitions: [1, 2, 3],
      approvedRuns: [
        approvedRun(matrixDirectory, "deepseek", 1),
        approvedRun(matrixDirectory, "deepseek", 2),
      ],
    });
    const refreshed = await readFile(paths[0]!, "utf8");
    expect(refreshed).toContain("`turn-2`");
    expect(refreshed).toContain("> user-2");
    expect(refreshed.match(/\*\*状态：已阻断\*\*/gu)).toHaveLength(1);
    expect(await readFile(sibling, "utf8")).toBe(
      '{"recordType":"logical_call"}\n',
    );
  });

  it("writes an explicit missing section for a completed run without evidence", async () => {
    const matrixDirectory = await mkdtemp(
      join(tmpdir(), "chatplus-profile-conversation-"),
    );
    cleanup.push(matrixDirectory);
    await writeJson(
      join(matrixDirectory, "runs", "grok-r1", "run-summary.json"),
      { finalStatus: "PARTIAL" },
    );

    const paths = await writeLongRunV2ProfileConversations({
      matrixDirectory,
      profiles: ["grok", "bigmodel"],
      repetitions: [1, 2],
      approvedRuns: [approvedRun(matrixDirectory, "grok", 1)],
    });

    expect(paths).toHaveLength(1);
    const output = await readFile(paths[0]!, "utf8");
    expect(output).toMatch(/## 第 1 次重复[\s\S]*\*\*状态：缺失\*\*/u);
    expect(output).toMatch(/## 第 2 次重复[\s\S]*\*\*状态：缺失\*\*/u);
    expect(output).not.toContain("**用户**");
    await expect(
      readFile(
        join(matrixDirectory, "profiles", "bigmodel", "conversation.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not read dialogue from an unapproved stale run directory", async () => {
    const matrixDirectory = await mkdtemp(
      join(tmpdir(), "chatplus-profile-conversation-"),
    );
    cleanup.push(matrixDirectory);
    await writeEvidence(matrixDirectory, "deepseek", 1, turn(1, 1));
    await writeJson(
      join(matrixDirectory, "runs", "deepseek-r1", "pilot-gate.json"),
      { eligibleForClosedLoop: false },
    );

    const paths = await writeLongRunV2ProfileConversations({
      matrixDirectory,
      profiles: ["deepseek"],
      repetitions: [1, 2],
      approvedRuns: [],
      blockedProfiles: new Set(["deepseek"]),
    });

    const output = await readFile(paths[0]!, "utf8");
    expect(output).toContain("**状态：已阻断**");
    expect(output).not.toContain("`turn-1`");
    expect(output).not.toContain("> user-1");
    expect(output).not.toContain("> assistant-1");
  });
});

function approvedRun(
  matrixDirectory: string,
  profile: "deepseek" | "grok",
  repetition: 1 | 2 | 3,
) {
  return {
    profile,
    repetition,
    runDirectory: join(
      matrixDirectory,
      "runs",
      `${profile}-r${String(repetition)}`,
    ),
  } as const;
}

async function writeEvidence(
  matrixDirectory: string,
  profile: string,
  repetition: number,
  evidence: TurnEvidence,
): Promise<void> {
  await writeText(
    join(
      matrixDirectory,
      "runs",
      `${profile}-r${String(repetition)}`,
      "turn-evidence.jsonl",
    ),
    `${JSON.stringify(evidence)}\n`,
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

function turn(candidateOrdinal: number, logicalOrdinal: number): TurnEvidence {
  const snapshot = emptySnapshot();
  return {
    schemaVersion: "companion-long-run-turn-evidence-v2",
    matrixId: "matrix",
    runId: `deepseek-r${String(candidateOrdinal)}`,
    profile: "deepseek",
    repetition: candidateOrdinal as 1 | 2 | 3,
    track: "paired",
    branch: "shared",
    turnId: `turn-${String(candidateOrdinal)}`,
    logicalOrdinal,
    candidateOrdinal,
    scenarioBlock: "block",
    rubricTags: [],
    fakeTimeBeforeUtc: "2026-09-01T01:00:00.000Z",
    fakeTimeAfterUtc: "2026-09-01T01:05:00.000Z",
    sessionId: "session",
    clientMessageId: `client-${String(candidateOrdinal)}`,
    userMessage: `user-${String(candidateOrdinal)}`,
    actions: [],
    http: { method: "POST", path: "/messages", status: 201, latencyMs: 5 },
    logicalCalls: [],
    providerAttempts: [],
    persistedAssistant: {
      role: "assistant",
      content: `assistant-${String(candidateOrdinal)}`,
    },
    before: snapshot,
    after: snapshot,
    assertions: [],
    status: "PASS",
    repairAttempted: false,
    idempotentReplay: false,
  };
}

function emptySnapshot(): LongRunStateSnapshot {
  return {
    capturedAtUtc: "2026-09-01T01:00:00.000Z",
    runtimeState: null,
    cursor: null,
    schedule: [],
    scheduleNegotiations: [],
    settlements: [],
    activityEvents: [],
    memories: [],
    memoryEvidence: [],
    proactiveCandidates: [],
    messages: [],
    domainEvents: [],
    rejectedProposals: [],
    retrievalRuns: [],
    llmCalls: [],
    tableCounts: {},
    durableSha256: "0".repeat(64),
  };
}
