import { describe, expect, it } from "vitest";

import {
  renderLongRunV2Conversation,
  renderLongRunV2ProfileConversation,
} from "./companion-long-run-v2-conversation.js";
import type {
  LongRunStateSnapshot,
  LongRunV2Branch,
  TurnEvidence,
} from "./companion-long-run-v2-run-types.js";

describe("companion long-run v2 conversation artifact", () => {
  it("orders candidates and makes paired probes and both closed-loop branches unambiguous", () => {
    const output = renderLongRunV2Conversation([
      turn(145, 109, "friends-109", "closed_loop", "friends"),
      turn(2, 2, "paired-02", "paired", "shared"),
      turn(144, 114, "date-114", "closed_loop", "date"),
      turn(31, 1, "shared-001", "closed_loop", "shared"),
      turn(1, 1, "paired-01", "paired", "shared"),
    ]);

    expect(output).toContain("配对探针——独立对话");
    expect(output).toContain("不是同一段连续对话");
    expect(output).toContain("分支 A——约会");
    expect(output).toContain("分支 B——保持朋友");
    expect(output).toContain("并不接续分支 A");
    expect(output.indexOf("`paired-01`")).toBeLessThan(
      output.indexOf("`paired-02`"),
    );
    expect(output.indexOf("`shared-001`")).toBeLessThan(
      output.indexOf("`date-114`"),
    );
    expect(output.indexOf("`date-114`")).toBeLessThan(
      output.indexOf("`friends-109`"),
    );
  });

  it("includes only requested turn metadata and persisted dialogue content", () => {
    const evidence = turn(7, 7, "memory-02-comparison", "paired", "shared");
    evidence.userMessage = "用户的原始消息\n第二行";
    evidence.persistedAssistant = {
      role: "assistant",
      content: "最终落库回复",
      metadata: "assistant-metadata-must-not-appear",
    };
    evidence.logicalCalls = [
      {
        index: 1,
        purpose: "chat_turn",
        system: "system-prompt-must-not-appear",
        prompt: "prompt-must-not-appear",
        promptSha256: "prompt-hash-must-not-appear",
      },
    ];
    evidence.applicationResponse = "raw-http-body-must-not-appear";
    evidence.rawCandidateOutput = "raw-provider-output-must-not-appear";
    evidence.before.runtimeState = "state-must-not-appear";
    evidence.assertions = [
      {
        code: "hard-gate-must-not-appear",
        status: "FAIL",
        summary: "assertion-must-not-appear",
      },
    ];

    const output = renderLongRunV2Conversation([evidence]);

    expect(output).toContain("候选轮次 7 · 逻辑轮次 7");
    expect(output).toContain("`memory-02-comparison`");
    expect(output).toContain("轨道：`paired`");
    expect(output).toContain("分支：`shared`");
    expect(output).toContain("2026-09-01T01:00:00.000Z");
    expect(output).toContain("> 用户的原始消息\n> 第二行");
    expect(output).toContain("> 最终落库回复");
    for (const forbidden of [
      "assistant-metadata-must-not-appear",
      "system-prompt-must-not-appear",
      "prompt-must-not-appear",
      "prompt-hash-must-not-appear",
      "raw-http-body-must-not-appear",
      "raw-provider-output-must-not-appear",
      "state-must-not-appear",
      "hard-gate-must-not-appear",
      "assertion-must-not-appear",
      "deepseek",
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });

  it("does not substitute provider or HTTP output for a missing persisted assistant", () => {
    const evidence = turn(1, 1, "failed-turn", "paired", "shared");
    delete evidence.persistedAssistant;
    evidence.applicationResponse = "unpersisted-http-answer";
    evidence.rawCandidateOutput = "unpersisted-provider-answer";

    const output = renderLongRunV2Conversation([evidence]);

    expect(output).toContain("> user-1");
    expect(output).not.toContain("**顾澜**");
    expect(output).not.toContain("unpersisted-http-answer");
    expect(output).not.toContain("unpersisted-provider-answer");
  });

  it("separates profile repetitions and never invents dialogue for missing runs", () => {
    const output = renderLongRunV2ProfileConversation({
      profile: "deepseek",
      repetitions: [
        { repetition: 3, status: "missing", evidence: [] },
        {
          repetition: 1,
          status: "available",
          evidence: [turn(1, 1, "paired-01", "paired", "shared")],
        },
        { repetition: 2, status: "blocked", evidence: [] },
      ],
    });

    expect(output.indexOf("## 第 1 次重复")).toBeLessThan(
      output.indexOf("## 第 2 次重复"),
    );
    expect(output.indexOf("## 第 2 次重复")).toBeLessThan(
      output.indexOf("## 第 3 次重复"),
    );
    expect(output).toContain("### 配对探针——独立对话");
    expect(output).toMatch(/## 第 2 次重复[\s\S]*\*\*状态：已阻断\*\*/u);
    expect(output).toMatch(/## 第 3 次重复[\s\S]*\*\*状态：缺失\*\*/u);
    expect(output.match(/\*\*用户\*\*/gu)).toHaveLength(1);
    expect(output.match(/\*\*顾澜\*\*/gu)).toHaveLength(1);
  });
});

function turn(
  candidateOrdinal: number,
  logicalOrdinal: number,
  turnId: string,
  track: TurnEvidence["track"],
  branch: LongRunV2Branch,
): TurnEvidence {
  const snapshot = emptySnapshot();
  return {
    schemaVersion: "companion-long-run-turn-evidence-v2",
    matrixId: "matrix",
    runId: "run",
    profile: "deepseek",
    repetition: 1,
    track,
    branch,
    turnId,
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
